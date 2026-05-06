/**
 * General-write CRUD MCP tools — initiative create/update/move/convert,
 * dependency edges, task ↔ initiative re-parenting, and inbox promotion.
 *
 * Persona-gated by the calling agent's soul_md (the PM agent is forbidden
 * from these by its persona; other personas may use them freely).
 *
 * Behavior is unchanged from the legacy `roadmap-tools.ts`; this is a
 * pure relocation as part of the MCP surface refactor (PR 1).
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import {
  createInitiative,
  updateInitiative,
  moveInitiative,
  convertInitiative,
  addInitiativeDependency,
  removeInitiativeDependency,
  moveTaskToInitiative,
  type InitiativeKind,
} from '@/lib/db/initiatives';
import {
  promoteInitiativeToTask,
  promoteTaskToInbox,
} from '@/lib/db/promotion';

import {
  agentIdArg,
  safeWrap,
  KINDS,
  DEP_KINDS,
} from '../shared';

export function registerCrudTools(server: McpServer): void {
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
}
