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
import Link from 'next/link';
import { Send, AlertTriangle, Check, X, RefreshCw, Loader, Inbox } from 'lucide-react';

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
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState<string>('default');
  const [pmAgent, setPmAgent] = useState<AgentLite | null>(null);
  const [messages, setMessages] = useState<AgentChatMessage[]>([]);
  const [proposals, setProposals] = useState<Record<string, PmProposal>>({});
  const [recentProposals, setRecentProposals] = useState<PmProposal[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refining, setRefining] = useState<string | null>(null);
  const [refineText, setRefineText] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  // Load workspace list once.
  useEffect(() => {
    fetch('/api/workspaces')
      .then(r => r.json())
      .then((rows: Workspace[]) => {
        setWorkspaces(rows);
        if (rows.length > 0 && !rows.find(w => w.id === 'default')) {
          setWorkspaceId(rows[0].id);
        }
      })
      .catch(() => { /* leave empty */ });
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

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

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

  const proposalCount = useMemo(() => {
    const draft = recentProposals.filter(p => p.status === 'draft').length;
    return { draft, total: recentProposals.length };
  }, [recentProposals]);

  return (
    <div className="flex flex-col h-screen bg-mc-bg text-mc-text">
      {/* Header */}
      <header className="border-b border-mc-border px-4 py-3 flex items-center gap-4 shrink-0">
        <h1 className="text-lg font-semibold">📋 PM Chat</h1>
        <select
          value={workspaceId}
          onChange={e => setWorkspaceId(e.target.value)}
          className="bg-mc-bg border border-mc-border rounded-sm px-3 py-1.5 text-sm focus:outline-hidden focus:border-mc-accent"
        >
          {workspaces.length === 0 && <option value="default">default</option>}
          {workspaces.map(w => (
            <option key={w.id} value={w.id}>
              {w.icon ?? '📁'} {w.name}
            </option>
          ))}
        </select>
        <div className="ml-auto text-xs text-mc-text-secondary">
          {proposalCount.draft} draft · {proposalCount.total} total
        </div>
        <Link href="/roadmap" className="text-xs text-mc-accent hover:underline">
          View roadmap →
        </Link>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* Chat thread */}
        <main className="flex flex-col flex-1 min-w-0">
          {error && (
            <div className="m-3 px-3 py-2 bg-red-500/10 border border-red-500/30 text-red-300 text-sm rounded-sm flex items-center gap-2">
              <AlertTriangle className="w-4 h-4" /> {error}
            </div>
          )}
          <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-3">
            {messages.length === 0 && pmAgent && (
              <div className="text-center py-12 text-mc-text-secondary">
                <Inbox className="w-8 h-8 mx-auto mb-3 opacity-50" />
                <p className="text-sm">Drop a disruption to get started.</p>
                <p className="text-xs mt-1 opacity-70">
                  Examples: &quot;Sarah out next week&quot; · &quot;API X delayed until 2026-05-03&quot; · &quot;We&apos;re cutting Phase 2&quot;
                </p>
              </div>
            )}

            {messages.map(m => (
              <ChatMessageRow
                key={m.id}
                message={m}
                proposal={parseProposalId(m) ? proposals[parseProposalId(m)!] : undefined}
                onAccept={onAccept}
                onReject={onReject}
                refining={refining}
                refineText={refineText}
                onRefineStart={(id) => { setRefining(id); setRefineText(''); }}
                onRefineCancel={() => { setRefining(null); setRefineText(''); }}
                onRefineSubmit={onRefineSubmit}
                onRefineTextChange={setRefineText}
              />
            ))}
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
          <div className="text-sm whitespace-pre-wrap">{message.content}</div>
        </div>
      </div>
    );
  }

  // Proposal card
  return (
    <div className="mr-12">
      <div className="border border-amber-500/40 bg-amber-500/5 rounded-md overflow-hidden">
        <div className="px-3 py-2 bg-amber-500/10 border-b border-amber-500/30 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 text-amber-300" />
          <span className="text-sm font-semibold text-amber-200">
            Proposal — {proposal.proposed_changes.length} change{proposal.proposed_changes.length === 1 ? '' : 's'}
          </span>
          <span className={`ml-auto px-2 py-0.5 text-xs rounded-sm ${STATUS_BADGE[proposal.status]}`}>
            {proposal.status}
          </span>
        </div>
        <div className="p-3 text-sm whitespace-pre-wrap">
          {message.content}
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
