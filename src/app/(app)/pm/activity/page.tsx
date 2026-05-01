'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ChevronDown, ChevronRight, RotateCcw, ExternalLink } from 'lucide-react';
import { ProposalDiffsList, summarizeDiff, type PmDiff } from '@/components/pm/ProposalDiffsList';
import { triggerBadgeFor } from '@/components/pm/triggerBadge';
import { showAlertDialog } from '@/lib/show-alert';

const WORKSPACE_ID = 'default';

interface PmProposal {
  id: string;
  workspace_id: string;
  trigger_kind: string;
  impact_md: string;
  proposed_changes: PmDiff[];
  status: 'draft' | 'accepted' | 'rejected' | 'superseded';
  applied_at: string | null;
  applied_by_agent_id: string | null;
  target_initiative_id: string | null;
  reverts_proposal_id: string | null;
  created_at: string;
}

interface AgentLite {
  id: string;
  name: string;
  avatar_emoji?: string;
}

interface InitiativeLite {
  id: string;
  title: string;
}

const DATE_RANGE_OPTIONS: Array<{ key: string; label: string; hours: number | null }> = [
  { key: '24h', label: '24h', hours: 24 },
  { key: '7d', label: '7d', hours: 24 * 7 },
  { key: '30d', label: '30d', hours: 24 * 30 },
  { key: 'all', label: 'All', hours: null },
];

