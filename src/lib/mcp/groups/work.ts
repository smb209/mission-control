/**
 * Work MCP tools — task execution, mail, deliverables, evidence,
 * subtask delegation, knowledge, subagent dispatch registration, and the
 * note-lifecycle tool (update_note — consume + archive actions).
 *
 * Behavior is unchanged from the legacy `tools.ts` consolidation; this is
 * a pure relocation as part of the MCP surface refactor (PR 1).
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { queryAll, queryOne, run } from '@/lib/db';
import { AuthzError, assertAgentActive } from '@/lib/authz/agent-task';

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
import { spawnDelegationSubtask, dispatchReadyConvoySubtasks } from '@/lib/convoy';
import { internalDispatch } from '@/lib/internal-dispatch';
import { upsertSession, type ScopeType } from '@/lib/db/mc-sessions';
import {
  archiveNote as archiveNoteDb,
  getNote,
  markNoteConsumed as markNoteConsumedDb,
  parseConsumedStages,
} from '@/lib/db/agent-notes';
import { broadcast } from '@/lib/events';

import {
  agentIdArg,
  taskIdArg,
  textResult,
  trace,
  deriveWorkspaceFromAgent,
  noteToPayload,
} from '../shared';

// ── update_subtask action handlers ──────────────────────────────────
// Helpers extracted from the legacy accept_subtask / reject_subtask /
// cancel_subtask MCP tools (PR 4 of the MCP surface v2 stack). Behavior
// is intentionally byte-equivalent to those handlers; the tool layer
// just dispatches to whichever helper matches `args.action`.

async function acceptSubtaskImpl(args: { agent_id: string; subtask_id: string }) {
  const row = queryOne<{ task_id: string; parent_task_id: string; task_status: string }>(
    `SELECT cs.task_id AS task_id, c.parent_task_id AS parent_task_id, t.status AS task_status
       FROM convoy_subtasks cs
       JOIN convoys c ON c.id = cs.convoy_id
       JOIN tasks t ON t.id = cs.task_id
      WHERE cs.id = ?`,
    [args.subtask_id],
  );
  if (!row) {
    return { isError: true, content: [{ type: 'text' as const, text: `subtask ${args.subtask_id} not found` }], structuredContent: { error: 'subtask_not_found' } };
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
      content: [{ type: 'text' as const, text: `Cannot accept subtask: ${result.error}` }],
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
  if (convoyId) {
    checkConvoyCompletion(convoyId);
    // Release any siblings whose depends_on now resolves. Subtasks
    // spawned with unsatisfied deps stay in 'inbox' (see spawn_subtask
    // dep gate); this is the matching release path. Best-effort — a
    // dispatch failure surfaces in the convoy view, not as an accept
    // error, since the accept itself already succeeded.
    void dispatchReadyConvoySubtasks(convoyId).catch(err => {
      console.warn('[update_subtask:accept] dispatchReadyConvoySubtasks failed:', (err as Error).message);
    });
  }

  return textResult(`Accepted subtask ${args.subtask_id}.`, {
    subtask_id: args.subtask_id,
    child_task_id: row.task_id,
    parent_task_id: row.parent_task_id,
  });
}

async function rejectSubtaskImpl(args: {
  agent_id: string;
  subtask_id: string;
  reason: string;
  new_acceptance_criteria?: string[];
}) {
  const row = queryOne<{ task_id: string; parent_task_id: string; task_status: string }>(
    `SELECT cs.task_id AS task_id, c.parent_task_id AS parent_task_id, t.status AS task_status
       FROM convoy_subtasks cs
       JOIN convoys c ON c.id = cs.convoy_id
       JOIN tasks t ON t.id = cs.task_id
      WHERE cs.id = ?`,
    [args.subtask_id],
  );
  if (!row) {
    return { isError: true, content: [{ type: 'text' as const, text: `subtask ${args.subtask_id} not found` }], structuredContent: { error: 'subtask_not_found' } };
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
        console.warn('[update_subtask:reject] chat.send notification failed:', result.error.message);
      }
    } catch (err) {
      console.warn('[update_subtask:reject] chat.send notification failed:', (err as Error).message);
    }
  }

  return textResult(`Rejected subtask ${args.subtask_id}. Peer task ${row.task_id} moved back to in_progress.`, {
    subtask_id: args.subtask_id,
    child_task_id: row.task_id,
  });
}

async function cancelSubtaskImpl(args: { agent_id: string; subtask_id: string; reason: string }) {
  const row = queryOne<{ task_id: string; parent_task_id: string; convoy_id: string }>(
    `SELECT cs.task_id AS task_id, c.parent_task_id AS parent_task_id, cs.convoy_id AS convoy_id
       FROM convoy_subtasks cs JOIN convoys c ON c.id = cs.convoy_id WHERE cs.id = ?`,
    [args.subtask_id],
  );
  if (!row) {
    return { isError: true, content: [{ type: 'text' as const, text: `subtask ${args.subtask_id} not found` }], structuredContent: { error: 'subtask_not_found' } };
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
}

export function registerWorkTools(server: McpServer): void {
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

  // update_note ────────────────────────────────────────────────────
  // Consolidated lifecycle tool. Replaces mark_note_consumed and
  // archive_note (PR 5 of the MCP surface v2 stack). Action enum keeps
  // the agent's mental model concrete (consume vs archive are
  // semantically distinct: consume = "I read it"; archive = "kill it
  // for everyone").
  server.registerTool(
    'update_note',
    {
      title: 'Update a note (mark consumed by your stage, or archive it)',
      description:
        "Two actions:\n" +
        "- `consume` — record that your stage has read this note so the next briefing for your stage doesn't re-show it. Idempotent. Requires `stage_slug` (typically your current role, e.g. 'tester' if you're the tester reading a builder breadcrumb).\n" +
        "- `archive` — soft-hide the note from future briefings and the live feed. The row stays for audit. Use when a blocker is resolved, an uncertainty clarified, or an observation has gone stale. Idempotent. Optional `reason` (max 500 chars).",
      inputSchema: {
        agent_id: agentIdArg,
        note_id: z.string().min(1),
        action: z.enum(['consume', 'archive']).describe('Which lifecycle transition to apply.'),
        stage_slug: z
          .string()
          .min(1)
          .optional()
          .describe("Required for action=consume. Your stage slug (typically your current role). Idempotent — duplicate calls are no-ops."),
        reason: z
          .string()
          .max(500)
          .optional()
          .describe('action=archive only. Optional reason recorded with the archive event.'),
      },
      annotations: { destructiveHint: false, openWorldHint: false },
    },
    trace('update_note', async (args) => {
      if (args.action === 'consume') {
        if (!args.stage_slug) {
          return {
            isError: true,
            content: [{ type: 'text', text: 'action=consume requires stage_slug' }],
            structuredContent: { error: 'stage_slug_required' },
          };
        }
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
      }

      // action === 'archive'
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
        // coordinator so they can call update_subtask({action:'accept'|'reject'})
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
              body: `Subtask ${ctx.subtask_id} is ready for review (status=${args.status}).\n\nCall update_subtask({subtask_id: "${ctx.subtask_id}", action: "accept"}) if it meets the acceptance criteria, or update_subtask({subtask_id: "${ctx.subtask_id}", action: "reject", reason: "..."}) to bounce it back.`,
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
      // docs/archive/coordinator-delegation-via-convoy-spec.md §3.8) — surface
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
            ? 'The peer is asking you to re-decompose this slice. Call update_subtask({action: "cancel", reason: "..."}) on this row and issue fresh spawn_subtask calls with a better-scoped brief.'
            : 'Peer declared itself blocked. Inspect the reason and decide: update_subtask({action: "reject", ...}) (redo), update_subtask({action: "cancel", ...}) (drop), or answer and redispatch.'}`,
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

  // escalate_to_parent ────────────────────────────────────────────
  // Slice 3 of review-stage-robustness. The escape hatch for an agent
  // that's hit a capability denial: instead of "doing it themselves",
  // they escalate back to the convoy coordinator (or operator for
  // top-level tasks). The child task bounces to assigned/is_failed=1
  // and the lock clears.
  server.registerTool(
    'escalate_to_parent',
    {
      title: 'Escalate this task back to its coordinator / operator',
      description:
        "Use when you cannot make further progress yourself — typically after `spawn_subtask` returned `agent_not_coordinator`. The task is bounced to its parent (convoy coordinator, or operator for top-level tasks). After this call, your work on this task is finished.",
      inputSchema: {
        agent_id: agentIdArg,
        task_id: taskIdArg,
        reason: z.string().min(1).max(2000).describe('Why you cannot complete this task. Be specific — the parent uses this to decide what to do.'),
      },
      annotations: { destructiveHint: true, openWorldHint: false },
    },
    trace('escalate_to_parent', async (args) => {
      const { assertAgentActive, clearTaskCompletionLock } = await import('@/lib/authz/agent-task');
      assertAgentActive(args.agent_id);

      const task = queryOne<{ id: string; status: string; assigned_agent_id: string | null; convoy_id: string | null; workspace_id: string; title: string }>(
        `SELECT id, status, assigned_agent_id, convoy_id, workspace_id, title FROM tasks WHERE id = ?`,
        [args.task_id],
      );
      if (!task) {
        return {
          isError: true,
          content: [{ type: 'text', text: `task ${args.task_id} not found` }],
          structuredContent: { error: 'task_not_found' },
        };
      }
      if (task.assigned_agent_id !== args.agent_id) {
        return {
          isError: true,
          content: [{ type: 'text', text: 'You are not assigned to this task; only the assigned agent can escalate it.' }],
          structuredContent: { error: 'agent_not_on_task' },
        };
      }

      // Idempotency: if an escalation activity was logged within the last
      // 60s, return the same response without writing again. Avoids
      // double-escalations when the agent retries after a transient error.
      const recent = queryOne<{ id: string; created_at: string }>(
        `SELECT id, created_at FROM task_activities
         WHERE task_id = ? AND activity_type = 'escalation'
         ORDER BY created_at DESC LIMIT 1`,
        [args.task_id],
      );
      const recentlyEscalated =
        recent && (Date.now() - new Date(recent.created_at).getTime()) < 60_000;
      if (recentlyEscalated) {
        return textResult(`Task ${args.task_id} was already escalated ${recent.created_at}. No-op.`, {
          task_id: args.task_id,
          already_escalated: true,
          escalation_id: recent.id,
        });
      }

      const now = new Date().toISOString();
      let parentTaskId: string | null = null;
      let coordinatorId: string | null = null;

      if (task.convoy_id) {
        // Convoy child — find the convoy parent + its coordinator.
        const convoyRow = queryOne<{ parent_task_id: string; coordinator_id: string | null }>(
          `SELECT c.parent_task_id AS parent_task_id, p.assigned_agent_id AS coordinator_id
             FROM convoys c
             JOIN tasks p ON p.id = c.parent_task_id
            WHERE c.id = ?`,
          [task.convoy_id],
        );
        parentTaskId = convoyRow?.parent_task_id ?? null;
        coordinatorId = convoyRow?.coordinator_id ?? null;
      }

      // Bounce the child task back to assigned with is_failed=1, clear the
      // lock so a future re-dispatch path can pick it up.
      run(
        `UPDATE tasks
            SET status = 'assigned',
                is_failed = 1,
                status_reason = ?,
                updated_at = ?
          WHERE id = ?`,
        [`Failed: child_escalated — ${args.reason.slice(0, 200)}`, now, args.task_id],
      );
      clearTaskCompletionLock(args.task_id);

      // Activity row on the child for audit.
      run(
        `INSERT INTO task_activities (id, task_id, agent_id, activity_type, message, metadata, created_at)
         VALUES (lower(hex(randomblob(16))), ?, ?, 'escalation', ?, ?, ?)`,
        [args.task_id, args.agent_id, `Escalated to parent: ${args.reason}`, JSON.stringify({ reason: args.reason, parent_task_id: parentTaskId }), now],
      );

      if (parentTaskId) {
        // Activity row on parent for the coordinator's feed.
        run(
          `INSERT INTO task_activities (id, task_id, agent_id, activity_type, message, metadata, created_at)
           VALUES (lower(hex(randomblob(16))), ?, ?, 'escalation', ?, ?, ?)`,
          [parentTaskId, args.agent_id, `Child task ${args.task_id} escalated: ${args.reason}`, JSON.stringify({ child_task_id: args.task_id, reason: args.reason }), now],
        );
        run(
          `UPDATE tasks SET status_reason = ?, updated_at = ? WHERE id = ?`,
          [`child_escalated:${args.reason.slice(0, 200)}`, now, parentTaskId],
        );
        if (coordinatorId) {
          // Use the lower-level sendMail (no authz) — the escalating agent
          // is not authz'd on the parent task, but this is a system-driven
          // notification, not an agent-driven message. Mirrors the pattern
          // in stall-detection.ts.
          const { sendMail } = await import('@/lib/mailbox');
          sendMail({
            fromAgentId: coordinatorId,
            toAgentId: coordinatorId,
            subject: `ESCALATION: ${task.title.slice(0, 80)}`,
            body: `Child task ${args.task_id} has been escalated by ${args.agent_id}.\n\n**Reason:** ${args.reason}\n\nThe child is bounced to assigned with is_failed=1. You can: re-decompose via update_subtask, reassign, or board_override.`,
            taskId: parentTaskId,
            push: true,
          }).catch((err: unknown) => {
            console.warn('[escalate_to_parent] coordinator notify failed:', (err as Error).message);
          });
        }
      } else {
        // Top-level task — operator becomes the implicit parent. Flip to
        // needs_user_input and ping the workspace PM.
        run(
          `UPDATE tasks SET status = 'needs_user_input', updated_at = ? WHERE id = ?`,
          [now, args.task_id],
        );
        const { getPmAgent } = await import('@/lib/agents/pm-resolver');
        const pm = getPmAgent(task.workspace_id);
        if (pm) {
          const { sendMail } = await import('@/lib/mailbox');
          sendMail({
            fromAgentId: pm.id,
            toAgentId: pm.id,
            subject: `ESCALATION: ${task.title.slice(0, 80)} (top-level)`,
            body: `Top-level task ${args.task_id} has been escalated by ${args.agent_id}.\n\n**Reason:** ${args.reason}\n\nTask is now needs_user_input. Reassign or board_override to continue.`,
            taskId: args.task_id,
            push: true,
          }).catch((err: unknown) => {
            console.warn('[escalate_to_parent] operator notify failed:', (err as Error).message);
          });
        }
      }

      return textResult(`Escalated task ${args.task_id} to parent. Bounced to assigned with is_failed=1.`, {
        task_id: args.task_id,
        parent_task_id: parentTaskId,
        coordinator_notified: Boolean(coordinatorId),
      });
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
  // — see docs/archive/coordinator-delegation-via-convoy-spec.md.
  server.registerTool(
    'spawn_subtask',
    {
      title: 'Spawn a delegated subtask (coordinator-only)',
      description:
        "Coordinator delegates a slice of its task to a peer by creating a convoy subtask with a declared contract. Every field is mandatory: the peer receives an explicit Delegation Contract (deliverables, acceptance criteria, duration, check-in cadence) and is dispatched via the normal pipeline. Peer sub-delegation is rejected by authz.",
      inputSchema: {
        agent_id: agentIdArg.describe('The calling coordinator agent.'),
        task_id: taskIdArg.describe('The coordinator\'s parent task id.'),
        role: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Peer role to delegate to, e.g. 'builder' / 'tester' / 'reviewer'. Preferred addressing for role-template peers. Use list_peers to see available roles.",
          ),
        peer_agent_id: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Direct MC agent UUID of the peer. Use when you need to disambiguate or address a non-role-template peer. Mutually exclusive with `role` and `peer_gateway_id`.",
          ),
        peer_gateway_id: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Back-compat: gateway id of the peer (e.g. 'mc-pm-default-dev', 'mc-runner-dev'). In the current model only the workspace PM and the org runner have gateway ids; role templates are addressed by `role`. Mutually exclusive with `role` and `peer_agent_id`.",
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
          .describe('Each criterion ≥10 chars. The peer must satisfy all of them for the coordinator to update_subtask({action: "accept"}).'),
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
      const { assertAgentCanActOnTask, AuthzError, setTaskCompletionLock } =
        await import('@/lib/authz/agent-task');
      // Reuse the 'delegate' authz action — same policy (coordinator-only
      // on this task). Action names are internal enum values, not
      // user-facing, so renaming isn't worth a schema change.
      try {
        assertAgentCanActOnTask(args.agent_id, args.task_id, 'delegate');
      } catch (err) {
        // Slice 3 of review-stage-robustness: capability-denial soft-lock.
        // When the caller isn't a coordinator on this task, set the lock
        // and force the next-action to escalate_to_parent. Without this
        // rail the agent would silently switch to "do it myself" mode and
        // strand the task in review with no reviewer.
        if (err instanceof AuthzError && err.code === 'agent_not_coordinator') {
          setTaskCompletionLock(args.task_id, 'agent_not_coordinator');
          return {
            isError: true,
            content: [{
              type: 'text',
              text: 'You are not the coordinator for this task and cannot delegate. The task is now locked pending escalation: your only valid next call is escalate_to_parent({ task_id, agent_id, reason }).',
            }],
            structuredContent: {
              error: 'agent_not_coordinator',
              next_action: 'escalate_to_parent',
              next_action_args_hint: { task_id: args.task_id, agent_id: args.agent_id, reason: '<why I cannot dispatch this myself>' },
              blocked_tools: ['register_deliverable', 'update_task_status', 'submit_evidence'],
            },
          };
        }
        throw err;
      }

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

      // Exactly one addressing axis must be supplied.
      const axes = [args.role, args.peer_agent_id, args.peer_gateway_id].filter(
        (v): v is string => typeof v === 'string' && v.length > 0,
      );
      if (axes.length === 0) {
        return {
          isError: true,
          content: [{
            type: 'text',
            text: 'Specify exactly one of `role` (preferred for role templates), `peer_agent_id` (direct MC UUID), or `peer_gateway_id` (back-compat — PM or org runner only).',
          }],
          structuredContent: { error: 'peer_addressing_missing' },
        };
      }
      if (axes.length > 1) {
        return {
          isError: true,
          content: [{
            type: 'text',
            text: '`role`, `peer_agent_id`, and `peer_gateway_id` are mutually exclusive. Pass only one.',
          }],
          structuredContent: { error: 'peer_addressing_conflict' },
        };
      }

      // Resolve to the parent task's workspace first — every axis below
      // either scopes to it or special-cases the org-global runner.
      const parentWs = queryOne<{ workspace_id: string | null }>(
        'SELECT workspace_id FROM tasks WHERE id = ?',
        [args.task_id],
      )?.workspace_id ?? 'default';

      type PeerRow = {
        id: string;
        name: string;
        role: string | null;
        gateway_agent_id: string | null;
      };
      let peer: PeerRow | undefined;
      let resolvedVia: 'role' | 'peer_agent_id' | 'peer_gateway_id';

      if (args.role) {
        resolvedVia = 'role';
        // Role-template addressing: pick the workspace's primary live
        // agent row for that role. Role templates have gateway_agent_id
        // NULL — that's expected; dispatch routes them through the runner.
        peer = queryOne<PeerRow>(
          `SELECT id, name, role, gateway_agent_id FROM agents
            WHERE role = ?
              AND COALESCE(workspace_id, 'default') = ?
              AND COALESCE(status, 'standby') != 'offline'
              AND COALESCE(is_active, 1) = 1
            ORDER BY updated_at DESC
            LIMIT 1`,
          [args.role, parentWs],
        );
        if (!peer) {
          // Surface whether the role exists anywhere or is unknown so
          // the coordinator can either retarget or escalate.
          const elsewhere = queryAll<{ workspace_id: string | null }>(
            `SELECT workspace_id FROM agents WHERE role = ? AND COALESCE(is_active, 1) = 1 AND COALESCE(status, 'standby') != 'offline'`,
            [args.role],
          );
          return {
            isError: true,
            content: [{
              type: 'text',
              text:
                elsewhere.length > 0
                  ? `No active agent with role "${args.role}" in this workspace (${parentWs}). The role exists in: ${elsewhere.map((r) => r.workspace_id ?? 'default').join(', ')}. Ask the workspace PM to provision a "${args.role}" agent, or call list_peers to see what's available here.`
                  : `No active agent with role "${args.role}" in the catalog. Call list_peers to see available roles.`,
            }],
            structuredContent: {
              error: 'peer_not_found',
              addressing: { role: args.role },
              task_workspace_id: parentWs,
            },
          };
        }
      } else if (args.peer_agent_id) {
        resolvedVia = 'peer_agent_id';
        peer = queryOne<PeerRow>(
          `SELECT id, name, role, gateway_agent_id FROM agents WHERE id = ? LIMIT 1`,
          [args.peer_agent_id],
        );
        if (!peer) {
          return {
            isError: true,
            content: [{
              type: 'text',
              text: `No agent with id "${args.peer_agent_id}". Call list_peers to see the roster.`,
            }],
            structuredContent: {
              error: 'peer_not_found',
              addressing: { peer_agent_id: args.peer_agent_id },
            },
          };
        }
        // Verify the peer is in the parent task's workspace, with one
        // carve-out: the org-global runner lives in workspace_id='default'
        // but is reachable from every workspace.
        const peerWs = queryOne<{ workspace_id: string | null }>(
          'SELECT workspace_id FROM agents WHERE id = ?',
          [args.peer_agent_id],
        )?.workspace_id ?? 'default';
        const isOrgRunner =
          peer.gateway_agent_id === 'mc-runner' ||
          peer.gateway_agent_id === 'mc-runner-dev';
        if (peerWs !== parentWs && !isOrgRunner) {
          return {
            isError: true,
            content: [{
              type: 'text',
              text: `Peer agent "${peer.name}" is in workspace ${peerWs}, not this task's workspace (${parentWs}). Pick a peer from list_peers in this workspace.`,
            }],
            structuredContent: {
              error: 'peer_not_in_workspace',
              addressing: { peer_agent_id: args.peer_agent_id },
              peer_workspace_id: peerWs,
              task_workspace_id: parentWs,
            },
          };
        }
      } else {
        resolvedVia = 'peer_gateway_id';
        const gwId = args.peer_gateway_id as string;
        // Org runner is workspace_id='default' but addressable from any
        // workspace — drop the workspace filter for it. Stale
        // multi-workspace role-bound rows from the old N-gateway model
        // (mc-builder-<ws>, etc.) keep the workspace filter so they
        // don't bleed across workspaces.
        const isOrgRunner = gwId === 'mc-runner' || gwId === 'mc-runner-dev';
        peer = isOrgRunner
          ? queryOne<PeerRow>(
              `SELECT id, name, role, gateway_agent_id FROM agents
                WHERE gateway_agent_id = ?
                LIMIT 1`,
              [gwId],
            )
          : queryOne<PeerRow>(
              `SELECT id, name, role, gateway_agent_id FROM agents
                WHERE gateway_agent_id = ?
                  AND COALESCE(workspace_id, 'default') = ?
                LIMIT 1`,
              [gwId, parentWs],
            );
        if (!peer) {
          const elsewhere = queryAll<{ workspace_id: string | null }>(
            `SELECT workspace_id FROM agents WHERE gateway_agent_id = ?`,
            [gwId],
          );
          if (elsewhere.length > 0) {
            const otherWorkspaces = elsewhere.map((r) => r.workspace_id ?? 'default');
            return {
              isError: true,
              content: [{
                type: 'text',
                text: `Peer "${gwId}" exists but not in this task's workspace (${parentWs}). Found in: ${otherWorkspaces.join(', ')}. In the current 2-gateway model only the workspace PM and the org runner have gateway ids; for builder/tester/reviewer/etc. use \`role: '...'\` instead. Call list_peers to see what's addressable here.`,
              }],
              structuredContent: {
                error: 'peer_not_in_workspace',
                addressing: { peer_gateway_id: gwId },
                task_workspace_id: parentWs,
                found_in_workspaces: otherWorkspaces,
              },
            };
          }
          return {
            isError: true,
            content: [{
              type: 'text',
              text: `No agent with gateway_agent_id "${gwId}" in the catalog. In the current 2-gateway model only the workspace PM and the org runner have gateway ids; for builder/tester/reviewer/etc. use \`role: '...'\`. Call list_peers to see the roster.`,
            }],
            structuredContent: { error: 'peer_not_found', addressing: { peer_gateway_id: gwId } },
          };
        }
      }

      const checkinInterval = args.checkin_interval_minutes ?? 15;

      // For the delegation row + activity log we want a stable peer
      // descriptor regardless of which axis was used to address it.
      // gateway_agent_id may be null for role templates.
      const peerGatewayForLog = peer.gateway_agent_id ?? '';
      const peerRoleForLog = peer.role ?? args.role ?? 'builder';

      const spawn = spawnDelegationSubtask({
        parentTaskId: args.task_id,
        parentAgentId: args.agent_id,
        peerAgentId: peer.id,
        peerGatewayId: peerGatewayForLog,
        suggestedRole: peerRoleForLog,
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
        message: `[delegation_spawned] peer=${peer.name} role=${peerRoleForLog}${peerGatewayForLog ? ` gateway_id=${peerGatewayForLog}` : ''} addressed_via=${resolvedVia} child_task=${spawn.childTaskId} due_at=${spawn.dueAt} slice="${args.slice.replace(/"/g, "'")}"`,
      });

      // Dep gate: if any depends_on_subtask_ids aren't done yet, leave
      // the child task in 'inbox' so dispatchReadyConvoySubtasks (called
      // from acceptSubtaskImpl when a parent dep completes) picks it up
      // later. Without this gate every spawn_subtask immediately ran
      // its briefing through the gateway regardless of declared
      // dependencies — tester/reviewer briefings landed before the
      // builder branch even existed.
      const depIds = args.depends_on_subtask_ids ?? [];
      const unsatisfiedDeps = depIds.length > 0
        ? queryAll<{ id: string; task_status: string }>(
            `SELECT cs.id, t.status as task_status
               FROM convoy_subtasks cs JOIN tasks t ON t.id = cs.task_id
              WHERE cs.id IN (${depIds.map(() => '?').join(',')})`,
            depIds,
          ).filter(r => r.task_status !== 'done').map(r => r.id)
        : [];

      if (unsatisfiedDeps.length > 0) {
        logActivity({
          taskId: args.task_id,
          actingAgentId: args.agent_id,
          activityType: 'updated',
          message: `[delegation_queued] child_task=${spawn.childTaskId} awaiting_deps=${unsatisfiedDeps.join(',')}`,
        });
        const payload = {
          subtask_id: spawn.subtaskId,
          child_task_id: spawn.childTaskId,
          convoy_id: spawn.convoyId,
          peer: {
            id: peer.id,
            name: peer.name,
            role: peerRoleForLog,
            gateway_agent_id: peer.gateway_agent_id,
            addressed_via: resolvedVia,
          },
          dispatched_at: null,
          due_at: spawn.dueAt,
          checkin_interval_minutes: checkinInterval,
          awaiting_deps: unsatisfiedDeps,
        };
        return textResult(
          `Queued subtask ${spawn.subtaskId} to ${peer.name} (role: ${peerRoleForLog}). Awaiting ${unsatisfiedDeps.length} dependenc${unsatisfiedDeps.length === 1 ? 'y' : 'ies'}; dispatches automatically when each dep is accepted.`,
          payload,
        );
      }

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
        // should see this explicitly and can call update_subtask({action:'cancel'}) +
        // retry. We do NOT auto-rollback: the convoy row is real,
        // half-done is visible, no silent data loss.
        return {
          isError: true,
          content: [{
            type: 'text',
            text: `Subtask ${spawn.subtaskId} created but dispatch failed: ${dispatchError}. The subtask row exists — call update_subtask({action: "cancel", reason: "..."}) to release it, or retry.`,
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
        peer: {
          id: peer.id,
          name: peer.name,
          role: peerRoleForLog,
          gateway_agent_id: peer.gateway_agent_id,
          addressed_via: resolvedVia,
        },
        dispatched_at: spawn.dispatchedAt,
        due_at: spawn.dueAt,
        checkin_interval_minutes: checkinInterval,
      };
      const peerLabel = peer.gateway_agent_id
        ? `${peer.name} (${peer.gateway_agent_id})`
        : `${peer.name} (role: ${peerRoleForLog})`;
      return textResult(
        `Spawned subtask ${spawn.subtaskId} to ${peerLabel}. Due at ${spawn.dueAt}; check-in cadence ${checkinInterval}m.`,
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

  // update_subtask ────────────────────────────────────────────────
  // Single entry-point for the subtask lifecycle. The action handler
  // helpers below preserve the exact behavior of the previous
  // accept_subtask / reject_subtask / cancel_subtask tools.
  server.registerTool(
    'update_subtask',
    {
      title: 'Accept, reject, or cancel a delegated subtask (coordinator-only)',
      description:
        "Single entry-point for the subtask lifecycle. Pick one of three actions:\n" +
        "- `accept` — the peer's deliverables meet your acceptance criteria. Promotes the child task to done. No extra fields needed.\n" +
        "- `reject` — bounce the subtask back to in_progress with a reason the peer reads. Use when deliverables exist but don't meet criteria. Requires `reason` (≥10 chars). Optional `new_acceptance_criteria` replaces the convoy_subtasks.acceptance_criteria for the next round.\n" +
        "- `cancel` — release the subtask entirely (scope change, dead branch, demonstrably stuck). The child task moves to cancelled and the convoy's failed_subtasks counter bumps so the subtask no longer blocks completion. Requires `reason` (≥5 chars).",
      inputSchema: {
        agent_id: agentIdArg,
        subtask_id: z.string().min(1).describe('The convoy_subtasks row id from spawn_subtask.'),
        action: z.enum(['accept', 'reject', 'cancel']).describe('Which lifecycle transition to apply.'),
        reason: z
          .string()
          .min(5)
          .max(2000)
          .optional()
          .describe(
            'Required for action=reject (≥10 chars) and action=cancel (≥5 chars). Shown to the peer on re-dispatch (reject) or recorded as status_reason (cancel).',
          ),
        new_acceptance_criteria: z
          .array(z.string().min(10).max(500))
          .optional()
          .describe(
            'action=reject only — when provided, replaces convoy_subtasks.acceptance_criteria for the next round.',
          ),
      },
      annotations: { destructiveHint: true, openWorldHint: false },
    },
    trace('update_subtask', async (args) => {
      switch (args.action) {
        case 'accept':
          return acceptSubtaskImpl({ agent_id: args.agent_id, subtask_id: args.subtask_id });
        case 'reject':
          if (!args.reason || args.reason.length < 10) {
            return {
              isError: true,
              content: [{ type: 'text', text: 'action=reject requires reason (≥10 chars)' }],
              structuredContent: { error: 'reason_required' },
            };
          }
          return rejectSubtaskImpl({
            agent_id: args.agent_id,
            subtask_id: args.subtask_id,
            reason: args.reason,
            new_acceptance_criteria: args.new_acceptance_criteria,
          });
        case 'cancel':
          if (!args.reason || args.reason.length < 5) {
            return {
              isError: true,
              content: [{ type: 'text', text: 'action=cancel requires reason (≥5 chars)' }],
              structuredContent: { error: 'reason_required' },
            };
          }
          return cancelSubtaskImpl({
            agent_id: args.agent_id,
            subtask_id: args.subtask_id,
            reason: args.reason,
          });
      }
    }),
  );

  // ── Phase J: subagent dispatch registration ──────────────────────
  // register_subagent_dispatch
  // Called by the workspace PM right after `sessions_spawn` returns.
  // Writes a row in mc_sessions correlating the openclaw runId +
  // childSessionKey with the (task | initiative | recurring_job, role,
  // attempt) tuple. Without this, MC has no way to attribute subagent
  // activity (notes, deliverables, status transitions) to the right
  // dispatch.
  // See docs/reference/scope-keyed-sessions-phase-j.md §D3.
  server.registerTool(
    'register_subagent_dispatch',
    {
      title: 'Register an openclaw subagent dispatch in mc_sessions',
      description:
        "After calling openclaw `sessions_spawn`, call this with the runId + childSessionKey + scope context. MC records the subagent in mc_sessions so deliverables, notes, and status transitions land on the correct (task, role, attempt) tuple. Idempotent on scope_key.",
      inputSchema: {
        agent_id: agentIdArg,
        run_id: z
          .string()
          .min(1)
          .describe(
            'The runId returned by openclaw `sessions_spawn`. Used to correlate `subagent_ended` events back to this dispatch.',
          ),
        child_session_key: z
          .string()
          .min(1)
          .describe(
            'The childSessionKey returned by openclaw `sessions_spawn` (shape: agent:<parentId>:subagent:<uuid>). Stored as mc_sessions.scope_key.',
          ),
        role: z
          .enum([
            'pm',
            'coordinator',
            'builder',
            'researcher',
            'tester',
            'reviewer',
            'writer',
            'learner',
          ])
          .describe('Role the subagent is dispatched to perform.'),
        scope_type: z
          .enum(['task_role', 'recurring', 'heartbeat'])
          .describe('Why this subagent was spawned. task_role = per-task worker dispatch.'),
        task_id: z.string().min(1).optional().describe('Task UUID for task_role spawns.'),
        initiative_id: z.string().min(1).optional().describe('Initiative UUID for initiative-scoped spawns.'),
        recurring_job_id: z.string().min(1).optional().describe('Recurring job UUID for scope_type=recurring.'),
        attempt: z
          .number()
          .int()
          .positive()
          .default(1)
          .describe('Attempt number (1 = first dispatch, 2 = retry, etc.).'),
      },
      annotations: { destructiveHint: false, openWorldHint: false },
    },
    trace('register_subagent_dispatch', async (args) => {
      assertAgentActive(args.agent_id);
      const workspaceId = deriveWorkspaceFromAgent(args.agent_id);
      const result = upsertSession({
        scope_key: args.child_session_key,
        workspace_id: workspaceId,
        role: args.role,
        scope_type: args.scope_type as ScopeType,
        task_id: args.task_id ?? null,
        initiative_id: args.initiative_id ?? null,
        recurring_job_id: args.recurring_job_id ?? null,
        attempt: args.attempt,
        run_id: args.run_id,
      });
      const payload = {
        scope_key: result.session.scope_key,
        run_id: result.session.run_id,
        workspace_id: result.session.workspace_id,
        role: result.session.role,
        scope_type: result.session.scope_type,
        task_id: result.session.task_id,
        initiative_id: result.session.initiative_id,
        recurring_job_id: result.session.recurring_job_id,
        attempt: result.session.attempt,
        status: result.session.status,
        is_new: result.is_new,
      };
      return textResult(JSON.stringify(payload, null, 2), payload);
    }),
  );
}
