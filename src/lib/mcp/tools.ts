/**
 * sc-mission-control MCP tools.
 *
 * All 11 tools consolidated into one file. Each tool is a thin wrapper
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

import { queryAll, queryOne } from '@/lib/db';
import { AuthzError, assertAgentActive } from '@/lib/authz/agent-task';
import { authzErrorToToolResult, internalErrorToToolResult } from './errors';
import { logMcpToolCall } from './debug';

import { registerDeliverable } from '@/lib/services/task-deliverables';
import { logActivity } from '@/lib/services/task-activities';
import { transitionTaskStatus } from '@/lib/services/task-status';
import { failTask } from '@/lib/services/task-failure';
import { saveTaskCheckpoint } from '@/lib/services/task-checkpoint';
import { sendAgentMail } from '@/lib/services/agent-mailbox';
import { getUnreadMail } from '@/lib/mailbox';
import { getOpenClawClient } from '@/lib/openclaw/client';

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
        error: result.isError
          ? result.structuredContent &&
            typeof result.structuredContent === 'object' &&
            'message' in result.structuredContent
            ? String((result.structuredContent as { message?: unknown }).message)
            : 'tool returned isError'
          : undefined,
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

function textResult(text: string, structured?: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: 'text', text }],
    ...(structured ? { structuredContent: structured } : {}),
  };
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
      inputSchema: { agent_id: agentIdArg },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    trace('whoami', async ({ agent_id }) => {
      const me = queryOne<{
        id: string;
        name: string;
        role: string;
        workspace_id: string;
        gateway_agent_id: string | null;
        is_active: number | null;
      }>(
        `SELECT id, name, role, workspace_id, gateway_agent_id, is_active
           FROM agents WHERE id = ? LIMIT 1`,
        [agent_id],
      );
      if (!me) {
        return {
          isError: true,
          content: [{ type: 'text', text: `agent ${agent_id} not found` }],
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
        [me.workspace_id, agent_id, agent_id],
      );

      const peers = queryAll<{ id: string; gateway_agent_id: string; name: string; role: string }>(
        `SELECT id, gateway_agent_id, name, role FROM agents
          WHERE workspace_id = ?
            AND gateway_agent_id IS NOT NULL AND gateway_agent_id != ''
            AND id != ?`,
        [me.workspace_id, agent_id],
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
    trace('get_task', async ({ task_id }) => {
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
      const summary = {
        deliverable: result.deliverable,
        file_exists: result.fileExists,
        normalized_path: result.normalizedPath,
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
      return textResult(JSON.stringify(activity, null, 2), { activity });
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

  // delegate ──────────────────────────────────────────────────────
  // Coordinator-only. Atomically (a) sends the peer an openclaw session
  // message and (b) logs a [DELEGATION] audit activity so the existing
  // coordinator-audit sees the delegation happened. Replaces the two-step
  // curl+sessions_send dance the coordinator does today.
  server.registerTool(
    'delegate',
    {
      title: 'Delegate a slice of work to a peer (coordinator-only)',
      description:
        "Coordinator sends a work slice to a named peer via OpenClaw sessions_send and auto-logs the required [DELEGATION] audit activity. Authorization enforces the caller is the task's coordinator. Use per-task session keys (agent:<peer_gateway_id>:task-<task_id>) — do NOT target :main.",
      inputSchema: {
        agent_id: agentIdArg.describe('The calling coordinator agent.'),
        task_id: taskIdArg,
        peer_gateway_id: z
          .string()
          .min(1)
          .describe(
            "Gateway id of the peer to delegate to, e.g. 'mc-researcher'. Use list_peers to discover.",
          ),
        slice: z
          .string()
          .min(1)
          .max(10000)
          .describe('One-line description of the work slice this peer owns.'),
        message: z
          .string()
          .min(1)
          .describe(
            "The full message to send to the peer's session. Should include role framing ('You are the <role> for this task'), goal, context, success criteria.",
          ),
        timeout_seconds: z
          .number()
          .int()
          .min(0)
          .max(600)
          .optional()
          .describe('0 for fire-and-forget parallel fan-out (recommended).'),
      },
      annotations: { destructiveHint: true, openWorldHint: false },
    },
    trace('delegate', async (args) => {
      // Authorize explicitly — the service layer doesn't own the delegate
      // action since there's no single "delegate service"; this tool
      // composes sessions_send + log_activity.
      const { assertAgentCanActOnTask } = await import('@/lib/authz/agent-task');
      assertAgentCanActOnTask(args.agent_id, args.task_id, 'delegate');

      // Resolve peer gateway id to a human name for the audit message.
      const peer = queryOne<{ id: string; name: string }>(
        `SELECT id, name FROM agents WHERE gateway_agent_id = ? LIMIT 1`,
        [args.peer_gateway_id],
      );
      if (!peer) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `No agent with gateway_agent_id "${args.peer_gateway_id}" in the catalog. Call list_peers to see the roster.`,
            },
          ],
          structuredContent: {
            error: 'peer_not_found',
            peer_gateway_id: args.peer_gateway_id,
          },
        };
      }

      const client = getOpenClawClient();
      if (!client.isConnected()) {
        await client.connect();
      }

      // Per-task session key avoids :main contention (see dispatch/route.ts
      // post-mortem for task cc3d40e1 — :main delegations were aborted).
      const sessionKey = `agent:${args.peer_gateway_id}:task-${args.task_id}`;

      // We use `chat.send` (not `sessions.send`) — same RPC the dispatch
      // route uses — because it implicitly creates the session on first
      // send. `sessions.send` requires the session to already exist and
      // fails with "session not found" for a fresh per-task key. The
      // observed live failure was:
      //
      //   invalid sessions.send params: must have required property 'key';
      //   at root: unexpected property 'sessionKey'; at root: unexpected
      //   property 'timeoutSeconds'
      //
      // fixed by moving to chat.send, whose param shape is
      // `{sessionKey, message, idempotencyKey}`. The `timeout_seconds`
      // argument on the MCP tool is now advisory-only: chat.send is
      // fire-and-forget by default; the gateway decides session lifecycle.
      // We keep the argument on the tool schema for forward-compat.
      const idempotencyKey = `delegate-${args.task_id}-${args.peer_gateway_id}-${Date.now()}`;
      let sendResult: Record<string, unknown> = {};
      try {
        sendResult = ((await client.call('chat.send', {
          sessionKey,
          message: args.message,
          idempotencyKey,
        })) as Record<string, unknown>) ?? {};
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `sessions.send failed: ${(err as Error).message}`,
            },
          ],
          structuredContent: {
            error: 'sessions_send_failed',
            message: (err as Error).message,
          },
        };
      }

      const toolCallId =
        (sendResult.tool_call_id as string | undefined) ||
        (sendResult.run_id as string | undefined) ||
        'unknown';
      const auditMessage = `[DELEGATION] target="${peer.name}" gateway_id="${args.peer_gateway_id}" tool_call_id="${toolCallId}" slice="${args.slice.replace(/"/g, "'")}"`;

      // Log the audit activity via the same service so coordinator-audit
      // sees it. Authz re-runs inside logActivity — coordinator must also
      // be on the task to post activities (they are, since delegate just
      // passed).
      const activity = logActivity({
        taskId: args.task_id,
        actingAgentId: args.agent_id,
        activityType: 'updated',
        message: auditMessage,
      });

      const payload = {
        peer: { id: peer.id, name: peer.name, gateway_agent_id: args.peer_gateway_id },
        session_key: sessionKey,
        session_send: sendResult,
        audit_activity_id: activity.id,
      };
      return textResult(
        `Delegated to ${peer.name} (${args.peer_gateway_id}). Audit logged as activity ${activity.id}.`,
        payload,
      );
    }),
  );
}
