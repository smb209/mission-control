'use client';

/**
 * /pm — operator chat with the PM agent (Phase 5 of the roadmap & PM
 * feature). Reuses the agent_chat_messages table for the chat thread,
 * but sends operator turns through the dedicated PM dispatch path
 * (POST /api/pm/proposals) so each disruption produces a structured
 * proposal card the operator can refine / accept / reject.
 *
 * Layout: workspace selector at top, chat thread on the left, "Recent
 * proposals" sidebar on the right with proposal status chips.
 */

import { useEffect, useState, useCallback, useMemo, useRef, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { Send, AlertTriangle, Check, X, RefreshCw, Loader, Inbox, Sunrise, Pin, ArrowDown } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  useCurrentWorkspaceId,
  useSetCurrentWorkspaceId,
} from '@/components/shell/workspace-context';

interface Workspace {
  id: string;
  name: string;
  slug: string;
  icon?: string;
}

interface AgentChatMessage {
  id: string;
  agent_id: string;
  role: 'user' | 'assistant';
  content: string;
  status: 'pending' | 'delivered';
  metadata?: string;
  created_at: string;
}

interface PmDiff {
  kind: string;
  initiative_id?: string;
  agent_id?: string;
  status?: string;
  target_start?: string;
  target_end?: string;
  start?: string;
  end?: string;
  reason?: string;
  status_check_md?: string;
  depends_on_initiative_id?: string;
  dependency_id?: string;
  parent_id?: string | null;
  child_ids_in_order?: string[];
  note?: string;
}

interface PmProposal {
  id: string;
  workspace_id: string;
  trigger_text: string;
  trigger_kind: string;
  impact_md: string;
  proposed_changes: PmDiff[];
  status: 'draft' | 'accepted' | 'rejected' | 'superseded';
  applied_at: string | null;
  parent_proposal_id: string | null;
  created_at: string;
}

interface AgentLite {
  id: string;
  name: string;
  role: string;
  workspace_id: string;
}

const STATUS_BADGE: Record<PmProposal['status'], string> = {
  draft: 'bg-amber-500/20 text-amber-300',
  accepted: 'bg-emerald-500/20 text-emerald-300',
  rejected: 'bg-red-500/20 text-red-300',
  superseded: 'bg-zinc-500/20 text-zinc-300',
};

// Trigger-kind badge palette. Distinct colors so the operator can tell at a
// glance whether a card was operator-initiated (manual), scheduled (drift),
// or a disruption response.
const TRIGGER_BADGE: Record<string, { label: string; cls: string }> = {
  manual: { label: 'manual', cls: 'bg-blue-500/15 text-blue-300 border-blue-500/30' },
  scheduled_drift_scan: {
    label: 'scheduled',
    cls: 'bg-violet-500/15 text-violet-300 border-violet-500/30',
  },
  disruption_event: {
    label: 'disruption',
    cls: 'bg-orange-500/15 text-orange-300 border-orange-500/30',
  },
  status_check_investigation: {
    label: 'status check',
    cls: 'bg-cyan-500/15 text-cyan-300 border-cyan-500/30',
  },
};

export default function PmChatPage() {
  // useSearchParams() requires a Suspense boundary during static prerender
  // (Next 16). The actual page contents live in PmChatPageInner below.
  return (
    <Suspense fallback={null}>
      <PmChatPageInner />
    </Suspense>
  );
}

