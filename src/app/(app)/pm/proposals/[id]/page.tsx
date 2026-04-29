'use client';

import { useEffect, useState, use } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Check, X, RefreshCw, AlertTriangle } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  stripSuggestionsSidecar,
  parseSuggestionsFromImpactMd,
} from '@/lib/pm/planSuggestionsSidecar';
import { ProposalDiffsList, type PmDiff } from '@/components/pm/ProposalDiffsList';

interface PmProposal {
  id: string;
  workspace_id: string;
  trigger_text: string;
  trigger_kind: string;
  impact_md: string;
  proposed_changes: PmDiff[];
  plan_suggestions: Record<string, unknown> | null;
  status: 'draft' | 'accepted' | 'rejected' | 'superseded';
  applied_at: string | null;
  parent_proposal_id: string | null;
  target_initiative_id: string | null;
  created_at: string;
}

const STATUS_BADGE: Record<PmProposal['status'], string> = {
  draft: 'bg-amber-500/20 text-amber-300',
  accepted: 'bg-emerald-500/20 text-emerald-300',
  rejected: 'bg-red-500/20 text-red-300',
  superseded: 'bg-zinc-500/20 text-zinc-300',
};

const TRIGGER_BADGE: Record<string, { label: string; cls: string }> = {
  manual: { label: 'manual', cls: 'bg-blue-500/15 text-blue-300 border-blue-500/30' },
  scheduled_drift_scan: { label: 'scheduled', cls: 'bg-violet-500/15 text-violet-300 border-violet-500/30' },
  disruption_event: { label: 'disruption', cls: 'bg-orange-500/15 text-orange-300 border-orange-500/30' },
  status_check_investigation: { label: 'status check', cls: 'bg-cyan-500/15 text-cyan-300 border-cyan-500/30' },
  plan_initiative: { label: 'plan', cls: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30' },
  decompose_initiative: { label: 'decompose', cls: 'bg-pink-500/15 text-pink-300 border-pink-500/30' },
};

// summarizeDiff lives in @/components/pm/ProposalDiffsList — both
// /pm and the standalone detail page render through the same component.

export default function ProposalDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const [proposal, setProposal] = useState<PmProposal | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [acting, setActing] = useState<'accept' | 'reject' | null>(null);
  const [refining, setRefining] = useState(false);
  const [refineText, setRefineText] = useState('');
  const [refineErr, setRefineErr] = useState<string | null>(null);
  const [showRefineInput, setShowRefineInput] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setErr(null);
      try {
        const res = await fetch(`/api/pm/proposals/${id}`);
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error((body as { error?: string }).error || `Failed to load (${res.status})`);
        }
        const data = await res.json();
        if (!cancelled) setProposal(data as PmProposal);
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : 'Failed to load proposal');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [id]);

  const accept = async () => {
    if (!proposal) return;
    setActing('accept');
    try {
      const res = await fetch(`/api/pm/proposals/${proposal.id}/accept`, { method: 'POST' });
      const body = await res.json();
      if (!res.ok) throw new Error((body as { error?: string }).error || 'Accept failed');
      setProposal(prev => prev ? { ...prev, status: 'accepted' } : prev);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Accept failed');
    } finally {
      setActing(null);
    }
  };

  const reject = async () => {
    if (!proposal) return;
    setActing('reject');
    try {
      const res = await fetch(`/api/pm/proposals/${proposal.id}/reject`, { method: 'POST' });
      const body = await res.json();
      if (!res.ok) throw new Error((body as { error?: string }).error || 'Reject failed');
      setProposal(prev => prev ? { ...prev, status: 'rejected' } : prev);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Reject failed');
    } finally {
      setActing(null);
    }
  };

  const refine = async () => {
    if (!proposal || !refineText.trim()) return;
    setRefining(true);
    setRefineErr(null);
    try {
      const res = await fetch(`/api/pm/proposals/${proposal.id}/refine`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ additional_constraint: refineText.trim() }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error((body as { error?: string }).error || 'Refine failed');
      // Refine creates a new child proposal — navigate there.
      const newId = (body as { proposal?: { id?: string } }).proposal?.id;
      if (newId) {
        router.push(`/pm/proposals/${newId}`);
      } else {
        setRefineText('');
        setShowRefineInput(false);
      }
    } catch (e) {
      setRefineErr(e instanceof Error ? e.message : 'Refine failed');
    } finally {
      setRefining(false);
    }
  };

  const trigger = proposal ? (TRIGGER_BADGE[proposal.trigger_kind] ?? TRIGGER_BADGE.manual) : null;
  const displayMd = proposal ? stripSuggestionsSidecar(proposal.impact_md).trim() : '';
  const suggestions = proposal?.trigger_kind === 'plan_initiative'
    ? parseSuggestionsFromImpactMd(proposal.impact_md)
    : null;

  return (
    <div className="min-h-screen bg-mc-bg text-mc-text">
      <div className="max-w-3xl mx-auto px-4 py-6">
        <div className="mb-4">
          <Link
            href="/pm"
            className="inline-flex items-center gap-1.5 text-sm text-mc-text-secondary hover:text-mc-text"
          >
            <ArrowLeft className="w-4 h-4" /> PM Chat
          </Link>
        </div>

        {loading && (
          <div className="flex items-center gap-2 text-mc-text-secondary text-sm py-12 justify-center">
            <RefreshCw className="w-4 h-4 animate-spin" /> Loading proposal…
          </div>
        )}

        {err && (
          <div className="p-3 rounded bg-red-500/10 border border-red-500/30 text-red-300 text-sm">
            {err}
          </div>
        )}

        {proposal && (
          <>
            {/* Header */}
            <div className="border border-amber-500/40 bg-amber-500/5 rounded-md overflow-hidden mb-4">
              <div className="px-4 py-3 bg-amber-500/10 border-b border-amber-500/30 flex flex-wrap items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-amber-300 shrink-0" />
                <span className="text-sm font-semibold text-amber-200">
                  Proposal — {proposal.proposed_changes.length} change{proposal.proposed_changes.length === 1 ? '' : 's'}
                </span>
                {trigger && (
                  <span className={`px-1.5 py-0.5 text-[10px] rounded-sm border uppercase tracking-wide ${trigger.cls}`}>
                    {trigger.label}
                  </span>
                )}
                <span className={`px-2 py-0.5 text-xs rounded-sm ${STATUS_BADGE[proposal.status]}`}>
                  {proposal.status}
                </span>
                <span className="ml-auto text-xs text-mc-text-secondary/70">
                  {new Date(proposal.created_at.endsWith('Z') ? proposal.created_at : proposal.created_at + 'Z').toLocaleString()}
                </span>
              </div>

              {/* Plan suggestions summary for plan_initiative proposals */}
              {suggestions && (
                <div className="px-4 py-3 border-b border-amber-500/20 grid grid-cols-3 gap-3 text-xs">
                  <div className="col-span-3">
                    <div className="text-mc-text-secondary uppercase tracking-wide text-[10px] mb-1">Refined description</div>
                    <p className="text-mc-text whitespace-pre-wrap font-sans">{(suggestions as { refined_description?: string }).refined_description}</p>
                  </div>
                  {(['complexity', 'target_start', 'target_end'] as const).map(field => (
                    <div key={field}>
                      <div className="text-mc-text-secondary uppercase tracking-wide text-[10px]">
                        {field.replace('_', ' ')}
                      </div>
                      <div className="text-mc-text font-medium">
                        {(suggestions as Record<string, unknown>)[field] as string ?? '—'}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Impact markdown */}
              {displayMd && (
                <div className="px-4 py-3 border-b border-amber-500/20 prose prose-invert prose-sm max-w-none">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{displayMd}</ReactMarkdown>
                </div>
              )}

              {/* Proposed changes — shared component with /pm. The
                  detail page has more vertical room than the inline
                  chat card, so we ask for the full list (no fold). */}
              {proposal.proposed_changes.length > 0 && (
                <ProposalDiffsList
                  diffs={proposal.proposed_changes}
                  showAll
                  className="px-4 py-3 border-b border-amber-500/20 space-y-1"
                />
              )}

              {/* Actions */}
              {proposal.status === 'draft' && (
                <div className="px-4 py-3 bg-amber-500/5 flex flex-wrap items-center gap-2">
                  {showRefineInput ? (
                    <>
                      <input
                        type="text"
                        autoFocus
                        value={refineText}
                        onChange={e => setRefineText(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Enter') { e.preventDefault(); refine(); }
                          if (e.key === 'Escape') setShowRefineInput(false);
                        }}
                        placeholder="Add a constraint…"
                        className="flex-1 bg-mc-bg border border-mc-border rounded-sm px-2 py-1 text-xs focus:outline-hidden focus:border-mc-accent"
                        disabled={refining}
                      />
                      <button
                        type="button"
                        onClick={refine}
                        disabled={refining || !refineText.trim()}
                        className="text-xs px-2 py-1 bg-mc-accent text-mc-bg rounded-sm hover:bg-mc-accent/90 disabled:opacity-50"
                      >
                        {refining ? 'Sending…' : 'Send'}
                      </button>
                      <button
                        type="button"
                        onClick={() => setShowRefineInput(false)}
                        className="text-xs px-2 py-1 text-mc-text-secondary hover:text-mc-text"
                      >
                        Cancel
                      </button>
                      {refineErr && (
                        <span className="text-xs text-red-300 w-full">{refineErr}</span>
                      )}
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        onClick={() => setShowRefineInput(true)}
                        className="text-xs px-2 py-1 border border-mc-border rounded-sm hover:bg-mc-bg/50 flex items-center gap-1"
                      >
                        <RefreshCw className="w-3 h-3" /> Refine
                      </button>
                      <button
                        type="button"
                        onClick={accept}
                        disabled={acting !== null}
                        className="text-xs px-2 py-1 bg-emerald-500/20 border border-emerald-500/40 text-emerald-200 rounded-sm hover:bg-emerald-500/30 flex items-center gap-1 disabled:opacity-50"
                      >
                        <Check className="w-3 h-3" /> {acting === 'accept' ? 'Accepting…' : 'Accept'}
                      </button>
                      <button
                        type="button"
                        onClick={reject}
                        disabled={acting !== null}
                        className="text-xs px-2 py-1 bg-red-500/20 border border-red-500/40 text-red-200 rounded-sm hover:bg-red-500/30 flex items-center gap-1 disabled:opacity-50"
                      >
                        <X className="w-3 h-3" /> {acting === 'reject' ? 'Rejecting…' : 'Reject'}
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>

            {/* Metadata */}
            <div className="text-xs text-mc-text-secondary space-y-1">
              <div><span className="font-medium text-mc-text">ID</span> {proposal.id}</div>
              {proposal.parent_proposal_id && (
                <div>
                  <span className="font-medium text-mc-text">Parent</span>{' '}
                  <Link href={`/pm/proposals/${proposal.parent_proposal_id}`} className="underline hover:text-mc-text">
                    {proposal.parent_proposal_id.slice(0, 8)}…
                  </Link>
                </div>
              )}
              {proposal.target_initiative_id && (
                <div>
                  <span className="font-medium text-mc-text">Initiative</span> {proposal.target_initiative_id.slice(0, 8)}…
                </div>
              )}
              {proposal.applied_at && (
                <div>
                  <span className="font-medium text-mc-text">Applied</span>{' '}
                  {new Date(proposal.applied_at.endsWith('Z') ? proposal.applied_at : proposal.applied_at + 'Z').toLocaleString()}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
