'use client';

/**
 * Decompose-with-PM modal.
 *
 * Polish B (PM-driven decomposition). The operator picks an existing
 * epic or milestone; the PM proposes 3-7 child initiatives. The
 * operator reviews — reorder, edit, remove, add — then Accept inserts
 * them transactionally with audit rows.
 *
 * Flow:
 *   1. POST /api/pm/decompose-initiative → draft proposal + create_child_initiative diffs.
 *   2. The operator edits the diffs locally (drag-reorder via arrow buttons,
 *      title/description inline edits, +/- rows).
 *   3. On Accept: PATCH the proposal's proposed_changes via a fresh POST
 *      to a new "edit" endpoint? No — simpler: we create the proposal,
 *      then if the operator changed anything we update via a small
 *      helper route. v1 keeps it simple by always re-creating the
 *      proposal on accept with the operator-edited diffs.
 *
 * v1 implementation: the modal calls accept directly with the original
 * proposal. If the operator edited the diffs, we PATCH the proposal's
 * proposed_changes via a small "apply edits" path: we delete the original
 * draft proposal and create a fresh one with the edited diffs, then
 * accept that. This keeps audit clean (one accepted proposal per
 * decompose run) and doesn't require a new mutate-proposal endpoint.
 *
 * Refine: posting to /api/pm/proposals/[id]/refine produces a fresh
 * superseded chain — the modal swaps in the new proposal's diffs.
 */

import { useState, useEffect } from 'react';
import { Sparkles, Send, RefreshCw, Plus, Trash2, ArrowUp, ArrowDown, X } from 'lucide-react';

interface InitiativeLite {
  id: string;
  title: string;
  kind: string;
  workspace_id: string;
}

interface ChildDiff {
  kind: 'create_child_initiative';
  parent_initiative_id: string;
  title: string;
  description?: string | null;
  child_kind: 'epic' | 'story';
  complexity?: 'S' | 'M' | 'L' | 'XL' | null;
  estimated_effort_hours?: number | null;
  sort_order?: number;
  depends_on_initiative_ids?: string[];
}

interface ProposalRow {
  id: string;
  trigger_text: string;
  trigger_kind: string;
  impact_md: string;
  proposed_changes: ChildDiff[];
  status: string;
}

