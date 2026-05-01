import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { moveInitiativeSubtreeToWorkspace } from '@/lib/db/initiatives';

export const dynamic = 'force-dynamic';

const Schema = z.object({
  to_workspace_id: z.string().min(1),
  moved_by_agent_id: z.string().nullish(),
  reason: z.string().max(2000).nullish(),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = await request.json().catch(() => ({}));
    const parsed = Schema.safeParse(body ?? {});
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: parsed.error.issues },
        { status: 400 },
      );
    }
    const result = moveInitiativeSubtreeToWorkspace(
      id,
      parsed.data.to_workspace_id,
      parsed.data.moved_by_agent_id ?? null,
      parsed.data.reason ?? null,
    );
    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Failed to move initiative subtree';
    if (msg.startsWith('Initiative not found') || msg.startsWith('Target workspace not found')) {
      return NextResponse.json({ error: msg }, { status: 404 });
    }
    if (msg.startsWith('Initiative is already')) {
      return NextResponse.json({ error: msg }, { status: 400 });
    }
    console.error('Failed to move initiative subtree:', error);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
