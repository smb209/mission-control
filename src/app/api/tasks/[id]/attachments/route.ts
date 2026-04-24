/**
 * Task Attachments (Uploads) API
 *
 * Operator-facing upload endpoint for the create-task flow. Accepts one or
 * more files as multipart/form-data under the `files` field, writes them
 * under the task's deliverables directory, and registers each as a
 * role='input' deliverable via the shared registerDeliverable() service so
 * all dedup / storage-scheme / SSE broadcast behavior is inherited.
 *
 * Separate from POST /api/tasks/:id/deliverables because that endpoint is
 * the agent-facing JSON registration call — not a file receiver. This route
 * is the only place MC ingests raw file bytes from the browser.
 */

import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { getDb } from '@/lib/db';
import { registerDeliverable } from '@/lib/services/task-deliverables';
import {
  getDeliverablesHostPath,
  getDeliverablesContainerPath,
  buildTaskDeliverableFolderName,
} from '@/lib/deliverables/storage';

import type { TaskDeliverable } from '@/lib/types';

export const dynamic = 'force-dynamic';

const MAX_FILE_BYTES = 100 * 1024 * 1024; // 100 MB — matches client-side cap

/**
 * Strip directory separators and `..` segments so a malicious filename can't
 * escape the target directory. Keeps the extension.
 */
function sanitizeFilename(name: string): string {
  const base = path.basename(name || 'file');
  return base.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'file';
}

interface FailedUpload {
  filename: string;
  error: string;
}

export async function POST(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const taskId = params.id;

  const db = getDb();
  const task = db
    .prepare('SELECT id, title, created_at FROM tasks WHERE id = ?')
    .get(taskId) as { id: string; title: string; created_at: string } | undefined;
  if (!task) {
    return NextResponse.json({ error: 'Task not found' }, { status: 404 });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch (err) {
    console.error('[attachments] Failed to parse multipart form:', err);
    return NextResponse.json({ error: 'Expected multipart/form-data body' }, { status: 400 });
  }

  const files = form.getAll('files').filter((v): v is File => v instanceof File);
  if (files.length === 0) {
    return NextResponse.json({ error: 'No files provided under "files" field' }, { status: 400 });
  }

  // Resolve per-task folder using the same friendly `YYYY-MM-DD-title-uuid`
  // layout agents write into. resolveDeliverableReadPath() rebuilds paths
  // from (container_root, task_id, basename) so storing under this exact
  // folder keeps downloads / previews working identically for inputs.
  const folderName = buildTaskDeliverableFolderName(task);
  const hostRoot = getDeliverablesHostPath();
  const containerRoot = getDeliverablesContainerPath();
  const containerDir = path.join(containerRoot, folderName);
  try {
    fs.mkdirSync(containerDir, { recursive: true });
  } catch (err) {
    console.error('[attachments] Failed to create task dir:', err);
    return NextResponse.json(
      { error: 'Failed to prepare storage directory' },
      { status: 500 }
    );
  }

  const created: TaskDeliverable[] = [];
  const failed: FailedUpload[] = [];

  for (const file of files) {
    const displayName = file.name || 'file';
    try {
      if (file.size > MAX_FILE_BYTES) {
        failed.push({
          filename: displayName,
          error: `File exceeds 100 MB limit (${file.size} bytes)`,
        });
        continue;
      }

      // UUID prefix prevents collisions between multiple uploads sharing a
      // filename, and between an upload and any later agent-produced file.
      const uniqueName = `${crypto.randomUUID()}-${sanitizeFilename(displayName)}`;
      const containerPath = path.join(containerDir, uniqueName);
      const hostPath = path.join(hostRoot, folderName, uniqueName);

      const buf = Buffer.from(await file.arrayBuffer());
      fs.writeFileSync(containerPath, buf);

      const result = registerDeliverable({
        taskId,
        actingAgentId: null,
        deliverableType: 'file',
        title: displayName,
        path: hostPath,
        role: 'input',
      });
      created.push(result.deliverable);
    } catch (err) {
      console.error('[attachments] Upload failed for', displayName, err);
      failed.push({
        filename: displayName,
        error: err instanceof Error ? err.message : 'Upload failed',
      });
    }
  }

  const status = created.length > 0 ? 201 : 400;
  return NextResponse.json({ created, failed }, { status });
}
