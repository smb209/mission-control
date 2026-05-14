'use client';

import { formatApiError } from '@/lib/format-api-error';

/**
 * Decompose-story-to-tasks modal.
 *
 * Sibling of DecomposeWithPmModal. The operator picks a story; the
 * selected agent (today only PM) proposes a small set of draft tasks.
 * On accept, each task is created via the existing
 * `create_task_under_initiative` diff path — landing in status='draft'
 * linked to the story via task.initiative_id.
 *
 * Reuses the proposal lifecycle endpoints already in place:
 *   - POST /api/pm/decompose-story          (or GET to resume a draft)
 *   - PUT  /api/pm/proposals/[id]/diffs     (persist operator edits)
 *   - POST /api/pm/proposals/[id]/refine    (regen with extra constraint)
 *   - POST /api/pm/proposals/[id]/accept    (apply transactionally)
 */

import { useState, useEffect, useRef } from 'react';
import { Sparkles, Send, RefreshCw, Plus, Trash2, ArrowUp, ArrowDown, X } from 'lucide-react';
import { InFlightProposalCard } from '@/components/InFlightProposalCard';
import { ConvoyDiffPreview, pickConvoyDiffs, type ConvoyDiff } from '@/components/ConvoyDiffPreview';

interface InitiativeLite {
  id: string;
  title: string;
  kind: string;
  workspace_id: string;
}

interface TaskDiff {
  kind: 'create_task_under_initiative';
  initiative_id: string;
  title: string;
  description?: string | null;
  priority?: 'low' | 'normal' | 'high';
  assigned_agent_id?: string | null;
  status_check_md?: string | null;
}

/**
 * Convoy mandate (slice 4): a decompose-story proposal may now carry one
 * or more `create_convoy_under_initiative` diffs instead of (or alongside)
 * the legacy flat task list. The modal renders both shapes — flat tasks
 * keep their existing per-row editor; convoy diffs render read-only
 * through ConvoyDiffPreview and ship as-is on accept (no inline editing
 * in V1; operator uses Refine to revise the plan).
 */
type AnyDiff = TaskDiff | ConvoyDiff;

interface ProposalRow {
  id: string;
  trigger_text: string;
  trigger_kind: string;
  impact_md: string;
  proposed_changes: AnyDiff[];
  status: string;
  dispatch_state?: 'pending_agent' | 'agent_complete' | 'synth_only' | null;
  created_at: string;
}

