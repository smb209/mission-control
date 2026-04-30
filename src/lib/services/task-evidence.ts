/**
 * Task evidence service.
 *
 * Implements the "run-and-forward" verification model from
 * specs/autonomous-flow-tightening-spec.md: agents submit the raw stdout/
 * stderr of a prescribed command and the server parses pass/fail
 * deterministically. The agent never self-reports a boolean.
 *
 * Five gate kinds, each with its own parser:
 *   - build_fast    typecheck + lint + related-tests (Builder gate)
 *   - test_full     full regression suite (Tester gate)
 *   - runtime_ui    Playwright/preview run with screenshot artifact
 *   - runtime_smoke MCP smoke / curl probe (Tester / Reviewer)
 *   - review_static structured diff notes (Reviewer gate; no execution)
 *
 * The parsers are intentionally strict: they look for fingerprints that
 * a real run produces (TS error lines, ESLint JSON shape, jest summary
 * line, "Tests:" totals). An agent that submits "echo ok" gets
 * `unverified` because none of the parsers match, and `passed=0`.
 */

import { createHash } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { queryAll, queryOne, run } from '@/lib/db';
import { assertAgentCanActOnTask } from '@/lib/authz/agent-task';

export type EvidenceGate =
  | 'build_fast'
  | 'test_full'
  | 'review_static'
  | 'runtime_ui'
  | 'runtime_smoke';

export const ALL_EVIDENCE_GATES: EvidenceGate[] = [
  'build_fast',
  'test_full',
  'review_static',
  'runtime_ui',
  'runtime_smoke',
];

export interface SubmitEvidenceInput {
  taskId: string;
  /** `null` for operator-initiated entries (rare; mostly tests). */
  actingAgentId: string | null;
  gate: EvidenceGate;
  command: string;
  stdout?: string;
  stderr?: string;
  exitCode: number;
  durationMs?: number;
  diffSha?: string;
  artifactPaths?: string[];
}

export interface SubmitEvidenceResult {
  ok: boolean;
  evidenceId: string;
  passed: boolean;
  parsedSummary: ParsedSummary;
  rejectReason?: string;
}

export interface ParsedSummary {
  /** Which parser fingerprints matched the output. Empty = unverified. */
  fingerprints: string[];
  ts_errors?: number;
  eslint_errors?: number;
  eslint_warnings?: number;
  tests_passed?: number;
  tests_failed?: number;
  tests_skipped?: number;
  /** Free-form notes the parser surfaces (e.g. "no recognizable runner output"). */
  notes?: string[];
}

export interface TaskEvidenceRow {
  id: string;
  task_id: string;
  agent_id: string | null;
  gate: EvidenceGate;
  command: string;
  stdout: string;
  stderr: string;
  exit_code: number;
  duration_ms: number | null;
  diff_sha: string | null;
  artifact_paths: string | null;
  parsed_summary: string | null;
  passed: number;
  reject_reason: string | null;
  stdout_hash: string;
  created_at: string;
}

// ─── Parsers ────────────────────────────────────────────────────────

/**
 * tsc parser. Pass iff exit_code === 0 AND no `error TS\d+:` lines anywhere.
 * Fingerprint: the output contains a TS error line, OR exit_code === 0 and
 * the command line invokes tsc/typecheck — empty success of tsc is a real
 * signal but only when we can confirm tsc was actually invoked.
 */
function parseTsc(command: string, stdout: string, stderr: string, exitCode: number): {
  matched: boolean;
  passed: boolean;
  errors: number;
} {
  const tscFingerprint =
    /\btsc\b|\btypecheck\b/i.test(command) ||
    /error TS\d{4}:/.test(stdout) ||
    /error TS\d{4}:/.test(stderr);
  if (!tscFingerprint) return { matched: false, passed: false, errors: 0 };
  const errors =
    (stdout.match(/error TS\d{4}:/g)?.length ?? 0) +
    (stderr.match(/error TS\d{4}:/g)?.length ?? 0);
  const passed = exitCode === 0 && errors === 0;
  return { matched: true, passed, errors };
}

/**
 * ESLint parser. Detects `eslint` invocation OR ESLint-shaped output (JSON
 * array of {messages: [{severity}]}) or stylish format (`X problems (Y errors,
 * Z warnings)`).
 */
