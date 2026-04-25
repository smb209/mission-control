/**
 * PM agent definition + soul_md loader.
 *
 * Phase 5 of the roadmap & PM-agent feature (specs/roadmap-and-pm-spec.md).
 * The PM is a planning-layer agent: one per workspace, role='pm', seeded
 * via migration. It reacts to operator-dropped disruptions and produces
 * `pm_proposals` rows. It never writes to the execution board.
 *
 * The system prompt is kept in `pm-soul.md` so it's readable and editable
 * without touching code. We read it at module init and bake it into the
 * exported constant — migrations call `getPmSoulMd()` synchronously and
 * the file lives next to this module.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Initiative } from '@/lib/db/initiatives';
import type { PmDiff } from '@/lib/db/pm-proposals';
import type { RoadmapSnapshot } from '@/lib/db/roadmap';

let _cache: string | null = null;

/**
 * Returns the PM agent's system prompt (soul_md) loaded from
 * `pm-soul.md`. Cached after first read. If the file is missing
 * (shouldn't happen in production — it's part of the source tree), we fall
 * back to a stub so seeds still succeed and the operator can fix it later.
 */
export function getPmSoulMd(): string {
  if (_cache) return _cache;
  try {
    // __dirname-equivalent for both bundled and unbundled callers. In
    // dev/test the file resolves alongside this TS file; under
    // `next build` the assets are co-located via the standalone bundler.
    const filePath = path.join(__dirname, 'pm-soul.md');
    _cache = fs.readFileSync(filePath, 'utf8');
  } catch {
    _cache = PM_SOUL_FALLBACK;
  }
  return _cache!;
}

/**
 * Hardcoded fallback — keeps seeds working even when the .md file isn't
 * reachable from the bundle path (e.g. some Next.js packaging modes). This
 * is intentionally a short summary rather than the full prompt; if the
 * file ever becomes unreadable in production we want the operator to
 * notice.
 */
const PM_SOUL_FALLBACK = `# PM Agent (fallback prompt)

You are the workspace PM. Read the roadmap snapshot, analyze the
operator's disruption, and call \`propose_changes\` with an impact
summary plus a structured diff. Never edit the execution board directly.
This is a stub fallback prompt; restore src/lib/agents/pm-soul.md to use
the full version.`;

export const PM_AGENT_NAME = 'PM';
export const PM_AGENT_AVATAR = '📋';
export const PM_AGENT_ROLE = 'pm';
export const PM_AGENT_DESCRIPTION =
  'Workspace project manager — maintains the roadmap, analyzes disruptions, proposes structured changes the operator approves.';

// ─── Polish B: Guided synthesizers ──────────────────────────────────
//
// Two new synthesize seams matching the LLM-swap-in pattern of
// `synthesizeImpactAnalysis` (pm-dispatch.ts). v1 is deterministic so
// the proposal lifecycle is testable without an LLM dependency. v2 will
// route through an LLM using the same input/output shape.

export interface PlanInitiativeDraft {
  title: string;
  description?: string | null;
  kind?: 'theme' | 'milestone' | 'epic' | 'story';
  complexity?: 'S' | 'M' | 'L' | 'XL' | null;
  parent_initiative_id?: string | null;
  target_start?: string | null;
  target_end?: string | null;
}

export interface PlanInitiativeSuggestions {
  refined_description: string;
  complexity: 'S' | 'M' | 'L' | 'XL';
  target_start: string | null;
  target_end: string;
  dependencies: Array<{
    depends_on_initiative_id: string;
    kind: 'finish_to_start' | 'informational';
    note: string;
  }>;
  status_check_md: string;
  owner_agent_id: string | null;
}

export interface SynthesizePlanResult {
  impact_md: string;
  suggestions: PlanInitiativeSuggestions;
  /** Stored on the proposal as `proposed_changes` for audit. The
   *  acceptProposal handler treats plan_initiative as advisory and never
   *  applies these — they exist as a snapshot of what the PM suggested. */
  changes: PmDiff[];
}

/**
 * Plan a draft initiative — produce a refined description + suggested
 * scaffolding the operator can apply to the form.
 *
 * v1 heuristics (DETERMINISTIC):
 *   - description: capitalize first letter, trim, append a "Goals" bullet
 *     stub if the input is too short to read as goals.
 *   - complexity: respect the operator's choice; otherwise infer from
 *     description word count + keywords:
 *       contains "platform"/"rebuild"/"migrate" → XL
 *       contains "redesign"/"refactor"/"system" → L
 *       contains "tweak"/"copy"/"text"/"fix"   → S
 *       0-30 words → S, 31-100 → M, 101-300 → L, 300+ → XL
 *   - target_start: today (or operator's value).
 *   - target_end: target_start + complexity-derived offset:
 *       S=7d, M=14d, L=28d, XL=56d.
 *   - dependencies: scan workspace initiatives for noun overlap with the
 *     draft title. We split on whitespace, drop stopwords, dedupe, and
 *     emit informational dep suggestions (operator confirms which become
 *     finish_to_start). Capped at 3 to avoid noise.
 *   - status_check_md: scaffolded with three operator-fillable bullets
 *     (Linked PR / Waiting on / Demo plan).
 *   - owner_agent_id: null (v1 doesn't suggest owners — the agent picker
 *     is the operator's call).
 *
 * The LLM swap-in seam is this whole function: replace the body with a
 * model call that returns the same `SynthesizePlanResult` shape.
 *
 * `velocityOverrides`/`availabilityOverrides` are accepted for parity with
 * `synthesizeImpactAnalysis` but unused in v1.
 */
