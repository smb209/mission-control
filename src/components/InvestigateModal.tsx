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
import { Search, X, Loader2 } from 'lucide-react';
import { useToast } from '@/components/Toast';
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
  onDispatched: (result: {
    mode: 'narrow' | 'subtree';
    scope_key?: string;
    root_scope_key?: string;
    attempt?: number;
    planned_nodes?: number;
    planned_layers?: number;
    concurrency?: number;
  }) => void;
}

interface SubtreePlan {
  planned_nodes: number;
  planned_layers: number;
  concurrency: number;
  per_node_timeout_ms: number;
}

type Reaudit = 'fresh' | 'build_on';

const GUIDANCE_MAX = 2000;

export default function InvestigateModal({
  initiative,
  priorAuditCount,
  mode = 'narrow',
  onClose,
  onDispatched,
}: InvestigateModalProps) {
  const [reaudit, setReaudit] = useState<Reaudit>('fresh');
  const [guidance, setGuidance] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [plan, setPlan] = useState<SubtreePlan | null>(null);
  const [planErr, setPlanErr] = useState<string | null>(null);
  const { addToast } = useToast();

  // Pre-flight: when opened in subtree mode, fetch the planned-nodes /
  // planned-layers / concurrency from the dryrun endpoint so we can
  // render an accurate ETA banner. Falls back to a generic message if
  // the request fails.
  useEffect(() => {
    if (mode !== 'subtree') return;
    let cancelled = false;
    setPlanErr(null);
    fetch(
      `/api/initiatives/${initiative.id}/investigate?dryrun=1&mode=subtree`,
    )
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(
            (body as { error?: string }).error || `Plan fetch failed (${res.status})`,
          );
        }
        if (!cancelled) setPlan(body as SubtreePlan);
      })
      .catch((e) => {
        if (!cancelled) setPlanErr(e instanceof Error ? e.message : String(e));
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

  const submit = async () => {
    if (submitting) return;
    setSubmitting(true);
    setErr(null);
    try {
      const baseBody = buildInvestigateBody({ reaudit, guidance });
      // Subtree mode is always 'fresh' in PR 4; reaudit field is ignored
      // server-side but harmless to omit. The route default keeps narrow
      // behavior unchanged.
      const requestBody = mode === 'subtree'
        ? { mode: 'subtree', guidance: baseBody.guidance }
        : baseBody;
      const res = await fetch(`/api/initiatives/${initiative.id}/investigate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      });
      // The route returns 200 once the dispatch is queued (or the
      // subtree orchestration is kicked off). Treat any 2xx as success.
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          (body as { error?: string }).error || `Investigate failed (${res.status})`,
        );
      }
      if (mode === 'subtree') {
        const { root_scope_key, planned_nodes, planned_layers, concurrency } =
          body as {
            root_scope_key: string;
            planned_nodes: number;
            planned_layers: number;
            concurrency: number;
          };
        addToast({
          type: 'success',
          title: 'Subtree audit dispatched',
          message: `${planned_nodes} initiative${planned_nodes === 1 ? '' : 's'} across ${planned_layers} layer${planned_layers === 1 ? '' : 's'} (up to ${concurrency} parallel). Each node’s note will appear in its own initiative’s notes panel as it lands.`,
          duration: 10000,
        });
        onDispatched({
          mode: 'subtree',
          root_scope_key,
          planned_nodes,
          planned_layers,
          concurrency,
        });
      } else {
        const { scope_key, attempt } = body as {
          scope_key: string;
          attempt: number;
        };
        addToast({
          type: 'success',
          title: 'Audit dispatched to researcher',
          message:
            'Note will appear in this initiative’s notes panel when the researcher finishes (typically 1–15 min).',
          duration: 8000,
        });
        onDispatched({ mode: 'narrow', scope_key, attempt });
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
            <Search className="w-4 h-4 mt-0.5 text-mc-accent shrink-0" />
            <div className="min-w-0">
              <h2 className="text-base font-semibold leading-tight">
                {mode === 'subtree'
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

        <div className="px-5 py-4 flex flex-col gap-4">
          {err && (
            <div
              className="p-3 rounded bg-red-500/10 border border-red-500/30 text-red-300 text-sm"
              role="alert"
            >
              {err}
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

        <footer className="border-t border-mc-border px-5 py-3 flex justify-end gap-2">
          <button
            onClick={onClose}
            disabled={submitting}
            className="px-3 py-2 rounded border border-mc-border text-mc-text-secondary text-sm disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={submit}
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
        </footer>
      </div>
    </div>
  );
}
