/**
 * Per-repo gate configuration.
 *
 * The convoy hook prescribes the EXACT command an agent must run for
 * each verification gate — typecheck, lint, related-tests, full
 * regression, runtime smoke. This module reads that config from the
 * target repo's `.mc/gates.json`, with auto-discovered defaults when
 * the file is absent so existing repos work without setup.
 *
 * Spec: specs/autonomous-flow-tightening-spec.md (slice 2).
 *
 * The gate config is INTENTIONALLY narrow:
 *   - build_fast      → Builder-stage commands (typecheck/lint/related-tests)
 *   - test_full       → Tester-stage full regression
 *   - runtime_smoke   → Tester-stage backend smoke (curl probe, MCP smoke)
 *
 * `runtime_ui` and `review_static` have no single prescribed command —
 * runtime_ui depends on the surface (Playwright vs preview_eval vs
 * manual), review_static is the Reviewer's judgment gate.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

export interface GateCommandSpec {
  /**
   * Ordered command list for this gate. Each command is run in sequence
   * and its output concatenated into the single evidence row submitted
   * for the gate. Placeholders supported:
   *   ${CHANGED_FILES}   — space-separated list of changed files vs
   *                         the task's base branch. Empty string when
   *                         no diff context available.
   */
  commands: string[];
  /**
   * Hard budget in ms. The worker SIGTERMs and emits a structured
   * `runner_stalled` event past this. Combined budget across the
   * `commands` array.
   */
  budget_ms: number;
}

export interface GateConfig {
  build_fast?: GateCommandSpec;
  test_full?: GateCommandSpec;
  runtime_smoke?: GateCommandSpec;
  /** True iff loaded from a real `.mc/gates.json` (vs auto-discovered). */
  source: 'file' | 'discovered' | 'none';
  /** Path the config was loaded from (when `source === 'file'`). */
  source_path?: string;
}

const RAW_FILE_SCHEMA_KEYS = ['build_fast', 'test_full', 'runtime_smoke'] as const;

// ─── Loading ────────────────────────────────────────────────────────

/**
 * Load gate config for a product whose repo lives at `productPath`.
 *
 * Resolution order:
 *   1. `<productPath>/.mc/gates.json` if present and parseable
 *   2. Auto-discovery: peek at `<productPath>/package.json` scripts
 *      for typecheck/lint/test
 *   3. Empty config (no gates prescribed; the legacy deliverable bar
 *      remains the default for that repo)
 */
export function loadGateConfig(productPath: string): GateConfig {
  const gatesFile = join(productPath, '.mc', 'gates.json');
  if (existsSync(gatesFile)) {
    try {
      const raw = readFileSync(gatesFile, 'utf8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const root = (
        parsed.gates && typeof parsed.gates === 'object'
          ? (parsed.gates as Record<string, unknown>)
          : parsed
      );
      const gates: GateConfig = { source: 'file', source_path: gatesFile };
      for (const key of RAW_FILE_SCHEMA_KEYS) {
        const entry = root[key];
        if (isValidSpec(entry)) {
          gates[key] = entry;
        }
      }
      return gates;
    } catch (err) {
      // Don't crash dispatch on a malformed gates file — fall through
      // to discovery and surface a warning.
      console.warn(`[gates] Failed to parse ${gatesFile}:`, err);
    }
  }
  return discoverFromPackageJson(productPath);
}

function isValidSpec(value: unknown): value is GateCommandSpec {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    Array.isArray(v.commands) &&
    v.commands.every((c) => typeof c === 'string' && c.length > 0) &&
    typeof v.budget_ms === 'number' &&
    v.budget_ms > 0
  );
}

interface PackageJsonShape {
  scripts?: Record<string, string>;
}

/**
 * Auto-discover gates from package.json scripts. Conservative — only
 * prescribes a gate when a recognizable script exists. The aim is to
 * make a typical Node repo work without writing `.mc/gates.json`, not
 * to be clever.
 */
function discoverFromPackageJson(productPath: string): GateConfig {
  const pkgFile = join(productPath, 'package.json');
  if (!existsSync(pkgFile)) {
    return { source: 'none' };
  }
  let pkg: PackageJsonShape;
  try {
    pkg = JSON.parse(readFileSync(pkgFile, 'utf8')) as PackageJsonShape;
  } catch {
    return { source: 'none' };
  }
  const scripts = pkg.scripts ?? {};
  const runner = detectRunner(productPath);
  const config: GateConfig = { source: 'discovered' };

  // build_fast: prefer an explicit `typecheck` + `lint` + a related-tests
  // command if present. If only `tsc --noEmit` is reachable directly,
  // use that.
  const buildCommands: string[] = [];
  if (scripts.typecheck) buildCommands.push(`${runner} typecheck`);
  else if (hasDep(pkg as Record<string, unknown>, 'typescript')) buildCommands.push(`${runner} tsc --noEmit`);
  if (scripts.lint) buildCommands.push(`${runner} lint`);
  // Related-tests: only if the project has a runner that supports it.
  // Keep this pattern explicit in `.mc/gates.json` for non-jest setups.
  if (scripts['test:related']) {
    buildCommands.push(`${runner} test:related \${CHANGED_FILES}`);
  }
  if (buildCommands.length > 0) {
    config.build_fast = { commands: buildCommands, budget_ms: 60_000 };
  }

  // test_full: yarn test / npm test (if present and not a typo of the
  // build_fast related-tests). 90s budget.
  if (scripts.test) {
    config.test_full = { commands: [`${runner} test`], budget_ms: 90_000 };
  }

  // runtime_smoke: explicit `mcp:smoke` or generic `smoke`.
  if (scripts['mcp:smoke']) {
    config.runtime_smoke = { commands: [`${runner} mcp:smoke`], budget_ms: 60_000 };
  } else if (scripts.smoke) {
    config.runtime_smoke = { commands: [`${runner} smoke`], budget_ms: 60_000 };
  }

  return config;
}

