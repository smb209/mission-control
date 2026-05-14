'use client';

/**
 * AC acknowledgement modal — PM convoy mandate slice 5/7.
 *
 * Opens when the operator tries to flip a parent task from `review` →
 * `done` and the PATCH returns `code: 'parent_ac_check_pending'`. The
 * server-returned `acceptance_criteria` payload bootstraps the list so
 * the modal renders synchronously without a second fetch.
 *
 * Each AC has a checkbox + an optional free-text rationale. "Save"
 * persists per-AC via POST /api/tasks/[id]/ac-ack. Once every AC is
 * acknowledged, the "Complete task" button enables and fires the
 * caller-supplied transition (which re-runs the PATCH and clears the
 * gate). A "board_override" escape hatch routes through ConfirmDialog
 * per project convention — no native window.confirm.
 *
 * Per spec: free-text rationale is soft-required for V1 (warn if empty,
 * still allow save). We can tighten to hard-required if operators game
 * the checkbox.
 */

import { useEffect, useState } from 'react';
import { CheckCircle2, Circle, X } from 'lucide-react';
import { ConfirmDialog } from './ConfirmDialog';

export interface AcStatus {
  ac_index: number;
  ac_text: string;
  acknowledged: boolean;
  rationale?: string;
}

interface AcAckModalProps {
  open: boolean;
  taskId: string;
  /** Optional initial snapshot (e.g. from the PATCH 400 body) to avoid a fetch round-trip. */
  initialAcs?: AcStatus[];
  onClose: () => void;
  /** Called when all ACs are acked and the operator confirms completion. */
  onComplete: () => Promise<void> | void;
  /** Called when the operator chooses the board_override escape hatch. */
  onBoardOverride: (reason: string) => Promise<void> | void;
}

