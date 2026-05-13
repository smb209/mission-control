'use client';

/**
 * Per-initiative "Recent PM activity" rail.
 *
 * Pulls /api/initiatives/<id>/pm-chat — the last N PM-chat messages whose
 * provenance points at this initiative (either directly via
 * `target_initiative_id` or via a `source_note_ids` entry that belongs
 * to the initiative). Click-through jumps back into /pm with
 * `?focus=<message_id>` so the chat scrolls + highlights the row.
 *
 * Closes the "what did the PM do about this initiative?" gap, the
 * reverse direction of the chat context strip that links forward to
 * the initiative.
 *
 * See docs/proposals/pm-chat-context-strip.md.
 */

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { MessageSquare, FileText, StickyNote, ScanSearch } from 'lucide-react';
import { triggerBadgeFor } from '@/components/pm/triggerBadge';

interface PmChatRailMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  created_at: string;
  trigger_kind?: string;
  proposal_id?: string;
  source_note_ids?: string[];
  audit_run_group_id?: string;
}

const REFRESH_MS = 5_000;
const PREVIEW_CHARS = 180;

function formatTimestamp(iso: string): string {
  // Match the activity rail's terse format: "MM-DD HH:mm".
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function truncate(s: string, n: number): string {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  return oneLine.length > n ? oneLine.slice(0, n - 1) + '…' : oneLine;
}

export function RecentPmActivity({
  initiativeId,
  limit = 10,
}: {
  initiativeId: string;
  limit?: number;
}) {
  const [messages, setMessages] = useState<PmChatRailMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch(
        `/api/initiatives/${encodeURIComponent(initiativeId)}/pm-chat?limit=${limit}`,
      );
      if (!r.ok) {
        throw new Error(`HTTP ${r.status}`);
      }
      const data = (await r.json()) as { messages: PmChatRailMessage[] };
      setMessages(data.messages ?? []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'load failed');
    } finally {
      setLoading(false);
    }
  }, [initiativeId, limit]);

  useEffect(() => {
    refresh();
    const t = window.setInterval(refresh, REFRESH_MS);
    return () => window.clearInterval(t);
  }, [refresh]);

  if (loading && messages.length === 0) {
    return (
      <p className="text-xs text-mc-text-secondary">Loading PM activity…</p>
    );
  }
  if (error) {
    return (
      <p className="text-xs text-red-300">
        Could not load PM activity: {error}
      </p>
    );
  }
  if (messages.length === 0) {
    return (
      <p className="text-sm text-mc-text-secondary">
        No PM chat activity for this initiative yet.
      </p>
    );
  }

  return (
    <ul className="space-y-2">
      {messages.map(m => {
        const tb = m.trigger_kind ? triggerBadgeFor(m.trigger_kind) : null;
        return (
          <li
            key={m.id}
            className="border border-mc-border rounded-md bg-mc-surface/40 p-2 text-sm"
          >
            <div className="flex flex-wrap items-center gap-1.5 mb-1 text-xs text-mc-text-secondary">
              <MessageSquare className="w-3 h-3" />
              <span className="font-medium text-mc-text">
                {m.role === 'user' ? 'You' : 'PM'}
              </span>
              <span>·</span>
              <span title={m.created_at}>{formatTimestamp(m.created_at)}</span>
              {tb && (
                <span
                  className={`px-1.5 py-0.5 text-[10px] rounded-sm border uppercase tracking-wide ${tb.cls}`}
                  title={`trigger_kind: ${m.trigger_kind}`}
                >
                  {tb.label}
                </span>
              )}
              {m.source_note_ids && m.source_note_ids.length > 0 && (
                <span
                  className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] rounded-sm border border-yellow-500/30 bg-yellow-500/5 text-yellow-200/80"
                  title={`Source notes: ${m.source_note_ids.join(', ')}`}
                >
                  <StickyNote className="w-3 h-3" />
                  {m.source_note_ids.length === 1
                    ? `note ${m.source_note_ids[0].slice(0, 8)}`
                    : `${m.source_note_ids.length} notes`}
                </span>
              )}
              {m.audit_run_group_id && (
                <span
                  className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] rounded-sm border border-violet-500/30 bg-violet-500/5 text-violet-200/80"
                  title={`Audit run ${m.audit_run_group_id}`}
                >
                  <ScanSearch className="w-3 h-3" />
                  audit {m.audit_run_group_id.slice(0, 8)}
                </span>
              )}
            </div>
            <div className="text-mc-text-secondary leading-snug">
              {truncate(m.content, PREVIEW_CHARS)}
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-3 text-[11px]">
              <Link
                href={`/pm?focus=${encodeURIComponent(m.id)}`}
                className="text-mc-accent hover:underline"
              >
                Open in PM chat →
              </Link>
              {m.proposal_id && (
                <Link
                  href={`/pm/proposals/${m.proposal_id}`}
                  className="inline-flex items-center gap-1 text-mc-text-secondary hover:text-mc-text"
                >
                  <FileText className="w-3 h-3" />
                  view proposal
                </Link>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
