'use client';

/**
 * Research section that lives on InitiativeDetailView. Lists briefs
 * scoped to this initiative and exposes the two entry points to the
 * loop: "Suggest research" (PM-driven candidate proposals) and
 * "New brief" (free-form prompt).
 *
 * Brief progress is reflected by polling `/api/briefs?initiative_id=...`
 * — there's no SSE channel for briefs in v1 of the loop. The polling
 * window narrows while a brief is queued/running and widens once
 * everything's settled.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Sparkles, Plus, RefreshCw, FileText, AlertTriangle, Loader2 } from 'lucide-react';
import { SuggestPickerDrawer } from './SuggestPickerDrawer';
import { RunBriefDrawer } from './RunBriefDrawer';

interface BriefRow {
  id: string;
  title: string;
  initiative_id: string | null;
  topic_id: string | null;
  agent_run_id: string;
  template: string;
  summary: string | null;
  citations: Array<{ url: string; title?: string }>;
  error_md: string | null;
  source_ref: string | null;
  status: string;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

interface Props {
  workspaceId: string;
  initiativeId: string;
}

const POLL_INTERVAL_ACTIVE_MS = 5000;
const POLL_INTERVAL_IDLE_MS = 30000;

export function InitiativeResearchSection({ workspaceId, initiativeId }: Props) {
  const [briefs, setBriefs] = useState<BriefRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [newBriefOpen, setNewBriefOpen] = useState(false);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    setError(null);
    try {
      const res = await fetch(`/api/initiatives/${initiativeId}/briefs`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `Load failed (${res.status})`);
      }
      const list: BriefRow[] = await res.json();
      setBriefs(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load briefs');
    } finally {
      setRefreshing(false);
    }
  }, [initiativeId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Adaptive polling: tighter while any brief is in flight, looser when
  // everything's settled.
  const hasActive = briefs?.some(
    b => b.status === 'queued' || b.status === 'running',
  );
  useEffect(() => {
    const interval = hasActive ? POLL_INTERVAL_ACTIVE_MS : POLL_INTERVAL_IDLE_MS;
    const t = setInterval(refresh, interval);
    return () => clearInterval(t);
  }, [refresh, hasActive]);

  return (
    <div id="research" className="mt-6 scroll-mt-20">
      <div className="flex items-center justify-between mb-2">
        <h2 className="font-medium text-mc-text flex items-center gap-2">
          Research
          {briefs && briefs.length > 0 && (
            <span className="text-xs text-mc-text-secondary">({briefs.length})</span>
          )}
          {refreshing && <RefreshCw className="w-3 h-3 text-mc-text-secondary animate-spin" />}
        </h2>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setSuggestOpen(true)}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-sm text-xs border border-mc-border text-mc-text-secondary hover:text-mc-accent hover:border-mc-accent/60"
            title="Ask the PM to propose 3–5 candidate briefs scoped to this initiative."
          >
            <Sparkles className="w-3 h-3" /> Suggest research
          </button>
          <button
            type="button"
            onClick={() => setNewBriefOpen(true)}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-sm text-xs border border-mc-border text-mc-text-secondary hover:text-mc-accent hover:border-mc-accent/60"
            title="Free-form research brief on this initiative."
          >
            <Plus className="w-3 h-3" /> New brief
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-2 px-3 py-2 rounded-sm bg-red-900/20 border border-red-500/30 text-red-300 text-xs flex items-start gap-2">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      {briefs && briefs.length === 0 && !error && (
        <p className="text-xs text-mc-text-secondary/70 italic px-3 py-3 rounded-sm border border-mc-border/60 bg-mc-bg">
          No research yet. Use Suggest research to have the PM propose candidates, or New brief
          for a free-form question.
        </p>
      )}

      {briefs && briefs.length > 0 && (
        <ul className="space-y-1.5">
          {briefs.map(b => (
            <BriefRowView key={b.id} brief={b} />
          ))}
        </ul>
      )}

      <SuggestPickerDrawer
        open={suggestOpen}
        onClose={() => setSuggestOpen(false)}
        workspaceId={workspaceId}
        kind="brief"
        initiativeId={initiativeId}
        onAccepted={() => {
          setSuggestOpen(false);
          refresh();
        }}
      />
      <RunBriefDrawer
        open={newBriefOpen}
        onClose={() => setNewBriefOpen(false)}
        workspaceId={workspaceId}
        topics={[]}
        defaultTopicId={null}
        initiativeId={initiativeId}
        onLaunched={() => {
          setNewBriefOpen(false);
          refresh();
        }}
      />
    </div>
  );
}

function BriefRowView({ brief }: { brief: BriefRow }) {
  const status = brief.status;
  const subtitle = brief.summary || (status === 'complete' ? '(no summary yet)' : '');
  const citationCount = Array.isArray(brief.citations) ? brief.citations.length : 0;
  const created = formatDate(brief.created_at);

  return (
    <li className="px-3 py-2 rounded-sm border border-mc-border bg-mc-bg-secondary hover:bg-mc-bg-tertiary">
      <Link
        href={`/research/briefs/${brief.id}`}
        className="block group"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <FileText className="w-3.5 h-3.5 text-mc-text-secondary shrink-0" />
              <span className="text-sm text-mc-text group-hover:text-mc-accent truncate">{brief.title}</span>
              <StatusBadge status={status} />
            </div>
            {subtitle && (
              <div className="mt-1 text-[11px] text-mc-text-secondary truncate">{subtitle}</div>
            )}
          </div>
          <div className="text-[10px] text-mc-text-secondary shrink-0 text-right whitespace-nowrap">
            {created}
            {citationCount > 0 && <div>{citationCount} citation{citationCount === 1 ? '' : 's'}</div>}
          </div>
        </div>
      </Link>
    </li>
  );
}

function StatusBadge({ status }: { status: string }) {
  const classes =
    status === 'complete'
      ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
      : status === 'running' || status === 'queued'
        ? 'border-blue-500/40 bg-blue-500/10 text-blue-300'
        : status === 'failed'
          ? 'border-red-500/40 bg-red-500/10 text-red-300'
          : status === 'cancelled'
            ? 'border-mc-border bg-mc-bg text-mc-text-secondary'
            : 'border-mc-border bg-mc-bg text-mc-text-secondary';
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded-sm border inline-flex items-center gap-1 ${classes}`}>
      {(status === 'running' || status === 'queued') && <Loader2 className="w-2.5 h-2.5 animate-spin" />}
      {status}
    </span>
  );
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const now = new Date();
    const sameYear = d.getUTCFullYear() === now.getUTCFullYear();
    return d.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: sameYear ? undefined : 'numeric',
    });
  } catch {
    return iso;
  }
}