function parseEslint(command: string, stdout: string, stderr: string, exitCode: number): {
  matched: boolean;
  passed: boolean;
  errors: number;
  warnings: number;
} {
  const isEslintCmd = /\beslint\b/i.test(command) || /\blint\b/i.test(command);
  let errors = 0;
  let warnings = 0;
  let parsedJson = false;

  // Stylish: "1 problem (1 error, 0 warnings)" or "✖ N problems (X errors, Y warnings)"
  const stylish = stdout.match(/(\d+)\s+errors?,\s*(\d+)\s+warnings?/i);
  if (stylish) {
    errors = parseInt(stylish[1]!, 10);
    warnings = parseInt(stylish[2]!, 10);
  } else {
    // Try JSON formatter output
    try {
      const trimmed = stdout.trim();
      if (trimmed.startsWith('[')) {
        const arr = JSON.parse(trimmed) as Array<{ messages?: Array<{ severity?: number }> }>;
        if (Array.isArray(arr)) {
          parsedJson = true;
          for (const f of arr) {
            for (const m of f.messages ?? []) {
              if (m.severity === 2) errors++;
              else if (m.severity === 1) warnings++;
            }
          }
        }
      }
    } catch {
      // not JSON
    }
  }

  const matched = isEslintCmd || stylish != null || parsedJson;
  if (!matched) return { matched: false, passed: false, errors: 0, warnings: 0 };
  // ESLint exits 0 when only warnings, 1 when errors. Use both signals.
  const passed = exitCode === 0 && errors === 0;
  return { matched: true, passed, errors, warnings };
  // stderr intentionally unused — eslint writes its report to stdout
  void stderr;
}

/**
 * Jest / Vitest / node:test summary parser. Looks for the canonical totals
 * line. Falls back to TAP-style `# pass N` / `# fail N` for `tsx --test`.
 */
