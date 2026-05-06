/**
 * Briefing builder for scope-keyed sessions.
 *
 * Composes the dispatch message that openclaw receives at the start of
 * a (re-)dispatched session. Composition order per
 * specs/scope-keyed-sessions.md §2.3:
 *
 *   1. Identity preamble (`Your agent_id is: …`).
 *   2. Role section — `agent_role_overrides.soul_md` if a row exists for
 *      `(workspace_id, role)`, else `agent-templates/<role>/SOUL.md`.
 *      Same fallback chain for AGENTS.md and IDENTITY.md.
 *   3. Notetaker addendum (`agent-templates/_shared/notetaker.md`)
 *      appended to every role.
 *   4. (Optional, for worker roles in Phase C+) task / scope context
 *      block — passed in via `trigger_body`.
 *   5. Trigger payload — the operator's actual ask, the scheduled job's
 *      prompt, etc. Passed in as `trigger_body` for now; richer
 *      composition layered in Phase C.
 *   6. Resume hint when `is_resume` is set.
 *
 * Pure function. Reads from the agent-templates/ directory
 * synchronously at call time, plus a single DB query for the override
 * row. No side effects.
 */

import path from 'node:path';
import fs from 'node:fs';
import { queryAll, queryOne } from '@/lib/db';

export type BriefingRole =
  | 'pm'
  | 'coordinator'
  | 'builder'
  | 'researcher'
  | 'tester'
  | 'reviewer'
  | 'writer'
  | 'learner';

export interface BuildBriefingInput {
  workspace_id: string;
  role: BriefingRole;
  scope_key: string;
  agent_id: string;
  gateway_agent_id: string;
  run_group_id: string;
  is_resume?: boolean;
  task_id?: string;
  initiative_id?: string;
  /**
   * The trigger-specific body. For PM dispatches this is the
   * disruption + snapshot summary built by pm-dispatch.ts. For workers
   * it's the task context + ask.
   */
  trigger_body: string;
}

interface RoleOverrideRow {
  soul_md: string | null;
  agents_md: string | null;
  identity_md: string | null;
}

const TEMPLATES_DIR = path.resolve(process.cwd(), 'agent-templates');

/**
 * Test seam — lets unit tests point briefing builder at a fixture
 * directory without touching the real `agent-templates/` files.
 */
let templatesDirOverride: string | null = null;
export function __setTemplatesDirForTests(dir: string | null): void {
  templatesDirOverride = dir;
}

function templatesDir(): string {
  return templatesDirOverride ?? TEMPLATES_DIR;
}

function readTemplateFile(role: string, name: string): string {
  const filePath = path.join(templatesDir(), role, name);
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw err;
  }
}

function readSharedFile(name: string): string {
  const filePath = path.join(templatesDir(), '_shared', name);
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw err;
  }
}

function loadOverride(workspaceId: string, role: BriefingRole): RoleOverrideRow | null {
  return (
    queryOne<RoleOverrideRow>(
      `SELECT soul_md, agents_md, identity_md
         FROM agent_role_overrides
        WHERE workspace_id = ? AND role = ?
        LIMIT 1`,
      [workspaceId, role],
    ) ?? null
  );
}

function buildIdentityPreamble(input: BuildBriefingInput): string {
  return (
    `Your agent_id is: ${input.agent_id}\n` +
    `Your gateway_agent_id is: ${input.gateway_agent_id}\n\n`
  );
}

function buildRoleSection(input: BuildBriefingInput): string {
  const override = loadOverride(input.workspace_id, input.role);
  const soul = override?.soul_md ?? readTemplateFile(input.role, 'SOUL.md');
  const agents = override?.agents_md ?? readTemplateFile(input.role, 'AGENTS.md');
  const identity = override?.identity_md ?? readTemplateFile(input.role, 'IDENTITY.md');

  const sections: string[] = [];
  if (soul.trim()) sections.push(soul.trim());
  if (agents.trim()) sections.push(agents.trim());
  if (identity.trim()) sections.push(identity.trim());
  return sections.join('\n\n---\n\n');
}

function buildNotetakerAddendum(input: BuildBriefingInput): string {
  const body = readSharedFile('notetaker.md').trim();
  if (!body) return '';
  // Inject the run_group_id literally so the agent doesn't have to
  // mint its own — it copies this verbatim into take_note calls.
  return (
    body +
    '\n\n' +
    `**For this dispatch:** use \`run_group_id: "${input.run_group_id}"\` ` +
    `and \`scope_key: "${input.scope_key}"\` in every \`take_note\` call.`
  );
}

