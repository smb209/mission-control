/**
 * /api/pm/active-dispatch — read the in-flight PM dispatch for a
 * workspace, plus steer / abort affordances.
 *
 *   GET    /api/pm/active-dispatch?workspace_id=… → null | dispatch
 *   POST   /api/pm/active-dispatch?workspace_id=… { action: 'steer', message }
 *   POST   /api/pm/active-dispatch?workspace_id=… { action: 'abort' }
 *
 * The dispatch entry is the in-memory registry maintained by
 * runDisruptionDispatchInBackground; cleared the moment the dispatch
 * resolves. /pm uses GET for the live "PM is replying" panel and
 * POST for the Steer / Stop buttons.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getOpenClawClient } from '@/lib/openclaw/client';
import { getActivePmDispatch } from '@/lib/agents/pm-dispatch';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const workspaceId = new URL(request.url).searchParams.get('workspace_id');
  if (!workspaceId) {
    return NextResponse.json({ error: 'workspace_id is required' }, { status: 400 });
  }
  const active = getActivePmDispatch(workspaceId);
  return NextResponse.json(active);
}

const PostSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('steer'),
    message: z.string().min(1).max(20_000),
  }),
  z.object({
    action: z.literal('abort'),
  }),
]);

export async function POST(request: NextRequest) {
  const workspaceId = new URL(request.url).searchParams.get('workspace_id');
  if (!workspaceId) {
    return NextResponse.json({ error: 'workspace_id is required' }, { status: 400 });
  }
  const active = getActivePmDispatch(workspaceId);
  if (!active) {
    return NextResponse.json(
      { error: 'No active PM dispatch for this workspace' },
      { status: 409 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const parsed = PostSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', details: parsed.error.issues },
      { status: 400 },
    );
  }

  const client = getOpenClawClient();
  if (!client.isConnected()) {
    return NextResponse.json(
      { error: 'Gateway is not connected; cannot steer or abort right now.' },
      { status: 503 },
    );
  }

  try {
    if (parsed.data.action === 'steer') {
      const result = await client.steerSession(active.session_key, parsed.data.message);
      return NextResponse.json({ ok: true, action: 'steer', result, dispatch: active });
    }
    const result = await client.abortSession(active.session_key);
    return NextResponse.json({ ok: true, action: 'abort', result, dispatch: active });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Gateway call failed';
    return NextResponse.json({ error: msg, dispatch: active }, { status: 502 });
  }
}