function hasDep(pkg: Record<string, unknown>, name: string): boolean {
  const deps = (pkg.dependencies ?? {}) as Record<string, string>;
  const dev = (pkg.devDependencies ?? {}) as Record<string, string>;
  return name in deps || name in dev;
}

/** yarn vs npm vs pnpm vs bun, detected from lockfile. Falls back to npm. */
function detectRunner(productPath: string): string {
  if (existsSync(join(productPath, 'yarn.lock'))) return 'yarn';
  if (existsSync(join(productPath, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(productPath, 'bun.lockb'))) return 'bun';
  return 'npm run';
}

// ─── Substitution ───────────────────────────────────────────────────

/**
 * Substitute placeholders in the commands of a gate spec. Currently
 * only `${CHANGED_FILES}`. Returns a new array; doesn't mutate input.
 */
export function substitutePlaceholders(
  commands: string[],
  ctx: { changedFiles?: string[] },
): string[] {
  const changed = (ctx.changedFiles ?? []).join(' ');
  return commands.map((c) => c.replaceAll('${CHANGED_FILES}', changed));
}

// ─── Public command-resolution helper ───────────────────────────────

export type RoleName = 'builder' | 'tester' | 'reviewer';

/**
 * Map a role to the gates it MUST submit before transitioning out of
 * its stage. Mirrors specs/autonomous-flow-tightening-spec.md.
 */
export const ROLE_REQUIRED_GATES: Record<RoleName, ReadonlyArray<keyof GateConfig>> = {
  builder: ['build_fast'],
  tester: ['test_full'], // runtime_ui or runtime_smoke also required, surface-dependent
  reviewer: [], // review_static is judgment-only; no prescribed command
};

export interface PrescribedCommandsForRole {
  role: RoleName;
  /** Per-gate prescribed command list, post-substitution. */
  gates: Partial<Record<keyof GateConfig, GateCommandSpec>>;
  /** Source of the underlying config (file/discovered/none). */
  source: GateConfig['source'];
  source_path?: string;
}

/**
 * Format the prescribed commands as a markdown section ready to embed
 * in a dispatch message. Mirrors the convention agents see for other
 * sections (planning spec, deliverables checklist).
 *
 * Returns an empty string when there are no commands to prescribe — the
 * legacy flow (no `.mc/gates.json`, no recognizable scripts) still
 * works via the deliverable bar inherited from slice 1.
 */
export function formatPrescribedCommandsSection(
  prescribed: PrescribedCommandsForRole,
  ctx: { agentId: string; taskId: string },
): string {
  const entries = Object.entries(prescribed.gates);
  if (entries.length === 0) return '';

  const lines: string[] = [];
  lines.push('---');
  lines.push('**🧪 PRESCRIBED VERIFICATION COMMANDS — run these exactly, submit raw output:**');
  lines.push('');
  for (const [gate, spec] of entries) {
    if (!spec) continue;
    lines.push(`### \`${gate}\` (budget: ${Math.round(spec.budget_ms / 1000)}s)`);
    lines.push('Run in sequence:');
    lines.push('```');
    for (const cmd of spec.commands) lines.push(cmd);
    lines.push('```');
    lines.push('Then submit the combined raw output:');
    lines.push('```');
    lines.push(
      `submit_evidence({ agent_id: "${ctx.agentId}", task_id: "${ctx.taskId}", gate: "${gate}", command: "<exact command line>", stdout: "<raw>", stderr: "<raw>", exit_code: <n>${gate === 'runtime_ui' ? ', artifact_paths: ["<absolute path to screenshot/trace>"]' : ''} })`,
    );
    lines.push('```');
    lines.push('');
  }
  lines.push(
    'The server parses your stdout (TS errors, ESLint counts, test summaries, artifacts) and decides pass/fail. **Self-reporting "verified" or "all good" without submit_evidence will be rejected by the stage gate.**',
  );
  lines.push('');
  if (prescribed.source === 'discovered') {
    lines.push(
      '_Commands auto-discovered from `package.json`. Pin them in `.mc/gates.json` to override._',
    );
  } else if (prescribed.source === 'file') {
    lines.push(`_Commands from \`${prescribed.source_path}\`._`);
  }
  return '\n' + lines.join('\n') + '\n';
}

export function getPrescribedCommandsForRole(
  productPath: string,
  role: RoleName,
  ctx: { changedFiles?: string[] } = {},
): PrescribedCommandsForRole {
  const cfg = loadGateConfig(productPath);
  const gates: PrescribedCommandsForRole['gates'] = {};
  const required = ROLE_REQUIRED_GATES[role];
  for (const key of required) {
    const spec = cfg[key];
    if (spec && key !== 'source' && key !== 'source_path') {
      gates[key] = {
        commands: substitutePlaceholders((spec as GateCommandSpec).commands, ctx),
        budget_ms: (spec as GateCommandSpec).budget_ms,
      };
    }
  }
  // Tester also gets test_full + (when discovered) runtime_smoke for backend tasks.
  if (role === 'tester' && cfg.runtime_smoke) {
    gates.runtime_smoke = {
      commands: substitutePlaceholders(cfg.runtime_smoke.commands, ctx),
      budget_ms: cfg.runtime_smoke.budget_ms,
    };
  }
  return {
    role,
    gates,
    source: cfg.source,
    source_path: cfg.source_path,
  };
}
