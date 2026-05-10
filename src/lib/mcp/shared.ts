/**
 * Shared helpers used across MCP tool group files.
 *
 * Pulled out of the legacy `tools.ts` / `roadmap-tools.ts` monoliths during
 * the group split (PR 1 of the MCP surface refactor). Behavior is unchanged
 * — these are verbatim relocations of the helpers each group needed.
 */

import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { queryOne } from '@/lib/db';
import { AuthzError } from '@/lib/authz/agent-task';
import { authzErrorToToolResult, internalErrorToToolResult } from './errors';
import { logMcpToolCall } from './debug';
import { PmProposalValidationError } from '@/lib/db/pm-proposals';
import {
  NOTE_KINDS,
  parseAttachedFiles,
  parsePmProposalIds,
  type AgentNote,
  type NoteKind,
} from '@/lib/db/agent-notes';

// ─── shared zod fragments ────────────────────────────────────────────

export const agentIdArg = z
  .string()
  .min(1)
  .describe("The calling agent's MC agent_id (see whoami)");

export const taskIdArg = z
  .string()
  .min(1)
  .describe('Task UUID');

// ─── result helpers ──────────────────────────────────────────────────

export function textResult(text: string, structured?: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: 'text', text }],
    ...(structured ? { structuredContent: structured } : {}),
  };
}

export function errorResult(message: string, code: string, extra: Record<string, unknown> = {}): CallToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: message }],
    structuredContent: { error: code, message, ...extra },
  };
}

// MCP structuredContent must be a record (object), never an array.
// Arrays are wrapped as { data: [...] } so the protocol contract holds.
export function toStructured(result: unknown): Record<string, unknown> {
  if (Array.isArray(result)) return { data: result };
  if (result !== null && typeof result === 'object') return result as Record<string, unknown>;
  return { value: result };
}

export function safeWrap<T>(fn: () => T): CallToolResult {
  try {
    const result = fn();
    return textResult(JSON.stringify(result, null, 2), toStructured(result));
  } catch (err) {
    if (err instanceof PmProposalValidationError) {
      return errorResult(err.message, 'validation_failed', { hints: err.hints });
    }
    const msg = err instanceof Error ? err.message : String(err);
    return errorResult(msg, 'internal_error');
  }
}

export async function safeWrapAsync<T>(fn: () => Promise<T>): Promise<CallToolResult> {
  try {
    const result = await fn();
    return textResult(JSON.stringify(result, null, 2), toStructured(result));
  } catch (err) {
    if (err instanceof PmProposalValidationError) {
      return errorResult(err.message, 'validation_failed', { hints: err.hints });
    }
    const msg = err instanceof Error ? err.message : String(err);
    return errorResult(msg, 'internal_error');
  }
}

// ─── trace wrapper (core/work groups) ───────────────────────────────

/**
 * Wraps a tool handler to log, time, and catch AuthzError uniformly.
 * The handler returns a CallToolResult or its contents; AuthzError is
 * mapped to a structured tool-error result rather than propagated as a
 * JSON-RPC protocol error.
 */
export function trace<TArgs extends { agent_id?: string; task_id?: string }>(
  toolName: string,
  handler: (args: TArgs) => Promise<CallToolResult> | CallToolResult,
) {
  return async (args: TArgs): Promise<CallToolResult> => {
    const started = Date.now();
    try {
      const result = await handler(args);
      logMcpToolCall({
        toolName,
        agentId: args.agent_id ?? null,
        taskId: args.task_id ?? null,
        ok: !result.isError,
        durationMs: Date.now() - started,
        error: result.isError ? extractErrorMessage(result) : undefined,
      });
      return result;
    } catch (err) {
      const durationMs = Date.now() - started;
      if (err instanceof AuthzError) {
        logMcpToolCall({
          toolName,
          agentId: args.agent_id ?? null,
          taskId: args.task_id ?? null,
          ok: false,
          durationMs,
          error: `authz:${err.code}`,
        });
        return authzErrorToToolResult(err);
      }
      logMcpToolCall({
        toolName,
        agentId: args.agent_id ?? null,
        taskId: args.task_id ?? null,
        ok: false,
        durationMs,
        error: err instanceof Error ? err.message : String(err),
      });
      return internalErrorToToolResult(err);
    }
  };
}

