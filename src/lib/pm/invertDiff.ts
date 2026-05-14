/**
 * Synthesize the inverse of an accepted PM proposal's diff list.
 *
 * Slice 2 of docs/reference/pm-revertable-proposals.md. Read in tandem with the
 * `applyDiff` capture pattern in `src/lib/db/pm-proposals.ts` — every
 * forward apply records enough prior state onto the diff that the inverse
 * is computable as a pure function of the diff row alone, without
 * recomputing from drifted DB state.
 *
 * Diffs are inverted in REVERSE order. Within a single proposal, later
 * diffs may depend on entities created by earlier diffs (e.g. a
 * `create_task_under_initiative` referencing a `create_child_initiative`
 * via `$N` placeholder). Reverting in reverse keeps those dependencies
 * intact: the task is cancelled before the initiative it lived under is.
 */

import type { PmDiff } from '@/lib/db/pm-proposals';

export type InvertibilityStatus =
  | 'inverted'
  /** Diff was missing capture state needed to compute its inverse — most
   *  often a pre-Slice-1 row, or a forward apply path that didn't write
   *  back. UI surfaces a "Revert (limited)" tooltip per affected diff. */
  | 'limited';

export interface InvertedDiff {
  /** The forward diff's index in the original `proposed_changes` array.
   *  Useful for the UI's per-diff warning chip. */
  original_index: number;
  /** The synthesized inverse, or null when capture was missing. */
  inverse: PmDiff | null;
  status: InvertibilityStatus;
  /** Human-readable explanation for the UI tooltip when status='limited'. */
  reason?: string;
}

export interface InvertProposalResult {
  /** Inverted diffs in REVERSE forward order, ready to seed into a new
   *  draft proposal. Limited diffs are omitted; the per-diff notes cover
   *  what was skipped. */
  diffs: PmDiff[];
  /** One entry per forward diff in original order so the UI can render
   *  a 1:1 chip strip. */
  notes: InvertedDiff[];
}

/**
 * Compute inverses for an accepted proposal's diff list.
 *
 * `forward` is the proposal's `proposed_changes` array post-apply (i.e.
 * with capture fields populated by Slice 1's apply path).
 */
export function invertProposalDiffs(forward: PmDiff[]): InvertProposalResult {
  const notes: InvertedDiff[] = [];

  for (let i = 0; i < forward.length; i++) {
    notes.push(invertOne(forward[i], i));
  }

  // Reverse so dependent inverses run first (e.g. cancel a task before
  // cancelling the initiative it was created under).
  const diffs = notes
    .slice()
    .reverse()
    .filter(n => n.inverse !== null)
    .map(n => n.inverse as PmDiff);

  return { diffs, notes };
}