export function synthesizePlanInitiative(
  snapshot: RoadmapSnapshot,
  draft: PlanInitiativeDraft,
  _opts: {
    velocityOverrides?: unknown;
    availabilityOverrides?: unknown;
  } = {},
): SynthesizePlanResult {
  const title = draft.title.trim();
  const rawDesc = (draft.description ?? '').trim();
  const wordCount = rawDesc ? rawDesc.split(/\s+/).filter(Boolean).length : 0;

  // ─── Refined description ─────────────────────────────────────────
  let refined: string;
  if (rawDesc.length === 0) {
    // Stub — give the operator a starting structure.
    refined =
      `${capitalizeFirst(title)}.\n\n` +
      `**Goals**\n- (define the primary user value here)\n\n` +
      `**Out of scope**\n- (call out what this is NOT)\n\n` +
      `**Success criteria**\n- (one measurable outcome)`;
  } else {
    refined = capitalizeFirst(rawDesc);
  }

  // ─── Complexity heuristic ────────────────────────────────────────
  const lowerCorpus = `${title} ${rawDesc}`.toLowerCase();
  let complexity: 'S' | 'M' | 'L' | 'XL';
  if (draft.complexity) {
    complexity = draft.complexity;
  } else if (/\b(platform|rebuild|migrate|migration|overhaul)\b/.test(lowerCorpus)) {
    complexity = 'XL';
  } else if (/\b(redesign|refactor|system|architecture|integrate)\b/.test(lowerCorpus)) {
    complexity = 'L';
  } else if (/\b(tweak|copy|text|fix|typo|polish)\b/.test(lowerCorpus)) {
    complexity = 'S';
  } else if (wordCount <= 30) complexity = 'S';
  else if (wordCount <= 100) complexity = 'M';
  else if (wordCount <= 300) complexity = 'L';
  else complexity = 'XL';

  // ─── Target window ───────────────────────────────────────────────
  const offsetDays: Record<typeof complexity, number> = { S: 7, M: 14, L: 28, XL: 56 };
  const today = new Date();
  const start = draft.target_start ?? isoDate(today);
  const startDate = new Date(start + 'T00:00:00Z');
  const end = isoDate(addDays(startDate, offsetDays[complexity]));

  // ─── Dependency suggestions (keyword overlap) ────────────────────
  const dependencies: PlanInitiativeSuggestions['dependencies'] = [];
  const titleNouns = extractNouns(title);
  if (titleNouns.length > 0) {
    const seen = new Set<string>();
    for (const i of snapshot.initiatives) {
      if (i.id === draft.parent_initiative_id) continue;
      if (i.status === 'done' || i.status === 'cancelled') continue;
      const otherNouns = extractNouns(i.title);
      const overlap = titleNouns.filter(n => otherNouns.includes(n));
      if (overlap.length === 0) continue;
      if (seen.has(i.id)) continue;
      seen.add(i.id);
      dependencies.push({
        depends_on_initiative_id: i.id,
        kind: 'informational',
        note: `Title shares "${overlap.join(', ')}" — confirm if this is a real dependency.`,
      });
      if (dependencies.length >= 3) break;
    }
  }

  // ─── Status check scaffolding ────────────────────────────────────
  const statusCheckMd =
    `### Status check\n` +
    `- **Linked PR / branch:** _(none yet)_\n` +
    `- **Waiting on:** _(nothing)_\n` +
    `- **Demo plan:** _(TBD)_`;

  const suggestions: PlanInitiativeSuggestions = {
    refined_description: refined,
    complexity,
    target_start: start,
    target_end: end,
    dependencies,
    status_check_md: statusCheckMd,
    owner_agent_id: null,
  };

  // ─── Compose impact_md (audit-friendly summary) ──────────────────
  const lines: string[] = [
    `### PM plan suggestion`,
    ``,
    `- **Title:** ${title}`,
    `- **Suggested complexity:** ${complexity}` +
      (draft.complexity ? ' (operator-set)' : ' (inferred)'),
    `- **Suggested window:** ${start} → ${end}`,
  ];
  if (dependencies.length > 0) {
    lines.push(`- **Possible dependencies (${dependencies.length}):**`);
    for (const d of dependencies) {
      const t = snapshot.initiatives.find(i => i.id === d.depends_on_initiative_id)?.title ?? d.depends_on_initiative_id;
      lines.push(`  - "${t}" — ${d.note}`);
    }
  } else {
    lines.push(`- **Dependencies:** none inferred`);
  }
  lines.push(
    ``,
    `_Advisory only — accept to record the suggestion; apply the form fields client-side._`,
  );

  // Embed the structured suggestions inside an HTML comment so the
  // client can parse them out of any /api/pm/proposals/[id]/refine
  // response (which returns only the proposal row). Markdown renderers
  // ignore HTML comments, so this is invisible to humans.
  lines.push('', `<!--pm-plan-suggestions ${JSON.stringify(suggestions)} -->`);

  // No DB-applied changes for plan_initiative — proposed_changes stays
  // empty so the advisory short-circuit in acceptProposal has nothing
  // to apply. The audit lives in trigger_text + impact_md.
  const changes: PmDiff[] = [];

  return { impact_md: lines.join('\n'), suggestions, changes };
}

