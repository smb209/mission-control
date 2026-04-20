/**
 * Deliverable storage resolution.
 *
 * Two paths matter:
 *   - HOST path: what the agent (running on the host OS) sees. Injected into
 *     dispatch prompts so agents write deliverables to the right place.
 *   - CONTAINER path: what MC (possibly running inside a Docker container)
 *     sees when reading the same bytes via a mounted volume.
 *
 * In local dev the two collapse to one value. In Docker compose a volume
 * mount makes host → container translation.
 *
 * On-disk layout for MC-managed deliverables:
 *   <root>/<task_id>/<filename>
 *
 * (The agent writes the file before it knows the deliverable_id, so we don't
 * prefix with it at write-time. Collisions between deliverables in the same
 * task are the agent's responsibility — typically distinct titles produce
 * distinct filenames.)
 */

import fs from 'fs';
import path from 'path';
import { getProjectsPath } from '@/lib/config';
import type { TaskDeliverable } from '@/lib/types';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.xml': 'application/xml',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.csv': 'text/csv',
  '.yaml': 'application/x-yaml',
  '.yml': 'application/x-yaml',
};

function expandTilde(p: string): string {
  if (p.startsWith('~')) {
    return p.replace(/^~/, process.env.HOME || '');
  }
  return p;
}

export function getDeliverablesHostPath(): string {
  // Agent-perspective. Defaults to the existing projects location so today's
  // flow keeps working when the env vars aren't set.
  return expandTilde(process.env.MC_DELIVERABLES_HOST_PATH || getProjectsPath());
}

export function getDeliverablesContainerPath(): string {
  // MC-perspective. In local mode this is identical to the host path.
  return expandTilde(
    process.env.MC_DELIVERABLES_CONTAINER_PATH ||
    process.env.MC_DELIVERABLES_HOST_PATH ||
    getProjectsPath()
  );
}

export function getTaskDeliverableDir(taskId: string, perspective: 'host' | 'container'): string {
  const root = perspective === 'host' ? getDeliverablesHostPath() : getDeliverablesContainerPath();
  return path.join(root, taskId);
}

/**
 * Given a submitted absolute host path, decide if it lives under the
 * deliverables root. Used at register-time to tag storage_scheme.
 */
export function isUnderDeliverablesHostRoot(submittedPath: string): boolean {
  if (!submittedPath) return false;
  const expanded = expandTilde(submittedPath);
  const root = path.resolve(getDeliverablesHostPath());
  const abs = path.resolve(expanded);
  return abs === root || abs.startsWith(root + path.sep);
}

/**
 * Translate a host-perspective absolute path to a container-perspective
 * absolute path by swapping the roots. Used when MC needs to read a file
 * the agent wrote.
 */
export function hostPathToContainerPath(hostPath: string): string {
  const expanded = expandTilde(hostPath);
  const hostRoot = path.resolve(getDeliverablesHostPath());
  const containerRoot = path.resolve(getDeliverablesContainerPath());
  if (hostRoot === containerRoot) return expanded;

  const abs = path.resolve(expanded);
  if (abs === hostRoot) return containerRoot;
  if (abs.startsWith(hostRoot + path.sep)) {
    return path.join(containerRoot, abs.slice(hostRoot.length + 1));
  }
  // Path is outside the deliverables root — can't translate, return as-is and
  // let the caller's safety check reject it if applicable.
  return expanded;
}

export class DeliverableReadError extends Error {
  status: number;
  constructor(message: string, status = 500) {
    super(message);
    this.status = status;
  }
}

/**
 * Resolve a deliverable record to an absolute, readable path in the MC
 * (container) filesystem. Validates:
 *   - scheme is supported (ssh:// is reserved but not yet implemented)
 *   - real path stays under the configured deliverables container root
 *     (for MC-managed rows) — this blocks path-traversal / symlink attacks
 *   - for legacy 'host' rows the stored path is used as-is (this is pre-existing
 *     behavior we preserve for deliverables created before this feature)
 */
export function resolveDeliverableReadPath(deliverable: TaskDeliverable): string {
  if (!deliverable.path) {
    throw new DeliverableReadError('Deliverable has no path', 400);
  }
  if (deliverable.path.startsWith('ssh://')) {
    throw new DeliverableReadError('Remote (ssh) deliverable storage is not yet supported', 501);
  }

  const scheme = deliverable.storage_scheme || 'host';

  if (scheme === 'mc') {
    // Rebuild from (container_root, task_id, basename(path)). We trust only
    // the basename of the stored path — the directory part is host-perspective
    // and not meaningful for reads. The on-disk layout is canonical.
    const containerDir = getTaskDeliverableDir(deliverable.task_id, 'container');
    const filename = path.basename(deliverable.path);
    const candidate = path.join(containerDir, filename);

    // Safety: real path must stay within the container root.
    const root = path.resolve(getDeliverablesContainerPath());
    let resolved: string;
    try {
      resolved = fs.realpathSync(candidate);
    } catch {
      throw new DeliverableReadError('Deliverable file not found', 404);
    }
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      throw new DeliverableReadError('Deliverable path escaped storage root', 403);
    }
    return resolved;
  }

  // Legacy host-only row. We still do a basic existence check so callers get
  // a 404 instead of a 500 when the file has been moved or the host path is
  // not reachable from the MC process (e.g. MC in Docker without the mount).
  const translated = hostPathToContainerPath(deliverable.path);
  if (!fs.existsSync(translated)) {
    throw new DeliverableReadError('Deliverable file not found', 404);
  }
  return translated;
}

export function mimeTypeForPath(p: string): string {
  const ext = path.extname(p).toLowerCase();
  return MIME_TYPES[ext] || 'application/octet-stream';
}

export function fileSizeBytes(absPath: string): number | undefined {
  try {
    return fs.statSync(absPath).size;
  } catch {
    return undefined;
  }
}