export function extractErrorMessage(result: CallToolResult): string {
  const sc = result.structuredContent;
  if (sc && typeof sc === 'object') {
    const obj = sc as Record<string, unknown>;
    if (typeof obj.message === 'string' && obj.message) return obj.message;
    if (typeof obj.error === 'string' && obj.error) return obj.error;
  }
  const first = result.content?.[0];
  if (first && first.type === 'text' && first.text) return first.text;
  return 'tool returned isError';
}

/**
 * Resolve the workspace_id for the calling agent. Used by tools whose
 * scope is workspace-bound (notes spine, etc.). Strict — refuses
 * gateway_agent_id on principle: callers must pass the MC UUID, which
 * matches one row unambiguously per spec §1.4 (post-migration the
 * runner is the only org-wide gateway id; non-PM agents have NULL).
 *
 * Throws AuthzError on miss so the trace wrapper produces a clean
 * error result.
 */
export function deriveWorkspaceFromAgent(agentId: string): string {
  const row = queryOne<{ workspace_id: string }>(
    `SELECT workspace_id FROM agents WHERE id = ? LIMIT 1`,
    [agentId],
  );
  if (row) return row.workspace_id;
  throw new AuthzError('agent_not_found', `agent ${agentId} not found`);
}

// ─── notes spine helpers (shared by core take/read + work consume/archive) ───

// Single source of truth: NOTE_KINDS from the DB module. The Zod enum
// picks up new kinds (e.g. audit_manifest / audit_proposal /
// audit_synthesis) automatically — no schema duplication.
export const noteKindArg = z
  .enum(NOTE_KINDS as readonly [NoteKind, ...NoteKind[]])
  .describe('What kind of note this is. See agent-templates/_shared/notetaker.md for guidance.');

export const noteImportanceArg = z
  .union([z.literal(0), z.literal(1), z.literal(2)])
  .describe('0 = low (default), 1 = normal, 2 = high (PM Chat surfaces this in real time).');

export function noteToPayload(note: AgentNote): Record<string, unknown> {
  return {
    id: note.id,
    workspace_id: note.workspace_id,
    agent_id: note.agent_id,
    task_id: note.task_id,
    initiative_id: note.initiative_id,
    scope_key: note.scope_key,
    role: note.role,
    run_group_id: note.run_group_id,
    kind: note.kind,
    audience: note.audience,
    body: note.body,
    attached_files: parseAttachedFiles(note),
    importance: note.importance,
    pm_proposal_ids: parsePmProposalIds(note),
    created_at: note.created_at,
  };
}

// ─── shared zod enums for roadmap tools ─────────────────────────────

export const KINDS = z.enum(['theme', 'milestone', 'epic', 'story']);
export const INIT_STATUSES = z.enum([
  'planned',
  'in_progress',
  'at_risk',
  'blocked',
  'done',
  'cancelled',
]);
export const DEP_KINDS = z.enum(['finish_to_start', 'start_to_start', 'blocking', 'informational']);

