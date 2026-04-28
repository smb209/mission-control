'use client';

/**
 * Plan-with-PM side panel.
 *
 * Polish B (guided planning). Operator hands a draft (title + optional
 * description and pre-set fields) to the PM agent and receives a
 * structured suggestion: refined description, complexity, target window,
 * candidate dependencies, status_check_md scaffolding.
 *
 * The panel:
 *   - POSTs to /api/pm/plan-initiative (creates an advisory pm_proposals
 *     row; accept is a no-op for plan_initiative trigger_kind).
 *   - Lets the operator refine via /api/pm/proposals/[id]/refine
 *     (chained re-synthesis with a free-text additional constraint).
 *   - On "Apply suggestions", calls back to the host with the parsed
 *     suggestions so the host can populate its form fields.
 *
 * The panel does NOT mutate any initiative directly. It is rendered
 * inline inside an existing Drawer, NOT as a separate dialog — keyboard
 * focus stays inside the parent drawer.
 */

import { useState, useEffect, useRef } from 'react';
import { Sparkles, Send, X, RefreshCw, ChevronDown, ChevronRight } from 'lucide-react';
import { parseSuggestionsFromImpactMd as parseSharedSuggestions } from '@/lib/pm/planSuggestionsSidecar';

export interface PlanInitiativeDraft {
  title: string;
  description?: string | null;
  kind?: 'theme' | 'milestone' | 'epic' | 'story';
  complexity?: 'S' | 'M' | 'L' | 'XL' | null;
  parent_initiative_id?: string | null;
  target_start?: string | null;
  target_end?: string | null;
}

export interface PlanInitiativeSuggestions {
  refined_description: string;
  complexity: 'S' | 'M' | 'L' | 'XL';
  target_start: string | null;
  target_end: string;
  dependencies: Array<{
    depends_on_initiative_id: string;
    kind: 'finish_to_start' | 'informational';
    note: string;
  }>;
  status_check_md: string;
  owner_agent_id: string | null;
}

function parseSuggestionsFromImpactMd(md: string): PlanInitiativeSuggestions | null {
  return parseSharedSuggestions(md) as PlanInitiativeSuggestions | null;
}

interface KnownInitiative {
  id: string;
  title: string;
}

