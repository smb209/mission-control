import { NextRequest, NextResponse } from 'next/server';
import {
  getRoadmapSnapshot,
  type InitiativeKind,
  type InitiativeStatus,
} from '@/lib/db/roadmap';

export const dynamic = 'force-dynamic';

const KINDS: ReadonlySet<InitiativeKind> = new Set(['theme', 'milestone', 'epic', 'story']);
const STATUSES: ReadonlySet<InitiativeStatus> = new Set([
  'planned',
  'in_progress',
  'at_risk',
  'blocked',
  'done',
  'cancelled',
]);

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const workspace_id = searchParams.get('workspace_id');
    if (!workspace_id) {
      return NextResponse.json(
        { error: 'workspace_id is required' },
        { status: 400 },
      );
    }

    const kind = searchParams.get('kind');
    const status = searchParams.get('status');
    if (kind && !KINDS.has(kind as InitiativeKind)) {
      return NextResponse.json({ error: `Invalid kind: ${kind}` }, { status: 400 });
    }
    if (status && !STATUSES.has(status as InitiativeStatus)) {
      return NextResponse.json({ error: `Invalid status: ${status}` }, { status: 400 });
    }

    const snapshot = getRoadmapSnapshot({
      workspace_id,
      product_id: searchParams.get('product_id') || null,
      owner_agent_id: searchParams.get('owner_agent_id') || null,
      kind: (kind as InitiativeKind) || undefined,
      status: (status as InitiativeStatus) || undefined,
      from: searchParams.get('from') || null,
      to: searchParams.get('to') || null,
    });

    return NextResponse.json(snapshot);
  } catch (error) {
    console.error('Failed to build roadmap snapshot:', error);
    const msg = error instanceof Error ? error.message : 'Failed to build roadmap';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