/**
 * Phase J2: when the briefing is going to a workspace PM's per-task
 * coord session, surface the active-subagent manifest from
 * `mc_sessions` so the PM (post-compaction or cold-start) can recover
 * orchestration state without remembering it.
 *
 * Returns empty string when:
 *  - no `task_id` in the briefing input (not a per-task coord briefing)
 *  - no active subagents for the task (nothing to surface)
 *
 * The manifest is informational — the PM uses it to decide whether to
 * spawn more subagents, accept results, or escalate. Authoritative
 * state lives in mc_sessions; the PM looks it up rather than
 * remembering.
 */
function buildActiveSubagentManifest(input: BuildBriefingInput): string {
  if (!input.task_id) return '';
  interface Row {
    scope_key: string;
    role: string;
    attempt: number;
    status: string;
    last_used_at: string;
    created_at: string;
    run_id: string | null;
  }
  const rows = queryAll<Row>(
    `SELECT scope_key, role, attempt, status, last_used_at, created_at, run_id
       FROM mc_sessions
      WHERE task_id = ?
        AND scope_type = 'task_role'
        AND status IN ('active', 'idle')
      ORDER BY created_at ASC`,
    [input.task_id],
  );
  if (rows.length === 0) return '';
  const lines = rows.map((r) => {
    const runFragment = r.run_id ? ` (run ${r.run_id.slice(0, 12)})` : '';
    const startedFragment = r.created_at ? `, started ${r.created_at}` : '';
    const lastFragment = r.last_used_at ? `, last activity ${r.last_used_at}` : '';
    return (
      `- **${r.role}** attempt ${r.attempt}${runFragment} — status=${r.status}` +
      `${startedFragment}${lastFragment}\n  scope_key: \`${r.scope_key}\``
    );
  });
  return [
    '**Active subagents for this task:**',
    '',
    ...lines,
    '',
    "Look up current notes via `read_notes(task_id=…)`. Don't try to",
    'remember any of this — re-read the manifest each time the briefing',
    'rolls in.',
  ].join('\n');
}

function buildResumeHint(input: BuildBriefingInput): string {
  if (!input.is_resume) return '';
  return (
    `\n\n_Note: this session has prior trajectory under the same scope key. ` +
    `Recent turns are above; you may build on them. Call \`read_notes\` to ` +
    `refresh anything you've forgotten._`
  );
}

/**
 * Build the dispatch briefing. Synchronous — file reads are fast and
 * the call site is already inside an async dispatch handler.
 *
 * Resume optimization: when `is_resume=true`, the gateway session
 * already absorbed the identity preamble + role section + notetaker
 * addendum on the first dispatch under this scope key. Re-sending
 * them on every turn just inflates the input prompt by 3–10K tokens
 * for a long-lived agent like the PM. We skip the static blocks and
 * send only dynamic content (active-subagent manifest, trigger body,
 * resume hint). The agent can re-read its own SOUL/AGENTS via the
 * read tool if compaction ever drops the early turn.
 */
export function buildBriefing(input: BuildBriefingInput): string {
  const parts: string[] = [];

  if (!input.is_resume) {
    parts.push(buildIdentityPreamble(input));

    const roleSection = buildRoleSection(input);
    if (roleSection) {
      parts.push(`# Role: ${input.role}\n\n${roleSection}`);
    }

    const notetaker = buildNotetakerAddendum(input);
    if (notetaker) {
      parts.push(`---\n\n${notetaker}`);
    }
  }

  // Phase J2: active-subagent manifest precedes the trigger body so
  // the PM sees the orchestration state before it reads what MC is
  // asking it to do next. Always included — it's dynamic and
  // authoritative state the agent shouldn't try to remember.
  const manifest = buildActiveSubagentManifest(input);
  if (manifest) {
    parts.push(`---\n\n${manifest}`);
  }

  if (input.trigger_body && input.trigger_body.trim()) {
    parts.push(`---\n\n${input.trigger_body.trim()}`);
  }

  const resumeHint = buildResumeHint(input);
  if (resumeHint) {
    parts.push(resumeHint.trim());
  }

  return parts.join('\n\n');
}

/**
 * Convenience for dispatchers that want to know how big the briefing
 * is before sending — useful for the briefing-length p95 metric.
 */
export function briefingByteLength(input: BuildBriefingInput): number {
  return Buffer.byteLength(buildBriefing(input), 'utf8');
}
