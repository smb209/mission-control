/**
 * Read-only MCP tools — initiatives, roadmap snapshot, history, owner
 * availability, velocity, proposals.
 *
 * Behavior is unchanged from the legacy `roadmap-tools.ts`; this is a
 * pure relocation as part of the MCP surface refactor (PR 1).
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import {
  getInitiative,
  getInitiativeTree,
  getInitiativeHistory,
  listInitiatives,
  type InitiativeKind,
  type InitiativeStatus,
} from '@/lib/db/initiatives';
import { getTaskInitiativeHistory } from '@/lib/db/promotion';
import { listOwnerAvailability } from '@/lib/db/owner-availability';
import { getRoadmapSnapshot } from '@/lib/db/roadmap';
import { computeVelocity } from '@/lib/roadmap/velocity';
import {
  listProposals,
  type PmProposalStatus,
} from '@/lib/db/pm-proposals';
import { getBrief } from '@/lib/db/briefs';
import { getAgentRun } from '@/lib/db/agent-runs';

import {
  agentIdArg,
  safeWrap,
  KINDS,
  INIT_STATUSES,
} from '../shared';

export function registerReadTools(server: McpServer): void {
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
    'read_brief',
    {
      title: 'Fetch one research brief',
      description:
        'Returns title, prompt, full result_md, citations, status, completed_at, and initiative_id for a brief. ' +
        'Use this when an initiative-scoped suggest prompt mentions a prior brief by id whose summary hints it might be relevant — ' +
        'pulling the full body lets you avoid duplicating prior research.',
      inputSchema: {
        agent_id: agentIdArg,
        brief_id: z.string().min(1),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => safeWrap(() => {
      const brief = getBrief(args.brief_id);
      if (!brief) throw new Error(`brief ${args.brief_id} not found`);
      const run = getAgentRun(brief.agent_run_id);
      return {
        id: brief.id,
        workspace_id: brief.workspace_id,
        initiative_id: brief.initiative_id,
        topic_id: brief.topic_id,
        template: brief.template,
        title: brief.title,
        prompt: brief.prompt,
        result_md: brief.result_md,
        summary: brief.summary,
        citations: brief.citations,
        error_md: brief.error_md,
        status: run?.status ?? 'unknown',
        completed_at: run?.completed_at ?? null,
        created_at: brief.created_at,
        updated_at: brief.updated_at,
      };
    }),
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
}
