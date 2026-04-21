/**
 * Task checkpoint service.
 *
 * Thin wrapper that adds authorization to the existing `saveCheckpoint`
 * helper in src/lib/checkpoint.ts and fires the pending-notes delivery
 * side effect. HTTP route and (PR 3) MCP tool share this one path.
 *
 * Throws `AuthzError` on authz failure. `agentId` is required (no
 * operator-skip path here — checkpoints without an owning agent have no
 * semantic meaning).
 */

import { saveCheckpoint } from '@/lib/checkpoint';
import { deliverPendingNotesAtCheckpoint } from '@/lib/task-notes';
import { assertAgentCanActOnTask } from '@/lib/authz/agent-task';
import type { WorkCheckpoint, CheckpointType } from '@/lib/types';

export interface SaveTaskCheckpointInput {
  taskId: string;
  agentId: string;
  checkpointType?: CheckpointType;
  stateSummary: string;
  filesSnapshot?: Array<{ path: string; hash: string; size: number }>;
  contextData?: Record<string, unknown>;
}

export function saveTaskCheckpoint(
  input: SaveTaskCheckpointInput,
): WorkCheckpoint {
  assertAgentCanActOnTask(input.agentId, input.taskId, 'checkpoint');

  const checkpoint = saveCheckpoint({
    taskId: input.taskId,
    agentId: input.agentId,
    checkpointType: input.checkpointType,
    stateSummary: input.stateSummary,
    filesSnapshot: input.filesSnapshot,
    contextData: input.contextData,
  });

  // Fire-and-forget — never block the caller on this.
  deliverPendingNotesAtCheckpoint(input.taskId).catch((err) => {
    console.warn('[Checkpoint] Failed to deliver pending notes:', err);
  });

  return checkpoint;
}
