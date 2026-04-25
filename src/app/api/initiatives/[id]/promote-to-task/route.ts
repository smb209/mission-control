import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { queryOne } from '@/lib/db';
import { promoteInitiativeToTask } from '@/lib/db/promotion';
import type { Task } from '@/lib/types';

export const dynamic = 'force-dynamic';

const Schema = z.object({
  task_title: z.string().min(1).max(500).optional(),
  task_description: z.string().max(10000).nullish(),
  status_check_md: z.string().nullish(),
  created_by_agent_id: z.string().nullish(),
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
    const { id: taskId } = promoteInitiativeToTask(id, parsed.data);
    const task = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [taskId]);
    return NextResponse.json(task, { status: 201 });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Failed to promote initiative';
    if (msg.startsWith('Initiative not found')) {
      return NextResponse.json({ error: msg }, { status: 404 });
    }
    if (msg.startsWith('Only story-kind')) {
      return NextResponse.json({ error: msg }, { status: 400 });
    }
    console.error('Failed to promote initiative to task:', error);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