export default function PlanWithPmPanel({
  open,
  workspaceId,
  draft,
  knownInitiatives,
  targetInitiativeId,
  initialGuidance,
  onClose,
  onApply,
}: {
  open: boolean;
  workspaceId: string;
  draft: PlanInitiativeDraft;
  knownInitiatives?: KnownInitiative[];
  /**
   * When set, the panel resumes any in-progress draft proposal for
   * this initiative on open (GET) instead of always running a fresh
   * PM dispatch (POST). The server stamps target_initiative_id on the
   * proposal so the resume lookup is initiative-scoped and won't fight
   * with concurrent plans of unrelated drafts.
   */
  targetInitiativeId?: string | null;
  /**
   * Free-text operator steering threaded into the agent prompt for
   * the initial dispatch. Captured by the host before opening the
   * panel (e.g. via the "With guidance…" split-button option). Ignored
   * when resuming an existing draft — the resumed proposal already
   * incorporated whatever guidance the original dispatch carried.
   */
  initialGuidance?: string | null;
  onClose: () => void;
  /**
   * Operator clicked Apply. Receives the parsed suggestions plus the
   * server-side proposal id (so callers that route through
   * `POST /api/pm/proposals/:id/accept` with `target_initiative_id` can
   * apply atomically server-side instead of doing the PATCH dance
   * client-side).
   */
  onApply: (
    suggestions: PlanInitiativeSuggestions,
    ctx: { proposalId: string },
  ) => void;
}) {
  const [proposalId, setProposalId] = useState<string | null>(null);
  const [impactMd, setImpactMd] = useState<string>('');
  const [suggestions, setSuggestions] = useState<PlanInitiativeSuggestions | null>(null);
  const [dispatchState, setDispatchState] = useState<'pending_agent' | 'agent_complete' | 'synth_only' | null>(null);
  const [loading, setLoading] = useState(false);
  const [refining, setRefining] = useState(false);
  const [refineText, setRefineText] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [draftOpen, setDraftOpen] = useState(false);
  // Snapshot the draft at open-time so React-driven re-renders of the
  // host (which construct a fresh `draft` object every render) don't
  // retrigger this effect and cancel the in-flight fetch.
  const draftRef = useRef(draft);
  draftRef.current = draft;

  // The previous implementation guarded against a duplicate fetch with
  // `submittedRef.current = true` set BEFORE the await. Combined with
  // React StrictMode's mount-cleanup-mount sequence in dev, that meant:
  //   1. effect run #1: ref→true, kicks off fetch A
  //   2. cleanup of #1: cancelled1 = true
  //   3. effect run #2 (StrictMode): ref is true → bail without fetching
  //   4. fetch A resolves → cancelled1=true → state never set
  //   → "Thinking…" forever, even though the network log shows a 201.
  // Drop the ref-guard. Each effect run owns its own `cancelled` flag,
  // so even if dev StrictMode fires two requests, exactly one of them
  // wins the state-setter race. In production this runs once.
  useEffect(() => {
    if (!open) {
      // Reset on close so the next open re-runs cleanly.
      setProposalId(null);
      setImpactMd('');
      setSuggestions(null);
      setDispatchState(null);
      setErr(null);
      setRefineText('');
      setDraftOpen(false);
      return;
    }

    let cancelled = false;
    (async () => {
      setLoading(true);
      setErr(null);
      try {
        // Resume path: when we have a target initiative, ask the server
        // for any existing draft first. This is what makes "click away
        // and come back" preserve refinements instead of starting over.
        if (targetInitiativeId) {
          const resumeRes = await fetch(
            `/api/pm/plan-initiative?workspace_id=${encodeURIComponent(workspaceId)}&target_initiative_id=${encodeURIComponent(targetInitiativeId)}`,
          );
          if (resumeRes.ok) {
            const resumeBody = await resumeRes.json();
            if (resumeBody?.proposal && resumeBody?.suggestions) {
              if (cancelled) return;
              setProposalId(resumeBody.proposal_id);
              setImpactMd(resumeBody.proposal.impact_md ?? '');
              setSuggestions(resumeBody.suggestions);
              setDispatchState(resumeBody.proposal.dispatch_state ?? null);
              return; // Skip the POST — we resumed an existing draft.
            }
          }
        }
        const res = await fetch('/api/pm/plan-initiative', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            workspace_id: workspaceId,
            target_initiative_id: targetInitiativeId ?? null,
            guidance: initialGuidance ?? null,
            draft: draftRef.current,
          }),
        });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error || `Plan failed (${res.status})`);
        if (cancelled) return;
        setProposalId(body.proposal_id);
        setImpactMd(body.proposal?.impact_md ?? '');
        setSuggestions(body.suggestions ?? null);
        setDispatchState(body.proposal?.dispatch_state ?? null);
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : 'Plan failed');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, workspaceId, targetInitiativeId, initialGuidance]);

  // Tier 3 of the pm-dispatch-async spec. While the synth placeholder is
  // pending the named-agent reply, listen for the server-side
  // `pm_proposal_replaced` SSE event. When the agent's row supersedes the
  // placeholder, swap to the new proposal id + refetch its content. Also
  // listen for `pm_proposal_dispatch_state_changed` so the indicator
  // resolves to "synth_only" if the agent never replies.
  useEffect(() => {
    if (!open || !proposalId || !targetInitiativeId) return;
    if (dispatchState !== 'pending_agent') return;
    const es = new EventSource('/api/events/stream');
    let cancelled = false;
    const refetch = async (newProposalId: string) => {
      try {
        const url = `/api/pm/plan-initiative?workspace_id=${encodeURIComponent(workspaceId)}&target_initiative_id=${encodeURIComponent(targetInitiativeId)}`;
        const res = await fetch(url);
        if (!res.ok) return;
        const body = await res.json();
        if (cancelled) return;
        // The server's plan-initiative GET already follows the supersede
        // chain when present, so we get the live (agent-completed) row.
        setProposalId(newProposalId);
        setImpactMd(body.proposal?.impact_md ?? '');
        setSuggestions(body.suggestions ?? null);
        setDispatchState(body.proposal?.dispatch_state ?? null);
      } catch {
        // Best-effort — leaves the panel as-is and the operator can refresh manually.
      }
    };
    es.onmessage = (ev) => {
      if (cancelled) return;
      let parsed: { type?: string; payload?: Record<string, unknown> } | null = null;
      try { parsed = JSON.parse(ev.data); } catch { return; }
      if (!parsed || !parsed.type) return;
      if (parsed.type === 'pm_proposal_replaced') {
        const oldId = parsed.payload?.old_id as string | undefined;
        const newId = parsed.payload?.new_id as string | undefined;
        if (oldId === proposalId && newId) {
          void refetch(newId);
        }
      } else if (parsed.type === 'pm_proposal_dispatch_state_changed') {
        const id = parsed.payload?.proposal_id as string | undefined;
        const next = parsed.payload?.dispatch_state as 'pending_agent' | 'agent_complete' | 'synth_only' | undefined;
        if (id === proposalId && next) {
          setDispatchState(next);
        }
      }
    };
    es.onerror = () => {
      // SSE auto-reconnects; nothing to do here.
    };
    return () => {
      cancelled = true;
      es.close();
    };
  }, [open, proposalId, dispatchState, targetInitiativeId, workspaceId]);

  const refine = async () => {
    if (!proposalId || !refineText.trim()) return;
    setRefining(true);
    setErr(null);
    try {
      const res = await fetch(`/api/pm/proposals/${proposalId}/refine`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ additional_constraint: refineText.trim() }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `Refine failed (${res.status})`);
      const newProposal = body.proposal;
      setProposalId(newProposal.id);
      setImpactMd(newProposal.impact_md);
      // Prefer structured plan_suggestions column; fall back to sidecar parsing.
      const refined =
        (newProposal.plan_suggestions as PlanInitiativeSuggestions | null) ??
        parseSuggestionsFromImpactMd(newProposal.impact_md);
      if (refined) setSuggestions(refined);
      setRefineText('');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Refine failed');
    } finally {
      setRefining(false);
    }
  };

  const apply = () => {
    if (suggestions && proposalId) onApply(suggestions, { proposalId });
  };

  // Reject the current draft so the resume lookup skips it on next open.
  // Fire-and-forget — the panel is closing regardless.
  const rejectAndClose = () => {
    if (proposalId) {
      fetch(`/api/pm/proposals/${proposalId}/reject`, { method: 'POST' }).catch(() => {});
    }
    onClose();
  };

  if (!open) return null;

  const titleFor = (id: string) =>
    knownInitiatives?.find(i => i.id === id)?.title ?? id;

  // Strip the embedded JSON comment from the markdown for human display.
  const displayMd = impactMd.replace(/<!--pm-plan-suggestions[\s\S]*?-->/g, '').trim();

  return (
    <aside
      className="border border-mc-accent/30 rounded-lg bg-mc-bg p-4 mt-4"
      role="region"
      aria-label="Plan with PM suggestions"
    >
      <header className="flex items-center gap-2 mb-3">
        <Sparkles className="w-4 h-4 text-mc-accent" />
        <h3 className="font-semibold text-mc-text text-sm">PM suggestions</h3>
        <button
          onClick={rejectAndClose}
          aria-label="Close suggestions panel"
          className="ml-auto p-1 rounded hover:bg-mc-bg-secondary text-mc-text-secondary hover:text-mc-text"
        >
          <X className="w-4 h-4" />
        </button>
      </header>

      <button
        type="button"
        onClick={() => setDraftOpen(o => !o)}
        className="w-full flex items-center gap-1 text-[10px] text-mc-text-secondary uppercase tracking-wide mb-3 hover:text-mc-text transition-colors"
      >
        {draftOpen ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        Your draft
      </button>
      {draftOpen && (
        <div className="rounded border border-mc-border bg-mc-bg-secondary p-3 mb-3 text-xs">
          <div className="text-mc-text">
            <strong>{draft.title}</strong>
            {draft.description ? <p className="text-mc-text-secondary mt-1 whitespace-pre-wrap">{draft.description}</p> : null}
          </div>
        </div>
      )}

      {err && (
        <div className="p-2 rounded bg-red-500/10 border border-red-500/30 text-red-300 text-xs mb-3">
          {err}
        </div>
      )}

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-mc-text-secondary">
          <RefreshCw className="w-4 h-4 animate-spin" /> Thinking…
        </div>
      ) : suggestions ? (
        <>
          {dispatchState === 'pending_agent' && (
            <div
              className="mb-3 flex items-start gap-2 rounded border border-mc-accent/30 bg-mc-accent/5 px-3 py-2 text-[11px] text-mc-text-secondary"
              role="status"
              aria-live="polite"
            >
              <RefreshCw className="w-3.5 h-3.5 mt-[1px] animate-spin text-mc-accent" />
              <div>
                PM agent is still composing — these are draft suggestions from the deterministic synth.
                The agent's final answer will replace this content automatically when it lands.
              </div>
            </div>
          )}
          <div className="rounded border border-mc-border bg-mc-bg-secondary p-3 mb-3 text-xs space-y-2">
            <div>
              <div className="text-mc-text-secondary uppercase tracking-wide text-[10px]">Refined description</div>
              <pre className="text-mc-text whitespace-pre-wrap font-sans text-xs mt-1">{suggestions.refined_description}</pre>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <div className="text-mc-text-secondary uppercase tracking-wide text-[10px]">Complexity</div>
                <div className="text-mc-text font-medium">{suggestions.complexity}</div>
              </div>
              <div>
                <div className="text-mc-text-secondary uppercase tracking-wide text-[10px]">Target start</div>
                <div className="text-mc-text font-medium">{suggestions.target_start ?? '—'}</div>
              </div>
              <div>
                <div className="text-mc-text-secondary uppercase tracking-wide text-[10px]">Target end</div>
                <div className="text-mc-text font-medium">{suggestions.target_end}</div>
              </div>
            </div>
            {(suggestions.dependencies?.length ?? 0) > 0 && (
              <div>
                <div className="text-mc-text-secondary uppercase tracking-wide text-[10px]">
                  Will create on Apply ({suggestions.dependencies!.length} dependenc{suggestions.dependencies!.length === 1 ? 'y' : 'ies'})
                </div>
                <ul className="text-mc-text mt-1 space-y-1">
                  {suggestions.dependencies!.map(d => (
                    <li key={d.depends_on_initiative_id}>
                      <span className="font-medium">{titleFor(d.depends_on_initiative_id)}</span>{' '}
                      <span className="text-mc-text-secondary italic">— {d.note}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          <div className="text-[11px] text-mc-text-secondary mb-3 whitespace-pre-wrap">
            {displayMd}
          </div>

          <div className="space-y-2 mb-3">
            <label className="block">
              <span className="text-xs text-mc-text-secondary">Refine (e.g., "make it L not M, drop the marketing dep")</span>
              <div className="mt-1 flex items-center gap-2">
                <input
                  type="text"
                  value={refineText}
                  onChange={e => setRefineText(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      refine();
                    }
                  }}
                  className="flex-1 px-2 py-1.5 rounded bg-mc-bg-secondary border border-mc-border text-xs"
                  placeholder="What should change?"
                  disabled={refining}
                />
                <button
                  onClick={refine}
                  disabled={refining || !refineText.trim()}
                  className="inline-flex items-center gap-1 px-2 py-1.5 rounded bg-mc-bg-secondary border border-mc-border text-xs text-mc-text disabled:opacity-50"
                >
                  <Send className="w-3 h-3" /> Send
                </button>
              </div>
            </label>
          </div>

          <div className="flex justify-end gap-2">
            <button
              onClick={rejectAndClose}
              className="px-3 py-1.5 rounded border border-mc-border text-mc-text-secondary text-xs"
            >
              Discard
            </button>
            <button
              onClick={apply}
              disabled={dispatchState === 'pending_agent'}
              title={
                dispatchState === 'pending_agent'
                  ? 'PM agent is still composing — wait for it to land or click Discard if you want to start over.'
                  : undefined
              }
              className="px-3 py-1.5 rounded bg-mc-accent text-white text-xs disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Apply suggestions
            </button>
          </div>
        </>
      ) : (
        <p className="text-sm text-mc-text-secondary">No suggestions yet.</p>
      )}
    </aside>
  );
}
