'use client';

/**
 * Investigate modal — mode-aware (narrow / subtree).
 *
 * PR 3 wired narrow mode through the POST /api/initiatives/:id/investigate
 * endpoint. PR 4 (specs/initiative-investigate.md) extends it for subtree
 * mode: the re-audit-policy radio is hidden (subtree always fresh in
 * PR 4), and a pre-flight `?dryrun=1` GET fetches the planned-layers /
 * planned-nodes / concurrency numbers so the modal can render an
 * accurate ETA banner.
 *
 * The audit dispatch is fire-and-forget at the route layer; we close
 * the modal once the orchestration has been queued and let the
 * operator watch for the take_note rows in each node's NotesRail.
 */

import { useEffect, useRef, useState } from 'react';
import {
  Search,
  X,
  Loader2,
  Activity,
  CheckCircle2,
  ExternalLink,
} from 'lucide-react';
import { buildInvestigateBody } from '@/components/inline/investigate-helpers';

interface InitiativeLite {
  id: string;
  title: string;
  workspace_id: string;
}

export interface InvestigateModalProps {
  initiative: InitiativeLite;
  /**
   * Number of prior audit notes for this initiative (kind='observation',
   * audience='pm', importance=2). Used to enable the "Build on prior
   * audit" radio. Caller derives this from the initiative's notes.
   */
  priorAuditCount: number;
  /** Audit scope. Drives radio visibility + endpoint mode. */
  mode?: 'narrow' | 'subtree';
  onClose: () => void;
  /**
   * Called after a successful dispatch. The modal stays open and shows
   * a confirmation panel — the parent should NOT close the modal in
   * response (closing happens when the operator clicks Done or
   * View Activity).
   */
  onDispatched: (result: {
    mode: 'narrow' | 'subtree';
    scope_key?: string;
    root_scope_key?: string;
    attempt?: number;
    planned_nodes?: number;
    planned_layers?: number;
    concurrency?: number;
  }) => void;
  /**
   * Called when the operator clicks "View activity" on the confirmation
   * panel. Parent should close the modal AND scroll the Activity strip
   * into view (audit-actions PR 2 mounts the strip on InitiativeDetailView).
   * If omitted, the button falls back to plain `onClose`.
   */
  onViewActivity?: () => void;
}

interface SubtreePlan {
  planned_nodes: number;
  planned_layers: number;
  concurrency: number;
  per_node_timeout_ms: number;
}

/**
 * Persistent confirmation panel shown after a successful dispatch.
 *
 * Polls /api/jobs filtered to this initiative every 2s and renders a
 * compact live-status line so the operator can watch the dispatch
 * progress without leaving the modal. The same data backs the Activity
 * strip on InitiativeDetailView (audit-actions PR 2) — this is just an
 * in-modal echo so the dispatch confirmation isn't a vanishing toast.
 */