function parseTestRunner(command: string, stdout: string, stderr: string, exitCode: number): {
  matched: boolean;
  passed: boolean;
  passed_count: number;
  failed_count: number;
  skipped_count: number;
  runner: string | null;
} {
  // Jest/Vitest: "Tests:       1 failed, 4 passed, 1 skipped, 6 total"
  const jestLine = (stdout + '\n' + stderr).match(
    /Tests?:\s*(?:(\d+)\s+failed[,\s]*)?(?:(\d+)\s+passed[,\s]*)?(?:(\d+)\s+skipped[,\s]*)?(?:(\d+)\s+total)?/i,
  );
  if (jestLine && (jestLine[1] || jestLine[2] || jestLine[4])) {
    const failed = parseInt(jestLine[1] ?? '0', 10);
    const passed = parseInt(jestLine[2] ?? '0', 10);
    const skipped = parseInt(jestLine[3] ?? '0', 10);
    return {
      matched: true,
      passed: exitCode === 0 && failed === 0 && passed > 0,
      passed_count: passed,
      failed_count: failed,
      skipped_count: skipped,
      runner: 'jest-like',
    };
  }
  // node:test TAP: "# pass N", "# fail N"
  const tapPass = (stdout + '\n' + stderr).match(/^# pass\s+(\d+)/m);
  const tapFail = (stdout + '\n' + stderr).match(/^# fail\s+(\d+)/m);
  const tapSkip = (stdout + '\n' + stderr).match(/^# skipped?\s+(\d+)/m);
  if (tapPass || tapFail) {
    const passed = parseInt(tapPass?.[1] ?? '0', 10);
    const failed = parseInt(tapFail?.[1] ?? '0', 10);
    const skipped = parseInt(tapSkip?.[1] ?? '0', 10);
    return {
      matched: true,
      passed: exitCode === 0 && failed === 0 && passed > 0,
      passed_count: passed,
      failed_count: failed,
      skipped_count: skipped,
      runner: 'tap',
    };
  }
  // Playwright: "N passed (Xs)" / "N failed"
  const pwPass = stdout.match(/^\s*(\d+)\s+passed\b/m);
  const pwFail = stdout.match(/^\s*(\d+)\s+failed\b/m);
  if (pwPass || pwFail) {
    const passed = parseInt(pwPass?.[1] ?? '0', 10);
    const failed = parseInt(pwFail?.[1] ?? '0', 10);
    return {
      matched: true,
      passed: exitCode === 0 && failed === 0 && passed > 0,
      passed_count: passed,
      failed_count: failed,
      skipped_count: 0,
      runner: 'playwright',
    };
  }
  // Command names a known runner but no recognizable output → unverified.
  void command;
  return { matched: false, passed: false, passed_count: 0, failed_count: 0, skipped_count: 0, runner: null };
}

/**
 * Compose parsers per gate. Returns the pass/fail decision and the
 * structured summary persisted alongside the raw output.
 */
function parseEvidence(
  gate: EvidenceGate,
  command: string,
  stdout: string,
  stderr: string,
  exitCode: number,
  artifactPaths: string[],
): { passed: boolean; summary: ParsedSummary; rejectReason?: string } {
  const summary: ParsedSummary = { fingerprints: [], notes: [] };

  if (gate === 'build_fast') {
    // build_fast = the union of fast checks. Pass iff every parser that
    // matches passes AND at least one parser matched (so an agent can't
    // submit `echo ok` and call it a typecheck).
    const tsc = parseTsc(command, stdout, stderr, exitCode);
    const eslint = parseEslint(command, stdout, stderr, exitCode);
    const tests = parseTestRunner(command, stdout, stderr, exitCode);
    if (tsc.matched) {
      summary.fingerprints.push('tsc');
      summary.ts_errors = tsc.errors;
    }
    if (eslint.matched) {
      summary.fingerprints.push('eslint');
      summary.eslint_errors = eslint.errors;
      summary.eslint_warnings = eslint.warnings;
    }
    if (tests.matched) {
      summary.fingerprints.push('test-runner');
      summary.tests_passed = tests.passed_count;
      summary.tests_failed = tests.failed_count;
      summary.tests_skipped = tests.skipped_count;
    }
    if (summary.fingerprints.length === 0) {
      return {
        passed: false,
        summary,
        rejectReason:
          'build_fast: no recognizable typecheck/lint/test output. Run tsc, eslint, or a focused jest/node:test run and submit the raw stdout.',
      };
    }
    const passed =
      (!tsc.matched || tsc.passed) &&
      (!eslint.matched || eslint.passed) &&
      (!tests.matched || tests.passed);
    return { passed, summary };
  }

  if (gate === 'test_full') {
    const tests = parseTestRunner(command, stdout, stderr, exitCode);
    if (!tests.matched) {
      return {
        passed: false,
        summary,
        rejectReason:
          'test_full: no recognizable test-runner summary in output. Submit the full output of `yarn test` (or equivalent).',
      };
    }
    summary.fingerprints.push('test-runner');
    summary.tests_passed = tests.passed_count;
    summary.tests_failed = tests.failed_count;
    summary.tests_skipped = tests.skipped_count;
    return { passed: tests.passed, summary };
  }

  if (gate === 'runtime_ui') {
    // Runtime UI must have at least one artifact (screenshot, trace, HAR).
    if (artifactPaths.length === 0) {
      return {
        passed: false,
        summary,
        rejectReason:
          'runtime_ui: at least one artifact_path (screenshot, trace.zip, HAR) is required. The artifact is the proof.',
      };
    }
    summary.fingerprints.push('artifact');
    // If the command happens to be a Playwright run, parse its summary too.
    const tests = parseTestRunner(command, stdout, stderr, exitCode);
    if (tests.matched) {
      summary.fingerprints.push('test-runner');
      summary.tests_passed = tests.passed_count;
      summary.tests_failed = tests.failed_count;
    }
    // Pass iff exit_code === 0 and any test-runner that matched also passed.
    const passed = exitCode === 0 && (!tests.matched || tests.passed);
    return { passed, summary };
  }

  if (gate === 'runtime_smoke') {
    // Smoke gate: exit_code === 0 and stdout is non-empty (something actually ran).
    if (stdout.trim().length === 0 && stderr.trim().length === 0) {
      return {
        passed: false,
        summary,
        rejectReason: 'runtime_smoke: stdout and stderr both empty — looks like nothing ran.',
      };
    }
    summary.fingerprints.push('exit-code');
    const tests = parseTestRunner(command, stdout, stderr, exitCode);
    if (tests.matched) {
      summary.fingerprints.push('test-runner');
      summary.tests_passed = tests.passed_count;
      summary.tests_failed = tests.failed_count;
    }
    return { passed: exitCode === 0 && (!tests.matched || tests.passed), summary };
  }

  // review_static: judgment gate. Reviewer submits structured notes; we
  // accept any non-empty stdout (their notes) and don't try to parse pass/fail.
  // The `passed` here is "the reviewer recorded their review" — final
  // approval still happens via status transition.
  if (gate === 'review_static') {
    if (stdout.trim().length === 0) {
      return {
        passed: false,
        summary,
        rejectReason: 'review_static: notes are required (submit the review text as stdout).',
      };
    }
    summary.fingerprints.push('reviewer-notes');
    return { passed: true, summary };
  }

  // Should be unreachable thanks to TS exhaustiveness, but be explicit.
  return { passed: false, summary, rejectReason: `unknown gate: ${String(gate)}` };
}

// ─── Submission ─────────────────────────────────────────────────────

export function submitEvidence(input: SubmitEvidenceInput): SubmitEvidenceResult {
  const {
    taskId,
    actingAgentId,
    gate,
    command,
    stdout = '',
    stderr = '',
    exitCode,
    durationMs,
    diffSha,
    artifactPaths = [],
  } = input;

  // Authorization: only agents on the task (or operators with no agent_id)
  // may submit evidence. Reuses the same predicate as deliverables.
  if (actingAgentId) {
    assertAgentCanActOnTask(actingAgentId, taskId, 'status');
  }

  // Parse first so a hard reject (no fingerprints) still gets persisted as
  // failed evidence the operator can audit. Persisting rejected attempts
  // is intentional — it's a record of the agent trying to short-circuit
  // the gate.
  const { passed, summary, rejectReason } = parseEvidence(
    gate,
    command,
    stdout,
    stderr,
    exitCode,
    artifactPaths,
  );

  const id = uuidv4();
  const stdoutHash = createHash('sha256').update(stdout).digest('hex');

  run(
    `INSERT INTO task_evidence (
       id, task_id, agent_id, gate, command, stdout, stderr,
       exit_code, duration_ms, diff_sha, artifact_paths, parsed_summary,
       passed, reject_reason, stdout_hash, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    [
      id,
      taskId,
      actingAgentId,
      gate,
      command,
      stdout,
      stderr,
      exitCode,
      durationMs ?? null,
      diffSha ?? null,
      artifactPaths.length > 0 ? JSON.stringify(artifactPaths) : null,
      JSON.stringify(summary),
      passed ? 1 : 0,
      rejectReason ?? null,
      stdoutHash,
    ],
  );

  return {
    ok: !rejectReason,
    evidenceId: id,
    passed,
    parsedSummary: summary,
    rejectReason,
  };
}

// ─── Lookup helpers (used by checkStageEvidence) ────────────────────

/**
 * Most-recent evidence row for a (task, gate) pair, or null if none.
 * Stage gates check this against `passed = 1` to admit a transition.
 */
export function getLatestEvidence(taskId: string, gate: EvidenceGate): TaskEvidenceRow | null {
  return (
    queryOne<TaskEvidenceRow>(
      `SELECT * FROM task_evidence
        WHERE task_id = ? AND gate = ?
        ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      [taskId, gate],
    ) ?? null
  );
}

/** All evidence rows for a task, newest first. */
export function listTaskEvidence(taskId: string): TaskEvidenceRow[] {
  return queryAll<TaskEvidenceRow>(
    `SELECT * FROM task_evidence WHERE task_id = ? ORDER BY created_at DESC`,
    [taskId],
  );
}

/**
 * Has the task accumulated *any* evidence rows? Used by the stage gate to
 * decide whether to enforce the new strict bar or fall back to the legacy
 * deliverable-count check. Once a task has been routed through a flow that
 * prescribes commands (slice 2), evidence rows should be present and the
 * legacy fallback is bypassed.
 */
export function hasAnyEvidence(taskId: string): boolean {
  const row = queryOne<{ count: number }>(
    `SELECT COUNT(*) as count FROM task_evidence WHERE task_id = ?`,
    [taskId],
  );
  return Number(row?.count ?? 0) > 0;
}