export default function DecomposeWithPmModal({
  initiative,
  onClose,
  onAccepted,
}: {
  initiative: InitiativeLite;
  onClose: () => void;
  onAccepted: () => void;
}) {
  const [proposalId, setProposalId] = useState<string | null>(null);
  const [impactMd, setImpactMd] = useState<string>('');
  const [children, setChildren] = useState<ChildDiff[]>([]);
  const [hint, setHint] = useState('');
  const [loading, setLoading] = useState(false);
  const [refining, setRefining] = useState(false);
  const [refineText, setRefineText] = useState('');
  const [accepting, setAccepting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setErr(null);
      try {
        const res = await fetch('/api/pm/decompose-initiative', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ initiative_id: initiative.id }),
        });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error || `Decompose failed (${res.status})`);
        if (cancelled) return;
        const proposal = body.proposal as ProposalRow;
        setProposalId(proposal.id);
        setImpactMd(proposal.impact_md);
        setChildren(proposal.proposed_changes);
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : 'Decompose failed');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [initiative.id]);

  // Esc to close.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

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
      const proposal = body.proposal as ProposalRow;
      setProposalId(proposal.id);
      setImpactMd(proposal.impact_md);
      setChildren(proposal.proposed_changes);
      setRefineText('');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Refine failed');
    } finally {
      setRefining(false);
    }
  };

  const accept = async () => {
    if (!proposalId) return;
    if (children.length === 0) {
      setErr('Add at least one child or close the modal.');
      return;
    }
    setAccepting(true);
    setErr(null);
    try {
      // The operator may have edited diffs locally; persist those
      // edits onto the proposal row before accepting. We use a small
      // PATCH-style route that updates proposed_changes in place when
      // the proposal is still draft.
      const persist = await fetch(`/api/pm/proposals/${proposalId}/diffs`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ proposed_changes: normalizedChildren(children) }),
      });
      if (!persist.ok) {
        const body = await persist.json().catch(() => ({}));
        throw new Error(body.error || `Could not persist edits (${persist.status})`);
      }
      const res = await fetch(`/api/pm/proposals/${proposalId}/accept`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `Accept failed (${res.status})`);
      onAccepted();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Accept failed');
    } finally {
      setAccepting(false);
    }
  };

  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= children.length) return;
    const next = [...children];
    [next[i], next[j]] = [next[j], next[i]];
    setChildren(next);
  };

  const updateChild = (i: number, patch: Partial<ChildDiff>) => {
    setChildren(prev => prev.map((c, idx) => (idx === i ? { ...c, ...patch } : c)));
  };

  const removeChild = (i: number) => {
    setChildren(prev => prev.filter((_, idx) => idx !== i));
  };

  const addChild = () => {
    setChildren(prev => [
      ...prev,
      {
        kind: 'create_child_initiative',
        parent_initiative_id: initiative.id,
        title: 'New child',
        description: null,
        child_kind: 'story',
        complexity: 'M',
      },
    ]);
  };

  // Strip the embedded JSON comment from the markdown for human display.
  const displayMd = impactMd.replace(/<!--pm-plan-suggestions[\s\S]*?-->/g, '').trim();

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center p-4 z-50"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Decompose initiative with PM"
    >
      <div
        className="bg-mc-bg-secondary border border-mc-border rounded-lg w-full max-w-5xl h-[88vh] flex flex-col text-mc-text"
        onClick={e => e.stopPropagation()}
      >
        <header className="flex items-center justify-between px-5 py-3 border-b border-mc-border">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-mc-accent" />
            <h2 className="text-lg font-semibold">Decompose &ldquo;{initiative.title}&rdquo;</h2>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            title="Close (Esc)"
            className="p-1.5 rounded hover:bg-mc-bg text-mc-text-secondary hover:text-mc-text"
          >
            <X className="w-4 h-4" />
          </button>
        </header>

        {/*
          Body is a flex column with min-h-0 so the children list (the only
          flex-1 region inside) can scroll independently. Without min-h-0 a
          flex child's intrinsic height wins and the inner overflow-y-auto
          collapses. Impact summary gets its own capped height so a long
          blurb can't push the children list out of view.
        */}
        <div className="flex-1 min-h-0 flex flex-col px-5 py-4 gap-4">
          {err && (
            <div className="p-3 rounded bg-red-500/10 border border-red-500/30 text-red-300 text-sm">
              {err}
            </div>
          )}

          {loading ? (
            <div className="flex items-center gap-2 text-sm text-mc-text-secondary">
              <RefreshCw className="w-4 h-4 animate-spin" /> Asking PM to decompose…
            </div>
          ) : (
            <>
              {displayMd && (
                <div className="shrink-0 max-h-32 overflow-y-auto text-xs text-mc-text-secondary whitespace-pre-wrap rounded border border-mc-border bg-mc-bg p-3">
                  {displayMd}
                </div>
              )}

              <div className="flex-1 min-h-0 flex flex-col">
                <div className="shrink-0 flex items-center gap-2 mb-2">
                  <h3 className="text-sm font-medium text-mc-text">
                    Proposed children ({children.length})
                  </h3>
                  <button
                    onClick={addChild}
                    className="ml-auto inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-mc-border text-mc-text-secondary hover:text-mc-text hover:border-mc-accent/40"
                  >
                    <Plus className="w-3 h-3" /> Add child
                  </button>
                </div>

                {children.length === 0 ? (
                  <p className="text-sm text-mc-text-secondary">No children proposed. Add one manually above or refine below.</p>
                ) : (
                  <ul className="flex-1 min-h-0 overflow-y-auto space-y-2 pr-1">
                    {children.map((c, i) => (
                      <li
                        key={i}
                        className="rounded border border-mc-border bg-mc-bg p-3 space-y-2"
                      >
                        <div className="flex items-center gap-2">
                          <div className="flex flex-col gap-1">
                            <button
                              onClick={() => move(i, -1)}
                              disabled={i === 0}
                              aria-label="Move up"
                              className="p-1 rounded hover:bg-mc-bg-secondary text-mc-text-secondary disabled:opacity-30"
                            >
                              <ArrowUp className="w-3 h-3" />
                            </button>
                            <button
                              onClick={() => move(i, 1)}
                              disabled={i === children.length - 1}
                              aria-label="Move down"
                              className="p-1 rounded hover:bg-mc-bg-secondary text-mc-text-secondary disabled:opacity-30"
                            >
                              <ArrowDown className="w-3 h-3" />
                            </button>
                          </div>
                          <select
                            value={c.child_kind}
                            onChange={e => updateChild(i, { child_kind: e.target.value as 'epic' | 'story' })}
                            className="px-2 py-1 rounded bg-mc-bg-secondary border border-mc-border text-xs"
                            aria-label="Child kind"
                          >
                            <option value="story">story</option>
                            <option value="epic">epic</option>
                          </select>
                          <input
                            type="text"
                            value={c.title}
                            onChange={e => updateChild(i, { title: e.target.value })}
                            className="flex-1 px-2 py-1 rounded bg-mc-bg-secondary border border-mc-border text-sm"
                            aria-label={`Title for child ${i + 1}`}
                          />
                          <select
                            value={c.complexity ?? ''}
                            onChange={e => updateChild(i, { complexity: (e.target.value || null) as ChildDiff['complexity'] })}
                            className="px-2 py-1 rounded bg-mc-bg-secondary border border-mc-border text-xs"
                            aria-label="Complexity"
                          >
                            <option value="">—</option>
                            <option value="S">S</option>
                            <option value="M">M</option>
                            <option value="L">L</option>
                            <option value="XL">XL</option>
                          </select>
                          <button
                            onClick={() => removeChild(i)}
                            aria-label={`Remove child ${i + 1}`}
                            className="p-1 rounded hover:bg-red-500/20 text-mc-text-secondary hover:text-red-400"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                        <textarea
                          value={c.description ?? ''}
                          onChange={e => updateChild(i, { description: e.target.value })}
                          placeholder="Description (optional)"
                          className="w-full px-2 py-1.5 rounded bg-mc-bg-secondary border border-mc-border text-xs min-h-[80px] resize-y leading-relaxed"
                          aria-label={`Description for child ${i + 1}`}
                        />
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div className="shrink-0 space-y-2">
                <label className="block">
                  <span className="text-xs text-mc-text-secondary">
                    Refine (e.g., &ldquo;skip the marketing step&rdquo;, &ldquo;add a security review child&rdquo;)
                  </span>
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
                      className="flex-1 px-2 py-1.5 rounded bg-mc-bg border border-mc-border text-xs"
                      placeholder="What should change?"
                      disabled={refining}
                    />
                    <button
                      onClick={refine}
                      disabled={refining || !refineText.trim()}
                      className="inline-flex items-center gap-1 px-2 py-1.5 rounded bg-mc-bg border border-mc-border text-xs text-mc-text disabled:opacity-50"
                    >
                      <Send className="w-3 h-3" />
                      {refining ? 'Refining…' : 'Send'}
                    </button>
                  </div>
                </label>
              </div>
            </>
          )}
        </div>

        <footer className="border-t border-mc-border px-5 py-3 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-3 py-2 rounded border border-mc-border text-mc-text-secondary text-sm"
          >
            Cancel
          </button>
          <button
            onClick={accept}
            disabled={accepting || loading || children.length === 0 || !proposalId}
            className="px-3 py-2 rounded bg-mc-accent text-white text-sm disabled:opacity-50"
          >
            {accepting ? 'Creating…' : `Accept (${children.length} children)`}
          </button>
        </footer>
      </div>
    </div>
  );
}

/** Re-stamp sort_order to the operator's current display order. */
function normalizedChildren(children: ChildDiff[]): ChildDiff[] {
  return children.map((c, i) => ({ ...c, sort_order: i }));
}
