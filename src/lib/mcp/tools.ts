/**
 * sc-mission-control MCP tools.
 *
 * All 12 tools consolidated into one file. Each tool is a thin wrapper
 * around a service-layer function (src/lib/services/*) that handles
 * authorization, DB work, and broadcasts.
 *
 * Every state-changing tool takes `agent_id` as the required first arg —
 * the Phase 0 spike confirmed OpenClaw passes no identity to MCP servers,
 * so agents self-identify on every call. The `MC_API_TOKEN` bearer is the
 * trust boundary (same as the current HTTP API).
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { queryAll, queryOne, run } from '@/lib/db';
import { AuthzError, assertAgentActive } from '@/lib/authz/agent-task';
import { authzErrorToToolResult, internalErrorToToolResult } from './errors';
import { logMcpToolCall } from './debug';

import { registerDeliverable } from '@/lib/services/task-deliverables';
import { submitEvidence, ALL_EVIDENCE_GATES } from '@/lib/services/task-evidence';
import { logActivity } from '@/lib/services/task-activities';
import { transitionTaskStatus } from '@/lib/services/task-status';
import { failTask } from '@/lib/services/task-failure';
import { handleStageTransition, drainQueue } from '@/lib/workflow-engine';
import { saveTaskCheckpoint } from '@/lib/services/task-checkpoint';
import { sendAgentMail } from '@/lib/services/agent-mailbox';
import { saveKnowledge, searchKnowledge } from '@/lib/services/knowledge';
import { getUnreadMail } from '@/lib/mailbox';
import { getOpenClawClient } from '@/lib/openclaw/client';
import { spawnDelegationSubtask } from '@/lib/convoy';
import { internalDispatch } from '@/lib/internal-dispatch';
import { postPmChatMessage } from '@/lib/agents/pm-dispatch';
import {
  archiveNote as archiveNoteDb,
  createNote,
  getNote,
  listNotes,
  markNoteConsumed as markNoteConsumedDb,
  parseAttachedFiles,
  parseConsumedStages,
  AgentNoteValidationError,
  NOTE_BODY_MAX,
  type AgentNote,
  type NoteImportance,
  type NoteKind,
} from '@/lib/db/agent-notes';
import { broadcast } from '@/lib/events';
import type { Task } from '@/lib/types';

// Common shape: agent_id on every state-changing tool.
const agentIdArg = z
  .string()
  .min(1)
  .describe("The calling agent's MC agent_id (see whoami)");

const taskIdArg = z
  .string()
  .min(1)
  .describe('Task UUID');

/**
 * Wraps a tool handler to log, time, and catch AuthzError uniformly.
 * The handler returns a CallToolResult or its contents; AuthzError is
 * mapped to a structured tool-error result rather than propagated as a
 * JSON-RPC protocol error.
 */
function trace<TArgs extends { agent_id?: string; task_id?: string }>(
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

function extractErrorMessage(result: CallToolResult): string {
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

function textResult(text: string, structured?: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: 'text', text }],
    ...(structured ? { structuredContent: structured } : {}),
  };
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
function deriveWorkspaceFromAgent(agentId: string): string {
  const row = queryOne<{ workspace_id: string }>(
    `SELECT workspace_id FROM agents WHERE id = ? LIMIT 1`,
    [agentId],
  );
  if (row) return row.workspace_id;
  throw new AuthzError('agent_not_found', `agent ${agentId} not found`);
}

// ─── tool registrations ─────────────────────────────────────────────

