import { NextRequest, NextResponse } from 'next/server';
import { initiateRollCall } from '@/lib/rollcall';

export const dynamic = 'force-dynamic';

/**
 * POST /api/agents/rollcall
 *
 * Kick off a roll-call across all active agents in a workspace.
 *
 * Body: {
 *   workspace_id?: string,                  // defaults to 'default'
 *   mode?: 'direct' | 'coordinator',        // defaults to 'direct'
 *   timeout_seconds?: number                // defaults to 30
 * }
 *
 * Returns 200 with the created rollcall + per-target entries (with
 * delivery status) on success. Returns 409 if no master orchestrator
 * exists or more than one does — operator must resolve that first via
 * `PATCH /api/agents/[id]` setting `is_master`. Returns 400 if there
 * are no active non-master agents to call.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({})) as {
      workspace_id?: string;
      mode?: 'direct' | 'coordinator';
      timeout_seconds?: number;
    };

    const workspaceId = body.workspace_id || 'default';
    const mode = body.mode === 'coordinator' ? 'coordinator' : 'direct';
    const timeoutSeconds = Math.max(5, Math.min(body.timeout_seconds ?? 30, 300));

    const result = await initiateRollCall({ workspaceId, mode, timeoutSeconds });

    if (!result.ok) {
      // no_master / multiple_masters → 409 Conflict (operator must fix),
      // no_active_agents → 400 Bad Request (no one to call).
      const status =
        result.reason === 'no_active_agents'
          ? 400
          : 409;
      return NextResponse.json(
        {
          error: result.detail,
          reason: result.reason,
          candidates: result.candidates?.map(a => ({ id: a.id, name: a.name, role: a.role })),
        },
        { status }
      );
    }

    return NextResponse.json({
      ok: true,
      rollcall_id: result.rollcall.id,
      rollcall: result.rollcall,
      entries: result.entries,
    });
  } catch (error) {
    console.error('[POST /api/agents/rollcall] failed:', error);
    return NextResponse.json(
      { error: `Failed to initiate roll-call: ${(error as Error).message}` },
      { status: 500 }
    );
  }
}