export interface SynthesizeDecomposeResult {
  impact_md: string;
  changes: PmDiff[];
}

/**
 * Decompose an existing epic/milestone into 3-7 child initiatives.
 *
 * v1 templates (DETERMINISTIC):
 *   - Title starts with "Build"/"Feature"/"Implement" →
 *       [Design X, Implement core X, Wire X to UI, Test X end-to-end, Document X]
 *   - Title starts with "Launch" or kind=milestone →
 *       [Finalize scope for X, Engineering for X, Marketing for X, QA for X, Go-live for X]
 *   - Otherwise → [Discovery for X, Implementation for X, Verification for X]
 *
 * Children are stories by default. The first child has no deps, each
 * subsequent child depends on its predecessor (pre-wired chain) so the
 * decomposed work has a sensible default ordering. Operators can edit
 * before accepting.
 *
 * `hint` is appended to the description of every child as context.
 *
 * The LLM swap-in seam is this whole function — same pattern as
 * `synthesizePlanInitiative`. v2 reads the parent's description + dep
 * graph and produces richer breakdowns.
 */
export function synthesizeDecompose(
  parent: Initiative,
  hint?: string,
  _opts: {
    velocityOverrides?: unknown;
    availabilityOverrides?: unknown;
  } = {},
): SynthesizeDecomposeResult {
  const x = parent.title;
  const lowerTitle = parent.title.toLowerCase();
  const isLaunch = lowerTitle.startsWith('launch') || parent.kind === 'milestone';
  const isBuild = /^(build|feature|implement|create|add)\b/i.test(parent.title);

  let titles: string[];
  if (isBuild) {
    titles = [
      `Design ${x}`,
      `Implement core ${x}`,
      `Wire ${x} to UI`,
      `Test ${x} end-to-end`,
      `Document ${x}`,
    ];
  } else if (isLaunch) {
    titles = [
      `Finalize scope for ${x}`,
      `Engineering for ${x}`,
      `Marketing for ${x}`,
      `QA for ${x}`,
      `Go-live for ${x}`,
    ];
  } else {
    titles = [
      `Discovery for ${x}`,
      `Implementation for ${x}`,
      `Verification for ${x}`,
    ];
  }

  const baseDesc = parent.description?.trim() ?? '';
  const hintBlock = hint ? `\n\n_Operator hint: ${hint.trim()}_` : '';

  const changes: PmDiff[] = [];
  for (let i = 0; i < titles.length; i++) {
    const t = titles[i];
    // Pre-wire each child to depend on the prior sibling — the operator
    // can prune. We use placeholder ids `$0`, `$1`, … which resolve to
    // real ids at apply time inside acceptProposal.
    const deps = i === 0 ? [] : [`$${i - 1}`];
    changes.push({
      kind: 'create_child_initiative',
      parent_initiative_id: parent.id,
      title: t,
      description:
        `${t} for parent initiative "${x}".` +
        (baseDesc ? `\n\nParent context:\n${baseDesc}` : '') +
        hintBlock,
      child_kind: 'story',
      complexity: 'M',
      sort_order: i,
      depends_on_initiative_ids: deps,
    });
  }

  const lines: string[] = [
    `### PM decomposition for "${x}"`,
    ``,
    `Proposed ${changes.length} children (${isLaunch ? 'launch template' : isBuild ? 'build template' : 'generic template'}):`,
    ``,
  ];
  for (const c of changes) {
    if (c.kind === 'create_child_initiative') {
      lines.push(`- ${c.title}`);
    }
  }
  if (hint) {
    lines.push(``, `_Operator hint applied: "${hint.trim()}"._`);
  }
  lines.push(
    ``,
    `Apply to insert these as children. You can edit titles or remove rows before accepting.`,
  );

  return { impact_md: lines.join('\n'), changes };
}

// ─── Helpers ────────────────────────────────────────────────────────

function capitalizeFirst(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setUTCDate(r.getUTCDate() + n);
  return r;
}

const STOPWORDS = new Set([
  'a','an','the','and','or','but','of','to','in','on','for','with','at','by',
  'from','up','as','is','it','be','do','we','our','i','my','this','that',
  'plan','build','add','create','launch','new','setup','make','feature',
]);

function extractNouns(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 4 && !STOPWORDS.has(w));
}
