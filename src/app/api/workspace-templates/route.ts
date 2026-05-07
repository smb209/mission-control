/**
 * GET /api/workspace-templates
 *
 * Returns the operator-pickable starter templates for the workspace
 * conventions textarea. See specs/workspace-conventions-structured.md §4.
 */

import { NextResponse } from 'next/server';
import { listTemplates } from '@/lib/workspace-templates';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const templates = await listTemplates();
    return NextResponse.json({ templates });
  } catch (err) {
    console.error('[workspace-templates] list failed', err);
    return NextResponse.json(
      { error: 'failed to list templates' },
      { status: 500 },
    );
  }
}