export function AcAckModal({
  open,
  taskId,
  initialAcs,
  onClose,
  onComplete,
  onBoardOverride,
}: AcAckModalProps) {
  const [acs, setAcs] = useState<AcStatus[]>(initialAcs ?? []);
  const [rationales, setRationales] = useState<Record<number, string>>({});
  const [savingIndex, setSavingIndex] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmOverride, setConfirmOverride] = useState(false);
  const [overrideReason, setOverrideReason] = useState('');
  const [completing, setCompleting] = useState(false);

  // Refresh from the server on open so we don't miss out-of-band ack rows
  // (e.g. another tab acked an AC since this modal was bootstrapped).
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/tasks/${taskId}/ac-ack`);
        if (!res.ok) return;
        const data = (await res.json()) as { acceptance_criteria: AcStatus[] | null };
        if (cancelled || !data.acceptance_criteria) return;
        setAcs(data.acceptance_criteria);
        const seed: Record<number, string> = {};
        for (const a of data.acceptance_criteria) {
          if (a.rationale) seed[a.ac_index] = a.rationale;
        }
        setRationales(prev => ({ ...seed, ...prev }));
      } catch {
        /* non-fatal — the initialAcs fallback covers offline */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, taskId]);

  const allAcked = acs.length > 0 && acs.every(a => a.acknowledged);

  const handleSave = async (acIndex: number) => {
    setSavingIndex(acIndex);
    setError(null);
    try {
      const rationale = rationales[acIndex]?.trim() ?? '';
      const res = await fetch(`/api/tasks/${taskId}/ac-ack`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ac_index: acIndex, rationale: rationale || undefined }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: 'Save failed' }));
        throw new Error(data.error || `Save failed (${res.status})`);
      }
      const data = (await res.json()) as { acceptance_criteria: AcStatus[] | null };
      if (data.acceptance_criteria) setAcs(data.acceptance_criteria);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSavingIndex(null);
    }
  };

  const handleUnack = async (acIndex: number) => {
    setSavingIndex(acIndex);
    setError(null);
    try {
      const res = await fetch(`/api/tasks/${taskId}/ac-ack`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ac_index: acIndex }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: 'Unack failed' }));
        throw new Error(data.error || `Unack failed (${res.status})`);
      }
      const data = (await res.json()) as { acceptance_criteria: AcStatus[] | null };
      if (data.acceptance_criteria) setAcs(data.acceptance_criteria);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unack failed');
    } finally {
      setSavingIndex(null);
    }
  };

  const handleComplete = async () => {
    setCompleting(true);
    setError(null);
    try {
      await onComplete();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Complete failed');
    } finally {
      setCompleting(false);
    }
  };

  const handleConfirmOverride = async () => {
    setConfirmOverride(false);
    setCompleting(true);
    setError(null);
    try {
      await onBoardOverride(overrideReason.trim() || 'operator override (no reason given)');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Override failed');
    } finally {
      setCompleting(false);
    }
  };

  if (!open) return null;

  return (
    <>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="ac-ack-title"
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
        data-testid="ac-ack-modal"
      >
        <div className="w-full max-w-2xl max-h-[85vh] overflow-hidden flex flex-col rounded-lg border border-mc-border bg-mc-bg shadow-2xl">
          <div className="flex items-center justify-between px-5 py-3 border-b border-mc-border">
            <h2 id="ac-ack-title" className="text-base font-medium">
              Acknowledge convoy acceptance criteria
            </h2>
            <button
              type="button"
              aria-label="Close"
              onClick={onClose}
              className="text-mc-text-secondary hover:text-mc-text"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="px-5 py-3 text-xs text-mc-text-secondary border-b border-mc-border">
            This parent task has feature-level acceptance criteria from a PM-emitted
            convoy. Tick each AC (rationale optional but recommended) before completing.
            Or use board override to bypass with an audit reason.
          </div>

          <div className="flex-1 overflow-y-auto px-5 py-3 space-y-3">
            {acs.length === 0 && (
              <div className="text-sm text-mc-text-secondary">
                No acceptance criteria found for this task.
              </div>
            )}
            {acs.map((ac) => {
              const draft = rationales[ac.ac_index] ?? '';
              const draftDiffersFromSaved = (ac.rationale ?? '') !== draft;
              return (
                <div
                  key={ac.ac_index}
                  className="border border-mc-border rounded-md p-3 bg-mc-bg-secondary"
                  data-testid={`ac-row-${ac.ac_index}`}
                >
                  <div className="flex items-start gap-2">
                    {ac.acknowledged ? (
                      <CheckCircle2 className="w-4 h-4 text-mc-accent-green mt-0.5 shrink-0" />
                    ) : (
                      <Circle className="w-4 h-4 text-mc-text-secondary mt-0.5 shrink-0" />
                    )}
                    <div className="flex-1 text-sm">{ac.ac_text}</div>
                  </div>
                  <textarea
                    value={draft}
                    onChange={(e) =>
                      setRationales((prev) => ({ ...prev, [ac.ac_index]: e.target.value }))
                    }
                    placeholder="Why is this AC satisfied? (optional but recommended)"
                    rows={2}
                    className="mt-2 w-full bg-mc-bg border border-mc-border rounded-sm px-2 py-1.5 text-sm focus:outline-hidden focus:border-mc-accent resize-none"
                    data-testid={`ac-rationale-${ac.ac_index}`}
                  />
                  {!draft.trim() && !ac.acknowledged && (
                    <div className="mt-1 text-[11px] text-amber-400">
                      Rationale empty — recommended but not required.
                    </div>
                  )}
                  <div className="mt-2 flex items-center gap-2">
                    {!ac.acknowledged ? (
                      <button
                        type="button"
                        onClick={() => handleSave(ac.ac_index)}
                        disabled={savingIndex === ac.ac_index}
                        className="px-3 py-1 text-xs bg-mc-accent text-mc-bg rounded-sm font-medium hover:bg-mc-accent/90 disabled:opacity-50"
                        data-testid={`ac-save-${ac.ac_index}`}
                      >
                        {savingIndex === ac.ac_index ? 'Saving…' : 'Acknowledge'}
                      </button>
                    ) : (
                      <>
                        {draftDiffersFromSaved && (
                          <button
                            type="button"
                            onClick={() => handleSave(ac.ac_index)}
                            disabled={savingIndex === ac.ac_index}
                            className="px-3 py-1 text-xs bg-mc-accent text-mc-bg rounded-sm font-medium hover:bg-mc-accent/90 disabled:opacity-50"
                          >
                            Update rationale
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => handleUnack(ac.ac_index)}
                          disabled={savingIndex === ac.ac_index}
                          className="px-3 py-1 text-xs text-mc-text-secondary hover:text-mc-text border border-mc-border rounded-sm disabled:opacity-50"
                        >
                          Undo
                        </button>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {error && (
            <div className="px-5 py-2 bg-red-500/10 border-t border-red-500/30 text-sm text-red-400">
              {error}
            </div>
          )}

          <div className="flex items-center justify-between gap-2 px-5 py-3 border-t border-mc-border">
            <button
              type="button"
              onClick={() => setConfirmOverride(true)}
              disabled={completing}
              className="px-3 py-1.5 text-xs text-mc-text-secondary hover:text-mc-text border border-mc-border rounded-sm disabled:opacity-50"
              data-testid="ac-board-override"
            >
              Override and complete without acknowledging
            </button>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                disabled={completing}
                className="px-3 py-1.5 text-xs border border-mc-border rounded-sm hover:bg-mc-bg-tertiary disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleComplete}
                disabled={!allAcked || completing}
                className="px-3 py-1.5 text-xs bg-mc-accent-green text-mc-bg rounded-sm font-medium hover:bg-mc-accent-green/90 disabled:opacity-50"
                data-testid="ac-complete-task"
              >
                {completing ? 'Completing…' : 'Complete task'}
              </button>
            </div>
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={confirmOverride}
        title="Override AC check and complete?"
        destructive
        body={
          <div className="space-y-2">
            <p className="text-sm">
              This skips the convoy AC acknowledgement gate and marks the task done
              anyway. The override is recorded in the board-override audit log.
            </p>
            <textarea
              value={overrideReason}
              onChange={(e) => setOverrideReason(e.target.value)}
              placeholder="Reason (recorded in audit log)"
              rows={2}
              className="w-full bg-mc-bg-secondary border border-mc-border rounded-sm px-2 py-1.5 text-sm focus:outline-hidden focus:border-mc-accent resize-none"
            />
          </div>
        }
        confirmLabel="Override and complete"
        onCancel={() => setConfirmOverride(false)}
        onConfirm={handleConfirmOverride}
      />
    </>
  );
}