function invertOne(diff: PmDiff, index: number): InvertedDiff {
  switch (diff.kind) {
    case 'shift_initiative_target': {
      // prev_target_start/end are populated by Slice 1's apply path.
      // Restore both targets even if only one moved forward — the
      // capture is symmetric and an UPDATE setting both is idempotent.
      if (diff.prev_target_start === undefined && diff.prev_target_end === undefined) {
        return limited(index, 'pre-capture proposal: target state was not recorded');
      }
      return {
        original_index: index,
        status: 'inverted',
        inverse: {
          kind: 'shift_initiative_target',
          initiative_id: diff.initiative_id,
          target_start: diff.prev_target_start ?? null,
          target_end: diff.prev_target_end ?? null,
          reason: 'revert',
        },
      };
    }

    case 'set_initiative_status': {
      if (!diff.prev_status) {
        return limited(index, 'pre-capture proposal: prior status was not recorded');
      }
      return {
        original_index: index,
        status: 'inverted',
        inverse: {
          kind: 'set_initiative_status',
          initiative_id: diff.initiative_id,
          status: diff.prev_status,
        },
      };
    }

    case 'update_status_check': {
      if (diff.prev_status_check_md === undefined) {
        return limited(index, 'pre-capture proposal: prior status_check_md was not recorded');
      }
      return {
        original_index: index,
        status: 'inverted',
        inverse: {
          kind: 'update_status_check',
          initiative_id: diff.initiative_id,
          // Empty-string back-fill: applyDiff treats null and '' the
          // same shape (UPDATE … SET status_check_md = ?). The forward
          // diff's `status_check_md` is required-string, so we coerce.
          status_check_md: diff.prev_status_check_md ?? '',
        },
      };
    }

    case 'add_dependency': {
      if (!diff.created_dependency_id) {
        return limited(index, 'pre-capture proposal: created edge id was not recorded');
      }
      return {
        original_index: index,
        status: 'inverted',
        inverse: {
          kind: 'remove_dependency',
          dependency_id: diff.created_dependency_id,
        },
      };
    }

    case 'remove_dependency': {
      const row = diff.removed_dependency_row;
      if (!row) {
        return limited(index, 'pre-capture proposal: removed edge snapshot was not recorded');
      }
      return {
        original_index: index,
        status: 'inverted',
        inverse: {
          kind: 'add_dependency',
          initiative_id: row.initiative_id,
          depends_on_initiative_id: row.depends_on_initiative_id,
          note: row.note ?? undefined,
        },
      };
    }

    case 'reorder_initiatives': {
      if (!diff.prev_child_ids_in_order) {
        return limited(index, 'pre-capture proposal: prior order was not recorded');
      }
      return {
        original_index: index,
        status: 'inverted',
        inverse: {
          kind: 'reorder_initiatives',
          parent_id: diff.parent_id,
          child_ids_in_order: diff.prev_child_ids_in_order,
        },
      };
    }

    case 'create_child_initiative': {
      if (!diff.created_initiative_id) {
        return limited(index, 'pre-capture proposal: new initiative id was not recorded');
      }
      // PM never hard-deletes — tombstone via status=cancelled. The
      // operator sees the row in /initiatives if they toggle "Show
      // cancelled" on, and Slice 4's filter hides it by default.
      return {
        original_index: index,
        status: 'inverted',
        inverse: {
          kind: 'set_initiative_status',
          initiative_id: diff.created_initiative_id,
          status: 'cancelled',
        },
      };
    }

    case 'create_task_under_initiative': {
      if (!diff.created_task_id) {
        return limited(index, 'pre-capture proposal: new task id was not recorded');
      }
      return {
        original_index: index,
        status: 'inverted',
        inverse: {
          kind: 'set_task_status',
          task_id: diff.created_task_id,
          status: 'cancelled',
        },
      };
    }

    case 'add_availability': {
      // No forward `remove_availability` diff kind exists today (the PM
      // never proposes a removal), so we surface this as 'limited'.
      // owner_availability is a pure annotation row with no downstream
      // references; the operator can delete the row directly via the
      // DB or via a future `remove_availability` diff kind if needed.
      return limited(
        index,
        'add_availability: revert is not modeled as a diff yet — delete the owner_availability row manually if needed',
      );
    }

    case 'set_task_status': {
      // Inverting set_task_status restores the captured prev_task_status.
      // The wider status union (added with confirm_task_done) lets us
      // emit a real inverse instead of marking limited; the validator
      // permits any status when trigger_kind === 'revert'.
      if (!diff.prev_task_status) {
        return limited(index, 'pre-capture proposal: prior task status was not recorded');
      }
      return {
        original_index: index,
        status: 'inverted',
        inverse: {
          kind: 'set_task_status',
          task_id: diff.task_id,
          status: diff.prev_task_status as Extract<PmDiff, { kind: 'set_task_status' }>['status'],
        },
      };
    }

    case 'confirm_task_done': {
      if (!diff.prev_task_status) {
        return limited(index, 'pre-capture proposal: prior task status was not recorded');
      }
      return {
        original_index: index,
        status: 'inverted',
        inverse: {
          kind: 'set_task_status',
          task_id: diff.task_id,
          status: diff.prev_task_status as Extract<PmDiff, { kind: 'set_task_status' }>['status'],
        },
      };
    }

    case 'create_convoy_under_initiative': {
      // PM convoy mandate — full revert. Capture state populated by
      // applyCreateConvoyUnderInitiative gives us everything we need:
      // convoy_id, parent_task_id, and the symbolic → real subtask map.
      // The synthesized cancel_convoy diff runs atomically inside
      // acceptProposal's outer transaction — refusal on any 'done'
      // subtask rolls the whole revert back. See
      // docs/reference/pm-revertable-proposals.md for the apply rules.
      if (!diff.created_convoy_id || !diff.created_parent_task_id) {
        return limited(
          index,
          'pre-capture proposal: convoy_id or parent_task_id was not recorded',
        );
      }
      const subtaskChildTaskIds = (diff.created_subtasks ?? []).map((s) => s.child_task_id);
      return {
        original_index: index,
        status: 'inverted',
        inverse: {
          kind: 'cancel_convoy',
          convoy_id: diff.created_convoy_id,
          parent_task_id: diff.created_parent_task_id,
          subtask_child_task_ids: subtaskChildTaskIds,
        },
      };
    }

    case 'cancel_convoy': {
      // Reverting a revert: we don't synthesize an "uncancel" because
      // the forward cancel already deleted inbox children and cascaded
      // their convoy_subtasks rows. A clean re-decomposition is the
      // right operator move, not a synthetic reinstate.
      return limited(
        index,
        'cancel_convoy revert is not modeled — re-decompose the parent task to re-spawn the convoy',
      );
    }

    default: {
      const exhaustive: never = diff;
      return {
        original_index: index,
        inverse: null,
        status: 'limited',
        reason: `unknown diff kind ${(exhaustive as { kind?: string }).kind ?? '?'}`,
      };
    }
  }
}

function limited(index: number, reason: string): InvertedDiff {
  return { original_index: index, inverse: null, status: 'limited', reason };
}