export function registerAllTools(server: McpServer): void {
  // whoami ────────────────────────────────────────────────────────
  server.registerTool(
    'whoami',
    {
      title: 'Identify the calling agent',
      description:
        "Returns the calling agent's identity, assigned task ids, and the peer roster (gateway_id → MC agent_id). Call this once at session start to learn your own agent_id and peers.",
      inputSchema: {
        agent_id: z
          .string()
          .min(1)
          .describe(
            "Your agent identity — accepts either MC agent_id (UUID) or gateway_agent_id (e.g. 'mc-project-manager'). whoami is the bootstrap call, so either form works; other tools require the MC agent_id this returns.",
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    trace('whoami', async ({ agent_id }) => {
      // Multi-workspace gateway clones (#133) make `gateway_agent_id`
      // ambiguous on its own. Try UUID first; on miss, only fall back to
      // gateway_agent_id when it resolves to exactly one row. Otherwise
      // return a structured error listing the candidate workspaces so
      // the operator can re-dispatch with the correct UUID — silently
      // returning the first match would mint the wrong workspace_id and
      // break every subsequent MCP call with workspace_mismatch.
      type AgentRow = {
        id: string;
        name: string;
        role: string;
        workspace_id: string;
        gateway_agent_id: string | null;
        is_active: number | null;
      };
      let me = queryOne<AgentRow>(
        `SELECT id, name, role, workspace_id, gateway_agent_id, is_active
           FROM agents WHERE id = ? LIMIT 1`,
        [agent_id],
      );
      if (!me) {
        const byGateway = queryAll<AgentRow>(
          `SELECT id, name, role, workspace_id, gateway_agent_id, is_active
             FROM agents WHERE gateway_agent_id = ?`,
          [agent_id],
        );
        if (byGateway.length === 1) {
          me = byGateway[0];
        } else if (byGateway.length > 1) {
          const candidates = byGateway.map((r) => ({ id: r.id, workspace_id: r.workspace_id, name: r.name }));
          return {
            isError: true,
            content: [{
              type: 'text',
              text: `gateway_agent_id "${agent_id}" exists in ${byGateway.length} workspaces. Pass your MC agent_id (UUID) instead — the dispatch briefing embeds it as "Your agent_id is: …".`,
            }],
            structuredContent: { error: 'ambiguous_gateway_id', gateway_agent_id: agent_id, candidates },
          };
        }
      }
      if (!me) {
        return {
          isError: true,
          content: [{ type: 'text', text: `agent ${agent_id} not found (tried both id and gateway_agent_id)` }],
          structuredContent: { error: 'agent_not_found', agent_id },
        };
      }

      const tasks = queryAll<{ id: string; title: string; status: string }>(
        `SELECT id, title, status FROM tasks
          WHERE workspace_id = ?
            AND (assigned_agent_id = ?
              OR id IN (SELECT task_id FROM task_roles WHERE agent_id = ?))
            AND status NOT IN ('done', 'cancelled')
          ORDER BY updated_at DESC`,
        [me.workspace_id, me.id, me.id],
      );

      const peers = queryAll<{ id: string; gateway_agent_id: string; name: string; role: string }>(
        `SELECT id, gateway_agent_id, name, role FROM agents
          WHERE workspace_id = ?
            AND gateway_agent_id IS NOT NULL AND gateway_agent_id != ''
            AND id != ?`,
        [me.workspace_id, me.id],
      );
      const peerMap: Record<string, { id: string; name: string; role: string }> = {};
      for (const p of peers) {
        peerMap[p.gateway_agent_id] = { id: p.id, name: p.name, role: p.role };
      }

      const payload = {
        id: me.id,
        name: me.name,
        role: me.role,
        workspace_id: me.workspace_id,
        gateway_agent_id: me.gateway_agent_id,
        assigned_task_ids: tasks.map((t) => t.id),
        assigned_tasks: tasks,
        peers: peerMap,
      };
      return textResult(JSON.stringify(payload, null, 2), payload);
    }),
  );

  // get_workspace_context ─────────────────────────────────────────
  // Lets an in-flight agent re-read the workspace's "rules of the road"
  // markdown without re-dispatch. The same blob is prepended to every
  // task dispatch as a "## Workspace conventions" section, so this tool
  // is mostly useful when an agent forks a subtask and wants to keep
  // the conventions in scope, or for debugging what the operator wrote.
  server.registerTool(
    'get_workspace_context',
    {
      title: 'Get workspace conventions',
      description:
        "Returns the markdown 'rules of the road' the operator wrote for this workspace (repos, testing, git/PR rules, package manager, etc). Same content prepended to every task dispatch's prompt; call this when you need to re-read it mid-session or surface it to a delegated subagent.",
      inputSchema: {
        agent_id: z
          .string()
          .min(1)
          .describe(
            "Your MC agent_id (UUID) or gateway_agent_id. Either form works — looked up the same way as whoami.",
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    trace('get_workspace_context', async ({ agent_id }) => {
      // Same multi-workspace ambiguity guard as whoami — picking the
      // first row by gateway_agent_id would surface the wrong
      // workspace's context_md silently.
      let me = queryOne<{ workspace_id: string }>(
        `SELECT workspace_id FROM agents WHERE id = ? LIMIT 1`,
        [agent_id],
      );
      if (!me) {
        const byGateway = queryAll<{ id: string; workspace_id: string; name: string }>(
          `SELECT id, workspace_id, name FROM agents WHERE gateway_agent_id = ?`,
          [agent_id],
        );
        if (byGateway.length === 1) {
          me = { workspace_id: byGateway[0].workspace_id };
        } else if (byGateway.length > 1) {
          return {
            isError: true,
            content: [{
              type: 'text',
              text: `gateway_agent_id "${agent_id}" exists in ${byGateway.length} workspaces. Pass your MC agent_id (UUID) instead.`,
            }],
            structuredContent: {
              error: 'ambiguous_gateway_id',
              gateway_agent_id: agent_id,
              candidates: byGateway,
            },
          };
        }
      }
      if (!me) {
        return {
          isError: true,
          content: [{ type: 'text', text: `agent ${agent_id} not found` }],
          structuredContent: { error: 'agent_not_found', agent_id },
        };
      }
      const ws = queryOne<{ id: string; name: string; context_md: string | null }>(
        `SELECT id, name, context_md FROM workspaces WHERE id = ?`,
        [me.workspace_id],
      );
      const payload = {
        workspace_id: me.workspace_id,
        workspace_name: ws?.name ?? null,
        context_md: ws?.context_md ?? null,
        present: typeof ws?.context_md === 'string' && ws.context_md.trim().length > 0,
      };
      return textResult(JSON.stringify(payload, null, 2), payload);
    }),
  );

  // list_peers ────────────────────────────────────────────────────
  server.registerTool(
    'list_peers',
    {
      title: 'List peer agents in your workspace',
      description:
        'Returns the workspace peer roster (gateway_id → MC agent_id, name, role). Use this before send_mail or delegate when you need a recipient id.',
      inputSchema: { agent_id: agentIdArg },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    trace('list_peers', async ({ agent_id }) => {
      const me = queryOne<{ workspace_id: string }>(
        `SELECT workspace_id FROM agents WHERE id = ? LIMIT 1`,
        [agent_id],
      );
      if (!me) {
        return {
          isError: true,
          content: [{ type: 'text', text: `agent ${agent_id} not found` }],
          structuredContent: { error: 'agent_not_found', agent_id },
        };
      }
      const peers = queryAll<{
        id: string;
        gateway_agent_id: string | null;
        name: string;
        role: string;
      }>(
        `SELECT id, gateway_agent_id, name, role FROM agents
          WHERE workspace_id = ? AND id != ?
          ORDER BY role, name`,
        [me.workspace_id, agent_id],
      );
      return textResult(JSON.stringify({ peers }, null, 2), { peers });
    }),
  );

  // get_task ──────────────────────────────────────────────────────
  server.registerTool(
    'get_task',
    {
      title: 'Fetch a task by id',
      description:
        'Returns the task row (title, description, status, assigned agent, workspace, etc.). Use before taking action on a task so you can verify its current state.',
      inputSchema: { agent_id: agentIdArg, task_id: taskIdArg },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    trace('get_task', async ({ agent_id, task_id }) => {
      // Gate cross-workspace reads. Until this PR get_task accepted the
      // bearer alone, so any agent could enumerate task UUIDs from
      // other workspaces. We only enforce workspace match here (not the
      // stricter on-task membership) so coordinators can still inspect
      // peer subtasks they didn't directly assign — list_my_subtasks
      // already proves they own the parent.
      const callerWs = queryOne<{ workspace_id: string | null }>(
        'SELECT workspace_id FROM agents WHERE id = ?',
        [agent_id],
      );
      const taskWs = queryOne<{ workspace_id: string | null }>(
        'SELECT workspace_id FROM tasks WHERE id = ?',
        [task_id],
      );
      if (!callerWs) {
        throw new AuthzError('agent_not_found', `agent not found: ${agent_id}`, { agentId: agent_id, taskId: task_id });
      }
      if (!taskWs) {
        // Fall through — the existing 'task not found' branch below
        // will return the structured not_found result.
      } else if ((callerWs.workspace_id ?? 'default') !== (taskWs.workspace_id ?? 'default')) {
        throw new AuthzError(
          'workspace_mismatch',
          `agent ${agent_id} cannot read task ${task_id} (different workspace)`,
          { agentId: agent_id, taskId: task_id, action: 'read' },
        );
      }
      const task = queryOne<Record<string, unknown>>(
        `SELECT t.*,
           aa.name as assigned_agent_name,
           aa.avatar_emoji as assigned_agent_emoji
          FROM tasks t
          LEFT JOIN agents aa ON t.assigned_agent_id = aa.id
          WHERE t.id = ?`,
        [task_id],
      );
      if (!task) {
        return {
          isError: true,
          content: [{ type: 'text', text: `task ${task_id} not found` }],
          structuredContent: { error: 'task_not_found', task_id },
        };
      }

      // If this task is a delegation subtask with SLO fields, surface the
      // Delegation Contract alongside the core task row so the peer can
      // re-read its obligation without parsing its dispatch brief.
      if (task.convoy_id) {
        const sub = queryOne<{
          id: string;
          slice: string | null;
          expected_deliverables: string | null;
          acceptance_criteria: string | null;
          expected_duration_minutes: number | null;
          checkin_interval_minutes: number | null;
          dispatched_at: string | null;
          due_at: string | null;
        }>(
          `SELECT id, slice, expected_deliverables, acceptance_criteria,
                  expected_duration_minutes, checkin_interval_minutes,
                  dispatched_at, due_at
             FROM convoy_subtasks WHERE task_id = ?`,
          [task_id],
        );
        if (sub && sub.expected_duration_minutes != null) {
          const parseJson = (s: string | null) => { if (!s) return null; try { return JSON.parse(s); } catch { return null; } };
          (task as Record<string, unknown>).delegation_contract = {
            subtask_id: sub.id,
            slice: sub.slice,
            expected_deliverables: parseJson(sub.expected_deliverables),
            acceptance_criteria: parseJson(sub.acceptance_criteria),
            expected_duration_minutes: sub.expected_duration_minutes,
            checkin_interval_minutes: sub.checkin_interval_minutes,
            dispatched_at: sub.dispatched_at,
            due_at: sub.due_at,
          };
        }
      }

      return textResult(JSON.stringify(task, null, 2), task);
    }),
  );

  // fetch_mail ────────────────────────────────────────────────────
  server.registerTool(
    'fetch_mail',
    {
      title: "Fetch this agent's unread mail",
      description: 'Returns unread mail messages sent to the calling agent.',
      inputSchema: { agent_id: agentIdArg },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    trace('fetch_mail', async ({ agent_id }) => {
      // Enforce existence + active flag before reading — the bearer gates
      // the transport but the agent_id is self-asserted, so someone with
      // the token can otherwise peek at any agent's mailbox by enumerating
      // UUIDs. Authz throws AuthzError which trace maps to isError.
      assertAgentActive(agent_id);
      const messages = getUnreadMail(agent_id);
      return textResult(JSON.stringify({ messages }, null, 2), { messages });
    }),
  );

  // register_deliverable ──────────────────────────────────────────
  server.registerTool(
    'register_deliverable',
    {
      title: 'Register a task deliverable (file, url, or artifact)',
      description:
        'Records that the agent produced a deliverable for the task. Required before transitioning the task out of a build stage — the evidence gate rejects status transitions without at least one deliverable.',
      inputSchema: {
        agent_id: agentIdArg,
        task_id: taskIdArg,
        title: z.string().min(1),
        deliverable_type: z.enum(['file', 'url', 'artifact']),
        path: z.string().optional(),
        description: z.string().optional(),
        spec_deliverable_id: z
          .string()
          .max(200)
          .optional()
          .describe("When fulfilling a planning-spec deliverable, the spec's id"),
      },
      annotations: { destructiveHint: true, openWorldHint: false },
    },
    trace('register_deliverable', async (args) => {
      const result = registerDeliverable({
        taskId: args.task_id,
        actingAgentId: args.agent_id,
        deliverableType: args.deliverable_type,
        title: args.title,
        path: args.path,
        description: args.description,
        specDeliverableId: args.spec_deliverable_id,
      });
      // Keep the coordinator's list_my_subtasks view cheap — bump the
      // counter on the convoy_subtasks row if this task is a delegated
      // subtask. No-op when the task isn't in any convoy.
      run(
        `UPDATE convoy_subtasks
            SET deliverables_registered_count = COALESCE(deliverables_registered_count, 0) + 1
          WHERE task_id = ?`,
        [args.task_id],
      );
      // Read post-write count back so the agent's mental model can't drift
      // from reality. A confidently-wrong "I've registered 2 deliverables"
      // status report (when the DB has 8) erodes coordinator trust — the
      // agent should reconcile against this number on every write.
      const totals = queryOne<{ output_count: number; total_count: number }>(
        `SELECT
           SUM(CASE WHEN role = 'output' THEN 1 ELSE 0 END) as output_count,
           COUNT(*) as total_count
         FROM task_deliverables WHERE task_id = ?`,
        [args.task_id],
      );
      const summary = {
        deliverable: result.deliverable,
        file_exists: result.fileExists,
        normalized_path: result.normalizedPath,
        // Authoritative post-write counts on this task — use these to
        // self-check before reporting status. The "output" count is what
        // the evidence gate reads.
        total_output_deliverables_on_task: Number(totals?.output_count ?? 0),
        total_deliverables_on_task: Number(totals?.total_count ?? 0),
      };
      return textResult(JSON.stringify(summary, null, 2), summary);
    }),
  );

  // submit_evidence ────────────────────────────────────────────────
  server.registerTool(
    'submit_evidence',
    {
      title: 'Submit raw command output as evidence for a stage gate',
      description:
        'Run-and-forward verification: paste the EXACT command you ran plus its raw stdout/stderr/exit_code. The server parses pass/fail (TS errors, ESLint counts, test totals, artifact presence). Never self-report a boolean — submit the output. Required to transition into testing/review on tasks that carry a prescribed gate set.',
      inputSchema: {
        agent_id: agentIdArg,
        task_id: taskIdArg,
        gate: z.enum(ALL_EVIDENCE_GATES as [string, ...string[]]),
        command: z.string().min(1).describe('Exact command line you ran'),
        stdout: z.string().default('').describe('Raw stdout, untrimmed'),
        stderr: z.string().default(''),
        exit_code: z.number().int(),
        duration_ms: z.number().int().optional(),
        diff_sha: z.string().optional().describe('git rev-parse HEAD at run time'),
        artifact_paths: z
          .array(z.string())
          .optional()
          .describe('Required for runtime_ui: screenshot/trace/HAR paths'),
      },
      annotations: { destructiveHint: false, openWorldHint: false },
    },
    trace('submit_evidence', async (args) => {
      const result = submitEvidence({
        taskId: args.task_id,
        actingAgentId: args.agent_id,
        gate: args.gate as Parameters<typeof submitEvidence>[0]['gate'],
        command: args.command,
        stdout: args.stdout,
        stderr: args.stderr,
        exitCode: args.exit_code,
        durationMs: args.duration_ms,
        diffSha: args.diff_sha,
        artifactPaths: args.artifact_paths,
      });
      const summary = {
        evidence_id: result.evidenceId,
        gate: args.gate,
        passed: result.passed,
        parsed_summary: result.parsedSummary,
        reject_reason: result.rejectReason,
      };
      return textResult(JSON.stringify(summary, null, 2), summary);
    }),
  );

  // log_activity ──────────────────────────────────────────────────
  server.registerTool(
    'log_activity',
    {
      title: 'Log an activity against a task',
      description:
        "Append a progress note. Required before status transitions — the evidence gate rejects transitions without at least one activity. Use activity_type='completed' for your final message before transitioning.",
      inputSchema: {
        agent_id: agentIdArg,
        task_id: taskIdArg,
        activity_type: z.enum([
          'spawned',
          'updated',
          'completed',
          'file_created',
          'status_changed',
        ]),
        message: z.string().min(1).max(5000),
        metadata: z.record(z.string(), z.unknown()).optional(),
      },
      annotations: { destructiveHint: true, openWorldHint: false },
    },
    trace('log_activity', async (args) => {
      const activity = logActivity({
        taskId: args.task_id,
        actingAgentId: args.agent_id,
        activityType: args.activity_type,
        message: args.message,
        metadata: args.metadata ? JSON.stringify(args.metadata) : undefined,
      });
      // Read post-write counts back. The "evidence" count matches what
      // the evidence gate inspects (completed / file_created / updated)
      // so the agent can see whether it's met the bar without guessing.
      const totals = queryOne<{ total_count: number; evidence_count: number }>(
        `SELECT
           COUNT(*) as total_count,
           SUM(CASE WHEN activity_type IN ('completed','file_created','updated') THEN 1 ELSE 0 END) as evidence_count
         FROM task_activities WHERE task_id = ?`,
        [args.task_id],
      );
      const summary = {
        activity,
        total_activities_on_task: Number(totals?.total_count ?? 0),
        evidence_qualifying_activities_on_task: Number(totals?.evidence_count ?? 0),
      };
      return textResult(JSON.stringify(summary, null, 2), summary);
    }),
  );

  // ── Notes spine (scope-keyed sessions Phase A) ───────────────────
  // take_note / read_notes / mark_note_consumed / archive_note
  // See specs/scope-keyed-sessions.md §3 for the full design.
  // No agents call these yet — this is the surface area; role-souls
  // start using it in Phase C when the notetaker addendum lands.

  const noteKindArg = z
    .enum(['discovery', 'blocker', 'uncertainty', 'decision', 'observation', 'question', 'breadcrumb'])
    .describe('What kind of note this is. See agent-templates/_shared/notetaker.md for guidance.');

  const noteImportanceArg = z
    .union([z.literal(0), z.literal(1), z.literal(2)])
    .describe('0 = low (default), 1 = normal, 2 = high (PM Chat surfaces this in real time).');

  function noteToPayload(note: AgentNote): Record<string, unknown> {
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
      created_at: note.created_at,
    };
  }

  // take_note ──────────────────────────────────────────────────────
  server.registerTool(
    'take_note',
    {
      title: 'Record an observation, decision, blocker, or breadcrumb',
      description:
        "Cheap, spammable observability primitive. Use liberally — every meaningful moment of your work should leave a trail here. NOT evidence: notes don't unblock status transitions (use log_activity for that). Set importance=2 only for genuinely high-stakes findings (security issues, broken assumptions); the PM sees those in PM Chat in real time.",
      inputSchema: {
        agent_id: agentIdArg,
        kind: noteKindArg,
        body: z
          .string()
          .min(1)
          .max(NOTE_BODY_MAX)
          .describe('Concrete > aspirational. One thought per note. Reference file paths in attached_files.'),
        scope_key: z
          .string()
          .min(1)
          .describe('The openclaw sessionKey you are running under. Take this verbatim from your dispatch briefing.'),
        role: z
          .string()
          .min(1)
          .describe("Your role-of-the-moment ('builder', 'tester', 'pm', 'researcher', etc.). From the briefing."),
        run_group_id: z
          .string()
          .min(1)
          .describe('UUID minted at session start that groups all notes from one run/stage. From the briefing.'),
        task_id: z.string().optional().describe('Set when the note relates to a specific task.'),
        initiative_id: z
          .string()
          .optional()
          .describe('Set when the note relates to an initiative directly (no task scope).'),
        audience: z
          .string()
          .optional()
          .describe("Who this note is for: 'pm', 'reviewer', 'next-stage', 'tester', etc. Omit for anyone."),
        attached_files: z
          .array(z.string())
          .optional()
          .describe('File paths the note references. Helps the next session navigate without re-reading.'),
        importance: noteImportanceArg.optional(),
      },
      annotations: { destructiveHint: false, openWorldHint: false },
    },
    trace('take_note', async (args) => {
      try {
        const note = createNote({
          workspace_id: deriveWorkspaceFromAgent(args.agent_id),
          agent_id: args.agent_id,
          task_id: args.task_id ?? null,
          initiative_id: args.initiative_id ?? null,
          scope_key: args.scope_key,
          role: args.role,
          run_group_id: args.run_group_id,
          kind: args.kind as NoteKind,
          audience: args.audience ?? null,
          body: args.body,
          attached_files: args.attached_files ?? null,
          importance: (args.importance ?? 0) as NoteImportance,
        });

        const payload = noteToPayload(note);
        broadcast({ type: 'agent_note_created', payload });

        // D5: importance=2 notes auto-post to PM Chat so the operator
        // sees high-stakes findings in their primary chat surface in
        // real time. Best-effort: failures don't fail the take_note.
        if (note.importance === 2) {
          try {
            const fileTrail = parseAttachedFiles(note);
            const filesLine = fileTrail.length > 0
              ? `\n\nFiles: ${fileTrail.map((f) => `\`${f}\``).join(', ')}`
              : '';
            postPmChatMessage({
              workspace_id: note.workspace_id,
              role: 'assistant',
              content:
                `**🚩 ${note.kind} (from ${note.role})**\n\n${note.body}${filesLine}`,
            });
          } catch (chatErr) {
            console.warn(
              '[take_note] importance=2 PM Chat post failed:',
              (chatErr as Error).message,
            );
          }
        }

        return textResult(JSON.stringify(payload, null, 2), payload);
      } catch (err) {
        if (err instanceof AgentNoteValidationError) {
          return {
            isError: true,
            content: [{ type: 'text', text: err.message }],
            structuredContent: { error: 'validation', message: err.message },
          };
        }
        throw err;
      }
    }),
  );

  // read_notes ─────────────────────────────────────────────────────
  server.registerTool(
    'read_notes',
    {
      title: 'List notes visible to the calling agent',
      description:
        "Query notes — by task, by initiative, by audience, by kind. Use this BEFORE committing to an approach: scan for prior decisions, blockers, and breadcrumbs from earlier stages. Returns up to 50 by default (capped at 200). Default order is created_at ASC so prior context comes first.",
      inputSchema: {
        agent_id: agentIdArg,
        task_id: z.string().optional(),
        initiative_id: z.string().optional(),
        audience: z
          .string()
          .optional()
          .describe("Restrict to notes addressed to this audience or to anyone (NULL audience). Common values: 'pm', 'next-stage', 'reviewer', or your own role."),
        kinds: z.array(noteKindArg).optional().describe('Restrict to specific kinds.'),
        not_consumed_by_stage: z
          .string()
          .optional()
          .describe('Skip notes already marked consumed by this stage slug. Useful when filtering "what is new for me".'),
        scope_key: z.string().optional(),
        run_group_id: z.string().optional(),
        min_importance: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional(),
        include_archived: z.boolean().optional(),
        limit: z.number().int().positive().max(200).optional(),
        order: z.enum(['asc', 'desc']).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    trace('read_notes', async (args) => {
      const workspaceId = deriveWorkspaceFromAgent(args.agent_id);
      const notes = listNotes({
        workspace_id: workspaceId,
        task_id: args.task_id,
        initiative_id: args.initiative_id,
        audience: args.audience,
        kinds: args.kinds as ReadonlyArray<NoteKind> | undefined,
        not_consumed_by_stage: args.not_consumed_by_stage,
        scope_key: args.scope_key,
        run_group_id: args.run_group_id,
        min_importance: args.min_importance as NoteImportance | undefined,
        include_archived: args.include_archived,
        limit: args.limit,
        order: args.order,
      });
      const payload = { count: notes.length, notes: notes.map(noteToPayload) };
      return textResult(JSON.stringify(payload, null, 2), payload);
    }),
  );

  // mark_note_consumed ─────────────────────────────────────────────
  server.registerTool(
    'mark_note_consumed',
    {
      title: 'Record that this stage has read a note',
      description:
        "Idempotent. Call this when you've actually processed a note from a prior stage so the next briefing for this stage doesn't re-show it. Pass your stage slug (your current role) — e.g., 'tester' if you're the tester reading a builder breadcrumb.",
      inputSchema: {
        agent_id: agentIdArg,
        note_id: z.string().min(1),
        stage_slug: z
          .string()
          .min(1)
          .describe("Your stage slug (typically your current role). Idempotent — duplicate calls are no-ops."),
      },
      annotations: { destructiveHint: false, openWorldHint: false },
    },
    trace('mark_note_consumed', async (args) => {
      const note = markNoteConsumedDb(args.note_id, args.stage_slug);
      if (!note) {
        return {
          isError: true,
          content: [{ type: 'text', text: `note ${args.note_id} not found` }],
          structuredContent: { error: 'not_found', note_id: args.note_id },
        };
      }
      const payload = noteToPayload(note);
      broadcast({
        type: 'agent_note_consumed',
        payload: {
          note_id: note.id,
          workspace_id: note.workspace_id,
          stage_slug: args.stage_slug,
          consumed_by_stages: parseConsumedStages(note),
        },
      });
      return textResult(JSON.stringify(payload, null, 2), payload);
    }),
  );

  // archive_note ───────────────────────────────────────────────────
  server.registerTool(
    'archive_note',
    {
      title: 'Soft-archive a note',
      description:
        "Hide a note from future briefings and the live feed. The row stays for audit. Use when a blocker is resolved, an uncertainty clarified, or an observation has gone stale. Idempotent — already-archived notes are no-ops.",
      inputSchema: {
        agent_id: agentIdArg,
        note_id: z.string().min(1),
        reason: z.string().max(500).optional(),
      },
      annotations: { destructiveHint: false, openWorldHint: false },
    },
    trace('archive_note', async (args) => {
      const existing = getNote(args.note_id);
      if (!existing) {
        return {
          isError: true,
          content: [{ type: 'text', text: `note ${args.note_id} not found` }],
          structuredContent: { error: 'not_found', note_id: args.note_id },
        };
      }
      const note = archiveNoteDb(args.note_id, args.reason ?? null);
      if (!note) {
        return {
          isError: true,
          content: [{ type: 'text', text: `note ${args.note_id} archive failed` }],
          structuredContent: { error: 'archive_failed', note_id: args.note_id },
        };
      }
      const payload = noteToPayload(note);
      broadcast({
        type: 'agent_note_archived',
        payload: {
          note_id: note.id,
          workspace_id: note.workspace_id,
          reason: note.archived_reason,
          archived_at: note.archived_at,
        },
      });
      return textResult(JSON.stringify(payload, null, 2), payload);
    }),
  );

  // update_task_status ────────────────────────────────────────────
  server.registerTool(
    'update_task_status',
    {
      title: 'Transition a task to a new status',
      description:
        "Move the task to the next workflow stage (e.g. in_progress → review). The evidence gate rejects forward transitions without at least one deliverable + one activity. Use `next_status` from the dispatch message — don't guess. NOTE: MCP-driven status changes do NOT trigger automatic workflow orchestration (convoy progression, next-stage dispatch). The operator will handle those until a follow-up PR wires it up.",
      inputSchema: {
        agent_id: agentIdArg,
        task_id: taskIdArg,
        status: z.enum([
          'pending_dispatch',
          'planning',
          'inbox',
          'assigned',
          'in_progress',
          'convoy_active',
          'testing',
          'review',
          'verification',
          'done',
          'cancelled',
        ]),
        status_reason: z
          .string()
          .max(2000)
          .optional()
          .describe('Required when failing backwards from a quality stage.'),
      },
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    trace('update_task_status', async (args) => {
      const result = transitionTaskStatus({
        taskId: args.task_id,
        actingAgentId: args.agent_id,
        newStatus: args.status,
        statusReason: args.status_reason,
      });
      if (result.ok) {
        console.log(
          `[update_task_status] task=${args.task_id} ${result.previousStatus}→${args.status} by agent=${args.agent_id}`,
        );

        // Drive workflow orchestration for forward moves into role-owned
        // stages. Without this, an agent can flip status to e.g. "testing"
        // but the Tester is never dispatched, leaving the task stuck with
        // the previous agent still assigned — which agent-health then
        // nudges every 16 min (see task 79e311a2 postmortem).
        const ORCHESTRATED_STAGES = new Set([
          'assigned',
          'in_progress',
          'testing',
          'review',
          'verification',
        ]);
        if (
          ORCHESTRATED_STAGES.has(args.status) &&
          args.status !== result.previousStatus
        ) {
          try {
            const stageResult = await handleStageTransition(args.task_id, args.status, {
              previousStatus: result.previousStatus,
            });
            if (stageResult.handedOff) {
              console.log(
                `[update_task_status] task=${args.task_id} handoff: ${args.status} → ${stageResult.newAgentName} (${stageResult.newAgentId})`,
              );
            } else if (!stageResult.success) {
              console.warn(
                `[update_task_status] task=${args.task_id} stage transition blocked for status=${args.status}: ${stageResult.error || 'unknown'}`,
              );
            } else {
              console.log(
                `[update_task_status] task=${args.task_id} status=${args.status} entered with no handoff (queue stage or no workflow template)`,
              );
              // Queue stage — attempt to drain in case the next stage is free.
              const t = queryOne<{ workspace_id: string }>(
                'SELECT workspace_id FROM tasks WHERE id = ?',
                [args.task_id],
              );
              if (t) {
                drainQueue(args.task_id, t.workspace_id).catch((err) => {
                  console.warn(
                    `[update_task_status] task=${args.task_id} drainQueue failed: ${(err as Error).message}`,
                  );
                });
              }
            }
          } catch (err) {
            console.error(
              `[update_task_status] task=${args.task_id} handleStageTransition threw: ${(err as Error).message}`,
            );
          }
        }

        // If the task just moved to a delivery state (review/testing/
        // verification) AND it's a delegation subtask, mail the
        // coordinator so they can call accept_subtask / reject_subtask
        // without polling list_my_subtasks. Silent if the task isn't in
        // a convoy or the coordinator assignment is missing.
        if (['review', 'testing', 'verification'].includes(args.status)) {
          const ctx = queryOne<{ subtask_id: string; slice: string | null; parent_task_id: string; coordinator_id: string | null; parent_title: string; convoy_id: string }>(
            `SELECT cs.id AS subtask_id, cs.slice AS slice,
                    c.parent_task_id AS parent_task_id,
                    c.id AS convoy_id,
                    p.title AS parent_title,
                    p.assigned_agent_id AS coordinator_id
               FROM convoy_subtasks cs
               JOIN convoys c ON c.id = cs.convoy_id
               JOIN tasks p ON p.id = c.parent_task_id
              WHERE cs.task_id = ?`,
            [args.task_id],
          );
          if (ctx?.coordinator_id) {
            sendAgentMail({
              fromAgentId: args.agent_id,
              toAgentId: ctx.coordinator_id,
              subject: `DELEGATION: ready_for_review — ${ctx.slice ?? ctx.parent_title}`,
              body: `Subtask ${ctx.subtask_id} is ready for review (status=${args.status}).\n\nCall accept_subtask({subtask_id: "${ctx.subtask_id}"}) if it meets the acceptance criteria, or reject_subtask with a reason to bounce it back.`,
              taskId: ctx.parent_task_id,
              convoyId: ctx.convoy_id,
              push: true,
            }).catch((err: unknown) => {
              console.warn('[update_task_status] coordinator notify failed:', (err as Error).message);
            });
          }
        }
      }
      if (!result.ok) {
        return {
          isError: true,
          content: [{ type: 'text', text: result.error }],
          structuredContent: {
            error: result.code,
            message: result.error,
            ...(result.missingDeliverableIds
              ? { missing_deliverable_ids: result.missingDeliverableIds }
              : {}),
          },
        };
      }
      const payload = {
        task: result.task,
        previous_status: result.previousStatus,
      };
      return textResult(JSON.stringify(payload, null, 2), payload);
    }),
  );

  // fail_task ─────────────────────────────────────────────────────
  server.registerTool(
    'fail_task',
    {
      title: 'Report a stage failure (tester/reviewer)',
      description:
        "Fail the current task stage, triggering the workflow engine's fail-loopback. Tester/reviewer uses this when the prior stage's work didn't pass. Include specific, actionable reasons — they're shown to the builder on re-dispatch.",
      inputSchema: {
        agent_id: agentIdArg,
        task_id: taskIdArg,
        reason: z.string().min(1).max(5000),
      },
      annotations: { destructiveHint: true, openWorldHint: false },
    },
    trace('fail_task', async (args) => {
      const result = await failTask({
        taskId: args.task_id,
        actingAgentId: args.agent_id,
        reason: args.reason,
      });
      if (!result.ok) {
        return {
          isError: true,
          content: [{ type: 'text', text: result.error }],
          structuredContent: {
            error: result.code,
            message: result.error,
            ...(result.hint ? { hint: result.hint } : {}),
          },
        };
      }
      // When a delegation subtask fails, notify the coordinator with a
      // deterministic subject line so their triage is mechanical. The
      // `redecompose:` reason prefix is the peer's escape hatch (see
      // specs/coordinator-delegation-via-convoy-spec.md §3.8) — surface
      // it explicitly so the coordinator cancels + re-plans rather than
      // re-dispatching the same slice.
      const ctx = queryOne<{ subtask_id: string; slice: string | null; parent_task_id: string; coordinator_id: string | null; convoy_id: string }>(
        `SELECT cs.id AS subtask_id, cs.slice AS slice,
                c.parent_task_id AS parent_task_id,
                c.id AS convoy_id,
                p.assigned_agent_id AS coordinator_id
           FROM convoy_subtasks cs
           JOIN convoys c ON c.id = cs.convoy_id
           JOIN tasks p ON p.id = c.parent_task_id
          WHERE cs.task_id = ?`,
        [args.task_id],
      );
      if (ctx?.coordinator_id) {
        const redecompose = /^redecompose\s*:/i.test(args.reason);
        sendAgentMail({
          fromAgentId: args.agent_id,
          toAgentId: ctx.coordinator_id,
          subject: redecompose
            ? `DELEGATION: redecompose_requested — ${ctx.slice ?? 'subtask'}`
            : `DELEGATION: blocked — ${ctx.slice ?? 'subtask'}`,
          body: `Subtask ${ctx.subtask_id} failed.\n\n**Reason:** ${args.reason}\n\n${redecompose
            ? 'The peer is asking you to re-decompose this slice. Call cancel_subtask on this row and issue fresh spawn_subtask calls with a better-scoped brief.'
            : 'Peer declared itself blocked. Inspect the reason and decide: reject_subtask (redo), cancel_subtask (drop), or answer and redispatch.'}`,
          taskId: ctx.parent_task_id,
          convoyId: ctx.convoy_id,
          push: true,
        }).catch((err: unknown) => {
          console.warn('[fail_task] coordinator notify failed:', (err as Error).message);
        });
      }
      return textResult(JSON.stringify(result, null, 2), result);
    }),
  );

  // save_checkpoint ───────────────────────────────────────────────
  server.registerTool(
    'save_checkpoint',
    {
      title: 'Save a work-state checkpoint',
      description:
        'Record a state snapshot for the task so it can be audited or resumed. Also triggers delivery of any pending operator notes at this checkpoint boundary.',
      inputSchema: {
        agent_id: agentIdArg,
        task_id: taskIdArg,
        state_summary: z.string().min(1).max(10000),
        checkpoint_type: z.enum(['auto', 'manual', 'crash_recovery']).optional(),
        files_snapshot: z
          .array(
            z.object({
              path: z.string().min(1),
              hash: z.string().min(1),
              size: z.number().int().min(0),
            }),
          )
          .optional(),
        context_data: z.record(z.string(), z.unknown()).optional(),
      },
      annotations: { destructiveHint: true, openWorldHint: false },
    },
    trace('save_checkpoint', async (args) => {
      const checkpoint = saveTaskCheckpoint({
        taskId: args.task_id,
        agentId: args.agent_id,
        checkpointType: args.checkpoint_type,
        stateSummary: args.state_summary,
        filesSnapshot: args.files_snapshot,
        contextData: args.context_data,
      });
      return textResult(JSON.stringify(checkpoint, null, 2), { checkpoint });
    }),
  );

  // send_mail ─────────────────────────────────────────────────────
  server.registerTool(
    'send_mail',
    {
      title: 'Send mail to another agent',
      description:
        "Send a message to another agent's mailbox. Use list_peers or whoami to resolve recipient ids. When task_id is provided, the sender must be on that task (cross-task probing via mail is blocked).",
      inputSchema: {
        agent_id: agentIdArg.describe(
          'The calling agent (the sender — goes in the From: field).',
        ),
        to_agent_id: z.string().min(1).describe('Recipient MC agent_id.'),
        body: z.string().min(1),
        subject: z.string().max(500).optional(),
        task_id: z.string().optional(),
        convoy_id: z.string().optional(),
        push: z.boolean().optional().describe('If true, also push via chat.send.'),
      },
      annotations: { destructiveHint: true, openWorldHint: false },
    },
    trace('send_mail', async (args) => {
      const result = await sendAgentMail({
        fromAgentId: args.agent_id,
        toAgentId: args.to_agent_id,
        body: args.body,
        subject: args.subject,
        taskId: args.task_id ?? null,
        convoyId: args.convoy_id ?? null,
        push: args.push,
      });
      if (!result.ok) {
        return {
          isError: true,
          content: [{ type: 'text', text: result.error }],
          structuredContent: { error: result.code, message: result.error },
        };
      }
      const payload = {
        message: result.message,
        rollcall_matched: result.rollcallMatched,
        rollcall_id: result.rollcallId ?? null,
      };
      return textResult(JSON.stringify(payload, null, 2), payload);
    }),
  );

  // save_knowledge ────────────────────────────────────────────────
  // Used by the Learner agent at stage transitions to capture lessons
  // learned (failure patterns, fixes, checklists, best practices). The
  // learner-knowledge pipeline (src/lib/learner.ts) injects these into
  // future builder dispatches via `formatKnowledgeForDispatch`.
  server.registerTool(
    'save_knowledge',
    {
      title: 'Save a learning / lesson to workspace knowledge',
      description:
        "Record a lesson learned from a task transition. Used by the Learner agent at stage transitions (pass/fail) to capture failure patterns, fixes, checklists, and best practices that future dispatches can inject via the learner-knowledge pipeline.",
      inputSchema: {
        agent_id: agentIdArg,
        workspace_id: z
          .string()
          .min(1)
          .describe(
            'The workspace this lesson applies to. Use the workspace of the task being observed.',
          ),
        task_id: z
          .string()
          .optional()
          .describe(
            'When the lesson is derived from a specific task, the task id. Enables cross-referencing.',
          ),
        category: z.enum(['failure', 'fix', 'pattern', 'checklist']),
        title: z.string().min(1).max(500),
        content: z.string().min(1).max(20000),
        tags: z.array(z.string().min(1).max(100)).optional(),
        confidence: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe(
            '0..1. Higher for patterns seen multiple times; lower for first-time observations.',
          ),
      },
      annotations: { destructiveHint: true, openWorldHint: false },
    },
    trace('save_knowledge', async (args) => {
      const entry = saveKnowledge({
        actingAgentId: args.agent_id,
        workspaceId: args.workspace_id,
        taskId: args.task_id,
        category: args.category,
        title: args.title,
        content: args.content,
        tags: args.tags,
        confidence: args.confidence,
      });
      return textResult(JSON.stringify(entry, null, 2), { entry });
    }),
  );

  // request_knowledge ─────────────────────────────────────────────
  // On-demand replacement for the old auto-injected PREVIOUS LESSONS
  // LEARNED block. The dispatcher no longer drops unrelated lessons into
  // every prompt; instead an agent calls this when it wants relevant
  // prior experience for the current problem. Matches query tokens
  // against title/tags/content and returns scored results (or a clear
  // "no relevant knowledge" response so the agent doesn't retry).
  server.registerTool(
    'request_knowledge',
    {
      title: 'Search workspace knowledge for relevant lessons',
      description:
        "Query the workspace knowledge base for lessons relevant to the current problem. Returns up to `limit` matches scored by title/tag/content hits × confidence, or an empty result with `none: true` when nothing relevant exists (do not retry in that case — lessons are only written by the Learner agent on stage transitions).",
      inputSchema: {
        agent_id: agentIdArg,
        task_id: taskIdArg
          .optional()
          .describe(
            "Optional task id. When provided, the workspace is resolved from the task so the caller doesn't need to pass workspace_id separately.",
          ),
        workspace_id: z
          .string()
          .min(1)
          .optional()
          .describe('Workspace to search. Required if task_id is omitted.'),
        query: z
          .string()
          .min(3)
          .max(500)
          .describe('Free-text query — what problem / topic are you trying to recall lessons for?'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(10)
          .optional()
          .describe('Max matches to return. Defaults to 5.'),
      },
      annotations: { destructiveHint: false, openWorldHint: false },
    },
    trace('request_knowledge', async (args) => {
      let workspaceId = args.workspace_id;
      if (!workspaceId && args.task_id) {
        const row = queryOne<{ workspace_id: string }>(
          'SELECT workspace_id FROM tasks WHERE id = ?',
          [args.task_id],
        );
        workspaceId = row?.workspace_id;
      }
      if (!workspaceId) {
        const message = 'workspace_id is required when task_id is omitted';
        return {
          isError: true,
          content: [{ type: 'text', text: message }],
          structuredContent: { error: 'missing_workspace', message },
        };
      }

      const result = searchKnowledge({
        actingAgentId: args.agent_id,
        workspaceId,
        query: args.query,
        limit: args.limit,
      });

      if (result.none) {
        const text = 'No relevant knowledge found in this workspace for that query. Proceed without prior-lesson context.';
        return textResult(text, { matches: [], none: true });
      }

      const text = result.matches
        .map(
          (m, i) =>
            `${i + 1}. **${m.title}** (${m.category}, confidence: ${(m.confidence * 100).toFixed(0)}%)\n   ${m.content}`,
        )
        .join('\n\n');
      return textResult(text, { matches: result.matches, none: false });
    }),
  );

  // spawn_subtask ─────────────────────────────────────────────────
  // Coordinator-only. The single entry point for agent-driven
  // delegation: creates (or appends to) a convoy on the caller's task,
  // writes a SLO-populated convoy_subtasks row, then POSTs to the normal
  // dispatch pipeline so the peer gets the standard briefing plus a
  // Delegation Contract block. Replaces the old `delegate` tool entirely
  // — see specs/coordinator-delegation-via-convoy-spec.md.
  server.registerTool(
    'spawn_subtask',
    {
      title: 'Spawn a delegated subtask (coordinator-only)',
      description:
        "Coordinator delegates a slice of its task to a peer by creating a convoy subtask with a declared contract. Every field is mandatory: the peer receives an explicit Delegation Contract (deliverables, acceptance criteria, duration, check-in cadence) and is dispatched via the normal pipeline. Peer sub-delegation is rejected by authz.",
      inputSchema: {
        agent_id: agentIdArg.describe('The calling coordinator agent.'),
        task_id: taskIdArg.describe('The coordinator\'s parent task id.'),
        peer_gateway_id: z
          .string()
          .min(1)
          .describe(
            "Gateway id of the peer to delegate to, e.g. 'mc-researcher'. Use list_peers to discover.",
          ),
        slice: z
          .string()
          .min(10)
          .max(500)
          .describe("One-line summary of what this peer owns (becomes the child task's title)."),
        message: z
          .string()
          .min(1)
          .max(10000)
          .describe(
            "The full brief sent to the peer as the child task's description. Should include context + why this slice exists.",
          ),
        expected_deliverables: z
          .array(
            z.object({
              title: z.string().min(1).max(200),
              kind: z.enum(['file', 'note', 'report']),
            }),
          )
          .min(1)
          .describe('At least one deliverable the peer must register via register_deliverable.'),
        acceptance_criteria: z
          .array(z.string().min(10).max(500))
          .min(1)
          .describe('Each criterion ≥10 chars. The peer must satisfy all of them for the coordinator to accept_subtask.'),
        expected_duration_minutes: z
          .number()
          .int()
          .min(5)
          .max(240)
          .describe('Declared SLO — stall detection uses 1.5× this as the hard overdue line.'),
        checkin_interval_minutes: z
          .number()
          .int()
          .min(5)
          .max(60)
          .optional()
          .describe('Default 15. The peer must log_activity at least this often; 2× is the silent-drift signal.'),
        depends_on_subtask_ids: z
          .array(z.string().min(1))
          .optional()
          .describe('Optional: subtask ids (from prior spawn_subtask calls in this convoy) that must complete first.'),
      },
      annotations: { destructiveHint: true, openWorldHint: false },
    },
    trace('spawn_subtask', async (args) => {
      const { assertAgentCanActOnTask } = await import('@/lib/authz/agent-task');
      // Reuse the 'delegate' authz action — same policy (coordinator-only
      // on this task). Action names are internal enum values, not
      // user-facing, so renaming isn't worth a schema change.
      assertAgentCanActOnTask(args.agent_id, args.task_id, 'delegate');

      // Explicit sub-delegation guard: if the caller's task is itself a
      // subtask, reject. Authz above only checks coordinator-role-on-task;
      // a peer could satisfy that on its own child task without this rail.
      const parent = queryOne<{ is_subtask: number | null }>(
        'SELECT is_subtask FROM tasks WHERE id = ?',
        [args.task_id],
      );
      if (parent?.is_subtask === 1) {
        return {
          isError: true,
          content: [{
            type: 'text',
            text: 'Peer sub-delegation is not allowed. Your task is itself a subtask — deliver what you have, or call fail_task with reason "redecompose: ..." and stop. The coordinator will re-plan.',
          }],
          structuredContent: {
            error: 'peer_sub_delegation_blocked',
            hint: 'deliver_partial_or_fail_task_with_redecompose_prefix',
          },
        };
      }

      // Scope peer lookup to the parent task's workspace. Without this,
      // the multi-workspace gateway clones from #133 mean we can grab
      // any workspace's row for `peer_gateway_id` — the child task is
      // created with parent.workspace_id but assigned_agent_id ends up
      // pointing at the foreign-workspace clone, and every subsequent
      // MCP call from the peer trips authz:workspace_mismatch.
      const parentWs = queryOne<{ workspace_id: string | null }>(
        'SELECT workspace_id FROM tasks WHERE id = ?',
        [args.task_id],
      )?.workspace_id ?? 'default';
      const peer = queryOne<{ id: string; name: string; role: string | null }>(
        `SELECT id, name, role FROM agents
          WHERE gateway_agent_id = ?
            AND COALESCE(workspace_id, 'default') = ?
          LIMIT 1`,
        [args.peer_gateway_id, parentWs],
      );
      if (!peer) {
        // Distinguish "exists, wrong workspace" from "doesn't exist
        // anywhere" so the coordinator gets an actionable error.
        const elsewhere = queryAll<{ workspace_id: string | null }>(
          `SELECT workspace_id FROM agents WHERE gateway_agent_id = ?`,
          [args.peer_gateway_id],
        );
        if (elsewhere.length > 0) {
          const otherWorkspaces = elsewhere.map((r) => r.workspace_id ?? 'default');
          return {
            isError: true,
            content: [{
              type: 'text',
              text: `Peer "${args.peer_gateway_id}" exists but not in this task's workspace (${parentWs}). Found in: ${otherWorkspaces.join(', ')}. Call list_peers to see the in-workspace roster, or have the operator clone the agent into ${parentWs}.`,
            }],
            structuredContent: {
              error: 'peer_not_in_workspace',
              peer_gateway_id: args.peer_gateway_id,
              task_workspace_id: parentWs,
              found_in_workspaces: otherWorkspaces,
            },
          };
        }
        return {
          isError: true,
          content: [{
            type: 'text',
            text: `No agent with gateway_agent_id "${args.peer_gateway_id}" in the catalog. Call list_peers to see the roster.`,
          }],
          structuredContent: { error: 'peer_not_found', peer_gateway_id: args.peer_gateway_id },
        };
      }

      const checkinInterval = args.checkin_interval_minutes ?? 15;

      const spawn = spawnDelegationSubtask({
        parentTaskId: args.task_id,
        parentAgentId: args.agent_id,
        peerAgentId: peer.id,
        peerGatewayId: args.peer_gateway_id,
        suggestedRole: peer.role || 'builder',
        slice: args.slice,
        message: args.message,
        expectedDeliverables: args.expected_deliverables,
        acceptanceCriteria: args.acceptance_criteria,
        expectedDurationMinutes: args.expected_duration_minutes,
        checkinIntervalMinutes: checkinInterval,
        dependsOnSubtaskIds: args.depends_on_subtask_ids,
      });

      // Log delegation_spawned on the PARENT task timeline so the
      // coordinator's activity feed shows the fan-out. The child task's
      // own activity starts once it's dispatched.
      logActivity({
        taskId: args.task_id,
        actingAgentId: args.agent_id,
        activityType: 'updated',
        message: `[delegation_spawned] peer=${peer.name} gateway_id=${args.peer_gateway_id} child_task=${spawn.childTaskId} due_at=${spawn.dueAt} slice="${args.slice.replace(/"/g, "'")}"`,
      });

      // Move child to 'assigned' before dispatch so the dispatch route
      // sees a valid state. The convoy dispatcher does the same.
      run(
        `UPDATE tasks SET status = 'assigned', updated_at = datetime('now') WHERE id = ?`,
        [spawn.childTaskId],
      );

      // Fire the dispatch via shared helper (IPv4, 120s, cause unwrap).
      const spawnResult = await internalDispatch(spawn.childTaskId, { caller: 'mcp-spawn-subtask' });
      const dispatchError = spawnResult.success ? null : (spawnResult.error || 'dispatch failed');

      if (dispatchError) {
        // The subtask row exists but dispatch failed — the coordinator
        // should see this explicitly and can call cancel_subtask +
        // retry. We do NOT auto-rollback: the convoy row is real,
        // half-done is visible, no silent data loss.
        return {
          isError: true,
          content: [{
            type: 'text',
            text: `Subtask ${spawn.subtaskId} created but dispatch failed: ${dispatchError}. The subtask row exists — call cancel_subtask to release it, or retry.`,
          }],
          structuredContent: {
            error: 'dispatch_failed',
            message: dispatchError,
            subtask_id: spawn.subtaskId,
            child_task_id: spawn.childTaskId,
            convoy_id: spawn.convoyId,
          },
        };
      }

      const payload = {
        subtask_id: spawn.subtaskId,
        child_task_id: spawn.childTaskId,
        convoy_id: spawn.convoyId,
        peer: { id: peer.id, name: peer.name, gateway_agent_id: args.peer_gateway_id },
        dispatched_at: spawn.dispatchedAt,
        due_at: spawn.dueAt,
        checkin_interval_minutes: checkinInterval,
      };
      return textResult(
        `Spawned subtask ${spawn.subtaskId} to ${peer.name} (${args.peer_gateway_id}). Due at ${spawn.dueAt}; check-in cadence ${checkinInterval}m.`,
        payload,
      );
    }),
  );

  // list_my_subtasks ──────────────────────────────────────────────
  // Coordinator's live view of its outstanding delegations. Computes a
  // derived state per row from tasks.status + SLO clock so callers don't
  // have to re-run the math.
  server.registerTool(
    'list_my_subtasks',
    {
      title: 'List the coordinator\'s outstanding delegations',
      description:
        "Returns all convoy subtasks for the caller's task with per-row derived state (dispatched / in_progress / drifting / overdue / delivered / accepted / rejected / timed_out / cancelled). Use this in a coordinator's 'who am I waiting on?' check.",
      inputSchema: {
        agent_id: agentIdArg,
        task_id: taskIdArg,
        states: z
          .array(
            z.enum(['active', 'overdue', 'drifting', 'delivered', 'closed']),
          )
          .optional()
          .describe('Optional filter. `active` = not closed/timed_out. Omit to return all.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    trace('list_my_subtasks', async (args) => {
      const { assertAgentCanActOnTask } = await import('@/lib/authz/agent-task');
      assertAgentCanActOnTask(args.agent_id, args.task_id, 'delegate');

      const rows = queryAll<{
        subtask_id: string;
        child_task_id: string;
        slice: string | null;
        peer_agent_id: string | null;
        peer_name: string | null;
        peer_gateway_id: string | null;
        task_status: string;
        status_reason: string | null;
        dispatched_at: string | null;
        due_at: string | null;
        checkin_interval_minutes: number | null;
        deliverables_registered_count: number | null;
        expected_deliverables: string | null;
        last_activity_at: string | null;
      }>(
        `SELECT cs.id            AS subtask_id,
                cs.task_id       AS child_task_id,
                cs.slice         AS slice,
                t.assigned_agent_id AS peer_agent_id,
                a.name           AS peer_name,
                a.gateway_agent_id AS peer_gateway_id,
                t.status         AS task_status,
                t.status_reason  AS status_reason,
                cs.dispatched_at AS dispatched_at,
                cs.due_at        AS due_at,
                cs.checkin_interval_minutes AS checkin_interval_minutes,
                cs.deliverables_registered_count AS deliverables_registered_count,
                cs.expected_deliverables AS expected_deliverables,
                (SELECT MAX(created_at) FROM task_activities WHERE task_id = t.id) AS last_activity_at
           FROM convoy_subtasks cs
           JOIN convoys c ON c.id = cs.convoy_id
           JOIN tasks   t ON t.id = cs.task_id
           LEFT JOIN agents a ON a.id = t.assigned_agent_id
          WHERE c.parent_task_id = ?
          ORDER BY cs.sort_order ASC`,
        [args.task_id],
      );

      const now = Date.now();
      const subtasks = rows.map((r) => {
        const dueMs = r.due_at ? new Date(r.due_at).getTime() : null;
        const lastMs = r.last_activity_at ? new Date(r.last_activity_at).getTime() : null;
        const driftMs = r.checkin_interval_minutes ? r.checkin_interval_minutes * 2 * 60_000 : null;
        const expectedCount = (() => {
          if (!r.expected_deliverables) return 0;
          try { return (JSON.parse(r.expected_deliverables) as unknown[]).length; } catch { return 0; }
        })();

        let derived: string;
        if (r.task_status === 'done') derived = 'accepted';
        else if (r.task_status === 'review' || r.task_status === 'verification' || r.task_status === 'testing') derived = 'delivered';
        else if (r.task_status === 'cancelled' && r.status_reason?.startsWith('timed_out')) derived = 'timed_out';
        else if (r.task_status === 'cancelled') derived = 'cancelled';
        else if (r.status_reason?.startsWith('rejected:')) derived = 'rejected';
        else if (r.status_reason === 'blocked' || r.status_reason?.startsWith('blocked:')) derived = 'blocked';
        else if (dueMs && now > dueMs) derived = 'overdue';
        else if (lastMs && driftMs && now - lastMs > driftMs) derived = 'drifting';
        else if (r.task_status === 'in_progress') derived = 'in_progress';
        else derived = 'dispatched';

        return {
          subtask_id: r.subtask_id,
          child_task_id: r.child_task_id,
          peer: r.peer_agent_id
            ? { id: r.peer_agent_id, name: r.peer_name, gateway_agent_id: r.peer_gateway_id }
            : null,
          slice: r.slice,
          state_derived: derived,
          task_status: r.task_status,
          dispatched_at: r.dispatched_at,
          due_at: r.due_at,
          last_activity_at: r.last_activity_at,
          deliverables_registered: r.deliverables_registered_count ?? 0,
          deliverables_expected: expectedCount,
        };
      });

      // Apply state filter last so the derived-state computation is the
      // same regardless of caller filter (keeps behavior obvious).
      const filter = args.states;
      const filtered = !filter || filter.length === 0
        ? subtasks
        : subtasks.filter((s) => {
            if (filter.includes('active') && !['accepted', 'rejected', 'cancelled', 'timed_out'].includes(s.state_derived)) return true;
            if (filter.includes('overdue')   && s.state_derived === 'overdue')   return true;
            if (filter.includes('drifting')  && s.state_derived === 'drifting')  return true;
            if (filter.includes('delivered') && s.state_derived === 'delivered') return true;
            if (filter.includes('closed')    && ['accepted','rejected','cancelled','timed_out'].includes(s.state_derived)) return true;
            return false;
          });

      return textResult(JSON.stringify({ subtasks: filtered }, null, 2), { subtasks: filtered });
    }),
  );

  // accept_subtask ────────────────────────────────────────────────
  server.registerTool(
    'accept_subtask',
    {
      title: 'Accept a peer\'s delivered delegation (coordinator-only)',
      description:
        "Promote a delivered child task (status=review/verification/testing) to done. Bumps the convoy's completed_subtasks counter and may promote the parent via checkConvoyCompletion. Call this after verifying the peer's deliverables meet the acceptance criteria you declared in spawn_subtask.",
      inputSchema: {
        agent_id: agentIdArg,
        subtask_id: z.string().min(1).describe('The convoy_subtasks row id from spawn_subtask.'),
      },
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    trace('accept_subtask', async (args) => {
      const row = queryOne<{ task_id: string; parent_task_id: string; task_status: string }>(
        `SELECT cs.task_id AS task_id, c.parent_task_id AS parent_task_id, t.status AS task_status
           FROM convoy_subtasks cs
           JOIN convoys c ON c.id = cs.convoy_id
           JOIN tasks t ON t.id = cs.task_id
          WHERE cs.id = ?`,
        [args.subtask_id],
      );
      if (!row) {
        return { isError: true, content: [{ type: 'text', text: `subtask ${args.subtask_id} not found` }], structuredContent: { error: 'subtask_not_found' } };
      }
      const { assertAgentCanActOnTask } = await import('@/lib/authz/agent-task');
      assertAgentCanActOnTask(args.agent_id, row.parent_task_id, 'delegate');

      if (row.task_status === 'done') {
        return textResult(`Subtask ${args.subtask_id} was already done. No-op.`, { subtask_id: args.subtask_id, already_done: true });
      }

      const result = transitionTaskStatus({
        taskId: row.task_id,
        actingAgentId: args.agent_id,
        newStatus: 'done',
      });
      if (!result.ok) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Cannot accept subtask: ${result.error}` }],
          structuredContent: {
            error: result.code,
            message: result.error,
            ...(result.missingDeliverableIds ? { missing_deliverable_ids: result.missingDeliverableIds } : {}),
          },
        };
      }

      logActivity({
        taskId: row.parent_task_id,
        actingAgentId: args.agent_id,
        activityType: 'updated',
        message: `[delegation_accepted] subtask=${args.subtask_id} child_task=${row.task_id}`,
      });

      // checkConvoyCompletion may promote the parent task.
      const { checkConvoyCompletion } = await import('@/lib/convoy');
      const convoyId = queryOne<{ convoy_id: string }>(
        'SELECT convoy_id FROM convoy_subtasks WHERE id = ?', [args.subtask_id],
      )?.convoy_id;
      if (convoyId) checkConvoyCompletion(convoyId);

      return textResult(`Accepted subtask ${args.subtask_id}.`, {
        subtask_id: args.subtask_id,
        child_task_id: row.task_id,
        parent_task_id: row.parent_task_id,
      });
    }),
  );

  // reject_subtask ────────────────────────────────────────────────
  server.registerTool(
    'reject_subtask',
    {
      title: 'Reject a peer\'s delivered delegation with a reason (coordinator-only)',
      description:
        "Bounce a delivered child task back to in_progress with a reason the peer sees on re-dispatch. Use when deliverables don't meet the acceptance criteria. For slice mismatch (peer built the wrong thing entirely), prefer cancel_subtask + a fresh spawn_subtask instead.",
      inputSchema: {
        agent_id: agentIdArg,
        subtask_id: z.string().min(1),
        reason: z.string().min(10).max(2000).describe('Specific, actionable — shown to the peer on re-dispatch.'),
        new_acceptance_criteria: z
          .array(z.string().min(10).max(500))
          .optional()
          .describe('Optional updated criteria. When provided, replaces the convoy_subtasks.acceptance_criteria for the next round.'),
      },
      annotations: { destructiveHint: true, openWorldHint: false },
    },
    trace('reject_subtask', async (args) => {
      const row = queryOne<{ task_id: string; parent_task_id: string; task_status: string }>(
        `SELECT cs.task_id AS task_id, c.parent_task_id AS parent_task_id, t.status AS task_status
           FROM convoy_subtasks cs
           JOIN convoys c ON c.id = cs.convoy_id
           JOIN tasks t ON t.id = cs.task_id
          WHERE cs.id = ?`,
        [args.subtask_id],
      );
      if (!row) {
        return { isError: true, content: [{ type: 'text', text: `subtask ${args.subtask_id} not found` }], structuredContent: { error: 'subtask_not_found' } };
      }
      const { assertAgentCanActOnTask } = await import('@/lib/authz/agent-task');
      assertAgentCanActOnTask(args.agent_id, row.parent_task_id, 'delegate');

      const now = new Date().toISOString();
      run(
        `UPDATE tasks SET status = 'in_progress', status_reason = ?, updated_at = ? WHERE id = ?`,
        [`rejected: ${args.reason}`, now, row.task_id],
      );
      if (args.new_acceptance_criteria && args.new_acceptance_criteria.length > 0) {
        run(
          `UPDATE convoy_subtasks SET acceptance_criteria = ? WHERE id = ?`,
          [JSON.stringify(args.new_acceptance_criteria), args.subtask_id],
        );
      }

      logActivity({
        taskId: row.parent_task_id,
        actingAgentId: args.agent_id,
        activityType: 'updated',
        message: `[delegation_rejected] subtask=${args.subtask_id} reason="${args.reason.replace(/"/g, "'")}"`,
      });

      // Notify the peer through their chat session so they see the
      // rejection inline. Best-effort — if the openclaw client is down,
      // the mailbox fallback still carries the message.
      const peer = queryOne<{ id: string; gateway_agent_id: string | null; name: string; session_key_prefix: string | null }>(
        'SELECT a.id, a.gateway_agent_id, a.name, a.session_key_prefix FROM tasks t JOIN agents a ON a.id = t.assigned_agent_id WHERE t.id = ?',
        [row.task_id],
      );
      if (peer?.gateway_agent_id) {
        try {
          const client = getOpenClawClient();
          if (!client.isConnected()) await client.connect();
          const { sendChatToAgent } = await import('@/lib/openclaw/send-chat');
          const result = await sendChatToAgent({
            agent: {
              id: peer.id,
              name: peer.name,
              gateway_agent_id: peer.gateway_agent_id,
              session_key_prefix: peer.session_key_prefix ?? undefined,
            },
            message: `🔁 **Subtask rejected by coordinator.**\n\n**Reason:** ${args.reason}\n\n${args.new_acceptance_criteria?.length ? `**Updated acceptance criteria:**\n${args.new_acceptance_criteria.map(c => `- ${c}`).join('\n')}\n\n` : ''}Please address the issues and re-register deliverables, then move status back to review.`,
            idempotencyKey: `reject-${args.subtask_id}-${Date.now()}`,
            sessionSuffix: `task-${row.task_id}`,
          });
          if (!result.sent && result.error) {
            console.warn('[reject_subtask] chat.send notification failed:', result.error.message);
          }
        } catch (err) {
          console.warn('[reject_subtask] chat.send notification failed:', (err as Error).message);
        }
      }

      return textResult(`Rejected subtask ${args.subtask_id}. Peer task ${row.task_id} moved back to in_progress.`, {
        subtask_id: args.subtask_id,
        child_task_id: row.task_id,
      });
    }),
  );

  // cancel_subtask ────────────────────────────────────────────────
  server.registerTool(
    'cancel_subtask',
    {
      title: 'Cancel a delegated subtask (coordinator-only)',
      description:
        "Release a subtask that's no longer needed or is demonstrably stuck. The child task moves to cancelled; the convoy's failed_subtasks counter bumps so the subtask no longer blocks convoy completion. Use for scope changes and dead branches; for rejecting delivered work that needs a redo, use reject_subtask.",
      inputSchema: {
        agent_id: agentIdArg,
        subtask_id: z.string().min(1),
        reason: z.string().min(5).max(2000),
      },
      annotations: { destructiveHint: true, openWorldHint: false },
    },
    trace('cancel_subtask', async (args) => {
      const row = queryOne<{ task_id: string; parent_task_id: string; convoy_id: string }>(
        `SELECT cs.task_id AS task_id, c.parent_task_id AS parent_task_id, cs.convoy_id AS convoy_id
           FROM convoy_subtasks cs JOIN convoys c ON c.id = cs.convoy_id WHERE cs.id = ?`,
        [args.subtask_id],
      );
      if (!row) {
        return { isError: true, content: [{ type: 'text', text: `subtask ${args.subtask_id} not found` }], structuredContent: { error: 'subtask_not_found' } };
      }
      const { assertAgentCanActOnTask } = await import('@/lib/authz/agent-task');
      assertAgentCanActOnTask(args.agent_id, row.parent_task_id, 'delegate');

      const now = new Date().toISOString();
      run(
        `UPDATE tasks SET status = 'cancelled', status_reason = ?, updated_at = ? WHERE id = ?`,
        [`cancelled_by_coordinator: ${args.reason}`, now, row.task_id],
      );
      run(
        `UPDATE convoys SET failed_subtasks = failed_subtasks + 1, updated_at = ? WHERE id = ?`,
        [now, row.convoy_id],
      );

      logActivity({
        taskId: row.parent_task_id,
        actingAgentId: args.agent_id,
        activityType: 'updated',
        message: `[delegation_cancelled] subtask=${args.subtask_id} reason="${args.reason.replace(/"/g, "'")}"`,
      });

      return textResult(`Cancelled subtask ${args.subtask_id}.`, {
        subtask_id: args.subtask_id,
        child_task_id: row.task_id,
      });
    }),
  );
}
