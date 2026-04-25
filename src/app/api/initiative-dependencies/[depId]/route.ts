import { NextRequest, NextResponse } from 'next/server';
import { removeInitiativeDependency } from '@/lib/db/initiatives';

export const dynamic = 'force-dynamic';

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ depId: string }> },
) {
  try {
    const { depId } = await params;
    removeInitiativeDependency(depId);
    return NextResponse.json({ success: true });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Failed to delete dependency';
    if (msg.startsWith('Dependency not found')) {
      return NextResponse.json({ error: msg }, { status: 404 });
    }
    console.error('Failed to delete dependency:', error);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