function DispatchedPanel({
  initiative,
  result,
  onRunAnother,
}: {
  initiative: InitiativeLite;
  result: DispatchResult;
  onRunAnother: () => void;
}) {
  interface JobsRow {
    id: string;
    kind: string;
    status: string;
    started_at: string | null;
    completed_at?: string | null;
    derived_label: string;
    parent_run_id: string | null;
  }
  const [live, setLive] = useState<JobsRow[]>([]);
  const [recent, setRecent] = useState<JobsRow[]>([]);
  const [now, setNow] = useState<number>(Date.now());

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      try {
        const url = `/api/jobs?workspace_id=${encodeURIComponent(initiative.workspace_id)}&initiative_id=${encodeURIComponent(initiative.id)}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as { live: JobsRow[]; recent: JobsRow[] };
        if (cancelled) return;
        setLive(json.live ?? []);
        setRecent(json.recent ?? []);
      } catch {
        /* swallow — the strip on the page handles surfacing errors. */
      } finally {
        if (!cancelled) timer = setTimeout(tick, 2000);
      }
    };
    tick();
    const elapsedTimer = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      clearInterval(elapsedTimer);
    };
  }, [initiative.id, initiative.workspace_id]);

  // Filter to runs started at-or-after the dispatch we just kicked off.
  // Belt-and-braces: scope_key alone would match too, but a parent
  // running in subtree fanout doesn't carry the per-node scope.
  const dispatchedAtMs = new Date(result.dispatched_at).getTime();
  const inFlight = live.filter((r) => {
    if (!r.started_at) return true;
    const t = new Date(r.started_at + (r.started_at.includes('T') ? '' : 'Z')).getTime();
    // Tolerate clock skew: include rows started up to 5s before dispatch.
    return t >= dispatchedAtMs - 5_000;
  });
  const justCompleted = recent.filter((r) => {
    if (!r.completed_at) return false;
    const t = new Date(r.completed_at + (r.completed_at.includes('T') ? '' : 'Z')).getTime();
    return t >= dispatchedAtMs - 5_000;
  });

  const runningCount = inFlight.filter((r) => r.status === 'running' || r.status === 'queued').length;
  const completeCount = justCompleted.filter((r) => r.status === 'complete').length;
  const failedCount = justCompleted.filter((r) => r.status === 'failed' || r.status === 'cancelled').length;

  const summary =
    result.mode === 'subtree'
      ? `${result.planned_nodes} initiative${result.planned_nodes === 1 ? '' : 's'} across ${result.planned_layers} layer${result.planned_layers === 1 ? '' : 's'} (up to ${result.concurrency} parallel)`
      : `Narrow audit, attempt ${result.attempt}`;

  function elapsedSec(iso: string | null): number {
    if (!iso) return 0;
    const t = new Date(iso + (iso.includes('T') ? '' : 'Z')).getTime();
    return Math.max(0, Math.round((now - t) / 1000));
  }

  return (
    <div className="px-5 py-4 flex flex-col gap-3">
      <div className="text-sm text-mc-text">
        <p className="leading-snug">
          {summary}. Activity is now visible on the initiative&apos;s detail page,
          so a refresh won&apos;t lose it.
        </p>
      </div>

      <div className="rounded border border-mc-border/60 bg-mc-bg/40 px-3 py-2 text-xs text-mc-text-secondary leading-relaxed">
        {runningCount === 0 && completeCount === 0 && failedCount === 0 ? (
          <span className="opacity-70">Waiting for the run to register…</span>
        ) : (
          <ul className="space-y-1">
            <li>
              <strong className="text-mc-text">{runningCount}</strong> running
              {runningCount > 0 && inFlight[0]?.started_at && (
                <span className="opacity-70">
                  {' '}
                  · oldest {elapsedSec(inFlight[0].started_at)}s
                </span>
              )}
            </li>
            {completeCount > 0 && (
              <li className="text-emerald-600 dark:text-emerald-400">
                <strong>{completeCount}</strong> complete
              </li>
            )}
            {failedCount > 0 && (
              <li className="text-rose-600 dark:text-rose-400">
                <strong>{failedCount}</strong> failed/cancelled
              </li>
            )}
          </ul>
        )}
      </div>

      <button
        onClick={onRunAnother}
        className="self-start text-xs underline text-mc-text-secondary hover:text-mc-text inline-flex items-center gap-1"
      >
        <ExternalLink className="w-3 h-3" />
        Run another audit
      </button>
    </div>
  );
}

type Reaudit = 'fresh' | 'build_on';

const GUIDANCE_MAX = 2000;

interface DispatchResult {
  mode: 'narrow' | 'subtree';
  scope_key?: string;
  root_scope_key?: string;
  attempt?: number;
  planned_nodes?: number;
  planned_layers?: number;
  concurrency?: number;
  dispatched_at: string;
}

export default function InvestigateModal({
  initiative,
  priorAuditCount,
  mode = 'narrow',
  onClose,
  onDispatched,
  onViewActivity,
}: InvestigateModalProps) {
  const [reaudit, setReaudit] = useState<Reaudit>('fresh');
  const [guidance, setGuidance] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [plan, setPlan] = useState<SubtreePlan | null>(null);
  const [planErr, setPlanErr] = useState<string | null>(null);
  // After a successful dispatch, the modal swaps to a persistent
  // confirmation panel instead of closing. Operator dismisses via
  // "Done" or jumps to the Activity strip via "View activity".
  const [dispatched, setDispatched] = useState<DispatchResult | null>(null);
  const [inFlightConflict, setInFlightConflict] = useState<{ message: string } | null>(null);
  // Soft cooldown: when the most recent complete initiative_audit on
  // this initiative is < RECENT_AUDIT_MS old, surface a non-blocking
  // "audited X ago" hint so back-to-back reruns are intentional rather
  // than accidental. Populated from the dryrun GET response.
  // See specs/dedupe-investigations.md §3.
  const [recentAuditAt, setRecentAuditAt] = useState<string | null>(null);

  // Pre-flight: fetch the dryrun endpoint to populate plan info
  // (subtree only) and the recent-audit timestamp (both modes). Falls
  // back to a generic message if the request fails.
  useEffect(() => {
    let cancelled = false;
    setPlanErr(null);
    fetch(
      `/api/initiatives/${initiative.id}/investigate?dryrun=1&mode=${mode}`,
    )
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(
            (body as { error?: string }).error || `Plan fetch failed (${res.status})`,
          );
        }
        if (cancelled) return;
        const last = (body as { last_complete_audit?: { completed_at: string | null } | null })
          .last_complete_audit;
        setRecentAuditAt(last?.completed_at ?? null);
        if (mode === 'subtree') setPlan(body as SubtreePlan);
      })
      .catch((e) => {
        if (!cancelled && mode === 'subtree') {
          setPlanErr(e instanceof Error ? e.message : String(e));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [mode, initiative.id]);

  const canBuildOn = priorAuditCount > 0;

  // Keep the radio in a valid state if the prior count drops to zero
  // mid-modal (rare but possible if SSE archives the only prior).
  useEffect(() => {
    if (!canBuildOn && reaudit === 'build_on') setReaudit('fresh');
  }, [canBuildOn, reaudit]);

  // Esc to close. Stash onClose in a ref so the keydown subscription
  // doesn't churn on every parent render (matches DecomposeWithPmModal).
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCloseRef.current();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const submit = async (opts?: { supersede?: boolean }) => {
    if (submitting) return;
    setSubmitting(true);
    setErr(null);
    try {
      const baseBody = buildInvestigateBody({ reaudit, guidance });
      // Subtree mode is always 'fresh' in PR 4; reaudit field is ignored
      // server-side but harmless to omit. The route default keeps narrow
      // behavior unchanged.
      const requestBody: Record<string, unknown> = mode === 'subtree'
        ? { mode: 'subtree', guidance: baseBody.guidance }
        : { ...baseBody };
      if (opts?.supersede) requestBody.supersede = true;
      const res = await fetch(`/api/initiatives/${initiative.id}/investigate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      });
      // The route returns 200 once the dispatch is queued (or the
      // subtree orchestration is kicked off). Treat any 2xx as success.
      const body = await res.json().catch(() => ({}));
      // 409 audit_in_flight: prompt the operator to cancel the live
      // run and redispatch. Resolved via the inline button → recurse
      // with supersede=true. See specs/dedupe-investigations.md §2.
      if (res.status === 409 && (body as { error?: string }).error === 'audit_in_flight') {
        setInFlightConflict({
          message: (body as { message?: string }).message ?? 'Audit already in flight.',
        });
        return;
      }
      if (!res.ok) {
        throw new Error(
          (body as { error?: string }).error || `Investigate failed (${res.status})`,
        );
      }
      const dispatchedAt = new Date().toISOString();
      if (mode === 'subtree') {
        const { root_scope_key, planned_nodes, planned_layers, concurrency } =
          body as {
            root_scope_key: string;
            planned_nodes: number;
            planned_layers: number;
            concurrency: number;
          };
        const result: DispatchResult = {
          mode: 'subtree',
          root_scope_key,
          planned_nodes,
          planned_layers,
          concurrency,
          dispatched_at: dispatchedAt,
        };
        setDispatched(result);
        onDispatched(result);
      } else {
        const { scope_key, attempt } = body as {
          scope_key: string;
          attempt: number;
        };
        const result: DispatchResult = {
          mode: 'narrow',
          scope_key,
          attempt,
          dispatched_at: dispatchedAt,
        };
        setDispatched(result);
        onDispatched(result);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Investigate failed');
      // Leave the modal open so the operator can adjust + retry.
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center p-4 z-50"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Investigate initiative"
    >
      <div
        className="bg-mc-bg-secondary border border-mc-border rounded-lg w-full max-w-lg flex flex-col text-mc-text"
        onClick={e => e.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-2 px-5 py-3 border-b border-mc-border">
          <div className="flex items-start gap-2">
            {dispatched ? (
              <CheckCircle2 className="w-4 h-4 mt-0.5 text-emerald-500 shrink-0" />
            ) : (
              <Search className="w-4 h-4 mt-0.5 text-mc-accent shrink-0" />
            )}
            <div className="min-w-0">
              <h2 className="text-base font-semibold leading-tight">
                {dispatched
                  ? mode === 'subtree'
                    ? 'Subtree audit dispatched'
                    : 'Audit dispatched'
                  : mode === 'subtree'
                    ? 'Investigate subtree (bottom-up)'
                    : 'Investigate initiative'}
              </h2>
              <p className="text-xs text-mc-text-secondary mt-0.5 truncate" title={initiative.title}>
                {initiative.title}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            title="Close (Esc)"
            className="p-1.5 rounded hover:bg-mc-bg text-mc-text-secondary hover:text-mc-text shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </header>

        {dispatched ? (
          <DispatchedPanel
            initiative={initiative}
            result={dispatched}
            onRunAnother={() => {
              setDispatched(null);
              setErr(null);
            }}
          />
        ) : (
        <div className="px-5 py-4 flex flex-col gap-4">
          {err && (
            <div
              className="p-3 rounded bg-red-500/10 border border-red-500/30 text-red-300 text-sm"
              role="alert"
            >
              {err}
            </div>
          )}

          {recentAuditAt && !inFlightConflict && (() => {
            const ageMs = Date.now() - new Date(recentAuditAt).getTime();
            const RECENT_MS = 15 * 60_000;
            if (ageMs < 0 || ageMs > RECENT_MS) return null;
            const mins = Math.max(1, Math.round(ageMs / 60_000));
            return (
              <div
                className="p-2 rounded bg-mc-bg/40 border border-mc-border text-xs text-mc-text-secondary"
                role="status"
              >
                Last audit completed {mins} minute{mins === 1 ? '' : 's'} ago. Re-audit if something changed.
              </div>
            );
          })()}

          {inFlightConflict && (
            <div
              className="p-3 rounded bg-amber-500/10 border border-amber-500/30 text-amber-200 text-sm flex flex-col gap-2"
              role="alert"
            >
              <div>{inFlightConflict.message}</div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setInFlightConflict(null);
                    void submit({ supersede: true });
                  }}
                  className="px-2 py-1 rounded bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/40 text-xs"
                >
                  Cancel & redispatch
                </button>
                <button
                  type="button"
                  onClick={() => setInFlightConflict(null)}
                  className="px-2 py-1 rounded hover:bg-mc-bg border border-mc-border text-xs text-mc-text-secondary"
                >
                  Keep existing
                </button>
              </div>
            </div>
          )}

          {mode === 'narrow' && (
          <fieldset className="flex flex-col gap-2">
            <legend className="text-xs uppercase tracking-wide text-mc-text-secondary/80">
              Re-audit policy
            </legend>
            <label className="flex items-start gap-2 cursor-pointer text-sm">
              <input
                type="radio"
                name="reaudit"
                value="fresh"
                checked={reaudit === 'fresh'}
                onChange={() => setReaudit('fresh')}
                className="mt-1"
              />
              <span>
                <span className="text-mc-text">Fresh context</span>
                <span className="block text-xs text-mc-text-secondary mt-0.5 leading-snug">
                  Researcher starts clean. New attempt suffix; no prior audit findings inlined.
                </span>
              </span>
            </label>
            <label
              className={`flex items-start gap-2 text-sm ${
                canBuildOn ? 'cursor-pointer' : 'cursor-not-allowed opacity-50'
              }`}
              title={canBuildOn ? undefined : 'No prior audit yet for this initiative'}
            >
              <input
                type="radio"
                name="reaudit"
                value="build_on"
                checked={reaudit === 'build_on'}
                onChange={() => canBuildOn && setReaudit('build_on')}
                disabled={!canBuildOn}
                className="mt-1"
              />
              <span>
                <span className="text-mc-text">Build on prior audit</span>
                <span className="block text-xs text-mc-text-secondary mt-0.5 leading-snug">
                  {canBuildOn
                    ? `Inlines the latest audit note(s) so the researcher refines instead of re-deriving. (${priorAuditCount} prior)`
                    : 'No prior audit yet — run a fresh audit first.'}
                </span>
              </span>
            </label>
          </fieldset>
          )}

          <label className="flex flex-col gap-1">
            <span className="text-xs uppercase tracking-wide text-mc-text-secondary/80">
              Guidance <span className="normal-case opacity-70">(optional)</span>
            </span>
            <textarea
              value={guidance}
              onChange={e => setGuidance(e.target.value.slice(0, GUIDANCE_MAX))}
              rows={5}
              placeholder="Optional &mdash; focus the audit (e.g. &lsquo;check for unused stories, look at db migrations&rsquo;)"
              className="w-full px-2 py-1.5 rounded bg-mc-bg border border-mc-border text-sm text-mc-text outline-none focus:border-mc-accent/60 resize-y leading-relaxed"
              maxLength={GUIDANCE_MAX}
            />
            <span className="text-[10px] text-mc-text-secondary/70 self-end">
              {guidance.length}/{GUIDANCE_MAX}
            </span>
          </label>

          {mode === 'subtree' ? (
            <div className="text-xs text-mc-text-secondary leading-relaxed border border-mc-border/60 rounded p-3 bg-mc-bg/40">
              {planErr ? (
                <span className="text-red-300">Couldn&apos;t plan subtree: {planErr}</span>
              ) : !plan ? (
                <span className="opacity-70">Computing planned nodes…</span>
              ) : (
                <>
                  Audits <strong className="text-mc-text">{plan.planned_nodes}</strong>{' '}
                  initiative{plan.planned_nodes === 1 ? '' : 's'} across{' '}
                  <strong className="text-mc-text">{plan.planned_layers}</strong>{' '}
                  layer{plan.planned_layers === 1 ? '' : 's'}, up to{' '}
                  <strong className="text-mc-text">{plan.concurrency}</strong>{' '}
                  in parallel. Estimated time:{' '}
                  <strong className="text-mc-text">
                    {plan.planned_layers * Math.round(plan.per_node_timeout_ms / 60_000)} min
                  </strong>{' '}
                  worst case (one researcher per node, layered). Each node&apos;s
                  note appears in its own initiative&apos;s notes panel as it
                  completes.
                </>
              )}
            </div>
          ) : (
            <p className="text-xs italic text-mc-text-secondary">
              May take 1–15 minutes. The note will appear in this initiative&apos;s notes panel when complete.
            </p>
          )}
        </div>
        )}

        <footer className="border-t border-mc-border px-5 py-3 flex justify-end gap-2">
          {dispatched ? (
            <>
              <button
                onClick={onClose}
                className="px-3 py-2 rounded border border-mc-border text-mc-text-secondary text-sm"
              >
                Done
              </button>
              <button
                onClick={() => {
                  if (onViewActivity) onViewActivity();
                  else onClose();
                }}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded bg-mc-accent text-white text-sm"
              >
                <Activity className="w-3.5 h-3.5" /> View activity
              </button>
            </>
          ) : (
            <>
              <button
                onClick={onClose}
                disabled={submitting}
                className="px-3 py-2 rounded border border-mc-border text-mc-text-secondary text-sm disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={() => submit()}
                disabled={submitting}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded bg-mc-accent text-white text-sm disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {submitting ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" /> Dispatching…
                  </>
                ) : (
                  <>
                    <Search className="w-3.5 h-3.5" /> Investigate
                  </>
                )}
              </button>
            </>
          )}
        </footer>
      </div>
    </div>
  );
}
