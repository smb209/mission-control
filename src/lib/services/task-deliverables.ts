/**
 * Task deliverables service.
 *
 * One-stop function the HTTP route and (in PR 3) the MCP tool both call.
 * Handles agent-task authorization, storage-scheme decision, DB insert, SSE
 * broadcast — everything except HTTP-wrapper concerns (request parsing,
 * response shaping, debug logging of HTTP context).
 *
 * Throws `AuthzError` when the calling agent isn't on the task. Callers map
 * to the transport-appropriate error response.
 */

import { existsSync } from 'fs';
import { getDb } from '@/lib/db';
import { broadcast } from '@/lib/events';
import { assertAgentCanActOnTask } from '@/lib/authz/agent-task';
import {
  isUnderDeliverablesHostRoot,
  hostPathToContainerPath,
  fileSizeBytes,
} from '@/lib/deliverables/storage';
import type { TaskDeliverable, DeliverableStorageScheme } from '@/lib/types';

export type DeliverableKind = 'file' | 'url' | 'artifact';

export interface RegisterDeliverableInput {
  taskId: string;
  /**
   * The agent posting this deliverable. `null` means operator flow — skip
   * authorization. Every agent-initiated call (HTTP curl from a dispatched
   * agent, or MCP tool call in PR 3) must pass a non-null value.
   */
  actingAgentId: string | null;
  deliverableType: DeliverableKind;
  title: string;
  path?: string;
  description?: string;
  specDeliverableId?: string;
}

export interface RegisterDeliverableResult {
  deliverable: TaskDeliverable;
  /** For file-kind deliverables: did the file exist on disk when we checked? */
  fileExists: boolean;
  /** Tilde-expanded path (null for non-file deliverables). */
  normalizedPath: string | null;
}

export function registerDeliverable(
  input: RegisterDeliverableInput,
): RegisterDeliverableResult {
  const {
    taskId,
    actingAgentId,
    deliverableType,
    title,
    path,
    description,
    specDeliverableId,
  } = input;

  if (actingAgentId) {
    assertAgentCanActOnTask(actingAgentId, taskId, 'deliverable');
  }

  // Decide storage_scheme + capture file metadata. Mirrors the original
  // behavior from deliverables/route.ts:93-115 verbatim — the evidence gate
  // depends on storage_scheme being set correctly so downloads route to the
  // right path on the host vs in the container.
  let storageScheme: DeliverableStorageScheme = 'host';
  let sizeBytes: number | undefined;
  let fileExists = true;
  let normalizedPath: string | null = null;

  if (deliverableType === 'file' && path) {
    normalizedPath = path.replace(/^~/, process.env.HOME || '');
    if (isUnderDeliverablesHostRoot(path)) {
      storageScheme = 'mc';
      const containerPath = hostPathToContainerPath(path);
      fileExists = existsSync(containerPath);
      if (fileExists) sizeBytes = fileSizeBytes(containerPath);
    } else {
      fileExists = existsSync(normalizedPath);
    }
    if (!fileExists) {
      console.warn(`[DELIVERABLE] Warning: File does not exist: ${normalizedPath}`);
    }
  }

  const db = getDb();
  const id = crypto.randomUUID();

  db.prepare(`
    INSERT INTO task_deliverables (id, task_id, deliverable_type, title, path, description, storage_scheme, size_bytes, spec_deliverable_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    taskId,
    deliverableType,
    title,
    path || null,
    description || null,
    storageScheme,
    sizeBytes ?? null,
    specDeliverableId || null,
  );

  const deliverable = db
    .prepare(`SELECT * FROM task_deliverables WHERE id = ?`)
    .get(id) as TaskDeliverable;

  broadcast({ type: 'deliverable_added', payload: deliverable });

  return { deliverable, fileExists, normalizedPath };
}
