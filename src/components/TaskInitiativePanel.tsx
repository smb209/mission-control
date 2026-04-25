'use client';

/**
 * Task → Initiative panel rendered inside the task modal Overview tab.
 *
 * Surfaces:
 *   - Owning initiative (if any) with a link to /initiatives/[id].
 *   - Provenance trail (collapsed) — every task_initiative_history row.
 *   - "Move to initiative" picker (workspace-scoped).
 *   - "Detach from initiative" button.
 *   - Promote-from-draft action when status='draft'.
 *
 * All mutations go through the Phase 2 API endpoints:
 *   POST /api/tasks/[id]/move-initiative
 *   POST /api/tasks/[id]/promote
 *   GET  /api/tasks/[id]/initiative-history
 *
 * Designed to be self-contained — owns its own state, refresh, and error
 * surface so TaskModal doesn't need to thread props for it.
 */

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { Send, MoveRight, Unlink, ChevronDown, ChevronRight as Chevron } from 'lucide-react';

interface InitiativeLite {
  id: string;
  title: string;
  kind: string;
  workspace_id: string;
}

interface HistoryRow {
  id: string;
  from_initiative_id: string | null;
  from_initiative_title: string | null;
  to_initiative_id: string | null;
  to_initiative_title: string | null;
  reason: string | null;
  moved_by_agent_id: string | null;
  created_at: string;
}

interface Props {
  taskId: string;
  taskStatus: string;
  workspaceId: string;
  initiativeId: string | null;
  /**
   * Notified after a successful mutation so the parent modal can refresh
   * its task object (status flip on promote, initiative_id change on move).
   */
  onChanged: () => void;
}

export function TaskInitiativePanel({
  taskId,
  taskStatus,
  workspaceId,
  initiativeId,
  onChanged,
}: Props) {
  const [initiatives, setInitiatives] = useState<InitiativeLite[]>([]);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [chosen, setChosen] = useState<string>('');
  const [reason, setReason] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false);
  const [busy, setBusy] = useState<'move' | 'detach' | 'promote' | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const loadHistory = useCallback(async () => {
    try {
      const res = await fetch(`/api/tasks/${taskId}/initiative-history`);
      if (res.ok) setHistory(await res.json());
    } catch {
      /* non-fatal */
    }
  }, [taskId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/initiatives?workspace_id=${workspaceId}`);
        if (res.ok && !cancelled) setInitiatives(await res.json());
      } catch {
        /* non-fatal */
      }
    })();
    loadHistory();
    return () => {
      cancelled = true;
    };
  }, [workspaceId, loadHistory]);

  const owning = initiativeId ? initiatives.find(i => i.id === initiativeId) : null;

  const move = async (toId: string | null, action: 'move' | 'detach') => {
    setBusy(action);
    setErr(null);
    try {
      const res = await fetch(`/api/tasks/${taskId}/move-initiative`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to_initiative_id: toId,
          reason: reason || null,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Move failed (${res.status})`);
      }
      setChosen('');
      setReason('');
      await loadHistory();
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Move failed');
    } finally {
      setBusy(null);
    }
  };

  const promote = async () => {
    setBusy('promote');
    setErr(null);
    try {
      const res = await fetch(`/api/tasks/${taskId}/promote`, { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Promote failed (${res.status})`);
      }
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Promote failed');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="p-3 bg-mc-bg rounded-lg border border-mc-border space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-sm font-medium text-mc-text">Initiative</h4>
        {taskStatus === 'draft' && (
          <button
            type="button"
            onClick={promote}
            disabled={busy === 'promote'}
            className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded bg-mc-accent/20 text-mc-accent border border-mc-accent/30 hover:bg-mc-accent/30 disabled:opacity-50"
            title="Promote draft to execution queue (status → inbox)"
          >
            <Send className="w-3 h-3" />
            {busy === 'promote' ? 'Promoting…' : 'Promote draft → inbox'}
          </button>
        )}
      </div>

      <div className="text-sm">
        {owning ? (
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-mc-text-secondary">Owning initiative:</span>
            <Link
              href={`/initiatives/${owning.id}`}
              className="text-mc-accent hover:underline"
            >
              {owning.title}
            </Link>
            <span className="text-[10px] uppercase tracking-wide text-mc-text-secondary">
              ({owning.kind})
            </span>
          </div>
        ) : initiativeId ? (
          <span className="text-mc-text-secondary">
            Initiative {initiativeId.slice(0, 8)}…
          </span>
        ) : (
          <span className="text-mc-text-secondary italic">Not linked to an initiative.</span>
        )}
      </div>

      {/* Move / detach controls */}
      <div className="space-y-2">
        <div className="flex gap-2">
          <select
            className="flex-1 min-h-9 px-2 py-1 rounded bg-mc-bg-secondary border border-mc-border text-xs"
            value={chosen}
            onChange={e => setChosen(e.target.value)}
          >
            <option value="">(choose initiative to move to)</option>
            {initiatives
              .filter(i => i.id !== initiativeId)
              .map(i => (
                <option key={i.id} value={i.id}>
                  {i.kind} — {i.title}
                </option>
              ))}
          </select>
          <button
            type="button"
            disabled={!chosen || busy === 'move'}
            onClick={() => move(chosen, 'move')}
            className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded bg-mc-bg-secondary border border-mc-border hover:border-mc-accent/40 disabled:opacity-50"
          >
            <MoveRight className="w-3 h-3" />
            {busy === 'move' ? 'Moving…' : 'Move'}
          </button>
          {initiativeId && (
            <button
              type="button"
              disabled={busy === 'detach'}
              onClick={() => move(null, 'detach')}
              className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded bg-mc-bg-secondary border border-mc-border hover:border-red-500/40 hover:text-red-300 disabled:opacity-50"
              title="Detach (set initiative_id=NULL); audit row recorded"
            >
              <Unlink className="w-3 h-3" />
              Detach
            </button>
          )}
        </div>
        <input
          className="w-full px-2 py-1 rounded bg-mc-bg-secondary border border-mc-border text-xs"
          placeholder="Reason (optional, recorded in audit history)"
          value={reason}
          onChange={e => setReason(e.target.value)}
        />
      </div>

      {err && <div className="text-xs text-red-400">{err}</div>}

      {/* Provenance trail */}
      <div>
        <button
          type="button"
          onClick={() => setHistoryOpen(v => !v)}
          className="inline-flex items-center gap-1 text-xs text-mc-text-secondary hover:text-mc-text"
        >
          {historyOpen ? <ChevronDown className="w-3 h-3" /> : <Chevron className="w-3 h-3" />}
          Provenance ({history.length})
        </button>
        {historyOpen && (
          history.length === 0 ? (
            <p className="text-xs text-mc-text-secondary mt-2">No history rows.</p>
          ) : (
            <ul className="space-y-1 text-xs mt-2">
              {history.map(h => (
                <li key={h.id} className="flex flex-wrap items-center gap-2 p-2 rounded bg-mc-bg-secondary border border-mc-border/60">
                  <span className="text-mc-text-secondary">
                    {h.created_at.replace('T', ' ').slice(0, 19)}
                  </span>
                  <span className="text-mc-text">
                    {h.from_initiative_title ?? '—'} → {h.to_initiative_title ?? '—'}
                  </span>
                  {h.reason && (
                    <span className="text-mc-text-secondary italic">— {h.reason}</span>
                  )}
                </li>
              ))}
            </ul>
          )
        )}
      </div>
    </div>
  );
}
