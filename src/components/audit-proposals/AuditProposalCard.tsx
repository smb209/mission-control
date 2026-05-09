/**
 * AuditProposalCard — single per-node proposal card with view + inline-
 * edit modes (Phase 6, specs/subtree-audit-proposals-spec.md §8).
 *
 * View mode: action badge, target node link, current → proposed diff,
 * evidence, rationale, Accept / Reject / Edit buttons.
 *
 * Edit mode (toggled by Edit): the card flips to a small form whose
 * fields depend on the chosen action. Save = POST accept with the
 * edited overrides; Cancel returns to view.
 */

'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { AuditProposalRecord } from '@/hooks/useAuditProposals';
import type { AuditProposalBody } from '@/lib/agents/audit-proposals/schemas';

// ─── Action / confidence styling ────────────────────────────────────

const ACTION_BADGE_CLASS: Record<AuditProposalBody['proposed_action'], string> = {
  keep: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  mark_done: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  modify_scope: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  modify_dates: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  cancel: 'bg-red-500/15 text-red-300 border-red-500/30',
};

const CONFIDENCE_BADGE_CLASS: Record<'low' | 'medium' | 'high', string> = {
  low: 'bg-mc-bg text-mc-text-secondary border-mc-border',
  medium: 'bg-mc-bg text-mc-text border-mc-border',
  high: 'bg-mc-bg text-mc-text border-mc-accent/40',
};

const ACTION_LABEL: Record<AuditProposalBody['proposed_action'], string> = {
  keep: 'Keep',
  mark_done: 'Mark done',
  modify_scope: 'Modify scope',
  modify_dates: 'Modify dates',
  cancel: 'Cancel',
};

interface Props {
  item: AuditProposalRecord;
  onAccepted: () => void;
  onRejected: () => void;
}

