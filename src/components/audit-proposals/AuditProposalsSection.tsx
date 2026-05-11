/**
 * AuditProposalsSection — operator-facing review queue rendered inline
 * on the initiative detail view (Phase 6, docs/archive/subtree-audit-proposals-spec.md §8).
 *
 * Auto-hides when there are no proposals AND no synthesis. The parent
 * (`InitiativeDetailView`) can drop this in unconditionally — empty
 * shows nothing, which keeps the page tight on initiatives that have
 * never been audited.
 */

'use client';

import { useState } from 'react';
import { Sparkles } from 'lucide-react';
import { useAuditProposals } from '@/hooks/useAuditProposals';
import { AuditProposalCard } from './AuditProposalCard';
import { ConfirmDialog } from '@/components/ConfirmDialog';

interface Props {
  initiativeId: string;
}

export function AuditProposalsSection({ initiativeId }: Props) {
  const { synthesis, proposals, bulkAcceptAvailable, loading, error, refresh } =
    useAuditProposals(initiativeId);

  const [bulkConfirmOpen, setBulkConfirmOpen] = useState(false);
  const [bulkSubmitting, setBulkSubmitting] = useState(false);
  const [bulkResult, setBulkResult] = useState<string | null>(null);

  // Empty state: parent should also be able to omit this section, but
  // we hide ourselves too so the page stays clean.
  const hasContent = synthesis !== null || proposals.length > 0;
  if (loading && !hasContent) return null;
  if (!hasContent) return null;

  const eligibleForBulk = proposals.filter(
    (p) =>
      p.body.confidence === 'high' &&
      (p.body.proposed_action === 'keep' ||
        p.body.proposed_action === 'mark_done'),
  );

  const onBulkAccept = async () => {
    setBulkSubmitting(true);
    setBulkResult(null);
    try {
      const res = await fetch(
        `/api/initiatives/${initiativeId}/proposals/bulk-accept`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            proposal_ids: eligibleForBulk.map((p) => p.note.id),
          }),
        },
      );
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as {
        accepted: number;
        failed: Array<{ proposalId: string; error: string }>;
      };
      setBulkResult(
        `Accepted ${data.accepted} proposal${data.accepted === 1 ? '' : 's'}` +
          (data.failed.length > 0
            ? `, ${data.failed.length} failed.`
            : '.'),
      );
      refresh();
    } catch (e) {
      setBulkResult(
        `Bulk accept failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      setBulkSubmitting(false);
      setBulkConfirmOpen(false);
    }
  };

  return (
    <section className="mb-6 p-4 rounded-lg bg-mc-bg-secondary border border-mc-border">
      <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
        <h2 className="font-medium text-mc-text flex items-center gap-2">
          <Sparkles className="w-4 h-4" />
          Audit Proposals
          {proposals.length > 0 && (
            <span className="text-mc-text-secondary text-sm">
              ({proposals.length})
            </span>
          )}
        </h2>
        {bulkAcceptAvailable && eligibleForBulk.length > 0 && (
          <button
            type="button"
            onClick={() => setBulkConfirmOpen(true)}
            disabled={bulkSubmitting}
            className="px-3 py-1 rounded text-sm bg-mc-accent/20 text-mc-accent border border-mc-accent/40 hover:bg-mc-accent/30 disabled:opacity-50"
          >
            Accept {eligibleForBulk.length} high-confidence{' '}
            {eligibleForBulk.length === 1 ? 'keep' : 'keeps'}
          </button>
        )}
      </div>

      {error && (
        <div className="mb-3 text-xs text-red-400 border border-red-500/30 bg-red-500/10 rounded px-2 py-1">
          {error.message}
        </div>
      )}
      {bulkResult && (
        <div className="mb-3 text-xs text-mc-text-secondary border border-mc-border bg-mc-bg rounded px-2 py-1">
          {bulkResult}
        </div>
      )}

      {synthesis && (
        <SynthesisBanner
          synthesis={synthesis}
          initiativeId={initiativeId}
          onChanged={refresh}
        />
      )}

      {proposals.length > 0 && (
        <div className="space-y-2">
          {proposals.map((p) => (
            <AuditProposalCard
              key={p.note.id}
              item={p}
              onAccepted={refresh}
              onRejected={refresh}
            />
          ))}
        </div>
      )}

      <ConfirmDialog
        open={bulkConfirmOpen}
        title={`Accept ${eligibleForBulk.length} proposals?`}
        body={
          <p className="text-sm text-mc-text-secondary">
            This applies the proposed action (keep / mark done) to each target
            initiative and writes a decision note. Only high-confidence keep /
            mark_done proposals are included.
          </p>
        }
        confirmLabel="Accept all"
        onConfirm={onBulkAccept}
        onCancel={() => setBulkConfirmOpen(false)}
      />
    </section>
  );
}

// ─── Synthesis banner ───────────────────────────────────────────────

import type { AuditSynthesisRecord } from '@/hooks/useAuditProposals';

function SynthesisBanner({
  synthesis,
  initiativeId,
}: {
  synthesis: AuditSynthesisRecord;
  initiativeId: string;
  onChanged: () => void;
}) {
  const epic = synthesis.body.epic_proposals ?? [];
  const cross = synthesis.body.cross_node_proposals ?? [];
  return (
    <div className="mb-3 rounded-md border border-mc-border bg-mc-bg p-3 space-y-2">
      <div className="text-sm text-mc-text font-medium">
        {synthesis.body.completion_sentinel}
      </div>
      {(epic.length > 0 || cross.length > 0) && (
        <div className="space-y-1.5">
          {epic.map((p, idx) => (
            <SynthesisSubProposal
              key={`epic-${idx}`}
              kind={p.proposed_action}
              rationale={p.rationale}
              confidence={p.confidence}
            />
          ))}
          {cross.map((p, idx) => (
            <SynthesisSubProposal
              key={`cross-${idx}`}
              kind={p.proposed_action}
              rationale={p.rationale}
              confidence={p.confidence}
            />
          ))}
        </div>
      )}
      {epic.length === 0 && cross.length === 0 && (
        <div className="text-xs text-mc-text-secondary">
          No epic-level or cross-node proposals.
        </div>
      )}
      <div className="text-[10px] text-mc-text-secondary">
        Synthesis on initiative{' '}
        <code>{initiativeId.slice(0, 8)}</code>
      </div>
    </div>
  );
}

function SynthesisSubProposal({
  kind,
  rationale,
  confidence,
}: {
  kind: string;
  rationale: string;
  confidence: 'low' | 'medium' | 'high';
}) {
  return (
    <div
      className="rounded border border-mc-border bg-mc-bg-secondary p-2 text-xs space-y-1"
      title="Manual review required — epic-level and cross-node proposals are deferred to v2 of the proposal queue."
    >
      <div className="flex items-center gap-2">
        <span className="px-1.5 py-0.5 rounded bg-mc-bg text-mc-text-secondary border border-mc-border uppercase tracking-wide">
          {kind}
        </span>
        <span className="text-mc-text-secondary">{confidence}</span>
        <span className="ml-auto text-[10px] text-mc-text-secondary italic">
          Manual review required
        </span>
      </div>
      <div className="text-mc-text whitespace-pre-line">{rationale}</div>
    </div>
  );
}
