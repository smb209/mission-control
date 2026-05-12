/**
 * Audit → PM auto-spawn bridge.
 *
 * When the narrow `initiative_audit` flow lands an `audit_verdict` note
 * that recommends action AND the workspace's `audit_auto_spawn_pm`
 * toggle is on, dispatch a `notes_intake` PM session whose trigger_text
 * bundles the verdict + the paired observation body. The resulting
 * `pm_proposal_id` is recorded on both notes via the existing
 * `appendNoteProposalId` helper, and both notes are marked consumed by
 * the `pm_proposal` stage so the UI fades the manual "Ask PM" button.
 *
 * See docs/archive/audit-action-recommended.md. Everything here is best-effort
 * — failures are logged and never thrown into the take_note caller.
 */

import {
  appendNoteProposalId,
  getNote,
  markNoteConsumed,
  type AgentNote,
} from '@/lib/db/agent-notes';
import { getInitiative } from '@/lib/db/initiatives';
import { getAuditAutoSpawn } from '@/lib/db/workspaces';
import {
  auditVerdictBodySchema,
  type AuditVerdictBody,
} from '@/lib/agents/audit-proposals/schemas';
import { dispatchPm } from '@/lib/agents/pm-dispatch';

const CONSUMED_STAGE = 'pm_proposal';

/**
 * Decide whether an `audit_verdict` body warrants an auto-dispatch.
 * Pure — no DB access — so the take_note path can short-circuit before
 * any lookups when the verdict is unambiguous-no-action.
 */
export function verdictWarrantsAutoSpawn(body: AuditVerdictBody): boolean {
  if (body.action_recommended) return true;
  // audit_failed always warrants a follow-up even if the auditor
  // mistakenly set action_recommended=false — the operator needs to
  // see the failure surfaced.
  if (body.verdict === 'audit_failed') return true;
  return false;
}

/**
 * Best-effort PM auto-dispatch for a freshly-created audit_verdict
 * note. Caller should fire-and-forget; this never throws.
 */
export async function maybeAutoSpawnPmFromVerdict(verdictNote: AgentNote): Promise<void> {
  if (verdictNote.kind !== 'audit_verdict') return;
  if (!verdictNote.initiative_id) {
    console.warn(
      `[audit-auto-spawn] verdict note ${verdictNote.id} has no initiative_id; skipping`,
    );
    return;
  }

  // 1. Parse the body. validateAuditNoteBody already ran in take_note,
  //    so this re-parse is defensive — a malformed body means the
  //    auditor wrote past the validator (shouldn't happen).
  let body: AuditVerdictBody;
  try {
    const raw = JSON.parse(verdictNote.body);
    const parsed = auditVerdictBodySchema.safeParse(raw);
    if (!parsed.success) {
      console.warn(
        `[audit-auto-spawn] verdict ${verdictNote.id} body failed schema re-parse:`,
        parsed.error.message,
      );
      return;
    }
    body = parsed.data;
  } catch (err) {
    console.warn(
      `[audit-auto-spawn] verdict ${verdictNote.id} body JSON parse failed:`,
      (err as Error).message,
    );
    return;
  }

  if (!verdictWarrantsAutoSpawn(body)) return;

  // 2. Workspace gate.
  if (!getAuditAutoSpawn(verdictNote.workspace_id)) return;

  // 3. Resolve the paired observation. Tolerate a missing pointer by
  //    falling back to no observation — the verdict body itself is
  //    enough signal for PM, but the observation is preferred when
  //    present because it has the full evidence prose.
  let observation: AgentNote | null = null;
  if (body.observation_note_id) {
    const candidate = getNote(body.observation_note_id);
    if (candidate && candidate.initiative_id === verdictNote.initiative_id) {
      observation = candidate;
    } else if (candidate) {
      console.warn(
        `[audit-auto-spawn] observation ${body.observation_note_id} points at a different initiative; ignoring`,
      );
    }
  }

  // 4. Build a trigger_text the PM agent can read straight into its
  //    notes_intake prompt. The shape mirrors what
  //    `formatNoteAsTrigger` in /api/initiatives/[id]/ask-pm-from-notes
  //    produces so PM sees a consistent payload regardless of who
  //    triggered the dispatch.
  const initiative = getInitiative(verdictNote.initiative_id);
  const initiativeTitle = initiative?.title ?? '(unknown initiative)';
  const triggerText = formatTriggerText({
    initiativeId: verdictNote.initiative_id,
    initiativeTitle,
    verdictNote,
    verdictBody: body,
    observation,
  });

  // 5. Dispatch. allowFallback=true matches the disruption path
  //    rather than the strict Ask-PM route: when the auto-spawn fires
  //    opportunistically, dropping a synth placeholder when the
  //    gateway is down is a better UX than silently doing nothing.
  //    The synth row still surfaces in the proposal queue and the
  //    real PM dispatch supersedes it when the gateway reconnects.
  try {
    const result = dispatchPm({
      workspace_id: verdictNote.workspace_id,
      trigger_text: triggerText,
      trigger_kind: 'notes_intake',
      allowFallback: true,
    });

    // 6. Bookkeeping. Idempotent — each helper tolerates an already-
    //    consumed/linked note.
    const notes: AgentNote[] = observation ? [verdictNote, observation] : [verdictNote];
    for (const n of notes) {
      try {
        markNoteConsumed(n.id, CONSUMED_STAGE);
        appendNoteProposalId(n.id, result.proposal.id);
      } catch (err) {
        console.warn(
          `[audit-auto-spawn] note bookkeeping failed for ${n.id}:`,
          (err as Error).message,
        );
      }
    }
  } catch (err) {
    console.warn(
      `[audit-auto-spawn] dispatch failed for verdict ${verdictNote.id}:`,
      (err as Error).message,
    );
  }
}

interface FormatTriggerArgs {
  initiativeId: string;
  initiativeTitle: string;
  verdictNote: AgentNote;
  verdictBody: AuditVerdictBody;
  observation: AgentNote | null;
}

function formatTriggerText(args: FormatTriggerArgs): string {
  const { initiativeId, initiativeTitle, verdictNote, verdictBody, observation } = args;
  const hint = verdictBody.recommended_action_hint ?? 'none';
  const lines: string[] = [
    `Audit verdict for initiative ${initiativeId} ("${initiativeTitle}"): **${verdictBody.verdict}**.`,
    `action_recommended=${verdictBody.action_recommended}, hint=${hint}.`,
    '',
    `Rationale: ${verdictBody.short_rationale}`,
    '',
    `(verdict note ${verdictNote.id})`,
  ];
  if (observation) {
    lines.push(
      '',
      '---',
      '',
      `## Full audit observation (note ${observation.id})`,
      '',
      observation.body,
    );
  }
  return lines.join('\n');
}
