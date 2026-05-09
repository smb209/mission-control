/**
 * useAuditProposals — fetch the operator-facing audit proposal queue
 * for a given initiative (Phase 6 of the subtree-audit-proposals spec
 * §8).
 *
 * Wraps GET /api/initiatives/:id/proposals. The endpoint already does
 * the aggregation (synthesis + per-descendant proposals + consumption
 * filter), so the hook is a thin fetch + refresh primitive — components
 * call `refresh()` after accept / reject / bulk-accept to repull the
 * latest queue state.
 *
 * No SSE today: the audit queue is operator-driven so polling on
 * mount + after each action covers the access pattern. If we add an
 * `audit_proposal` note SSE event in the future, this hook can listen
 * for it the same way `useAgentNotes` does.
 */

'use client';

import { useCallback, useEffect, useState } from 'react';
import type { AgentNoteRecord } from '@/hooks/useAgentNotes';
import type {
  AuditProposalBody,
  AuditSynthesisBody,
} from '@/lib/agents/audit-proposals/schemas';

/**
 * Mirrors `ProposalQueueItem` returned by the route. Re-declared here
 * so the client-side type doesn't pull in the server-only AgentNote
 * shape (which references @/lib/db internals).
 */
export interface AuditProposalRecord {
  note: AgentNoteRecord;
  body: AuditProposalBody;
  target: {
    id: string;
    title: string;
    current_status: string;
    target_end: string | null;
  } | null;
}

export interface AuditSynthesisRecord {
  note: AgentNoteRecord;
  body: AuditSynthesisBody;
}

export interface UseAuditProposalsResult {
  synthesis: AuditSynthesisRecord | null;
  proposals: AuditProposalRecord[];
  bulkAcceptAvailable: boolean;
  loading: boolean;
  error: Error | null;
  refresh: () => void;
}

export function useAuditProposals(
  initiativeId: string | null | undefined,
): UseAuditProposalsResult {
  const [synthesis, setSynthesis] = useState<AuditSynthesisRecord | null>(null);
  const [proposals, setProposals] = useState<AuditProposalRecord[]>([]);
  const [bulkAcceptAvailable, setBulkAcceptAvailable] = useState(false);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<Error | null>(null);
  const [tick, setTick] = useState(0);

  const refresh = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    if (!initiativeId) {
      setSynthesis(null);
      setProposals([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/initiatives/${initiativeId}/proposals`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<{
          synthesis: AuditSynthesisRecord | null;
          proposals: AuditProposalRecord[];
          bulk_accept_available: boolean;
        }>;
      })
      .then((data) => {
        if (cancelled) return;
        setSynthesis(data.synthesis);
        setProposals(data.proposals);
        setBulkAcceptAvailable(Boolean(data.bulk_accept_available));
        setLoading(false);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setError(err);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [initiativeId, tick]);

  return {
    synthesis,
    proposals,
    bulkAcceptAvailable,
    loading,
    error,
    refresh,
  };
}
