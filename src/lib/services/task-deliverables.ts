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
import type { TaskDeliverable, DeliverableStorageScheme, DeliverableRole } from '@/lib/types';

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
  /** Defaults to 'output' (the pre-existing agent-posting behavior). 'input'
   *  is used by the operator-facing attachments flow on task creation. */
  role?: DeliverableRole;
  /** Set when this row was created by referencing a prior deliverable
   *  (role='input' ref flow). */
  sourceDeliverableId?: string;
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
    sourceDeliverableId,
  } = input;
  const role: DeliverableRole = input.role ?? 'output';

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

  // Dedup: the same agent often re-registers the same file (e.g. after an
  // iteration) and we used to accumulate a row per call. The natural
  // uniqueness key is (task_id, deliverable_type, path, role) when path is
  // set, or (task_id, deliverable_type, title, role) for path-less rows.
  // `role` is in the key so an operator can attach an input with the same
  // path as an agent's output without collapsing into one row.
  // If a row already matches, update its mutable fields in place and keep
  // the stable id + created_at so any downstream refs remain valid.
  const existing = (path
    ? db
        .prepare(
          `SELECT id FROM task_deliverables
           WHERE task_id = ? AND deliverable_type = ? AND path = ? AND role = ?
           LIMIT 1`,
        )
        .get(taskId, deliverableType, path, role)
    : db
        .prepare(
          `SELECT id FROM task_deliverables
           WHERE task_id = ? AND deliverable_type = ? AND path IS NULL AND title = ? AND role = ?
           LIMIT 1`,
        )
        .get(taskId, deliverableType, title, role)) as { id: string } | undefined;

  const id = existing?.id ?? crypto.randomUUID();

  if (existing) {
    db.prepare(`
      UPDATE task_deliverables
      SET title = ?, description = ?, storage_scheme = ?, size_bytes = ?, spec_deliverable_id = ?, source_deliverable_id = ?
      WHERE id = ?
    `).run(
      title,
      description || null,
      storageScheme,
      sizeBytes ?? null,
      specDeliverableId || null,
      sourceDeliverableId || null,
      id,
    );
  } else {
    db.prepare(`
      INSERT INTO task_deliverables (id, task_id, deliverable_type, title, path, description, storage_scheme, size_bytes, spec_deliverable_id, role, source_deliverable_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      role,
      sourceDeliverableId || null,
    );
  }

  const deliverable = db
    .prepare(`SELECT * FROM task_deliverables WHERE id = ?`)
    .get(id) as TaskDeliverable;

  broadcast({ type: 'deliverable_added', payload: deliverable });

  return { deliverable, fileExists, normalizedPath };
}
