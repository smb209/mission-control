import { NextRequest, NextResponse } from 'next/server';
import { queryOne } from '@/lib/db';
import { writeWorkerContext } from '@/lib/openclaw/worker-context';

export const dynamic = 'force-dynamic';

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/agents/[id]/provision-context
 *
 * (Re)write MC-CONTEXT.json into the openclaw workspace for this agent.
 * The `id` path parameter accepts either an MC agent_id (UUID/hex) or a
 * gateway_agent_id (e.g. "mc-writer") for operator convenience.
 *
 * Used by:
 *   - operator tooling on token rotation
 *   - agent self-heal when its own MC-CONTEXT.json is stale
 *     (agents hit this via the bearer token they already have)
 *
 * The endpoint is authenticated by the same middleware that guards every
 * other /api/agents/* route (see src/proxy.ts). Agents that don't already
 * have the token cannot bootstrap themselves via this route — that's by
 * design; a missing-token situation means MC-CONTEXT.json was never written
 * and the operator needs to call this route (or restart MC, which triggers
 * the startup backfill) once from the host.
 */
export async function POST(_request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;

    // Resolve to a gateway_agent_id. The writer only needs a gateway id to
    // locate the workspace directory.
    const row = queryOne<{ gateway_agent_id: string | null }>(
      `SELECT gateway_agent_id FROM agents
       WHERE id = ? OR gateway_agent_id = ?
       LIMIT 1`,
      [id, id]
    );

    if (!row || !row.gateway_agent_id) {
      return NextResponse.json(
        { error: `Agent not found, or has no gateway_agent_id: ${id}` },
        { status: 404 }
      );
    }

    const result = writeWorkerContext(row.gateway_agent_id);
    return NextResponse.json({
      gateway_agent_id: row.gateway_agent_id,
      path: result.path,
      skipped: result.skipped ?? null,
    });
  } catch (error) {
    const message = (error as Error).message;
    const isConfig = message.includes('OPENCLAW_WORKSPACES');
    return NextResponse.json(
      { error: message },
      { status: isConfig ? 500 : 400 }
    );
  }
}
