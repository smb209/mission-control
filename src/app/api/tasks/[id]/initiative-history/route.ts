import { NextRequest, NextResponse } from 'next/server';
import { queryOne } from '@/lib/db';
import { getTaskInitiativeHistory } from '@/lib/db/promotion';

export const dynamic = 'force-dynamic';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const task = queryOne<{ id: string }>('SELECT id FROM tasks WHERE id = ?', [id]);
    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }
    const rows = getTaskInitiativeHistory(id);
    return NextResponse.json(rows);
  } catch (error) {
    console.error('Failed to fetch task initiative history:', error);
    return NextResponse.json({ error: 'Failed to fetch task initiative history' }, { status: 500 });
  }
}
