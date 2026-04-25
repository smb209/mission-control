/**
 * /api/pm/proposals
 *
 *   POST  body { workspace_id, trigger_text, trigger_kind? }
 *         → triggers PM dispatch, returns the new draft proposal.
 *   GET   query { workspace_id?, status?, since?, limit? }
 *         → list proposals.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { listProposals, type PmProposalStatus } from '@/lib/db/pm-proposals';
import { dispatchPm } from '@/lib/agents/pm-dispatch';

export const dynamic = 'force-dynamic';

const PostSchema = z.object({
  workspace_id: z.string().min(1),
  trigger_text: z.string().min(1).max(20000),
  trigger_kind: z
    .enum(['manual', 'scheduled_drift_scan', 'disruption_event', 'status_check_investigation'])
    .optional(),
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const parsed = PostSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: parsed.error.issues },
        { status: 400 },
      );
    }
    const result = dispatchPm(parsed.data);
    return NextResponse.json(
      {
        proposal: result.proposal,
        used_synthesize_fallback: result.used_synthesize_fallback,
      },
      { status: 201 },
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Failed to create proposal';
    console.error('Failed to create PM proposal:', error);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

const STATUS_VALUES: PmProposalStatus[] = ['draft', 'accepted', 'rejected', 'superseded'];

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const status = searchParams.get('status');
    const limitRaw = searchParams.get('limit');
    const filters = {
      workspace_id: searchParams.get('workspace_id') || undefined,
      status:
        status && (STATUS_VALUES as string[]).includes(status)
          ? (status as PmProposalStatus)
          : undefined,
      since: searchParams.get('since') || undefined,
      limit: limitRaw ? Math.max(1, parseInt(limitRaw, 10) || 50) : undefined,
    };
    const rows = listProposals(filters);
    return NextResponse.json(rows);
  } catch (error) {
    console.error('Failed to list PM proposals:', error);
    const msg = error instanceof Error ? error.message : 'Failed to list proposals';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
