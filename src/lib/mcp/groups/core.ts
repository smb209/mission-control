/**
 * Core MCP tools — identity, peers, workspace context, and the lightweight
 * activity / notes primitives.
 *
 * Tools: whoami, get_workspace_context, list_peers, log_activity,
 * take_note, read_notes.
 *
 * Behavior is unchanged from the legacy `tools.ts` consolidation; this is
 * a pure relocation as part of the MCP surface refactor (PR 1).
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { queryAll, queryOne } from '@/lib/db';
import { resolveWorkspacePath } from '@/lib/config';
import {
  resolveVariables,
  type VariableSource,
} from '@/lib/workspace-conventions/resolve-variables';
import { logActivity } from '@/lib/services/task-activities';
import { postPmChatMessage } from '@/lib/agents/pm-dispatch';
import {
  createNote,
  listNotes,
  parseAttachedFiles,
  AgentNoteValidationError,
  NOTE_BODY_MAX,
  type NoteImportance,
  type NoteKind,
} from '@/lib/db/agent-notes';
import {
  isAuditNoteKind,
  validateAuditNoteBody,
  MAX_AUDIT_NOTE_BODY_CHARS,
} from '@/lib/agents/audit-proposals/schemas';
import { getRunByGroupId } from '@/lib/db/agent-runs';
import { broadcast } from '@/lib/events';

import {
  agentIdArg,
  taskIdArg,
  textResult,
  trace,
  deriveWorkspaceFromAgent,
  noteKindArg,
  noteImportanceArg,
  noteToPayload,
} from '../shared';

export function registerCoreTools(server: McpServer): void {
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
      const ws = queryOne<{
        id: string;
        slug: string;
        name: string;
        context_md: string | null;
        workspace_path: string | null;
        repo_url: string | null;
        default_base_branch: string | null;
      }>(
        `SELECT id, slug, name, context_md, workspace_path, repo_url, default_base_branch
           FROM workspaces WHERE id = ?`,
        [me.workspace_id],
      );

      const working_dir = ws
        ? (ws.workspace_path && ws.workspace_path.trim()) ||
          resolveWorkspacePath(ws.slug, null)
        : '';

      // Resolve {{...}} tokens in the conventions text so agents see
      // working_dir / repo_url etc. expanded rather than the literal
      // template variables. Spec §3.
      const variableSrc: VariableSource = {
        name: ws?.name ?? '',
        working_dir,
        deliverables: working_dir,
        repo_url: ws?.repo_url ?? null,
        base_branch: ws?.default_base_branch ?? null,
      };
      const resolved_context_md = resolveVariables(ws?.context_md ?? null, variableSrc);

      const payload = {
        workspace_id: me.workspace_id,
        workspace_name: ws?.name ?? null,
        // Raw markdown — what's stored in the DB. Kept for back-compat
        // with callers that already round-trip this exact field.
        context_md: ws?.context_md ?? null,
        // {{token}}-resolved variant — what agents should prefer.
        resolved_context_md: resolved_context_md || null,
        working_dir,
        repo_url: ws?.repo_url ?? null,
        base_branch: ws?.default_base_branch ?? null,
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
  // take_note / read_notes
  // See specs/scope-keyed-sessions.md §3 for the full design.

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
          .describe(
            `REQUIRED. Concrete > aspirational. One thought per note. Hard limit ${NOTE_BODY_MAX} characters. If your finding doesn't fit (e.g. a multi-section audit report), attach the full report as a deliverable via register_deliverable and use this body for a tight summary + verdict + link only. Reference file paths in attached_files.`,
          ),
        scope_key: z
          .string()
          .min(1)
          .describe(
            'REQUIRED. The openclaw sessionKey you are running under. Take this verbatim from your dispatch briefing.',
          ),
        role: z
          .string()
          .min(1)
          .describe(
            "REQUIRED. Your role-of-the-moment ('builder', 'tester', 'pm', 'researcher', etc.). From the briefing.",
          ),
        run_group_id: z
          .string()
          .min(1)
          .describe(
            'REQUIRED. UUID minted at session start that groups all notes from one run/stage. From the briefing.',
          ),
        task_id: z
          .string()
          .optional()
          .describe('Optional. Set when the note relates to a specific task.'),
        initiative_id: z
          .string()
          .optional()
          .describe(
            'Optional. Set when the note relates to an initiative directly (no task scope).',
          ),
        audience: z
          .string()
          .optional()
          .describe(
            "Optional. Who this note is for: 'pm', 'reviewer', 'next-stage', 'tester', etc. Omit for anyone.",
          ),
        attached_files: z
          .array(z.string())
          .optional()
          .describe(
            'Optional. File paths the note references. Helps the next session navigate without re-reading.',
          ),
        importance: noteImportanceArg.optional(),
      },
      annotations: { destructiveHint: false, openWorldHint: false },
    },
    trace('take_note', async (args) => {
      try {
        // Refuse writes from a worker whose run was already cancelled
        // by the operator. Without this guard, the openclaw worker
        // (which isn't actually killed when agent_runs.status flips to
        // 'cancelled') keeps executing tools and can leave orphan
        // notes — see specs/dedupe-investigations.md and the May 7
        // duplicate-audit incident.
        const owningRun = getRunByGroupId(args.run_group_id);
        if (owningRun && owningRun.status === 'cancelled') {
          const message =
            `Refusing to write note: run ${owningRun.id} (run_group_id=${args.run_group_id}) was cancelled. ` +
            `Stop work and exit cleanly.`;
          return {
            isError: true,
            content: [{ type: 'text', text: message }],
            structuredContent: { error: 'run_cancelled', message, run_id: owningRun.id },
          };
        }

        // Audit-pipeline kinds (audit_manifest / audit_proposal /
        // audit_synthesis) carry a JSON-stringified body that must
        // match a strict Zod schema and stay under the orchestrator's
        // pre-cap budget. Validation runs here so auditor agents get
        // structured feedback in the same dispatch and can retry by
        // tightening rationale / fixing the schema. See
        // specs/subtree-audit-proposals-spec.md §4 + §5.2.
        const noteKind = args.kind as NoteKind;
        if (isAuditNoteKind(noteKind)) {
          if (args.body.length > MAX_AUDIT_NOTE_BODY_CHARS) {
            const message =
              `Body exceeds ${MAX_AUDIT_NOTE_BODY_CHARS} chars (got ${args.body.length}). ` +
              `Tighten the rationale or split via continuation_note_id (see spec §4.5).`;
            return {
              isError: true,
              content: [{ type: 'text', text: message }],
              structuredContent: {
                error: 'audit_body_too_large',
                message,
                limit: MAX_AUDIT_NOTE_BODY_CHARS,
                got: args.body.length,
                kind: noteKind,
              },
            };
          }
          const validation = validateAuditNoteBody(noteKind, args.body);
          if (!validation.ok) {
            return {
              isError: true,
              content: [{ type: 'text', text: validation.error }],
              structuredContent: {
                error: 'audit_body_invalid',
                message: validation.error,
                kind: noteKind,
              },
            };
          }
        }

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
}
