import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { applyDerivation } from '@/lib/roadmap/apply-derivation';

export const dynamic = 'force-dynamic';

const Body = z.object({
  workspace_id: z.string().min(1),
});

/**
 * Manually trigger the roadmap derivation engine for a workspace.
 *
 * Returns the same payload as the scheduled run: drift events, update
 * counts, and any warnings. Useful for the "Recompute now" toolbar button
 * and for tests.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const parsed = Body.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: parsed.error.issues },
        { status: 400 },
      );
    }
    const result = applyDerivation(parsed.data.workspace_id);
    return NextResponse.json(result);
  } catch (error) {
    console.error('Failed to recompute roadmap:', error);
    const msg = error instanceof Error ? error.message : 'Failed to recompute';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