export function AuditProposalCard({ item, onAccepted, onRejected }: Props) {
  const [editing, setEditing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rejectMode, setRejectMode] = useState(false);
  const [rejectReason, setRejectReason] = useState('');

  const onAccept = async (overrides?: {
    proposed_action?: AuditProposalBody['proposed_action'];
    proposed_changes?: Record<string, unknown>;
  }) => {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/initiatives/${item.note.initiative_id}/proposals/${item.note.id}/accept`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(overrides ?? {}),
        },
      );
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      onAccepted();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  const onReject = async () => {
    if (!rejectReason.trim()) {
      setError('Rejection reason is required.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/initiatives/${item.note.initiative_id}/proposals/${item.note.id}/reject`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason: rejectReason.trim() }),
        },
      );
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      onRejected();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="rounded-md border border-mc-border bg-mc-bg p-3 space-y-2">
      {/* Header */}
      <div className="flex items-center gap-2 flex-wrap">
        <span
          className={`px-2 py-0.5 rounded text-xs uppercase tracking-wide border ${
            ACTION_BADGE_CLASS[item.body.proposed_action] ?? ''
          }`}
        >
          {ACTION_LABEL[item.body.proposed_action]}
        </span>
        <span
          className={`px-2 py-0.5 rounded text-[11px] uppercase tracking-wide border ${
            CONFIDENCE_BADGE_CLASS[item.body.confidence]
          }`}
        >
          {item.body.confidence} confidence
        </span>
        {item.target ? (
          <Link
            href={`/initiatives/${item.target.id}`}
            className="text-sm text-mc-accent hover:underline truncate"
          >
            {item.target.title}
          </Link>
        ) : (
          <span className="text-sm text-mc-text-secondary">
            (target unknown)
          </span>
        )}
      </div>

      {!editing && !rejectMode && (
        <ViewBody body={item.body} target={item.target} />
      )}

      {editing && (
        <EditForm
          body={item.body}
          submitting={submitting}
          onCancel={() => setEditing(false)}
          onSave={async (overrides) => {
            await onAccept(overrides);
          }}
        />
      )}

      {rejectMode && (
        <div className="space-y-2 pt-1">
          <label className="block text-xs text-mc-text-secondary">
            Reason (required)
          </label>
          <textarea
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            rows={2}
            className="w-full rounded border border-mc-border bg-mc-bg-secondary px-2 py-1 text-sm text-mc-text"
            placeholder="Why is this proposal wrong?"
          />
        </div>
      )}

      {error && (
        <div className="text-xs text-red-400 border border-red-500/30 bg-red-500/10 rounded px-2 py-1">
          {error}
        </div>
      )}

      {/* Footer */}
      <div className="flex items-center gap-2 pt-1">
        {!editing && !rejectMode && (
          <>
            <button
              type="button"
              onClick={() => onAccept()}
              disabled={submitting}
              className="px-3 py-1 rounded text-sm bg-mc-accent/20 text-mc-accent border border-mc-accent/40 hover:bg-mc-accent/30 disabled:opacity-50"
            >
              Accept
            </button>
            <button
              type="button"
              onClick={() => setRejectMode(true)}
              disabled={submitting}
              className="px-3 py-1 rounded text-sm bg-mc-bg-secondary border border-mc-border text-mc-text hover:bg-mc-bg disabled:opacity-50"
            >
              Reject
            </button>
            <button
              type="button"
              onClick={() => setEditing(true)}
              disabled={submitting}
              className="px-3 py-1 rounded text-sm bg-mc-bg-secondary border border-mc-border text-mc-text hover:bg-mc-bg disabled:opacity-50"
            >
              Edit
            </button>
          </>
        )}
        {rejectMode && (
          <>
            <button
              type="button"
              onClick={onReject}
              disabled={submitting || !rejectReason.trim()}
              className="px-3 py-1 rounded text-sm bg-red-500/20 text-red-300 border border-red-500/40 hover:bg-red-500/30 disabled:opacity-50"
            >
              Confirm reject
            </button>
            <button
              type="button"
              onClick={() => {
                setRejectMode(false);
                setRejectReason('');
                setError(null);
              }}
              disabled={submitting}
              className="px-3 py-1 rounded text-sm bg-mc-bg-secondary border border-mc-border text-mc-text hover:bg-mc-bg disabled:opacity-50"
            >
              Cancel
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// ─── View mode body ─────────────────────────────────────────────────

function ViewBody({
  body,
  target,
}: {
  body: AuditProposalBody;
  target: AuditProposalRecord['target'];
}) {
  return (
    <div className="space-y-2 text-sm">
      <DiffView body={body} target={target} />
      <Evidence refs={body.repo_evidence} />
      <div className="text-mc-text-secondary whitespace-pre-line text-xs">
        {body.rationale}
      </div>
      {body.confidence !== 'high' && body.would_confirm_by && (
        <div className="text-[11px] text-mc-text-secondary italic">
          Would confirm by: {body.would_confirm_by}
        </div>
      )}
    </div>
  );
}

function DiffView({
  body,
  target,
}: {
  body: AuditProposalBody;
  target: AuditProposalRecord['target'];
}) {
  if (body.proposed_action === 'keep') {
    return (
      <div className="text-xs text-mc-text-secondary">No changes proposed.</div>
    );
  }
  if (body.proposed_action === 'mark_done') {
    return (
      <div className="text-xs">
        <span className="text-mc-text-secondary">status:</span>{' '}
        <code className="text-mc-text">
          {target?.current_status ?? body.current_mc_status}
        </code>{' '}
        →{' '}
        <code className="text-emerald-300">done</code>
        {' — '}
        <span className="text-mc-text-secondary">
          {body.proposed_changes.note}
        </span>
      </div>
    );
  }
  if (body.proposed_action === 'cancel') {
    return (
      <div className="text-xs">
        <span className="text-mc-text-secondary">status:</span>{' '}
        <code className="text-mc-text">
          {target?.current_status ?? body.current_mc_status}
        </code>{' '}
        →{' '}
        <code className="text-red-300">cancelled</code>
        {' — '}
        <span className="text-mc-text-secondary">
          {body.proposed_changes.reason}
        </span>
      </div>
    );
  }
  if (body.proposed_action === 'modify_scope') {
    return (
      <div className="text-xs space-y-1">
        {body.proposed_changes.title !== undefined && (
          <div>
            <span className="text-mc-text-secondary">title:</span>{' '}
            <code className="text-mc-text">{truncate(target?.title ?? '', 80)}</code>{' '}
            →{' '}
            <code className="text-amber-300">
              {truncate(body.proposed_changes.title, 80)}
            </code>
          </div>
        )}
        {body.proposed_changes.description !== undefined && (
          <details className="cursor-pointer">
            <summary className="text-mc-text-secondary">description (changed)</summary>
            <pre className="text-[11px] whitespace-pre-wrap text-mc-text mt-1 bg-mc-bg-secondary border border-mc-border rounded p-2">
              {body.proposed_changes.description}
            </pre>
          </details>
        )}
      </div>
    );
  }
  if (body.proposed_action === 'modify_dates') {
    return (
      <div className="text-xs space-y-1">
        {body.proposed_changes.target_start !== undefined && (
          <div>
            <span className="text-mc-text-secondary">target_start:</span>{' '}
            →{' '}
            <code className="text-amber-300">
              {body.proposed_changes.target_start}
            </code>
          </div>
        )}
        {body.proposed_changes.target_end !== undefined && (
          <div>
            <span className="text-mc-text-secondary">target_end:</span>{' '}
            <code className="text-mc-text">
              {target?.target_end ?? body.current_mc_target_end ?? '(unset)'}
            </code>{' '}
            →{' '}
            <code className="text-amber-300">
              {body.proposed_changes.target_end}
            </code>
          </div>
        )}
      </div>
    );
  }
  return null;
}

function Evidence({ refs }: { refs: AuditProposalBody['repo_evidence'] }) {
  if (refs.length === 0) return null;
  return (
    <ul className="text-[11px] flex flex-wrap gap-1.5">
      {refs.map((r, idx) => (
        <li key={idx}>
          {r.kind === 'file' && (
            <code className="px-1.5 py-0.5 bg-mc-bg-secondary border border-mc-border rounded">
              {r.ref}
            </code>
          )}
          {r.kind === 'git' && (
            <code className="px-1.5 py-0.5 bg-mc-bg-secondary border border-mc-border rounded font-mono">
              {r.ref.slice(0, 7)}
            </code>
          )}
          {r.kind === 'pr' && /^https?:\/\//.test(r.ref) ? (
            <a
              href={r.ref}
              target="_blank"
              rel="noopener noreferrer"
              className="px-1.5 py-0.5 bg-mc-bg-secondary border border-mc-border rounded text-mc-accent hover:underline"
            >
              PR
            </a>
          ) : r.kind === 'pr' ? (
            <code className="px-1.5 py-0.5 bg-mc-bg-secondary border border-mc-border rounded">
              {r.ref}
            </code>
          ) : null}
          {r.kind === 'note' && (
            <span className="px-1.5 py-0.5 bg-mc-bg-secondary border border-mc-border rounded text-mc-text-secondary">
              → note
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}

// ─── Edit mode form ─────────────────────────────────────────────────

type ActionType = AuditProposalBody['proposed_action'];

function EditForm({
  body,
  submitting,
  onCancel,
  onSave,
}: {
  body: AuditProposalBody;
  submitting: boolean;
  onCancel: () => void;
  onSave: (overrides: {
    proposed_action: ActionType;
    proposed_changes: Record<string, unknown>;
  }) => Promise<void>;
}) {
  const [action, setAction] = useState<ActionType>(body.proposed_action);
  const [doneNote, setDoneNote] = useState(
    body.proposed_action === 'mark_done' ? body.proposed_changes.note : '',
  );
  const [cancelReason, setCancelReason] = useState(
    body.proposed_action === 'cancel' ? body.proposed_changes.reason : '',
  );
  const [scopeTitle, setScopeTitle] = useState(
    body.proposed_action === 'modify_scope'
      ? (body.proposed_changes.title ?? '')
      : '',
  );
  const [scopeDescription, setScopeDescription] = useState(
    body.proposed_action === 'modify_scope'
      ? (body.proposed_changes.description ?? '')
      : '',
  );
  const [dateStart, setDateStart] = useState(
    body.proposed_action === 'modify_dates'
      ? (body.proposed_changes.target_start ?? '')
      : '',
  );
  const [dateEnd, setDateEnd] = useState(
    body.proposed_action === 'modify_dates'
      ? (body.proposed_changes.target_end ?? '')
      : '',
  );

  const validity = (): { ok: boolean; changes: Record<string, unknown> } => {
    switch (action) {
      case 'keep':
        return { ok: true, changes: {} };
      case 'mark_done':
        return doneNote.trim()
          ? { ok: true, changes: { note: doneNote.trim() } }
          : { ok: false, changes: {} };
      case 'cancel':
        return cancelReason.trim()
          ? { ok: true, changes: { reason: cancelReason.trim() } }
          : { ok: false, changes: {} };
      case 'modify_scope': {
        const changes: Record<string, unknown> = {};
        if (scopeTitle.trim()) changes.title = scopeTitle.trim();
        if (scopeDescription.trim()) changes.description = scopeDescription.trim();
        return { ok: Object.keys(changes).length > 0, changes };
      }
      case 'modify_dates': {
        const changes: Record<string, unknown> = {};
        if (/^\d{4}-\d{2}-\d{2}$/.test(dateStart))
          changes.target_start = dateStart;
        if (/^\d{4}-\d{2}-\d{2}$/.test(dateEnd))
          changes.target_end = dateEnd;
        return { ok: Object.keys(changes).length > 0, changes };
      }
      default:
        return { ok: false, changes: {} };
    }
  };

  const v = validity();

  return (
    <div className="space-y-2 pt-1 text-xs">
      <div className="flex items-center gap-2">
        <label className="text-mc-text-secondary">Action:</label>
        <select
          value={action}
          onChange={(e) => setAction(e.target.value as ActionType)}
          className="rounded border border-mc-border bg-mc-bg-secondary px-2 py-1 text-mc-text"
        >
          <option value="keep">Keep</option>
          <option value="mark_done">Mark done</option>
          <option value="cancel">Cancel</option>
          <option value="modify_scope">Modify scope</option>
          <option value="modify_dates">Modify dates</option>
        </select>
      </div>

      {action === 'keep' && (
        <div className="text-mc-text-secondary">(no changes)</div>
      )}
      {action === 'mark_done' && (
        <textarea
          value={doneNote}
          onChange={(e) => setDoneNote(e.target.value)}
          placeholder="What evidence supports completion?"
          rows={2}
          className="w-full rounded border border-mc-border bg-mc-bg-secondary px-2 py-1 text-mc-text"
        />
      )}
      {action === 'cancel' && (
        <textarea
          value={cancelReason}
          onChange={(e) => setCancelReason(e.target.value)}
          placeholder="Why cancel?"
          rows={2}
          className="w-full rounded border border-mc-border bg-mc-bg-secondary px-2 py-1 text-mc-text"
        />
      )}
      {action === 'modify_scope' && (
        <>
          <input
            value={scopeTitle}
            onChange={(e) => setScopeTitle(e.target.value)}
            placeholder="New title (optional)"
            className="w-full rounded border border-mc-border bg-mc-bg-secondary px-2 py-1 text-mc-text"
          />
          <textarea
            value={scopeDescription}
            onChange={(e) => setScopeDescription(e.target.value)}
            placeholder="New description (optional)"
            rows={3}
            className="w-full rounded border border-mc-border bg-mc-bg-secondary px-2 py-1 text-mc-text"
          />
        </>
      )}
      {action === 'modify_dates' && (
        <div className="flex items-center gap-2">
          <label>
            <span className="text-mc-text-secondary mr-1">target_start:</span>
            <input
              type="date"
              value={dateStart}
              onChange={(e) => setDateStart(e.target.value)}
              className="rounded border border-mc-border bg-mc-bg-secondary px-2 py-1 text-mc-text"
            />
          </label>
          <label>
            <span className="text-mc-text-secondary mr-1">target_end:</span>
            <input
              type="date"
              value={dateEnd}
              onChange={(e) => setDateEnd(e.target.value)}
              className="rounded border border-mc-border bg-mc-bg-secondary px-2 py-1 text-mc-text"
            />
          </label>
        </div>
      )}

      <div className="flex items-center gap-2 pt-1">
        <button
          type="button"
          onClick={() =>
            onSave({ proposed_action: action, proposed_changes: v.changes })
          }
          disabled={!v.ok || submitting}
          className="px-3 py-1 rounded bg-mc-accent/20 text-mc-accent border border-mc-accent/40 hover:bg-mc-accent/30 disabled:opacity-50"
        >
          Save (accept with edits)
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={submitting}
          className="px-3 py-1 rounded bg-mc-bg-secondary border border-mc-border text-mc-text hover:bg-mc-bg disabled:opacity-50"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