function PmChatPageInner() {
  const workspaceId = useCurrentWorkspaceId();
  const setCurrentWorkspaceId = useSetCurrentWorkspaceId();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [pmAgent, setPmAgent] = useState<AgentLite | null>(null);
  const [messages, setMessages] = useState<AgentChatMessage[]>([]);
  const [proposals, setProposals] = useState<Record<string, PmProposal>>({});
  const [recentProposals, setRecentProposals] = useState<PmProposal[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refining, setRefining] = useState<string | null>(null);
  const [refineText, setRefineText] = useState('');
  const [runningStandup, setRunningStandup] = useState(false);
  const [standupBanner, setStandupBanner] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const cardRefs = useRef<Map<string, HTMLDivElement | null>>(new Map());
  // Sticky-bottom: only auto-scroll if the user is already near the
  // bottom. The page polls /api/agents/<pm>/chat every 3s — without this
  // gate the auto-scroll yanked the operator back every poll, even when
  // they were trying to read older proposals. We refresh the flag on
  // scroll events using a "within 80px of bottom" threshold so a small
  // accidental nudge doesn't break stickiness.
  const [stuckToBottom, setStuckToBottom] = useState(true);

  // Phase 6: support `?proposal=<id>` deep-links — scroll to and highlight
  // the matching proposal card on load. Cleared after first successful
  // scroll so subsequent re-renders don't keep re-scrolling.
  const searchParams = useSearchParams();
  const focusProposalId = searchParams?.get('proposal') ?? null;
  const [highlightedProposalId, setHighlightedProposalId] = useState<string | null>(null);

  // Load workspace list once. The global switcher in the left nav owns the
  // selected id; we only fetch the list here so the legacy fallback path
  // can still pick up a sensible default if the stored id no longer exists.
  useEffect(() => {
    fetch('/api/workspaces')
      .then(r => r.json())
      .then((rows: Workspace[]) => {
        setWorkspaces(rows);
        if (rows.length > 0 && !rows.find(w => w.id === workspaceId)) {
          setCurrentWorkspaceId(rows[0].id);
        }
      })
      .catch(() => { /* leave empty */ });
    // intentionally only on mount — workspaceId/setCurrentWorkspaceId
    // changes after a switcher click and we don't need to re-bootstrap.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Resolve the PM agent for the selected workspace.
  useEffect(() => {
    if (!workspaceId) return;
    fetch(`/api/agents?workspace_id=${encodeURIComponent(workspaceId)}`)
      .then(r => r.ok ? r.json() : Promise.reject(r.status))
      .then((agents: AgentLite[]) => {
        const pm = agents.find(a => a.role === 'pm');
        setPmAgent(pm ?? null);
        if (!pm) {
          setError(
            'No PM agent for this workspace. Migration 045 should have seeded one — try restarting the dev server, or create the workspace anew.',
          );
        } else {
          setError(null);
        }
      })
      .catch(() => setError('Failed to load workspace agents'));
  }, [workspaceId]);

  const loadMessages = useCallback(async () => {
    if (!pmAgent) return;
    try {
      const res = await fetch(`/api/agents/${pmAgent.id}/chat`);
      if (!res.ok) return;
      const rows: AgentChatMessage[] = await res.json();
      setMessages(rows);

      // Find proposal_ids referenced from metadata; fetch those proposals.
      const ids = new Set<string>();
      for (const m of rows) {
        if (!m.metadata) continue;
        try {
          const parsed = JSON.parse(m.metadata) as { proposal_id?: string };
          if (parsed.proposal_id) ids.add(parsed.proposal_id);
        } catch { /* ignore */ }
      }
      if (ids.size > 0) {
        const fetched = await Promise.all(
          [...ids].map(id =>
            fetch(`/api/pm/proposals/${id}`)
              .then(r => (r.ok ? r.json() : null))
              .catch(() => null),
          ),
        );
        const next: Record<string, PmProposal> = {};
        for (const p of fetched) {
          if (p) next[p.id] = p;
        }
        setProposals(next);
      }
    } catch { /* silent retry */ }
  }, [pmAgent]);

  const loadRecent = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/pm/proposals?workspace_id=${encodeURIComponent(workspaceId)}&limit=20`,
      );
      if (res.ok) setRecentProposals(await res.json());
    } catch { /* ignore */ }
  }, [workspaceId]);

  useEffect(() => {
    if (!pmAgent) return;
    loadMessages();
    loadRecent();
    const id = setInterval(() => {
      loadMessages();
      loadRecent();
    }, 3000);
    return () => clearInterval(id);
  }, [pmAgent, loadMessages, loadRecent]);

  // Auto-scroll only when the operator is already at the bottom. This
  // depends on `messages` AND the latest stuckToBottom value — including
  // stuckToBottom in the deps list would re-scroll the moment they touch
  // the bottom again, which is the desired behaviour.
  useEffect(() => {
    if (!stuckToBottom) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, stuckToBottom]);

  const onScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const distanceFromBottom = el.scrollHeight - (el.scrollTop + el.clientHeight);
    setStuckToBottom(distanceFromBottom < 80);
  }, []);

  const jumpToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    setStuckToBottom(true);
  }, []);

  const handleSend = async () => {
    if (!input.trim() || sending) return;
    setSending(true);
    setError(null);
    try {
      const res = await fetch('/api/pm/proposals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspace_id: workspaceId,
          trigger_text: input.trim(),
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Failed to dispatch (${res.status})`);
      }
      setInput('');
      // The operator just dispatched — they want to see the result. Re-stick
      // to the bottom even if they had been scrolled up reading old cards.
      setStuckToBottom(true);
      await loadMessages();
      await loadRecent();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSending(false);
    }
  };

  const onAccept = async (proposalId: string) => {
    try {
      const res = await fetch(`/api/pm/proposals/${proposalId}/accept`, { method: 'POST' });
      if (!res.ok) throw new Error('Accept failed');
      await loadMessages();
      await loadRecent();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const onReject = async (proposalId: string) => {
    try {
      const res = await fetch(`/api/pm/proposals/${proposalId}/reject`, { method: 'POST' });
      if (!res.ok) throw new Error('Reject failed');
      await loadMessages();
      await loadRecent();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const onRefineSubmit = async (parentId: string) => {
    if (!refineText.trim()) return;
    try {
      const res = await fetch(`/api/pm/proposals/${parentId}/refine`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ additional_constraint: refineText.trim() }),
      });
      if (!res.ok) throw new Error('Refine failed');
      setRefining(null);
      setRefineText('');
      await loadMessages();
      await loadRecent();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleRunStandup = useCallback(async () => {
    if (runningStandup) return;
    setRunningStandup(true);
    setStandupBanner(null);
    setError(null);
    try {
      const res = await fetch('/api/pm/standup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace_id: workspaceId, force: true }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Standup failed');
      if (data.proposal) {
        setStandupBanner(
          `Standup posted — ${data.drift_count ?? 0} drift signal${data.drift_count === 1 ? '' : 's'}.`,
        );
      } else {
        setStandupBanner(
          `Standup ran — nothing to surface (${data.reason ?? 'no_drift'}).`,
        );
      }
      await loadMessages();
      await loadRecent();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRunningStandup(false);
    }
  }, [runningStandup, workspaceId, loadMessages, loadRecent]);

  // Deep-link scroll: once the proposal card is rendered, scroll it into
  // view and apply a transient highlight class. We watch `proposals` so the
  // effect waits for the underlying fetches in `loadMessages` to populate.
  useEffect(() => {
    if (!focusProposalId) return;
    if (!proposals[focusProposalId]) return;
    const el = cardRefs.current.get(focusProposalId);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setHighlightedProposalId(focusProposalId);
      // Auto-dim the highlight after 4s.
      const timer = setTimeout(() => setHighlightedProposalId(null), 4000);
      return () => clearTimeout(timer);
    }
  }, [focusProposalId, proposals]);

  const proposalCount = useMemo(() => {
    const draft = recentProposals.filter(p => p.status === 'draft').length;
    return { draft, total: recentProposals.length };
  }, [recentProposals]);

  // Latest still-draft standup proposal for the current workspace, if any.
  // Used to render the pinned banner at the top of the chat thread.
  const pinnedStandup = useMemo<PmProposal | null>(() => {
    const standups = recentProposals.filter(
      p =>
        p.workspace_id === workspaceId &&
        p.status === 'draft' &&
        p.trigger_kind === 'scheduled_drift_scan',
    );
    if (standups.length === 0) return null;
    // Newest first.
    return standups.sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
  }, [recentProposals, workspaceId]);

  return (
    <div className="flex flex-col h-full bg-mc-bg text-mc-text">
      {/* Page header. Workspace selection now lives in the unified left
          nav — this header only carries page-scoped controls. */}
      <header className="border-b border-mc-border px-4 py-3 flex items-center gap-4 shrink-0">
        <h1 className="text-lg font-semibold">📋 PM Chat</h1>
        <span className="text-xs text-mc-text-secondary">
          {workspaces.find(w => w.id === workspaceId)?.name ?? workspaceId}
        </span>
        <div className="ml-auto text-xs text-mc-text-secondary">
          {proposalCount.draft} draft · {proposalCount.total} total
        </div>
        <button
          type="button"
          onClick={handleRunStandup}
          disabled={!pmAgent || runningStandup}
          title="Run today's PM standup now (proactive drift scan)"
          className="flex items-center gap-1.5 text-xs px-2.5 py-1 border border-mc-border rounded-sm hover:bg-mc-bg/50 disabled:opacity-50"
        >
          {runningStandup ? <Loader className="w-3 h-3 animate-spin" /> : <Sunrise className="w-3 h-3" />}
          Run standup
        </button>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* Chat thread */}
        <main className="flex flex-col flex-1 min-w-0">
          {error && (
            <div className="m-3 px-3 py-2 bg-red-500/10 border border-red-500/30 text-red-300 text-sm rounded-sm flex items-center gap-2">
              <AlertTriangle className="w-4 h-4" /> {error}
            </div>
          )}
          {standupBanner && (
            <div className="m-3 px-3 py-2 bg-violet-500/10 border border-violet-500/30 text-violet-200 text-sm rounded-sm flex items-center gap-2">
              <Sunrise className="w-4 h-4" /> {standupBanner}
              <button
                type="button"
                onClick={() => setStandupBanner(null)}
                className="ml-auto text-violet-300/70 hover:text-violet-200"
                aria-label="Dismiss"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          )}
          {pinnedStandup && (
            <PinnedStandupCard
              proposal={pinnedStandup}
              onAccept={onAccept}
              onReject={onReject}
              setRef={(el) => cardRefs.current.set(pinnedStandup.id, el)}
              highlighted={highlightedProposalId === pinnedStandup.id}
            />
          )}
          <div className="relative flex-1 min-h-0">
            <div
              ref={scrollRef}
              onScroll={onScroll}
              className="absolute inset-0 overflow-y-auto p-4 space-y-3"
            >
            {messages.length === 0 && pmAgent && (
              <div className="text-center py-12 text-mc-text-secondary">
                <Inbox className="w-8 h-8 mx-auto mb-3 opacity-50" />
                <p className="text-sm">Drop a disruption to get started.</p>
                <p className="text-xs mt-1 opacity-70">
                  Examples: &quot;Sarah out next week&quot; · &quot;API X delayed until 2026-05-03&quot; · &quot;We&apos;re cutting Phase 2&quot;
                </p>
              </div>
            )}

            {messages.map(m => {
              const pid = parseProposalId(m);
              const proposal = pid ? proposals[pid] : undefined;
              // Suppress duplicate render of the pinned standup card here —
              // it's already rendered above the thread.
              if (proposal && pinnedStandup && proposal.id === pinnedStandup.id) {
                return null;
              }
              return (
                <ChatMessageRow
                  key={m.id}
                  message={m}
                  proposal={proposal}
                  onAccept={onAccept}
                  onReject={onReject}
                  refining={refining}
                  refineText={refineText}
                  onRefineStart={(id) => { setRefining(id); setRefineText(''); }}
                  onRefineCancel={() => { setRefining(null); setRefineText(''); }}
                  onRefineSubmit={onRefineSubmit}
                  onRefineTextChange={setRefineText}
                  setCardRef={(id, el) => cardRefs.current.set(id, el)}
                  highlighted={proposal ? highlightedProposalId === proposal.id : false}
                />
              );
            })}
            </div>
            {/* Floating "jump to bottom" — only when the user has scrolled
                up enough that auto-stick is disabled. New messages land
                while they're scrolled up; this gives them a one-click way
                to catch up without losing their reading position by
                accident. */}
            {!stuckToBottom && (
              <button
                type="button"
                onClick={jumpToBottom}
                className="absolute bottom-3 right-4 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-mc-accent text-mc-bg text-xs font-medium shadow-lg hover:bg-mc-accent/90"
                title="Jump to latest"
              >
                <ArrowDown className="w-3.5 h-3.5" /> Jump to latest
              </button>
            )}
          </div>

          <div className="border-t border-mc-border p-3 space-y-2 shrink-0">
            <div className="flex gap-2">
              <textarea
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={onKeyDown}
                rows={2}
                placeholder={
                  pmAgent
                    ? 'Drop a disruption — the PM will respond with a proposal card.'
                    : 'No PM agent in this workspace.'
                }
                disabled={!pmAgent || sending}
                className="flex-1 bg-mc-bg border border-mc-border rounded-sm px-3 py-2 text-sm focus:outline-hidden focus:border-mc-accent resize-none disabled:opacity-50"
              />
              <button
                type="button"
                onClick={handleSend}
                disabled={!pmAgent || !input.trim() || sending}
                className="self-end flex items-center gap-2 px-3 py-2 bg-mc-accent text-mc-bg rounded-sm text-sm font-medium hover:bg-mc-accent/90 disabled:opacity-50"
              >
                {sending ? <Loader className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                Dispatch
              </button>
            </div>
          </div>
        </main>

        {/* Sidebar: recent proposals */}
        <aside className="w-80 border-l border-mc-border overflow-y-auto shrink-0 hidden lg:block">
          <div className="px-4 py-3 border-b border-mc-border flex items-center justify-between">
            <h2 className="text-sm font-semibold">Recent proposals</h2>
            <button
              type="button"
              onClick={loadRecent}
              className="text-xs text-mc-text-secondary hover:text-mc-text"
              title="Refresh"
            >
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
          </div>
          <ul className="divide-y divide-mc-border">
            {recentProposals.length === 0 && (
              <li className="px-4 py-6 text-center text-xs text-mc-text-secondary">
                No proposals yet.
              </li>
            )}
            {recentProposals.map(p => (
              <li key={p.id} className="px-4 py-3 hover:bg-mc-bg/50">
                <div className="flex items-center gap-2 text-xs mb-1">
                  <span className={`px-2 py-0.5 rounded-sm ${STATUS_BADGE[p.status]}`}>{p.status}</span>
                  <span className="text-mc-text-secondary">
                    {p.proposed_changes.length} change{p.proposed_changes.length === 1 ? '' : 's'}
                  </span>
                  <span className="ml-auto text-mc-text-secondary/70">
                    {new Date(p.created_at.endsWith('Z') ? p.created_at : p.created_at + 'Z').toLocaleString()}
                  </span>
                </div>
                <p className="text-xs text-mc-text-secondary line-clamp-2 break-words">
                  {p.trigger_text}
                </p>
              </li>
            ))}
          </ul>
        </aside>
      </div>
    </div>
  );
}

function parseProposalId(m: AgentChatMessage): string | null {
  if (!m.metadata) return null;
  try {
    const parsed = JSON.parse(m.metadata) as { proposal_id?: string };
    return parsed.proposal_id ?? null;
  } catch { return null; }
}

interface ChatMessageRowProps {
  message: AgentChatMessage;
  proposal?: PmProposal;
  onAccept: (id: string) => void;
  onReject: (id: string) => void;
  refining: string | null;
  refineText: string;
  onRefineStart: (id: string) => void;
  onRefineCancel: () => void;
  onRefineSubmit: (id: string) => void;
  onRefineTextChange: (s: string) => void;
  /** Phase 6: register the card's DOM element so the page can scroll to it. */
  setCardRef?: (id: string, el: HTMLDivElement | null) => void;
  /** Phase 6: visual highlight after a deep-link scroll. */
  highlighted?: boolean;
}

function ChatMessageRow({
  message,
  proposal,
  onAccept,
  onReject,
  refining,
  refineText,
  onRefineStart,
  onRefineCancel,
  onRefineSubmit,
  onRefineTextChange,
  setCardRef,
  highlighted,
}: ChatMessageRowProps) {
  const isUser = message.role === 'user';

  // Bare chat bubble for messages that aren't proposal cards.
  if (!proposal) {
    return (
      <div className={isUser ? 'ml-12' : 'mr-12'}>
        <div className={`border rounded-md px-3 py-2 ${
          isUser
            ? 'bg-blue-500/10 border-blue-500/20'
            : 'bg-emerald-500/10 border-emerald-500/20'
        }`}>
          <div className="text-xs font-medium text-mc-text-secondary mb-1">
            {isUser ? 'You' : 'PM'}
          </div>
          <ChatMarkdown content={message.content} />
        </div>
      </div>
    );
  }

  // Proposal card
  const trigger = TRIGGER_BADGE[proposal.trigger_kind] ?? TRIGGER_BADGE.manual;
  return (
    <div className="mr-12">
      <div
        ref={(el) => setCardRef?.(proposal.id, el)}
        className={`border border-amber-500/40 bg-amber-500/5 rounded-md overflow-hidden transition-shadow ${
          highlighted ? 'ring-2 ring-mc-accent shadow-lg shadow-mc-accent/20' : ''
        }`}
      >
        <div className="px-3 py-2 bg-amber-500/10 border-b border-amber-500/30 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 text-amber-300" />
          <span className="text-sm font-semibold text-amber-200">
            Proposal — {proposal.proposed_changes.length} change{proposal.proposed_changes.length === 1 ? '' : 's'}
          </span>
          <span
            className={`px-1.5 py-0.5 text-[10px] rounded-sm border uppercase tracking-wide ${trigger.cls}`}
            title={`trigger_kind: ${proposal.trigger_kind}`}
          >
            {trigger.label}
          </span>
          <span className={`ml-auto px-2 py-0.5 text-xs rounded-sm ${STATUS_BADGE[proposal.status]}`}>
            {proposal.status}
          </span>
        </div>
        <div className="p-3">
          <ChatMarkdown content={message.content} />
        </div>
        {proposal.proposed_changes.length > 0 && (
          <div className="px-3 pb-3 space-y-1 text-xs text-mc-text-secondary">
            {proposal.proposed_changes.slice(0, 6).map((c, idx) => (
              <div key={idx} className="font-mono">
                · {summarizeDiff(c)}
              </div>
            ))}
            {proposal.proposed_changes.length > 6 && (
              <div className="font-mono">…and {proposal.proposed_changes.length - 6} more</div>
            )}
          </div>
        )}
        {proposal.status === 'draft' && (
          <div className="px-3 py-2 border-t border-amber-500/30 bg-amber-500/5 flex items-center gap-2">
            {refining === proposal.id ? (
              <>
                <input
                  type="text"
                  autoFocus
                  value={refineText}
                  onChange={e => onRefineTextChange(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') { e.preventDefault(); onRefineSubmit(proposal.id); }
                    if (e.key === 'Escape') { onRefineCancel(); }
                  }}
                  placeholder="Add a constraint (e.g. don't slip launch)"
                  className="flex-1 bg-mc-bg border border-mc-border rounded-sm px-2 py-1 text-xs focus:outline-hidden focus:border-mc-accent"
                />
                <button
                  type="button"
                  onClick={() => onRefineSubmit(proposal.id)}
                  className="text-xs px-2 py-1 bg-mc-accent text-mc-bg rounded-sm hover:bg-mc-accent/90"
                >Send</button>
                <button
                  type="button"
                  onClick={onRefineCancel}
                  className="text-xs px-2 py-1 text-mc-text-secondary hover:text-mc-text"
                >Cancel</button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => onRefineStart(proposal.id)}
                  className="text-xs px-2 py-1 border border-mc-border rounded-sm hover:bg-mc-bg/50 flex items-center gap-1"
                >
                  <RefreshCw className="w-3 h-3" /> Refine
                </button>
                <button
                  type="button"
                  onClick={() => onAccept(proposal.id)}
                  className="text-xs px-2 py-1 bg-emerald-500/20 border border-emerald-500/40 text-emerald-200 rounded-sm hover:bg-emerald-500/30 flex items-center gap-1"
                >
                  <Check className="w-3 h-3" /> Accept
                </button>
                <button
                  type="button"
                  onClick={() => onReject(proposal.id)}
                  className="text-xs px-2 py-1 bg-red-500/20 border border-red-500/40 text-red-200 rounded-sm hover:bg-red-500/30 flex items-center gap-1"
                >
                  <X className="w-3 h-3" /> Reject
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function summarizeDiff(c: PmDiff): string {
  switch (c.kind) {
    case 'shift_initiative_target':
      return `shift ${shortId(c.initiative_id)}: ${c.target_start ?? '∅'} → ${c.target_end ?? '∅'}`;
    case 'add_availability':
      return `availability ${shortId(c.agent_id)}: ${c.start} – ${c.end}`;
    case 'set_initiative_status':
      return `${shortId(c.initiative_id)} → ${c.status}`;
    case 'add_dependency':
      return `dep ${shortId(c.initiative_id)} blocks on ${shortId(c.depends_on_initiative_id)}`;
    case 'remove_dependency':
      return `remove dep ${shortId(c.dependency_id)}`;
    case 'reorder_initiatives':
      return `reorder under ${shortId(c.parent_id ?? null) || 'root'} (${c.child_ids_in_order?.length ?? 0})`;
    case 'update_status_check':
      return `status_check ${shortId(c.initiative_id)}`;
    default:
      return c.kind ?? '?';
  }
}

function shortId(id: string | null | undefined): string {
  if (!id) return '∅';
  return id.slice(0, 8);
}

interface PinnedStandupCardProps {
  proposal: PmProposal;
  onAccept: (id: string) => void;
  onReject: (id: string) => void;
  setRef: (el: HTMLDivElement | null) => void;
  highlighted: boolean;
}

/**
 * Pinned banner above the chat thread for the current workspace's most-
 * recent draft standup. Visually distinct from the inline proposal cards
 * (violet accent + pin icon) so the operator can tell at a glance "this is
 * today's PM-initiated card, not something I asked for".
 *
 * Renders accept/reject inline. Clicking the title scrolls into view (no
 * change of route) — refining is intentionally NOT exposed here; the
 * operator can refine via the inline card lower in the thread, or accept
 * the standup as-is. Keeps the banner uncluttered.
 */
function PinnedStandupCard({
  proposal,
  onAccept,
  onReject,
  setRef,
  highlighted,
}: PinnedStandupCardProps) {
  const created = new Date(
    proposal.created_at.endsWith('Z') ? proposal.created_at : proposal.created_at + 'Z',
  ).toLocaleString();
  return (
    <div
      ref={setRef}
      className={`m-3 border-l-4 border-violet-500 bg-violet-500/10 rounded-sm overflow-hidden transition-shadow ${
        highlighted ? 'ring-2 ring-mc-accent shadow-lg shadow-mc-accent/20' : ''
      }`}
    >
      <div className="px-3 py-2 flex items-center gap-2 border-b border-violet-500/30">
        <Pin className="w-4 h-4 text-violet-300" />
        <span className="text-sm font-semibold text-violet-200">
          Latest standup — {proposal.proposed_changes.length} change
          {proposal.proposed_changes.length === 1 ? '' : 's'}
        </span>
        <span
          className="px-1.5 py-0.5 text-[10px] rounded-sm border bg-violet-500/15 text-violet-300 border-violet-500/30 uppercase tracking-wide"
          title="trigger_kind: scheduled_drift_scan"
        >
          scheduled
        </span>
        <span className="ml-auto text-[11px] text-mc-text-secondary/80">{created}</span>
      </div>
      <div className="p-3">
        <ChatMarkdown content={proposal.impact_md} />
      </div>
      {proposal.proposed_changes.length > 0 && (
        <div className="px-3 pb-3 space-y-1 text-xs text-mc-text-secondary">
          {proposal.proposed_changes.slice(0, 6).map((c, idx) => (
            <div key={idx} className="font-mono">
              · {summarizeDiff(c)}
            </div>
          ))}
          {proposal.proposed_changes.length > 6 && (
            <div className="font-mono">
              …and {proposal.proposed_changes.length - 6} more
            </div>
          )}
        </div>
      )}
      <div className="px-3 py-2 border-t border-violet-500/30 bg-violet-500/5 flex items-center gap-2">
        <button
          type="button"
          onClick={() => onAccept(proposal.id)}
          className="text-xs px-2 py-1 bg-emerald-500/20 border border-emerald-500/40 text-emerald-200 rounded-sm hover:bg-emerald-500/30 flex items-center gap-1"
        >
          <Check className="w-3 h-3" /> Accept
        </button>
        <button
          type="button"
          onClick={() => onReject(proposal.id)}
          className="text-xs px-2 py-1 bg-red-500/20 border border-red-500/40 text-red-200 rounded-sm hover:bg-red-500/30 flex items-center gap-1"
        >
          <X className="w-3 h-3" /> Reject
        </button>
        <span className="ml-auto text-[10px] text-mc-text-secondary/80">
          See thread below to refine.
        </span>
      </div>
    </div>
  );
}

/**
 * Render PM/operator chat content as markdown. Uses the global `.mc-md`
 * stylesheet (defined in globals.css) tightened with `text-sm` so chat
 * bubbles don't blow up to an article-style line-height. GFM enabled so
 * tables, task-lists, and strikethrough render correctly — the PM's
 * decompose / plan output frequently uses markdown tables.
 */
function ChatMarkdown({ content }: { content: string }) {
  return (
    <div className="mc-md text-sm">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </div>
  );
}