export default function DecomposeStoryToTasksModal({
  initiative,
  agentId,
  agentLabel,
  initialHint,
  onClose,
  onAccepted,
}: {
  initiative: InitiativeLite;
  /** Selected decomposer agent id from the picker. Reserved for the
   *  multi-agent future; the route enforces PM-only today. */
  agentId?: string | null;
  /** Display label for the picked agent ("PM"), shown in the header so
   *  the operator can confirm which agent ran. */
  agentLabel?: string;
  initialHint?: string | null;
  onClose: () => void;
  onAccepted: () => void;
}) {
  const [proposalId, setProposalId] = useState<string | null>(null);
  const [proposalCreatedAt, setProposalCreatedAt] = useState<string | null>(null);
  const [impactMd, setImpactMd] = useState<string>('');
  const [tasks, setTasks] = useState<AnyDiff[]>([]);
  const [loading, setLoading] = useState(false);
  const [refining, setRefining] = useState(false);
  const [refineText, setRefineText] = useState('');
  const [accepting, setAccepting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [dispatchState, setDispatchState] = useState<'pending_agent' | 'agent_complete' | 'synth_only' | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setErr(null);
      try {
        const resumeRes = await fetch(
          `/api/pm/decompose-story?workspace_id=${encodeURIComponent(initiative.workspace_id)}&initiative_id=${encodeURIComponent(initiative.id)}`,
        );
        if (resumeRes.ok) {
          const resumeBody = await resumeRes.json() as { proposal?: ProposalRow | null };
          if (resumeBody?.proposal) {
            if (cancelled) return;
            setProposalId(resumeBody.proposal.id);
            setProposalCreatedAt(resumeBody.proposal.created_at);
            setImpactMd(resumeBody.proposal.impact_md);
            setTasks(resumeBody.proposal.proposed_changes);
            setDispatchState(resumeBody.proposal.dispatch_state ?? null);
            return;
          }
        }
        const res = await fetch('/api/pm/decompose-story', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            initiative_id: initiative.id,
            ...(initialHint ? { hint: initialHint } : {}),
            ...(agentId ? { agent_id: agentId } : {}),
          }),
        });
        const body = await res.json();
        if (!res.ok) throw new Error(formatApiError(body, `Decompose failed (${res.status})`));
        if (cancelled) return;
        const proposal = body.proposal as ProposalRow;
        setProposalId(proposal.id);
        setProposalCreatedAt(proposal.created_at);
        setImpactMd(proposal.impact_md);
        setTasks(proposal.proposed_changes);
        setDispatchState(proposal.dispatch_state ?? null);
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : 'Decompose failed');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [initiative.id, initiative.workspace_id, initialHint, agentId]);

  // SSE: when the named-agent reply lands, swap the synth placeholder for
  // the agent's row. Mirrors DecomposeWithPmModal.
  useEffect(() => {
    if (!proposalId) return;
    if (dispatchState !== 'pending_agent') return;
    const es = new EventSource('/api/events/stream');
    let cancelled = false;
    const refetch = async () => {
      try {
        const url = `/api/pm/decompose-story?workspace_id=${encodeURIComponent(initiative.workspace_id)}&initiative_id=${encodeURIComponent(initiative.id)}`;
        const res = await fetch(url);
        if (!res.ok) return;
        const body = await res.json() as { proposal?: ProposalRow | null };
        if (cancelled || !body?.proposal) return;
        setProposalId(body.proposal.id);
        setProposalCreatedAt(body.proposal.created_at);
        setImpactMd(body.proposal.impact_md);
        setTasks(body.proposal.proposed_changes);
        setDispatchState(body.proposal.dispatch_state ?? null);
      } catch {
        // best-effort
      }
    };
    es.onmessage = (ev) => {
      if (cancelled) return;
      let parsed: { type?: string; payload?: Record<string, unknown> } | null = null;
      try { parsed = JSON.parse(ev.data); } catch { return; }
      if (!parsed || !parsed.type) return;
      if (parsed.type === 'pm_proposal_replaced') {
        const oldId = parsed.payload?.old_id as string | undefined;
        if (oldId === proposalId) void refetch();
      } else if (parsed.type === 'pm_proposal_dispatch_state_changed') {
        const id = parsed.payload?.proposal_id as string | undefined;
        const next = parsed.payload?.dispatch_state as 'pending_agent' | 'agent_complete' | 'synth_only' | undefined;
        if (id === proposalId && next) setDispatchState(next);
      }
    };
    return () => {
      cancelled = true;
      es.close();
    };
  }, [proposalId, dispatchState, initiative.id, initiative.workspace_id]);

  // Stash onClose in a ref so the keydown subscription doesn't churn
  // on every parent render — same fix as Drawer.tsx.
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
      if (!res.ok) throw new Error(formatApiError(body, `Refine failed (${res.status})`));
      const proposal = body.proposal as ProposalRow;
      setProposalId(proposal.id);
      setProposalCreatedAt(proposal.created_at);
      setImpactMd(proposal.impact_md);
      setTasks(proposal.proposed_changes);
      setRefineText('');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Refine failed');
    } finally {
      setRefining(false);
    }
  };

  const accept = async () => {
    if (!proposalId) return;
    if (tasks.length === 0) {
      setErr('Add at least one task or close the modal.');
      return;
    }
    setAccepting(true);
    setErr(null);
    try {
      const persist = await fetch(`/api/pm/proposals/${proposalId}/diffs`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ proposed_changes: tasks }),
      });
      if (!persist.ok) {
        const body = await persist.json().catch(() => ({}));
        throw new Error(formatApiError(body, `Could not persist edits (${persist.status})`));
      }
      const res = await fetch(`/api/pm/proposals/${proposalId}/accept`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(formatApiError(body, `Accept failed (${res.status})`));
      // Convoy mandate (slice 4): on a successful apply the backend
      // mutates each create_convoy_under_initiative diff in place with
      // `created_convoy_id` + `created_parent_task_id`. We expose that to
      // the host so it can navigate to the parent task page where the
      // operator can monitor dispatch instead of bouncing back to the
      // roadmap. Hosts that don't care still get the existing onAccepted
      // ping.
      onAccepted();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Accept failed');
    } finally {
      setAccepting(false);
    }
  };

  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= tasks.length) return;
    const next = [...tasks];
    [next[i], next[j]] = [next[j], next[i]];
    setTasks(next);
  };

  const updateTask = (i: number, patch: Partial<TaskDiff>) => {
    setTasks(prev =>
      prev.map((c, idx) =>
        idx === i && c.kind === 'create_task_under_initiative' ? { ...c, ...patch } : c,
      ),
    );
  };

  const removeTask = (i: number) => {
    setTasks(prev => prev.filter((_, idx) => idx !== i));
  };

  const addTask = () => {
    setTasks(prev => [
      ...prev,
      {
        kind: 'create_task_under_initiative',
        initiative_id: initiative.id,
        title: 'New task',
        description: null,
        priority: 'normal',
      },
    ]);
  };

  const displayMd = impactMd.replace(/<!--pm-plan-suggestions[\s\S]*?-->/g, '').trim();
  const headerLabel = agentLabel ? `Create tasks with ${agentLabel}` : 'Create tasks';

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center p-4 z-50"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Create tasks from story"
    >
      <div
        className="bg-mc-bg-secondary border border-mc-border rounded-lg w-full max-w-5xl h-[88vh] flex flex-col text-mc-text"
        onClick={e => e.stopPropagation()}
      >
        <header className="flex items-center justify-between px-5 py-3 border-b border-mc-border">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-mc-accent" />
            <h2 className="text-lg font-semibold">{headerLabel}: &ldquo;{initiative.title}&rdquo;</h2>
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

        <div className="flex-1 min-h-0 flex flex-col px-5 py-4 gap-4">
          {err && (
            <div className="p-3 rounded bg-red-500/10 border border-red-500/30 text-red-300 text-sm whitespace-pre-wrap">
              {err}
            </div>
          )}

          {loading ? (
            <div className="flex items-center gap-2 text-sm text-mc-text-secondary">
              <RefreshCw className="w-4 h-4 animate-spin" /> Asking {agentLabel ?? 'PM'} to decompose…
            </div>
          ) : dispatchState === 'pending_agent' && proposalId ? (
            // While the agent composes, replace the synth-template body
            // with the in-flight card. Story 2edccd24 ("In-flight
            // proposal card replaces synth-as-placeholder"). SSE-driven
            // card swaps to the real proposal when pm_proposal_replaced
            // fires.
            <InFlightProposalCard
              proposalId={proposalId}
              workspaceId={initiative.workspace_id}
              sessionKey={null}
              sentAt={proposalCreatedAt ?? new Date().toISOString()}
              onCancel={() => {
                // Flip dispatch_state to 'cancelled' so the dispatcher
                // short-circuits its poll loop. The card hides via SSE.
                fetch(`/api/pm/proposals/${proposalId}/cancel`, { method: 'POST' }).catch(() => {});
                onClose();
              }}
              onUseSynthFallback={() => {
                setDispatchState('synth_only');
              }}
            />
          ) : (() => {
            // Convoy mandate (slice 4): split diffs by kind so convoy DAGs
            // render through the shared preview while flat task diffs
            // (notes-intake style, or legacy decompose output) still get
            // the inline editor.
            const convoyDiffs = pickConvoyDiffs(tasks);
            const flatTasks = tasks.filter(
              (t): t is TaskDiff => t.kind === 'create_task_under_initiative',
            );
            return (
            <>
              {displayMd && (
                <div className="shrink-0 max-h-32 overflow-y-auto text-xs text-mc-text-secondary whitespace-pre-wrap rounded border border-mc-border bg-mc-bg p-3">
                  {displayMd}
                </div>
              )}

              {convoyDiffs.length > 0 && (
                <div className="shrink-0 max-h-[40vh] overflow-y-auto pr-1">
                  {convoyDiffs.map((d, i) => (
                    <ConvoyDiffPreview key={i} diff={d} className="space-y-3 mb-3" />
                  ))}
                </div>
              )}

              <div className="flex-1 min-h-0 flex flex-col">
                <div className="shrink-0 flex items-center gap-2 mb-2">
                  <h3 className="text-sm font-medium text-mc-text">
                    {convoyDiffs.length > 0 && flatTasks.length === 0
                      ? `Convoy plan (${convoyDiffs.reduce((n, d) => n + d.slices.length, 0)} slices)`
                      : `Proposed tasks (${flatTasks.length})`}
                  </h3>
                  {!(convoyDiffs.length > 0 && flatTasks.length === 0) && (
                    <button
                      onClick={addTask}
                      className="ml-auto inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-mc-border text-mc-text-secondary hover:text-mc-text hover:border-mc-accent/40"
                    >
                      <Plus className="w-3 h-3" /> Add task
                    </button>
                  )}
                </div>

                {tasks.length === 0 ? (
                  <p className="text-sm text-mc-text-secondary">No tasks proposed. Add one manually above or refine below.</p>
                ) : flatTasks.length === 0 ? (
                  <p className="text-sm text-mc-text-secondary">Convoy plan is read-only here — use Refine to revise.</p>
                ) : (
                  <ul className="flex-1 min-h-0 overflow-y-auto space-y-2 pr-1">
                    {tasks.map((c, i) => {
                      if (c.kind !== 'create_task_under_initiative') return null;
                      return (
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
                              disabled={i === tasks.length - 1}
                              aria-label="Move down"
                              className="p-1 rounded hover:bg-mc-bg-secondary text-mc-text-secondary disabled:opacity-30"
                            >
                              <ArrowDown className="w-3 h-3" />
                            </button>
                          </div>
                          <input
                            type="text"
                            value={c.title}
                            onChange={e => updateTask(i, { title: e.target.value })}
                            className="flex-1 px-2 py-1 rounded bg-mc-bg-secondary border border-mc-border text-sm"
                            aria-label={`Title for task ${i + 1}`}
                          />
                          <select
                            value={c.priority ?? 'normal'}
                            onChange={e => updateTask(i, { priority: e.target.value as 'low' | 'normal' | 'high' })}
                            className="px-2 py-1 rounded bg-mc-bg-secondary border border-mc-border text-xs"
                            aria-label="Priority"
                          >
                            <option value="low">low</option>
                            <option value="normal">normal</option>
                            <option value="high">high</option>
                          </select>
                          <button
                            onClick={() => removeTask(i)}
                            aria-label={`Remove task ${i + 1}`}
                            className="p-1 rounded hover:bg-red-500/20 text-mc-text-secondary hover:text-red-400"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                        <textarea
                          value={c.description ?? ''}
                          onChange={e => updateTask(i, { description: e.target.value })}
                          placeholder="Description (optional)"
                          className="w-full px-2 py-1.5 rounded bg-mc-bg-secondary border border-mc-border text-xs min-h-[80px] resize-y leading-relaxed"
                          aria-label={`Description for task ${i + 1}`}
                        />
                      </li>
                      );
                    })}
                  </ul>
                )}
              </div>

              <div className="shrink-0 space-y-2">
                <label className="block">
                  <span className="text-xs text-mc-text-secondary">
                    Refine (e.g., &ldquo;merge the test step into implementation&rdquo;, &ldquo;add a docs task&rdquo;)
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
            );
          })()}
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
            disabled={accepting || loading || tasks.length === 0 || !proposalId || dispatchState === 'pending_agent'}
            title={
              dispatchState === 'pending_agent'
                ? `${agentLabel ?? 'PM'} agent is still composing — wait for the breakdown or click Cancel.`
                : undefined
            }
            className="px-3 py-2 rounded bg-mc-accent text-white text-sm disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {accepting
              ? 'Creating…'
              : (() => {
                  const convoyDiffs = pickConvoyDiffs(
                    tasks,
                  );
                  const sliceCount = convoyDiffs.reduce((n, d) => n + d.slices.length, 0);
                  if (convoyDiffs.length > 0 && sliceCount > 0) {
                    return `Plan and dispatch convoy (${sliceCount} slice${sliceCount === 1 ? '' : 's'})`;
                  }
                  const taskCount = tasks.filter((t) => t.kind === 'create_task_under_initiative').length;
                  return `Accept (${taskCount} draft task${taskCount === 1 ? '' : 's'})`;
                })()}
          </button>
        </footer>
      </div>
    </div>
  );
}
