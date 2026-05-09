'use client';

/**
 * Suggestion picker drawer.
 *
 * Open with `kind` ('topic' | 'brief'). On open it kicks the PM
 * dispatch (POST /api/research/suggestions) and shows a spinner.
 * When candidates arrive, each is a checkbox row with the rationale
 * underneath. Operator multi-selects → "Insert N selected" → each
 * accepted suggestion creates a real topic/brief. Briefs land
 * queued (the brief detail page's "Run a brief" affordance stays
 * the explicit dispatch trigger).
 */

import { useCallback, useEffect, useState } from 'react';
import { Sparkles, AlertTriangle, RefreshCw } from 'lucide-react';
import Drawer from '@/components/Drawer';

interface TopicPayload { name: string; description: string; tags: string[] }
interface BriefPayload { title: string; prompt: string; topic_id?: string | null }
type Payload = TopicPayload | BriefPayload;

interface Suggestion {
  id: string;
  kind: 'topic' | 'brief' | 'recurring_brief';
  payload: Payload;
  rationale: string | null;
  status: 'pending' | 'accepted' | 'rejected' | 'dismissed';
}

interface Props {
  open: boolean;
  onClose: () => void;
  workspaceId: string;
  kind: 'topic' | 'brief';
  /**
   * When set, scope the dispatch and resulting suggestions to a
   * specific initiative. The PM gets initiative-scoped context;
   * accepted brief suggestions dispatch with `initiative_id` set.
   */
  initiativeId?: string;
  /** Called after the operator accepts ≥ 1 suggestion. */
  onAccepted: () => void;
}

export function SuggestPickerDrawer({ open, onClose, workspaceId, kind, initiativeId, onAccepted }: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);

  const dispatchSuggest = useCallback(async () => {
    setLoading(true);
    setError(null);
    setSuggestions([]);
    setSelected(new Set());
    try {
      const res = await fetch('/api/research/suggestions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspace_id: workspaceId,
          kind,
          ...(initiativeId ? { initiative_id: initiativeId } : {}),
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body.error ?? `Request failed (${res.status})`);
      }
      setSuggestions(body.suggestions ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to fetch suggestions');
    } finally {
      setLoading(false);
    }
  }, [workspaceId, kind, initiativeId]);

  // Auto-kick on open.
  useEffect(() => {
    if (open) dispatchSuggest();
  }, [open, dispatchSuggest]);

  const toggle = (id: string) => {
    setSelected(s => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const insertSelected = useCallback(async () => {
    if (selected.size === 0 || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const ids = Array.from(selected);
      const results = await Promise.all(
        ids.map(id =>
          fetch(`/api/research/suggestions/${id}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'accept' }),
          }),
        ),
      );
      const failed = results.filter(r => !r.ok);
      if (failed.length > 0) {
        throw new Error(`${failed.length} of ${results.length} suggestions failed to insert`);
      }
      onAccepted();
      handleClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Insert failed');
    } finally {
      setSubmitting(false);
    }
  }, [selected, submitting, onAccepted]);

  const handleClose = () => {
    if (submitting) return;
    setSuggestions([]);
    setSelected(new Set());
    setError(null);
    onClose();
  };

  return (
    <Drawer
      open={open}
      title={`Suggest ${kind === 'topic' ? 'topics' : 'briefs'}`}
      onClose={handleClose}
      footer={
        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={dispatchSuggest}
            disabled={loading || submitting}
            className="text-xs text-mc-text-secondary hover:text-mc-accent flex items-center gap-1.5 disabled:opacity-40"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            Suggest again
          </button>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleClose}
              disabled={submitting}
              className="px-3 py-1.5 text-sm rounded-sm text-mc-text-secondary hover:bg-mc-bg-tertiary"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={insertSelected}
              disabled={selected.size === 0 || submitting || loading}
              className="px-3 py-1.5 text-sm rounded-sm bg-mc-accent text-mc-bg disabled:opacity-40 hover:opacity-90"
            >
              {submitting
                ? 'Inserting…'
                : selected.size === 0
                  ? 'Select to insert'
                  : `Insert ${selected.size} selected`}
            </button>
          </div>
        </div>
      }
    >
      <div className="space-y-3">
        <p className="text-xs text-mc-text-secondary">
          The PM is surveying the workspace's initiatives, in-flight tasks, existing topics, and recent briefs to propose candidates. Pick one or more to insert. {kind === 'brief' && 'Briefs land queued — you still hit "Run" to dispatch.'}
        </p>

        {loading && (
          <div className="flex items-center gap-2 text-sm text-mc-text-secondary px-3 py-4 rounded-sm bg-mc-bg-tertiary border border-mc-border">
            <Sparkles className="w-4 h-4 text-mc-accent animate-pulse" />
            <span>PM is thinking…</span>
          </div>
        )}

        {error && !loading && (
          <div className="flex items-start gap-2 px-3 py-2 rounded-sm bg-red-900/20 border border-red-500/30 text-red-300 text-sm">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            <div className="flex-1">{error}</div>
          </div>
        )}

        {!loading && !error && suggestions.length === 0 && (
          <p className="text-sm text-mc-text-secondary/70 italic px-3 py-4">
            No candidates returned. Click "Suggest again" to retry.
          </p>
        )}

        {!loading && suggestions.length > 0 && (
          <ul className="space-y-2">
            {suggestions.map(s => {
              const isSelected = selected.has(s.id);
              const title = kind === 'topic'
                ? (s.payload as TopicPayload).name
                : (s.payload as BriefPayload).title;
              const body = kind === 'topic'
                ? (s.payload as TopicPayload).description
                : (s.payload as BriefPayload).prompt;
              return (
                <li key={s.id}>
                  <label className={`block px-3 py-2 rounded-sm border cursor-pointer ${
                    isSelected
                      ? 'border-mc-accent/60 bg-mc-accent/5'
                      : 'border-mc-border bg-mc-bg-secondary hover:bg-mc-bg-tertiary'
                  }`}>
                    <div className="flex items-start gap-2">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggle(s.id)}
                        className="mt-1 shrink-0 accent-mc-accent"
                      />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium text-mc-text">{title}</div>
                        <div className="text-xs text-mc-text-secondary mt-1 whitespace-pre-wrap">{body}</div>
                        {s.rationale && (
                          <div className="mt-2 text-[11px] text-mc-accent/80 italic">
                            Why: {s.rationale}
                          </div>
                        )}
                        {kind === 'topic' && (s.payload as TopicPayload).tags?.length > 0 && (
                          <div className="flex flex-wrap gap-1 mt-1.5">
                            {(s.payload as TopicPayload).tags.map(t => (
                              <span key={t} className="text-[10px] px-1.5 py-0.5 rounded-sm bg-mc-bg-tertiary text-mc-text-secondary border border-mc-border">{t}</span>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  </label>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Drawer>
  );
}
