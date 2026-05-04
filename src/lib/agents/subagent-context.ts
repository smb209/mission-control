/**
 * Phase J: per-role default for openclaw subagent `context` parameter.
 *
 * `isolated` — clean child session, no parent transcript inherited.
 *              Cheap, naturally avoids parent-chatter leakage. Default
 *              for builder/tester/reviewer/researcher/writer/learner.
 * `fork`     — parent transcript forked into child for context. Useful
 *              for summarization-style tasks where the parent's chat
 *              IS the input. No worker role uses this by default;
 *              future summarizer roles will opt in via
 *              agent_role_overrides.subagent_context_mode='fork'.
 *
 * Resolution order:
 *   1. Per-spawn override (caller passes `context_mode` directly).
 *   2. Per-workspace per-role override
 *      (`agent_role_overrides.subagent_context_mode` for this workspace + role).
 *   3. Hard-coded role default below (the table).
 */

import { queryOne } from '@/lib/db';
import type { BriefingRole } from './briefing';

export type SubagentContextMode = 'isolated' | 'fork';

const ROLE_DEFAULT: Record<BriefingRole, SubagentContextMode> = {
  pm: 'isolated', // not actually used — PM dispatches don't go via subagents in J1/J2
  coordinator: 'isolated',
  builder: 'isolated',
  researcher: 'isolated',
  tester: 'isolated',
  reviewer: 'isolated',
  writer: 'isolated',
  learner: 'isolated',
};

interface OverrideRow {
  subagent_context_mode: string | null;
}

/**
 * Resolve which context mode to use for a (workspace, role) spawn.
 * Per-spawn arg wins; otherwise workspace-scoped override; otherwise
 * the hard-coded role default.
 */
export function resolveSubagentContextMode(input: {
  workspace_id: string;
  role: BriefingRole;
  override?: SubagentContextMode | null;
}): SubagentContextMode {
  if (input.override === 'isolated' || input.override === 'fork') {
    return input.override;
  }
  const row = queryOne<OverrideRow>(
    `SELECT subagent_context_mode
       FROM agent_role_overrides
      WHERE workspace_id = ? AND role = ?
      LIMIT 1`,
    [input.workspace_id, input.role],
  );
  if (row?.subagent_context_mode === 'isolated' || row?.subagent_context_mode === 'fork') {
    return row.subagent_context_mode;
  }
  return ROLE_DEFAULT[input.role];
}
