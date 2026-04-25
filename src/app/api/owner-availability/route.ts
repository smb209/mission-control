import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import {
  createOwnerAvailability,
  listOwnerAvailability,
} from '@/lib/db/owner-availability';

export const dynamic = 'force-dynamic';

const CreateSchema = z.object({
  agent_id: z.string().min(1),
  unavailable_start: z.string().min(1),
  unavailable_end: z.string().min(1),
  reason: z.string().nullish(),
});

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const rows = listOwnerAvailability({
      agent_id: searchParams.get('agent_id') || undefined,
      between_start: searchParams.get('between_start') || null,
      between_end: searchParams.get('between_end') || null,
      workspace_id: searchParams.get('workspace_id') || undefined,
    });
    return NextResponse.json(rows);
  } catch (error) {
    console.error('Failed to list owner availability:', error);
    const msg = error instanceof Error ? error.message : 'Failed to list availability';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const parsed = CreateSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: parsed.error.issues },
        { status: 400 },
      );
    }
    const row = createOwnerAvailability(parsed.data);
    return NextResponse.json(row, { status: 201 });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Failed to create availability';
    if (msg.startsWith('Agent not found') || msg.startsWith('unavailable_')) {
      return NextResponse.json({ error: msg }, { status: 400 });
    }
    console.error('Failed to create owner availability:', error);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
