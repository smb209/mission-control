/**
 * Task Deliverables API
 * Endpoints for managing task deliverables (files, URLs, artifacts)
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { broadcast } from '@/lib/events';
import { CreateDeliverableSchema } from '@/lib/validation';
import { logDebugEvent } from '@/lib/debug-log';
import { existsSync } from 'fs';
import {
  isUnderDeliverablesHostRoot,
  hostPathToContainerPath,
  fileSizeBytes,
} from '@/lib/deliverables/storage';

import type { TaskDeliverable, DeliverableStorageScheme } from '@/lib/types';

export const dynamic = 'force-dynamic';
/**
 * GET /api/tasks/[id]/deliverables
 * Retrieve all deliverables for a task
 */
export async function GET(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const taskId = params.id;
    const db = getDb();

    const deliverables = db.prepare(`
      SELECT *
      FROM task_deliverables
      WHERE task_id = ?
      ORDER BY created_at DESC
    `).all(taskId) as TaskDeliverable[];

    return NextResponse.json(deliverables);
  } catch (error) {
    console.error('Error fetching deliverables:', error);
    return NextResponse.json(
      { error: 'Failed to fetch deliverables' },
      { status: 500 }
    );
  }
}

/**
 * POST /api/tasks/[id]/deliverables
 * Add a new deliverable to a task
 */
export async function POST(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const taskId = params.id;
    const body = await request.json();
    
    // Validate input with Zod
    const validation = CreateDeliverableSchema.safeParse(body);
    if (!validation.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: validation.error.issues },
        { status: 400 }
      );
    }

    const { deliverable_type, title, path, description } = validation.data;

    // Reject the reserved ssh:// prefix — the column is widened for future
    // remote storage, but nothing reads it yet. Failing here avoids half-wired
    // deliverables accumulating.
    if (path && path.startsWith('ssh://')) {
      return NextResponse.json(
        { error: 'Remote (ssh://) deliverable storage is not yet supported' },
        { status: 501 }
      );
    }

    // Decide storage_scheme + capture file metadata.
    let storageScheme: DeliverableStorageScheme = 'host';
    let sizeBytes: number | undefined;
    let fileExists = true;
    let normalizedPath = path;

    if (deliverable_type === 'file' && path) {
      normalizedPath = path.replace(/^~/, process.env.HOME || '');
      if (isUnderDeliverablesHostRoot(path)) {
        storageScheme = 'mc';
        // Existence + size measured against the container-perspective path
        // (MC reads from there; the path the agent wrote is host-perspective).
        const containerPath = hostPathToContainerPath(path);
        fileExists = existsSync(containerPath);
        if (fileExists) sizeBytes = fileSizeBytes(containerPath);
      } else {
        // Legacy host-path: just use as-given (tilde-expanded).
        fileExists = existsSync(normalizedPath);
      }
      if (!fileExists) {
        console.warn(`[DELIVERABLE] Warning: File does not exist: ${normalizedPath}`);
      }
    }

    const db = getDb();
    const id = crypto.randomUUID();

    // Insert deliverable
    db.prepare(`
      INSERT INTO task_deliverables (id, task_id, deliverable_type, title, path, description, storage_scheme, size_bytes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      taskId,
      deliverable_type,
      title,
      path || null,
      description || null,
      storageScheme,
      sizeBytes ?? null
    );

    // Get the created deliverable
    const deliverable = db.prepare(`
      SELECT *
      FROM task_deliverables
      WHERE id = ?
    `).get(id) as TaskDeliverable;

    // Broadcast to SSE clients
    broadcast({
      type: 'deliverable_added',
      payload: deliverable,
    });

    logDebugEvent({
      type: 'agent.deliverable_post',
      direction: 'inbound',
      taskId,
      requestBody: body,
      metadata: { deliverable_type, title, file_exists: fileExists },
    });

    // Return with warning if file doesn't exist
    if (deliverable_type === 'file' && !fileExists) {
      return NextResponse.json(
        {
          ...deliverable,
          warning: `File does not exist at path: ${normalizedPath}. Please create the file.`
        },
        { status: 201 }
      );
    }

    return NextResponse.json(deliverable, { status: 201 });
  } catch (error) {
    console.error('Error creating deliverable:', error);
    return NextResponse.json(
      { error: 'Failed to create deliverable' },
      { status: 500 }
    );
  }
}
