import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { queryOne } from '@/lib/db';
import { promoteTaskToInbox } from '@/lib/db/promotion';
import type { Task } from '@/lib/types';

export const dynamic = 'force-dynamic';

const Schema = z.object({
  reason: z.string().max(2000).nullish(),
  promoted_by_agent_id: z.string().nullish(),
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
    promoteTaskToInbox(id, parsed.data);
    const task = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [id]);
    return NextResponse.json(task);
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Failed to promote task';
    if (msg.startsWith('Task not found')) {
      return NextResponse.json({ error: msg }, { status: 404 });
    }
    if (msg.startsWith('Task is not in draft')) {
      return NextResponse.json({ error: msg }, { status: 400 });
    }
    console.error('Failed to promote task:', error);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
