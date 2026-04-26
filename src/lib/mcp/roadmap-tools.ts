/**
 * Roadmap & PM MCP tools (Phase 5).
 *
 * Registered alongside the core sc-mission-control tools (registerAllTools
 * in ./tools.ts). Split into a separate file purely for readability —
 * tools.ts already covers the task-execution surface.
 *
 * Tool families:
 *
 *   - Read tools (§11.1 of the spec): list_initiatives, get_initiative,
 *     get_initiative_tree, get_roadmap_snapshot, get_initiative_history,
 *     get_task_initiative_history, list_owner_availability,
 *     get_velocity_data, list_proposals.
 *
 *   - General writes (§11.2, persona-gated by the agent's soul_md):
 *     create_initiative, update_initiative, move_initiative,
 *     convert_initiative, add_initiative_dependency,
 *     remove_initiative_dependency, move_task_to_initiative,
 *     promote_initiative_to_task, promote_task_to_inbox,
 *     add_owner_availability.
 *
 *   - PM-specific (§11.3): propose_changes, refine_proposal,
 *     preview_derivation.
 *
 * Authn/authz: same as the core tools — bearer at the transport,
 * `agent_id` arg on every state-changing tool. The PM agent's soul_md
 * forbids it from calling the general-write tools (it's persona policy,
 * not enforced by the server). Spec §9.4: "PM is a suggester, never an
 * actor."
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { queryOne } from '@/lib/db';
import {
  createInitiative,
  updateInitiative,
  moveInitiative,
  convertInitiative,
  addInitiativeDependency,
  removeInitiativeDependency,
  getInitiative,
  getInitiativeTree,
  getInitiativeHistory,
  listInitiatives,
  moveTaskToInitiative,
  type InitiativeKind,
  type InitiativeStatus,
} from '@/lib/db/initiatives';
import {
  promoteInitiativeToTask,
  promoteTaskToInbox,
  getTaskInitiativeHistory,
} from '@/lib/db/promotion';
import {
  createOwnerAvailability,
  listOwnerAvailability,
} from '@/lib/db/owner-availability';
import { getRoadmapSnapshot } from '@/lib/db/roadmap';
import { computeVelocity } from '@/lib/roadmap/velocity';
import { previewDerivation } from '@/lib/roadmap/apply-derivation';
import {
  createProposal,
  listProposals,
  refineProposal as refineProposalDb,
  type PmDiff,
  type PmProposalStatus,
  PmProposalValidationError,
} from '@/lib/db/pm-proposals';
import { dispatchPm } from '@/lib/agents/pm-dispatch';

const agentIdArg = z
  .string()
  .min(1)
  .describe("The calling agent's MC agent_id (see whoami)");

function textResult(text: string, structured?: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: 'text', text }],
    ...(structured ? { structuredContent: structured } : {}),
  };
}

function errorResult(message: string, code: string, extra: Record<string, unknown> = {}): CallToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: message }],
    structuredContent: { error: code, message, ...extra },
  };
}

function safeWrap<T>(fn: () => T): CallToolResult {
  try {
    const result = fn();
    return textResult(JSON.stringify(result, null, 2), result as Record<string, unknown>);
  } catch (err) {
    if (err instanceof PmProposalValidationError) {
      return errorResult(err.message, 'validation_failed', { hints: err.hints });
    }
    const msg = err instanceof Error ? err.message : String(err);
    return errorResult(msg, 'internal_error');
  }
}

async function safeWrapAsync<T>(fn: () => Promise<T>): Promise<CallToolResult> {
  try {
    const result = await fn();
    return textResult(JSON.stringify(result, null, 2), result as Record<string, unknown>);
  } catch (err) {
    if (err instanceof PmProposalValidationError) {
      return errorResult(err.message, 'validation_failed', { hints: err.hints });
    }
    const msg = err instanceof Error ? err.message : String(err);
    return errorResult(msg, 'internal_error');
  }
}

const KINDS = z.enum(['theme', 'milestone', 'epic', 'story']);
const INIT_STATUSES = z.enum([
  'planned',
  'in_progress',
  'at_risk',
  'blocked',
  'done',
  'cancelled',
]);
const DEP_KINDS = z.enum(['finish_to_start', 'start_to_start', 'blocking', 'informational']);

// Diff schema mirrors PmDiff shape exactly. We use z.discriminatedUnion so
// MCP clients get accurate error messages on bad payloads.
const DiffSchema = z.discriminatedUnion('kind', [
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
    status: z.enum(['planned', 'in_progress', 'at_risk', 'blocked']),
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
]);

export function registerRoadmapTools(server: McpServer): void {
  // ─── Read tools ───────────────────────────────────────────────────

  server.registerTool(
    'list_initiatives',
    {
      title: 'List initiatives',
      description: 'Filter the planning tree by workspace, product, parent, status, or kind.',
      inputSchema: {
        agent_id: agentIdArg,
        workspace_id: z.string().min(1).optional(),
        product_id: z.string().nullish(),
        parent_initiative_id: z.string().nullish(),
        kind: KINDS.optional(),
        status: INIT_STATUSES.optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => safeWrap(() =>
      listInitiatives({
        workspace_id: args.workspace_id,
        product_id: args.product_id ?? undefined,
        parent_id: args.parent_initiative_id === null
          ? null
          : args.parent_initiative_id ?? undefined,
        kind: args.kind as InitiativeKind | undefined,
        status: args.status as InitiativeStatus | undefined,
      }),
    ),
  );

  server.registerTool(
    'get_initiative',
    {
      title: 'Fetch one initiative',
      description: 'Returns the row plus optional descendant tree and tasks.',
      inputSchema: {
        agent_id: agentIdArg,
        id: z.string().min(1),
        include_descendants: z.boolean().optional(),
        include_tasks: z.boolean().optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => safeWrap(() => {
      const init = getInitiative(args.id, {
        includeChildren: args.include_descendants,
        includeTasks: args.include_tasks,
      });
      if (!init) throw new Error(`initiative ${args.id} not found`);
      return init;
    }),
  );

  server.registerTool(
    'get_initiative_tree',
    {
      title: 'Fetch the initiative tree for a workspace',
      description: 'Hierarchical list, useful for PM context.',
      inputSchema: {
        agent_id: agentIdArg,
        workspace_id: z.string().min(1),
        root_id: z.string().optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => safeWrap(() => getInitiativeTree(args.workspace_id, args.root_id)),
  );

  server.registerTool(
    'get_roadmap_snapshot',
    {
      title: 'Fetch a roadmap snapshot',
      description:
        'Flattened initiatives + tasks + dependencies + owner_availability for a workspace. The PM agent uses this as input to its impact analysis.',
      inputSchema: {
        agent_id: agentIdArg,
        workspace_id: z.string().min(1),
        product_id: z.string().nullish(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => safeWrap(() =>
      getRoadmapSnapshot({ workspace_id: args.workspace_id, product_id: args.product_id ?? undefined }),
    ),
  );

  server.registerTool(
    'get_initiative_history',
    {
      title: 'Fetch initiative parent-change history',
      description: 'Audit log of every move (re-parent) of this initiative.',
      inputSchema: { agent_id: agentIdArg, id: z.string().min(1) },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => safeWrap(() => getInitiativeHistory(args.id)),
  );

  server.registerTool(
    'get_task_initiative_history',
    {
      title: 'Fetch task → initiative provenance trail',
      description: 'Every initiative this task has been associated with, in order.',
      inputSchema: { agent_id: agentIdArg, task_id: z.string().min(1) },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => safeWrap(() => getTaskInitiativeHistory(args.task_id)),
  );

  server.registerTool(
    'list_owner_availability',
    {
      title: 'List owner-availability windows',
      description: 'Filter by agent_id or by an overlap window.',
      inputSchema: {
        agent_id: agentIdArg,
        for_agent_id: z.string().optional(),
        between_start: z.string().nullish(),
        between_end: z.string().nullish(),
        workspace_id: z.string().optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => safeWrap(() =>
      listOwnerAvailability({
        agent_id: args.for_agent_id,
        between_start: args.between_start ?? undefined,
        between_end: args.between_end ?? undefined,
        workspace_id: args.workspace_id,
      }),
    ),
  );

  server.registerTool(
    'get_velocity_data',
    {
      title: 'Fetch per-owner velocity ratio',
      description: 'Returns the actual/estimated ratio for completed tasks. Defaults to 1.0 when no history.',
      inputSchema: {
        agent_id: agentIdArg,
        owner_agent_id: z.string().min(1),
        since_days: z.number().int().min(1).max(365).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => safeWrap(() => ({
      owner_agent_id: args.owner_agent_id,
      ratio: computeVelocity({ owner_agent_id: args.owner_agent_id, since_days: args.since_days }),
    })),
  );

  server.registerTool(
    'list_proposals',
    {
      title: 'List PM proposals',
      description: 'Filter by workspace, status, or since-date.',
      inputSchema: {
        agent_id: agentIdArg,
        workspace_id: z.string().optional(),
        status: z.enum(['draft', 'accepted', 'rejected', 'superseded']).optional(),
        since: z.string().optional(),
        limit: z.number().int().min(1).max(200).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => safeWrap(() =>
      listProposals({
        workspace_id: args.workspace_id,
        status: args.status as PmProposalStatus | undefined,
        since: args.since,
        limit: args.limit,
      }),
    ),
  );

  // ─── General write tools (persona-gated) ──────────────────────────

  server.registerTool(
    'create_initiative',
    {
      title: 'Create an initiative',
      description: 'NOT for the PM agent — PM uses propose_changes. Other personas may use this freely.',
      inputSchema: {
        agent_id: agentIdArg,
        workspace_id: z.string().min(1),
        kind: KINDS,
        title: z.string().min(1).max(500),
        product_id: z.string().nullish(),
        parent_initiative_id: z.string().nullish(),
        description: z.string().optional(),
        owner_agent_id: z.string().nullish(),
        target_start: z.string().nullish(),
        target_end: z.string().nullish(),
        committed_end: z.string().nullish(),
      },
      annotations: { destructiveHint: true, openWorldHint: false },
    },
    async (args) => safeWrap(() =>
      createInitiative({
        workspace_id: args.workspace_id,
        kind: args.kind as InitiativeKind,
        title: args.title,
        product_id: args.product_id ?? null,
        parent_initiative_id: args.parent_initiative_id ?? null,
        description: args.description ?? null,
        owner_agent_id: args.owner_agent_id ?? null,
        target_start: args.target_start ?? null,
        target_end: args.target_end ?? null,
        committed_end: args.committed_end ?? null,
      }),
    ),
  );

  server.registerTool(
    'update_initiative',
    {
      title: 'Update an initiative (PATCH semantics)',
      description: 'Partial update. NOT for the PM agent.',
      inputSchema: {
        agent_id: agentIdArg,
        id: z.string().min(1),
        patch: z.record(z.string(), z.unknown()),
      },
      annotations: { destructiveHint: true, openWorldHint: false },
    },
    async (args) => safeWrap(() => updateInitiative(args.id, args.patch as Record<string, never>)),
  );

  server.registerTool(
    'move_initiative',
    {
      title: 'Re-parent an initiative',
      description: 'Audited via initiative_parent_history. NOT for the PM.',
      inputSchema: {
        agent_id: agentIdArg,
        id: z.string().min(1),
        to_parent_id: z.string().nullable(),
        reason: z.string().optional(),
      },
      annotations: { destructiveHint: true, openWorldHint: false },
    },
    async (args) => safeWrap(() =>
      moveInitiative(args.id, args.to_parent_id, args.agent_id, args.reason ?? null),
    ),
  );

  server.registerTool(
    'convert_initiative',
    {
      title: 'Change an initiative kind',
      description: 'Story → epic, etc. Emits an events row. NOT for the PM.',
      inputSchema: { agent_id: agentIdArg, id: z.string().min(1), new_kind: KINDS },
      annotations: { destructiveHint: true, openWorldHint: false },
    },
    async (args) => safeWrap(() =>
      convertInitiative(args.id, args.new_kind as InitiativeKind, args.agent_id),
    ),
  );

  server.registerTool(
    'add_initiative_dependency',
    {
      title: 'Add a dependency edge',
      description: 'Many-to-many. UNIQUE on (initiative_id, depends_on_initiative_id).',
      inputSchema: {
        agent_id: agentIdArg,
        initiative_id: z.string().min(1),
        depends_on_initiative_id: z.string().min(1),
        kind: DEP_KINDS.optional(),
        note: z.string().optional(),
      },
      annotations: { destructiveHint: true, openWorldHint: false },
    },
    async (args) => safeWrap(() =>
      addInitiativeDependency({
        initiative_id: args.initiative_id,
        depends_on_initiative_id: args.depends_on_initiative_id,
        kind: args.kind,
        note: args.note,
      }),
    ),
  );

  server.registerTool(
    'remove_initiative_dependency',
    {
      title: 'Remove a dependency edge by id',
      description: 'No-op when the edge is already gone.',
      inputSchema: { agent_id: agentIdArg, dependency_id: z.string().min(1) },
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) => safeWrap(() => {
      removeInitiativeDependency(args.dependency_id);
      return { dependency_id: args.dependency_id, removed: true };
    }),
  );

  server.registerTool(
    'move_task_to_initiative',
    {
      title: 'Re-parent a task to a different initiative',
      description: 'Writes a task_initiative_history row.',
      inputSchema: {
        agent_id: agentIdArg,
        task_id: z.string().min(1),
        to_initiative_id: z.string().nullable(),
        reason: z.string().optional(),
      },
      annotations: { destructiveHint: true, openWorldHint: false },
    },
    async (args) => safeWrap(() => {
      moveTaskToInitiative(args.task_id, args.to_initiative_id, args.agent_id, args.reason ?? null);
      return { task_id: args.task_id, to_initiative_id: args.to_initiative_id };
    }),
  );

  server.registerTool(
    'promote_initiative_to_task',
    {
      title: 'Promote a story to a draft task',
      description: 'Creates ONE task in status=draft linked to the initiative. NOT for the PM (operator-driven only).',
      inputSchema: {
        agent_id: agentIdArg,
        initiative_id: z.string().min(1),
        task_title: z.string().min(1).max(500),
        task_description: z.string().optional(),
      },
      annotations: { destructiveHint: true, openWorldHint: false },
    },
    async (args) => safeWrap(() =>
      promoteInitiativeToTask(args.initiative_id, {
        task_title: args.task_title,
        task_description: args.task_description ?? null,
        created_by_agent_id: args.agent_id,
      }),
    ),
  );

  server.registerTool(
    'promote_task_to_inbox',
    {
      title: 'Promote a draft task to inbox',
      description: 'Draft → inbox: makes the task visible on the Mission Queue. NOT for the PM.',
      inputSchema: { agent_id: agentIdArg, task_id: z.string().min(1) },
      annotations: { destructiveHint: true, openWorldHint: false },
    },
    async (args) => safeWrap(() =>
      promoteTaskToInbox(args.task_id, { promoted_by_agent_id: args.agent_id }),
    ),
  );

  server.registerTool(
    'add_owner_availability',
    {
      title: 'Add an owner-availability window',
      description:
        'Records that an agent is unavailable in a window. The PM may use this when the operator stated an availability fact directly; otherwise the PM proposes the change via propose_changes.',
      inputSchema: {
        agent_id: agentIdArg,
        for_agent_id: z.string().min(1),
        start: z.string().min(1),
        end: z.string().min(1),
        reason: z.string().optional(),
      },
      annotations: { destructiveHint: true, openWorldHint: false },
    },
    async (args) => safeWrap(() =>
      createOwnerAvailability({
        agent_id: args.for_agent_id,
        unavailable_start: args.start,
        unavailable_end: args.end,
        reason: args.reason,
      }),
    ),
  );

  // ─── PM-specific tools ────────────────────────────────────────────

  server.registerTool(
    'propose_changes',
    {
      title: 'PM: propose roadmap changes',
      description:
        "The PM agent's primary write path. Creates a `pm_proposals` row in `draft` status with a markdown impact summary and a structured diff list. The operator approves at the proposal level — never call any of the other write tools to push changes through; always go through this one.",
      inputSchema: {
        agent_id: agentIdArg,
        workspace_id: z.string().min(1),
        trigger_text: z.string().min(1).max(20000),
        trigger_kind: z
          .enum([
            'manual',
            'scheduled_drift_scan',
            'disruption_event',
            'status_check_investigation',
          ])
          .optional(),
        impact_md: z.string().min(1).max(20000),
        changes: z.array(DiffSchema),
        parent_proposal_id: z.string().nullish(),
      },
      annotations: { destructiveHint: false, openWorldHint: false },
    },
    async (args) => safeWrap(() =>
      createProposal({
        workspace_id: args.workspace_id,
        trigger_text: args.trigger_text,
        trigger_kind: args.trigger_kind,
        impact_md: args.impact_md,
        proposed_changes: args.changes as PmDiff[],
        parent_proposal_id: args.parent_proposal_id ?? null,
      }),
    ),
  );

  server.registerTool(
    'refine_proposal',
    {
      title: 'PM: refine a prior proposal with an additional constraint',
      description:
        "Marks the parent superseded and creates a fresh draft. Use this when the operator says 'refine — keep launch on schedule, defer analytics'.",
      inputSchema: {
        agent_id: agentIdArg,
        proposal_id: z.string().min(1),
        additional_constraint: z.string().min(1).max(5000),
      },
      annotations: { destructiveHint: false, openWorldHint: false },
    },
    async (args) => safeWrapAsync(async () => {
      // The DB helper creates an empty child slot; the dispatch path
      // fills it with a freshly-synthesized impact + changes.
      const parent = queryOne<{ workspace_id: string }>(
        'SELECT workspace_id FROM pm_proposals WHERE id = ?',
        [args.proposal_id],
      );
      if (!parent) throw new Error(`proposal ${args.proposal_id} not found`);
      refineProposalDb(args.proposal_id, args.additional_constraint);
      // Re-dispatch so the new draft has impact_md + changes filled in.
      // We do this here (instead of relying on the API route refine
      // path) so MCP-driven refines also work.
      const result = await dispatchPm({
        workspace_id: parent.workspace_id,
        trigger_text: args.additional_constraint,
        trigger_kind: 'manual',
      });
      return { refined_proposal: result.proposal };
    }),
  );

  server.registerTool(
    'preview_derivation',
    {
      title: 'PM: read-only schedule what-if',
      description:
        'Run the derivation engine against the current snapshot with optional velocity / availability overrides, WITHOUT writing. Use this to estimate impact before composing a propose_changes call.',
      inputSchema: {
        agent_id: agentIdArg,
        workspace_id: z.string().min(1),
        velocity_overrides: z.record(z.string(), z.number().min(0).max(10)).optional(),
        availability_overrides: z
          .array(
            z.object({
              agent_id: z.string().min(1),
              unavailable_start: z.string().min(1),
              unavailable_end: z.string().min(1),
              reason: z.string().optional(),
            }),
          )
          .optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => safeWrap(() => {
      const snapshot = getRoadmapSnapshot({ workspace_id: args.workspace_id });
      const result = previewDerivation(snapshot, {
        velocityOverrides: args.velocity_overrides,
        availabilityOverrides: (args.availability_overrides ?? []).map(a => ({
          agent_id: a.agent_id,
          unavailable_start: a.unavailable_start,
          unavailable_end: a.unavailable_end,
          reason: a.reason ?? null,
        })),
      });
      // Strip the schedule Map (not JSON-serializable) — diffs already
      // capture the differences; cycle/warnings are still useful.
      return {
        diffs: result.diffs,
        drifts: result.drifts,
        cycle: result.derived.cycle,
        no_effort_initiative_ids: result.derived.noEffort,
        warnings: result.derived.warnings,
      };
    }),
  );
}