// Diff schema mirrors PmDiff shape exactly. We use z.discriminatedUnion so
// MCP clients get accurate error messages on bad payloads.
export const DiffSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('shift_initiative_target'),
    initiative_id: z.string().min(1),
    target_start: z.string().nullish(),
    target_end: z.string().nullish(),
    reason: z.string().optional(),
  }),
  z.object({
    kind: z.literal('add_availability'),
    agent_id: z.string().min(1),
    start: z.string().min(1),
    end: z.string().min(1),
    reason: z.string().optional(),
  }),
  z.object({
    kind: z.literal('set_initiative_status'),
    initiative_id: z.string().min(1),
    // Agent-proposed status updates intentionally exclude `done` and
    // `cancelled` — those terminal states are operator territory per
    // pm-soul.md ("What you NEVER do"). The full InitiativeStatus enum
    // (6 values) still lives on the column; the applier and
    // prev_status capture still handle all 6 because operator-driven
    // mutations and revert paths need them. We just refuse to let
    // the agent autonomously close work via this diff.
    status: z
      .enum(['planned', 'in_progress', 'at_risk', 'blocked'])
      .describe(
        "Status to set. Excludes 'done' and 'cancelled' — terminal states are operator territory; surface evidence via update_status_check + a task and let the operator flip to done themselves.",
      ),
  }),
  z.object({
    kind: z.literal('add_dependency'),
    initiative_id: z.string().min(1),
    depends_on_initiative_id: z.string().min(1),
    note: z.string().optional(),
  }),
  z.object({
    kind: z.literal('remove_dependency'),
    dependency_id: z.string().min(1),
  }),
  z.object({
    kind: z.literal('reorder_initiatives'),
    parent_id: z.string().nullable(),
    child_ids_in_order: z.array(z.string().min(1)).min(1),
  }),
  z.object({
    kind: z.literal('update_status_check'),
    initiative_id: z.string().min(1),
    status_check_md: z.string(),
  }),
  z.object({
    // Decompose flow: insert one child initiative under
    // `parent_initiative_id` on accept. `depends_on_initiative_ids` may
    // carry placeholder ids (`$0`, `$1`, …) that resolve post-insert
    // against other create_child_initiative diffs in the same proposal.
    kind: z.literal('create_child_initiative'),
    parent_initiative_id: z.string().min(1),
    title: z.string().min(1),
    description: z.string().nullish(),
    child_kind: z.enum(['milestone', 'epic', 'story']),
    complexity: z.enum(['S', 'M', 'L', 'XL']).nullish(),
    estimated_effort_hours: z.number().nullish(),
    sort_order: z.number().optional(),
    depends_on_initiative_ids: z.array(z.string().min(1)).optional(),
    placeholder_id: z.string().optional(),
  }),
  z.object({
    // Notes-intake flow: insert one draft task attached to an existing
    // initiative or to a placeholder ($N or `placeholder_id`) referring
    // to a create_child_initiative diff earlier in the same proposal.
    kind: z.literal('create_task_under_initiative'),
    initiative_id: z.string().min(1),
    title: z.string().min(1).max(500),
    description: z.string().nullish(),
    status_check_md: z.string().nullish(),
    // .min(1) so callers can't pass "" — that bypassed the
    // `if (c.assigned_agent_id)` validator and tripped the
    // tasks.assigned_agent_id FK at apply time (see PR #325).
    assigned_agent_id: z.string().min(1).nullish(),
    priority: z.enum(['low', 'normal', 'high']).optional(),
  }),
  z.object({
    // PM may close out a task that's already in a late workflow state
    // when concrete evidence (audit proposal, commit, PR) confirms it
    // shipped. The apply pass routes through `transitionTaskStatus` so
    // existing workflow gates still run.
    kind: z.literal('confirm_task_done'),
    task_id: z.string().min(1),
    evidence_md: z
      .string()
      .min(20)
      .describe(
        'REQUIRED. Human-readable explanation of why the task is done. Min 20 chars; PM should not ship one-word attestations.',
      ),
    audit_proposal_id: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Optional. Id of a previously-accepted PM audit proposal that confirms the work shipped.',
      ),
    commit_sha: z
      .string()
      .regex(/^[0-9a-f]{7,40}$/i)
      .optional()
      .describe('Optional. Hex commit sha (7-40 chars) verifying the work landed.'),
    pr_url: z.string().url().optional().describe('Optional. URL to the merged PR.'),
  }),
]);
