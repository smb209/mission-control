import { NextRequest, NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { queryOne, queryAll, run, transaction } from '@/lib/db';
import type { Agent } from '@/lib/types';

export const dynamic = 'force-dynamic';
interface ImportAgentRequest {
  gateway_agent_id: string;
  name: string;
  model?: string;
  workspace_id?: string;
}

interface ImportRequest {
  agents: ImportAgentRequest[];
}

// POST /api/agents/import - Import one or more agents from the OpenClaw Gateway
export async function POST(request: NextRequest) {
  try {
    const body: ImportRequest = await request.json();

    if (!body.agents || !Array.isArray(body.agents) || body.agents.length === 0) {
      return NextResponse.json(
        { error: 'At least one agent is required in the agents array' },
        { status: 400 }
      );
    }

    // Validate each agent
    for (const agentReq of body.agents) {
      if (!agentReq.gateway_agent_id || !agentReq.name) {
        return NextResponse.json(
          { error: 'Each agent must have gateway_agent_id and name' },
          { status: 400 }
        );
      }
    }

    // Conflict check is per-workspace: a gateway agent already cloned into
    // workspace A should still be importable into workspace B. Globally
    // scoped, a single import would block every other workspace from ever
    // adopting that persona. Build the set as workspace_id → gateway_agent_id
    // pairs so the per-row check below filters on both axes.
    const existingImports = queryAll<Agent>(
      `SELECT workspace_id, gateway_agent_id FROM agents WHERE gateway_agent_id IS NOT NULL`
    );
    const importedKey = (workspaceId: string, gatewayAgentId: string) =>
      `${workspaceId}::${gatewayAgentId}`;
    const importedGatewayIds = new Set(
      existingImports.map((a) =>
        importedKey(a.workspace_id || 'default', a.gateway_agent_id || ''),
      ),
    );

    const results: { imported: Agent[]; skipped: { gateway_agent_id: string; reason: string }[] } = {
      imported: [],
      skipped: [],
    };

    transaction(() => {
      const now = new Date().toISOString();

      for (const agentReq of body.agents) {
        const workspaceId = agentReq.workspace_id || 'default';

        // Skip if already imported into THIS workspace; cloning into
        // sibling workspaces remains allowed.
        if (importedGatewayIds.has(importedKey(workspaceId, agentReq.gateway_agent_id))) {
          results.skipped.push({
            gateway_agent_id: agentReq.gateway_agent_id,
            reason: 'Already imported',
          });
          continue;
        }

        const id = uuidv4();

        // Generate default identity files referencing the gateway agent.
        // The gateway does not expose SOUL.md/USER.md/AGENTS.md via its API,
        // so we populate sensible defaults that prompt the user to paste their
        // existing content from the OpenClaw workspace.
        const soulMd = [
          `# ${agentReq.name}`,
          '',
          `Imported from OpenClaw Gateway (agent: ${agentReq.gateway_agent_id}).`,
          '',
          'Configure this agent\'s personality, values, and communication style here.',
          'If this agent has a SOUL.md in your OpenClaw workspace, paste its contents here.',
        ].join('\n');

        const userMd = [
          '# User Context',
          '',
          `Imported from OpenClaw Gateway (agent: ${agentReq.gateway_agent_id}).`,
          '',
          'Add context about the human this agent works with.',
          'If this agent has a USER.md in your OpenClaw workspace, paste its contents here.',
        ].join('\n');

        const agentsMd = [
          '# Team Roster',
          '',
          `Imported from OpenClaw Gateway (agent: ${agentReq.gateway_agent_id}).`,
          '',
          'Describe the other agents this agent collaborates with.',
          'If this agent has an AGENTS.md in your OpenClaw workspace, paste its contents here.',
        ].join('\n');

        run(
          `INSERT INTO agents (id, name, role, description, avatar_emoji, is_master, workspace_id, soul_md, user_md, agents_md, model, source, gateway_agent_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            id,
            agentReq.name,
            'Imported Agent',
            `Imported from OpenClaw Gateway (${agentReq.gateway_agent_id})`,
            '🔗',
            0,
            workspaceId,
            soulMd,
            userMd,
            agentsMd,
            agentReq.model || null,
            'gateway',
            agentReq.gateway_agent_id,
            now,
            now,
          ]
        );

        // Log event
        run(
          `INSERT INTO events (id, type, agent_id, message, created_at)
           VALUES (?, ?, ?, ?, ?)`,
          [uuidv4(), 'agent_joined', id, `${agentReq.name} imported from OpenClaw Gateway`, now]
        );

        const agent = queryOne<Agent>('SELECT * FROM agents WHERE id = ?', [id]);
        if (agent) {
          results.imported.push(agent);
        }
      }
    });

    return NextResponse.json(results, { status: 201 });
  } catch (error) {
    console.error('Failed to import agents:', error);
    return NextResponse.json(
      { error: 'Failed to import agents' },
      { status: 500 }
    );
  }
}
