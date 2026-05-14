'use client';

/**
 * InFlightProposalCard — transparent in-flight placeholder shown while the PM
 * agent is composing a proposal. Replaces the synthetic-template-as-placeholder
 * pattern so the operator never sees a generic proposal masquerading as an
 * answer.
 *
 * Three visual states:
 *   (a) pending — shows sent-at timestamp, live elapsed counter, session_key,
 *       placeholder proposal_id, and a Cancel button.
 *   (b) replaced — fades out on pm_proposal_replaced SSE event.
 *   (c) synth_only — shows agent timeout message with "Use Synth Fallback" and
 *       "Cancel" buttons giving the operator agency.
 *
 * SSE subscriptions: pm_proposal_replaced, pm_proposal_dispatch_state_changed.
 * Uses the same import path as the existing synth-content card's SSE subscription
 * (EventSource on /api/events/stream).
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { RefreshCw, X, Loader, AlertTriangle } from 'lucide-react';

// ─── Types ──────────────────────────────────────────────────────────────────

export type InFlightState = 'pending' | 'replaced' | 'synth_only' | 'cancelled';

export interface InFlightProposalCardProps {
  /** Placeholder proposal id created by the async dispatch path. */
  proposalId: string;
  /** Workspace id for SSE filtering. */
  workspaceId: string;
  /** Target session_key from the dispatch (shown as-is). */
  sessionKey?: string | null;
  /** Sent-at timestamp (ISO 8601). Used to compute elapsed. */
  sentAt: string;
  /** Callback when the operator clicks Cancel. */
  onCancel: () => void;
  /** Callback when the operator clicks "Use Synth Fallback" in synth_only state. */
  onUseSynthFallback?: () => void;
  /** Optional: called when the card transitions to replaced so the parent can
   *  clean up any in-flight state. */
  onReplaced?: () => void;
  /** Optional: additional metadata row to show in the card body. */
  extraContent?: React.ReactNode;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatTimestamp(iso: string): string {
  const d = new Date(iso.endsWith('Z') ? iso : iso + 'Z');
  if (isNaN(d.getTime())) return '—:—:—';
  return d.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

function elapsedSince(iso: string): string {
  const d = new Date(iso.endsWith('Z') ? iso : iso + 'Z');
  if (isNaN(d.getTime())) return '0s';
  const diff = Math.max(0, Date.now() - d.getTime());
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
}

// ─── Component ──────────────────────────────────────────────────────────────

export function InFlightProposalCard({
  proposalId,
  workspaceId,
  sessionKey,
  sentAt,
  onCancel,
  onUseSynthFallback,
  onReplaced,
  extraContent,
}: InFlightProposalCardProps) {
  const [state, setState] = useState<InFlightState>('pending');
  const [elapsed, setElapsed] = useState(elapsedSince(sentAt));
  const [fadeOut, setFadeOut] = useState(false);

  // Live elapsed counter — tick every second.
  useEffect(() => {
    const id = setInterval(() => {
      setElapsed(elapsedSince(sentAt));
    }, 1000);
    return () => clearInterval(id);
  }, [sentAt]);

  // SSE subscription for state transitions.
  useEffect(() => {
    const es = new EventSource('/api/events/stream');
    let cancelled = false;

    es.onmessage = (ev) => {
      if (cancelled) return;
      let parsed: { type?: string; payload?: Record<string, unknown> } | null = null;
      try { parsed = JSON.parse(ev.data); } catch { return; }
      if (!parsed || !parsed.type) return;

      // pm_proposal_replaced: fade out and hand off.
      if (parsed.type === 'pm_proposal_replaced') {
        const oldId = parsed.payload?.old_id as string | undefined;
        if (oldId === proposalId && parsed.payload?.workspace_id === workspaceId) {
          setFadeOut(true);
          setState('replaced');
          onReplaced?.();
        }
      }

      // pm_proposal_dispatch_state_changed: synth_only fallback or cancelled.
      if (parsed.type === 'pm_proposal_dispatch_state_changed') {
        const id = parsed.payload?.proposal_id as string | undefined;
        const next = parsed.payload?.dispatch_state as string | undefined;
        if (id === proposalId && next === 'synth_only') {
          setState('synth_only');
        }
        if (id === proposalId && next === 'cancelled') {
          // Operator cancelled the dispatch — fade out like replaced.
          setFadeOut(true);
          setState('cancelled');
        }
      }
    };

    return () => {
      cancelled = true;
      es.close();
    };
  }, [proposalId, workspaceId, onReplaced]);

  // Auto-dismiss fade-out after 2s.
  useEffect(() => {
    if (!fadeOut) return;
    const timer = setTimeout(() => {
      // Parent can handle the actual removal; we just clear the visual state.
    }, 2000);
    return () => clearTimeout(timer);
  }, [fadeOut]);

  // ─── Render ────────────────────────────────────────────────────────────

  const cardStyle = `border rounded-md overflow-hidden transition-opacity duration-500 ${
    fadeOut ? 'opacity-0' : 'opacity-100'
  }`;

  const pendingStyle = `${cardStyle} border-amber-500/40 bg-amber-500/5`;
  const synthStyle = `${cardStyle} border-red-500/40 bg-red-500/5`;
  const cancelledStyle = `${cardStyle} border-slate-400/40 bg-slate-400/5`;

  // Cancelled state: fade out like replaced.
  if (state === 'cancelled' && fadeOut) {
    return (
      <div className={cancelledStyle} aria-label="Proposal cancelled">
        <div className="px-3 py-2 bg-slate-400/10 border-b border-slate-400/30 flex items-center gap-2">
          <X className="w-4 h-4 text-slate-400 shrink-0" />
          <span className="text-sm font-semibold text-slate-300">Proposal cancelled</span>
        </div>
      </div>
    );
  }

  // Cancelled state (pre-fade): show confirmation banner.
  if (state === 'cancelled' && !fadeOut) {
    return (
      <div className={cancelledStyle}>
        <div className="px-3 py-2 bg-slate-400/10 border-b border-slate-400/30 flex items-center gap-2">
          <X className="w-4 h-4 text-slate-400 shrink-0" />
          <span className="text-sm font-semibold text-slate-300">Proposal cancelled</span>
        </div>
        <div className="p-3">
          <div className="text-xs text-slate-400">The dispatch was cancelled — MC will no longer wait for the agent reply.</div>
        </div>
      </div>
    );
  }

  if (state === 'replaced' && fadeOut) {
    // Render a minimal placeholder so the parent can handle the swap.
    return (
      <div className={pendingStyle} aria-label="Proposal replaced, fading out">
        <div className="px-3 py-2 bg-amber-500/10 border-b border-amber-500/30 flex items-center gap-2">
          <RefreshCw className="w-4 h-4 text-amber-300 animate-spin" />
          <span className="text-sm font-semibold text-amber-200">Proposal replaced</span>
        </div>
      </div>
    );
  }

  return (
    <div className={state === 'synth_only' ? synthStyle : pendingStyle}>
      {/* Header */}
      <div className="px-3 py-2 bg-amber-500/10 border-b border-amber-500/30 flex items-center gap-2">
        {state === 'synth_only' ? (
          <AlertTriangle className="w-4 h-4 text-red-300 shrink-0" />
        ) : (
          <Loader className="w-4 h-4 text-amber-300 animate-spin shrink-0" />
        )}
        <span className="text-sm font-semibold text-amber-200">
          {state === 'synth_only'
            ? 'PM Agent Timeout — Synthetic Placeholder'
            : 'PM Agent In Flight'}
        </span>
        <span className="ml-auto text-xs text-mc-text-secondary/70">
          {formatTimestamp(sentAt)}
        </span>
      </div>

      {/* Body */}
      <div className="p-3 space-y-2">
        {/* Elapsed timer */}
        <div className="flex items-center gap-2 text-xs text-mc-text-secondary">
          <RefreshCw className={`w-3 h-3 ${state === 'pending' ? 'animate-spin' : ''}`} />
          <span>
            {state === 'pending'
              ? `In progress — ${elapsed} elapsed`
              : 'PM agent did not respond within timeout window'}
          </span>
        </div>

        {/* Proposal ID */}
        {proposalId && (
          <div className="text-xs font-mono text-mc-text-secondary/80">
            Proposal: {proposalId.slice(0, 8)}…
          </div>
        )}

        {/* Session key */}
        {sessionKey && (
          <div className="text-xs font-mono text-mc-text-secondary/80">
            Session: {sessionKey.slice(0, 32)}{sessionKey.length > 32 ? '…' : ''}
          </div>
        )}

        {/* Extra content */}
        {extraContent}

        {/* Synth-only message */}
        {state === 'synth_only' && (
          <div className="text-xs text-red-300/80 bg-red-500/5 border border-red-500/20 rounded p-2 mt-1">
            The PM agent did not respond within the timeout window. This is a synthetic
            placeholder generated from deterministic rules. You can use it as a starting
            point or cancel and try again.
          </div>
        )}
      </div>

      {/* Footer / Actions */}
      <div className="px-3 py-2 border-t border-amber-500/30 bg-amber-500/5 flex items-center gap-2">
        {state === 'synth_only' ? (
          <>
            {onUseSynthFallback && (
              <button
                type="button"
                onClick={onUseSynthFallback}
                className="text-xs px-2 py-1 bg-emerald-500/20 border border-emerald-500/40 text-emerald-200 rounded-sm hover:bg-emerald-500/30 flex items-center gap-1"
              >
                Use Synth Fallback
              </button>
            )}
            <button
              type="button"
              onClick={onCancel}
              className="text-xs px-2 py-1 bg-red-500/20 border border-red-500/40 text-red-200 rounded-sm hover:bg-red-500/30 flex items-center gap-1"
            >
              <X className="w-3 h-3" /> Cancel
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={onCancel}
            className="text-xs px-2 py-1 border border-mc-border rounded-sm hover:bg-mc-bg/50 flex items-center gap-1"
          >
            <X className="w-3 h-3" /> Cancel
          </button>
        )}
      </div>
    </div>
  );
}

export default InFlightProposalCard;