export default function PmActivityPage() {
  const router = useRouter();
  const [proposals, setProposals] = useState<PmProposal[]>([]);
  const [agents, setAgents] = useState<Record<string, AgentLite>>({});
  const [initiatives, setInitiatives] = useState<Record<string, InitiativeLite>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [reverting, setReverting] = useState<string | null>(null);

  // Filter state. trigger_kinds is a Set so each chip toggles independently.
  const [activeKinds, setActiveKinds] = useState<Set<string>>(new Set());
  const [activeAgent, setActiveAgent] = useState<string | null>(null);
  const [dateRange, setDateRange] = useState<string>('30d');

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const [pRes, aRes, iRes] = await Promise.all([
        fetch(`/api/pm/proposals?workspace_id=${WORKSPACE_ID}&status=accepted&limit=200`),
        fetch(`/api/agents?workspace_id=${WORKSPACE_ID}`),
        fetch(`/api/initiatives?workspace_id=${WORKSPACE_ID}`),
      ]);
      if (!pRes.ok) throw new Error(`Failed to load proposals (${pRes.status})`);
      const ps: PmProposal[] = await pRes.json();
      setProposals(ps);

      if (aRes.ok) {
        const list: AgentLite[] = await aRes.json();
        const map: Record<string, AgentLite> = {};
        for (const a of list) map[a.id] = a;
        setAgents(map);
      }
      if (iRes.ok) {
        const list: InitiativeLite[] = await iRes.json();
        const map: Record<string, InitiativeLite> = {};
        for (const i of list) map[i.id] = i;
        setInitiatives(map);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load activity');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Derive the per-kind / per-agent filter chip vocabularies from the
  // returned proposal set so we never render a chip that selects zero.
  const availableKinds = useMemo(() => {
    return Array.from(new Set(proposals.map(p => p.trigger_kind))).sort();
  }, [proposals]);

  const availableAgents = useMemo(() => {
    const ids = new Set<string>();
    for (const p of proposals) if (p.applied_by_agent_id) ids.add(p.applied_by_agent_id);
    return Array.from(ids);
  }, [proposals]);

  const visibleProposals = useMemo(() => {
    const cutoff = (() => {
      const opt = DATE_RANGE_OPTIONS.find(o => o.key === dateRange);
      if (!opt || opt.hours == null) return null;
      return Date.now() - opt.hours * 3600 * 1000;
    })();
    return proposals.filter(p => {
      if (activeKinds.size > 0 && !activeKinds.has(p.trigger_kind)) return false;
      if (activeAgent && p.applied_by_agent_id !== activeAgent) return false;
      if (cutoff !== null && p.applied_at) {
        const t = Date.parse(p.applied_at);
        if (!Number.isNaN(t) && t < cutoff) return false;
      }
      return true;
    });
  }, [proposals, activeKinds, activeAgent, dateRange]);

  const onRevert = useCallback(
    async (proposal: PmProposal) => {
      setReverting(proposal.id);
      try {
        const res = await fetch(`/api/pm/proposals/${proposal.id}/revert`, {
          method: 'POST',
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          const msg = (body as { error?: string }).error || `Revert failed (${res.status})`;
          showAlertDialog('Revert failed', msg);
          return;
        }
        const newId = (body as { proposal?: { id?: string } }).proposal?.id;
        if (newId) {
          // Land on the new draft so the operator can review/edit before
          // accepting the revert. Routes through /pm/proposals/[id] which
          // already handles draft proposals.
          router.push(`/pm/proposals/${newId}`);
        } else {
          showAlertDialog('Revert created', 'Draft proposal created but no id returned.');
          refresh();
        }
      } catch (e) {
        showAlertDialog('Revert failed', e instanceof Error ? e.message : String(e));
      } finally {
        setReverting(null);
      }
    },
    [router, refresh],
  );

  const toggleKind = (kind: string) => {
    setActiveKinds(prev => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  };

  return (
    <div className="min-h-screen bg-mc-bg p-6">
      <header className="max-w-5xl mx-auto mb-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-mc-text">PM activity</h1>
            <p className="text-sm text-mc-text-secondary">
              Accepted proposals, newest first. Click any row to inspect the diff list, or
              use <strong>Revert</strong> to draft an inverse proposal for review.
            </p>
          </div>
          <Link
            href="/pm"
            className="text-sm text-mc-text-secondary hover:text-mc-text inline-flex items-center gap-1"
          >
            <ExternalLink className="w-3.5 h-3.5" /> Open PM chat
          </Link>
        </div>
      </header>

      <main className="max-w-5xl mx-auto space-y-4">
        <FilterBar
          availableKinds={availableKinds}
          availableAgents={availableAgents}
          agents={agents}
          activeKinds={activeKinds}
          activeAgent={activeAgent}
          dateRange={dateRange}
          onToggleKind={toggleKind}
          onSetAgent={setActiveAgent}
          onSetDateRange={setDateRange}
          totalCount={proposals.length}
          shownCount={visibleProposals.length}
        />

        {error && (
          <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-300 text-sm">
            {error}
          </div>
        )}

        {loading ? (
          <p className="text-mc-text-secondary">Loading activity…</p>
        ) : visibleProposals.length === 0 ? (
          <p className="text-mc-text-secondary">
            No accepted proposals match these filters.
          </p>
        ) : (
          <ul className="space-y-2">
            {visibleProposals.map(p => (
              <ActivityRow
                key={p.id}
                proposal={p}
                agent={p.applied_by_agent_id ? agents[p.applied_by_agent_id] : undefined}
                targetTitle={
                  p.target_initiative_id ? initiatives[p.target_initiative_id]?.title : undefined
                }
                expanded={!!expanded[p.id]}
                onToggle={() =>
                  setExpanded(prev => ({ ...prev, [p.id]: !prev[p.id] }))
                }
                onRevert={() => onRevert(p)}
                reverting={reverting === p.id}
              />
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}

function FilterBar({
  availableKinds,
  availableAgents,
  agents,
  activeKinds,
  activeAgent,
  dateRange,
  onToggleKind,
  onSetAgent,
  onSetDateRange,
  totalCount,
  shownCount,
}: {
  availableKinds: string[];
  availableAgents: string[];
  agents: Record<string, AgentLite>;
  activeKinds: Set<string>;
  activeAgent: string | null;
  dateRange: string;
  onToggleKind: (k: string) => void;
  onSetAgent: (id: string | null) => void;
  onSetDateRange: (r: string) => void;
  totalCount: number;
  shownCount: number;
}) {
  return (
    <div className="rounded-lg bg-mc-bg-secondary border border-mc-border p-3 space-y-2.5">
      <div className="flex items-center justify-between text-xs text-mc-text-secondary">
        <span>
          Showing <span className="text-mc-text">{shownCount}</span> of{' '}
          <span className="text-mc-text">{totalCount}</span> accepted proposals.
        </span>
        {(activeKinds.size > 0 || activeAgent || dateRange !== 'all') && (
          <button
            onClick={() => {
              activeKinds.forEach(k => onToggleKind(k));
              onSetAgent(null);
              onSetDateRange('all');
            }}
            className="hover:text-mc-text underline"
          >
            Clear filters
          </button>
        )}
      </div>

      {availableKinds.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] uppercase tracking-wide text-mc-text-secondary mr-1">
            Trigger
          </span>
          {availableKinds.map(k => {
            const badge = triggerBadgeFor(k);
            const active = activeKinds.has(k);
            return (
              <button
                key={k}
                onClick={() => onToggleKind(k)}
                className={`text-xs px-2 py-0.5 rounded border transition-colors ${
                  active
                    ? badge.cls
                    : 'border-mc-border text-mc-text-secondary hover:border-mc-accent/40'
                }`}
              >
                {badge.label}
              </button>
            );
          })}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        {availableAgents.length > 0 && (
          <label className="text-xs text-mc-text-secondary inline-flex items-center gap-1.5">
            <span className="uppercase tracking-wide">Agent</span>
            <select
              className="px-2 py-1 rounded bg-mc-bg border border-mc-border text-mc-text"
              value={activeAgent ?? ''}
              onChange={e => onSetAgent(e.target.value || null)}
            >
              <option value="">All</option>
              {availableAgents.map(id => (
                <option key={id} value={id}>
                  {agents[id]?.avatar_emoji ? `${agents[id].avatar_emoji} ` : ''}
                  {agents[id]?.name ?? id.slice(0, 8)}
                </option>
              ))}
            </select>
          </label>
        )}

        <div className="flex items-center gap-1">
          <span className="text-[11px] uppercase tracking-wide text-mc-text-secondary mr-1">
            Range
          </span>
          {DATE_RANGE_OPTIONS.map(opt => (
            <button
              key={opt.key}
              onClick={() => onSetDateRange(opt.key)}
              className={`text-xs px-2 py-0.5 rounded border ${
                dateRange === opt.key
                  ? 'border-mc-accent/60 text-mc-accent bg-mc-accent/10'
                  : 'border-mc-border text-mc-text-secondary hover:border-mc-accent/40'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function ActivityRow({
  proposal,
  agent,
  targetTitle,
  expanded,
  onToggle,
  onRevert,
  reverting,
}: {
  proposal: PmProposal;
  agent?: AgentLite;
  targetTitle?: string;
  expanded: boolean;
  onToggle: () => void;
  onRevert: () => void;
  reverting: boolean;
}) {
  const badge = triggerBadgeFor(proposal.trigger_kind);
  const appliedRaw = proposal.applied_at;
  const applied = appliedRaw ? new Date(
    /T.*Z$|[+-]\d{2}:?\d{2}$/.test(appliedRaw) ? appliedRaw : appliedRaw.replace(' ', 'T') + 'Z',
  ) : null;
  const summary = proposal.proposed_changes.length > 0
    ? proposal.proposed_changes.length === 1
      ? summarizeDiff(proposal.proposed_changes[0])
      : `${proposal.proposed_changes.length} changes`
    : '(no diffs)';
  const isRevertItself = proposal.trigger_kind === 'revert';

  return (
    <li className="rounded-lg bg-mc-bg-secondary border border-mc-border hover:border-mc-accent/40">
      <div className="flex items-center gap-2 p-3">
        <button
          onClick={onToggle}
          aria-expanded={expanded}
          aria-label={expanded ? 'Collapse diff list' : 'Expand diff list'}
          className="p-1 rounded hover:bg-mc-bg text-mc-text-secondary"
        >
          {expanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        </button>
        <span className={`text-xs px-2 py-0.5 rounded border ${badge.cls}`}>
          {badge.label}
        </span>
        <button onClick={onToggle} className="text-left flex-1 min-w-0 hover:text-mc-accent">
          <div className="text-sm text-mc-text truncate">
            {targetTitle ?? <span className="text-mc-text-secondary italic">(no target)</span>}
          </div>
          <div className="text-xs text-mc-text-secondary truncate">{summary}</div>
        </button>
        <div className="text-xs text-mc-text-secondary text-right shrink-0">
          {applied && appliedRaw && (
            <div title={applied.toISOString()}>
              {relativeTime(appliedRaw)}
            </div>
          )}
          {agent && (
            <div className="text-[11px]">
              {agent.avatar_emoji ? `${agent.avatar_emoji} ` : ''}
              {agent.name}
            </div>
          )}
        </div>
        <Link
          href={`/pm/proposals/${proposal.id}`}
          title="Open proposal detail page"
          className="p-1.5 rounded hover:bg-mc-bg text-mc-text-secondary hover:text-mc-text"
        >
          <ExternalLink className="w-3.5 h-3.5" />
        </Link>
        <button
          onClick={onRevert}
          disabled={reverting}
          title={
            isRevertItself
              ? 'Revert this revert (synthesizes another inverse — produces the original forward state)'
              : 'Synthesize an inverse proposal in draft status. Nothing mutates until you accept the revert.'
          }
          className="text-xs px-2 py-1 rounded border border-mc-border text-mc-text-secondary hover:text-mc-text hover:border-mc-accent/40 inline-flex items-center gap-1 disabled:opacity-50"
        >
          <RotateCcw className="w-3 h-3" /> {reverting ? 'Reverting…' : 'Revert'}
        </button>
      </div>
      {expanded && (
        <div className="border-t border-mc-border/60 px-3 py-2">
          <ProposalDiffsList diffs={proposal.proposed_changes} showAll />
          {proposal.reverts_proposal_id && (
            <div className="mt-2 text-[11px] text-mc-text-secondary">
              Reverts proposal{' '}
              <Link
                href={`/pm/proposals/${proposal.reverts_proposal_id}`}
                className="text-mc-accent hover:underline font-mono"
              >
                {proposal.reverts_proposal_id.slice(0, 8)}
              </Link>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

/** "5m ago" / "2h ago" / "3d ago" — falls back to ISO date past 14d.
 *  Accepts the raw applied_at string so we can correctly parse SQLite's
 *  no-Z format ("2026-05-01 16:35:00") as UTC; passing the already-parsed
 *  Date would lose that signal and treat it as local time. */
function relativeTime(input: string | Date): string {
  const iso = typeof input === 'string'
    ? (/T.*Z$|[+-]\d{2}:?\d{2}$/.test(input) ? input : input.replace(' ', 'T') + 'Z')
    : input.toISOString();
  const t = Date.parse(iso);
  const sec = Math.floor((Date.now() - t) / 1000);
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  if (sec < 86400 * 14) return `${Math.floor(sec / 86400)}d ago`;
  return new Date(t).toISOString().slice(0, 10);
}
