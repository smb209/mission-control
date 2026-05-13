import { NextRequest, NextResponse } from 'next/server';
import {
  listAgentRuns,
  type AgentRunKind,
  type AgentRunStatus,
} from '@/lib/db/agent-runs';
import { logApiError } from '@/lib/debug-log';

export const dynamic = 'force-dynamic';

const ALLOWED_KINDS: AgentRunKind[] = ['brief'];
const ALLOWED_STATUSES: AgentRunStatus[] = [
  'queued', 'running', 'complete', 'failed', 'cancelled',
];

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const workspaceId = searchParams.get('workspace_id');
    if (!workspaceId) {
      return NextResponse.json({ error: 'workspace_id is required' }, { status: 400 });
    }
    const kindParam = searchParams.get('kind');
    const statusParam = searchParams.get('status');
    if (kindParam && !ALLOWED_KINDS.includes(kindParam as AgentRunKind)) {
      return NextResponse.json({ error: `kind must be one of: ${ALLOWED_KINDS.join(', ')}` }, { status: 400 });
    }
    if (statusParam && !ALLOWED_STATUSES.includes(statusParam as AgentRunStatus)) {
      return NextResponse.json({ error: `status must be one of: ${ALLOWED_STATUSES.join(', ')}` }, { status: 400 });
    }
    const limitParam = searchParams.get('limit');
    const limit = limitParam ? Math.max(1, Math.min(500, parseInt(limitParam, 10))) : undefined;
    return NextResponse.json(
      listAgentRuns(workspaceId, {
        kind: (kindParam as AgentRunKind | null) ?? undefined,
        status: (statusParam as AgentRunStatus | null) ?? undefined,
        limit,
      }),
    );
  } catch (error) {
    logApiError({ route: '/api/agent-runs', method: 'GET', status: 500, error });
    return NextResponse.json({ error: 'Failed to list agent_runs' }, { status: 500 });
  }
}
