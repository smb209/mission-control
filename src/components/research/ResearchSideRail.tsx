'use client';

/**
 * Persistent left rail rendered by `(app)/research/layout.tsx`.
 *
 * Stays mounted across /research, /research/topics/[id],
 * /research/briefs/[id], so the operator can navigate between
 * topics and recent briefs without going back to the hub.
 *
 * Features:
 *   - Sections (Topics, Briefs) each collapse vertically so a big
 *     topics list doesn't bury briefs.
 *   - Pin a topic or brief to keep it pinned to the top of its
 *     section (per-workspace, localStorage-only — pure UI state, no
 *     DB row required).
 *   - Drag the right edge to resize the rail width (180–480px).
 *   - Collapse the entire rail to a thin icon column for focus mode.
 *
 * All UI state (rail collapsed, rail width, section open/closed,
 * pinned ids per workspace) persists in localStorage so operator
 * preference survives reloads.
 *
 * Active row highlighting is pathname-based.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Plus,
  Sparkles,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  Search,
  FileText,
  Archive,
  Zap,
  CircleDot,
  CheckCircle2,
  XCircle,
  Loader2,
  Pin,
  PinOff,
  Clock,
} from 'lucide-react';
import { useCurrentWorkspaceId } from '@/components/shell/workspace-context';
import { useResearchPreflight } from '@/components/research/useResearchPreflight';
import { CreateTopicDrawer } from '@/components/research/CreateTopicDrawer';
import { RunBriefDrawer } from '@/components/research/RunBriefDrawer';
import { SuggestPickerDrawer } from '@/components/research/SuggestPickerDrawer';

interface TopicSummary {
  id: string;
  name: string;
  description: string;
  tags: string[];
  archived_at: string | null;
}

interface BriefSummary {
  id: string;
  title: string;
  topic_id: string | null;
  agent_run_id: string;
  template: string;
  created_at: string;
}

interface AgentRunSummary {
  id: string;
  status: 'queued' | 'running' | 'complete' | 'failed' | 'cancelled';
}

interface ScheduleSummary {
  id: string;
  topic_id: string | null;
  status: 'active' | 'paused' | 'done';
}

const RAIL_COLLAPSED_KEY = 'mc.research.rail.collapsed';
const RAIL_WIDTH_KEY = 'mc.research.rail.width';
const SECTION_OPEN_KEY = 'mc.research.rail.sections';
const PINS_KEY_PREFIX = 'mc.research.rail.pins.';

const RAIL_MIN_WIDTH = 180;
const RAIL_MAX_WIDTH = 480;
const RAIL_DEFAULT_WIDTH = 256;

/**
 * SSE event types the rail reacts to. `brief_failed` is also broadcast
 * (with `payload.deleted: true`) by the DELETE /api/briefs/[id] route
 * so the deleted entry disappears from the rail without a manual
 * refresh.
 *
 * We open our OWN EventSource (instead of routing through the store)
 * because the project's `useSSE` hook only pushes specific event
 * types into the global events array — `brief_*` events are not on
 * its allowlist. Matches the pattern in DecomposeWithPmModal /
 * AgentActivityDashboard / etc.
 */
const RELEVANT_EVENTS = new Set([
  'brief_started', 'brief_progress', 'brief_completed', 'brief_failed',
]);

const STATUS_ICON: Record<AgentRunSummary['status'], React.ComponentType<{ className?: string }>> = {
  queued: CircleDot,
  running: Loader2,
  complete: CheckCircle2,
  failed: XCircle,
  cancelled: XCircle,
};

const STATUS_COLOR: Record<AgentRunSummary['status'], string> = {
  queued: 'text-mc-text-secondary',
  running: 'text-mc-accent animate-spin',
  complete: 'text-green-400',
  failed: 'text-red-400',
  cancelled: 'text-yellow-400',
};

interface SectionState { topics: boolean; briefs: boolean }
const DEFAULT_SECTION_STATE: SectionState = { topics: true, briefs: true };

export function ResearchSideRail() {
  const workspaceId = useCurrentWorkspaceId();
  const pathname = usePathname() ?? '/research';
  const preflight = useResearchPreflight(workspaceId);

  const [collapsed, setCollapsed] = useState(false);
  const [width, setWidth] = useState(RAIL_DEFAULT_WIDTH);
  const [sections, setSections] = useState<SectionState>(DEFAULT_SECTION_STATE);
  const [pinnedTopics, setPinnedTopics] = useState<string[]>([]);
  const [pinnedBriefs, setPinnedBriefs] = useState<string[]>([]);

  const [topics, setTopics] = useState<TopicSummary[]>([]);
  const [briefs, setBriefs] = useState<BriefSummary[]>([]);
  const [runs, setRuns] = useState<AgentRunSummary[]>([]);
  const [schedules, setSchedules] = useState<ScheduleSummary[]>([]);
  const [createTopicOpen, setCreateTopicOpen] = useState(false);
  const [runBriefOpen, setRunBriefOpen] = useState(false);
  const [suggestKind, setSuggestKind] = useState<'topic' | 'brief' | null>(null);

  // Restore persisted UI state.
  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem(RAIL_COLLAPSED_KEY) === '1');
      const w = parseInt(localStorage.getItem(RAIL_WIDTH_KEY) ?? '', 10);
      if (Number.isFinite(w) && w >= RAIL_MIN_WIDTH && w <= RAIL_MAX_WIDTH) setWidth(w);
      const sec = localStorage.getItem(SECTION_OPEN_KEY);
      if (sec) {
        const parsed = JSON.parse(sec) as Partial<SectionState>;
        setSections({ ...DEFAULT_SECTION_STATE, ...parsed });
      }
    } catch { /* ignore */ }
  }, []);

  // Per-workspace pinned ids.
  useEffect(() => {
    if (!workspaceId) {
      setPinnedTopics([]); setPinnedBriefs([]);
      return;
    }
    try {
      const raw = localStorage.getItem(PINS_KEY_PREFIX + workspaceId);
      if (raw) {
        const parsed = JSON.parse(raw) as { topics?: string[]; briefs?: string[] };
        setPinnedTopics(parsed.topics ?? []);
        setPinnedBriefs(parsed.briefs ?? []);
      } else {
        setPinnedTopics([]); setPinnedBriefs([]);
      }
    } catch {
      setPinnedTopics([]); setPinnedBriefs([]);
    }
  }, [workspaceId]);

  const persistPins = useCallback((topicsArr: string[], briefsArr: string[]) => {
    if (!workspaceId) return;
    try {
      localStorage.setItem(PINS_KEY_PREFIX + workspaceId, JSON.stringify({ topics: topicsArr, briefs: briefsArr }));
    } catch { /* ignore */ }
  }, [workspaceId]);

  const toggleCollapsed = useCallback(() => {
    setCollapsed(c => {
      const next = !c;
      try { localStorage.setItem(RAIL_COLLAPSED_KEY, next ? '1' : '0'); } catch { /* ignore */ }
      return next;
    });
  }, []);

  const toggleSection = useCallback((key: keyof SectionState) => {
    setSections(s => {
      const next = { ...s, [key]: !s[key] };
      try { localStorage.setItem(SECTION_OPEN_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }, []);

  const togglePinTopic = useCallback((id: string) => {
    setPinnedTopics(prev => {
      const next = prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id];
      persistPins(next, pinnedBriefs);
      return next;
    });
  }, [persistPins, pinnedBriefs]);

  const togglePinBrief = useCallback((id: string) => {
    setPinnedBriefs(prev => {
      const next = prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id];
      persistPins(pinnedTopics, next);
      return next;
    });
  }, [persistPins, pinnedTopics]);

  // Resize-drag.
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const onDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startWidth: width };
    const onMove = (ev: MouseEvent) => {
      if (!dragRef.current) return;
      const dx = ev.clientX - dragRef.current.startX;
      const next = Math.min(RAIL_MAX_WIDTH, Math.max(RAIL_MIN_WIDTH, dragRef.current.startWidth + dx));
      setWidth(next);
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      dragRef.current = null;
      // Persist final width.
      try {
        const finalWidth = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--mc-research-rail-w') || '', 10);
        // Fallback: read from state via setWidth(prev => ...). We
        // can just use the latest setter trick here.
        void finalWidth;
      } catch { /* ignore */ }
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
  }, [width]);

  // Persist width when it stops changing (debounced via effect).
  useEffect(() => {
    const id = setTimeout(() => {
      try { localStorage.setItem(RAIL_WIDTH_KEY, String(width)); } catch { /* ignore */ }
    }, 200);
    return () => clearTimeout(id);
  }, [width]);

  const load = useCallback(async () => {
    if (!workspaceId) {
      setTopics([]); setBriefs([]); setRuns([]); setSchedules([]);
      return;
    }
    const qs = `?workspace_id=${encodeURIComponent(workspaceId)}`;
    try {
      const [t, b, r, s] = await Promise.all([
        fetch(`/api/topics${qs}`).then(res => res.ok ? res.json() : []),
        fetch(`/api/briefs${qs}&limit=20`).then(res => res.ok ? res.json() : []),
        fetch(`/api/agent-runs${qs}&kind=brief&limit=50`).then(res => res.ok ? res.json() : []),
        // limit=100 covers any realistic per-workspace schedule count;
        // we just need topic_ids for the indicator dot.
        fetch(`/api/schedules${qs}&limit=100`).then(res => res.ok ? res.json() : []),
      ]);
      setTopics(t);
      setBriefs(b);
      setRuns(r);
      setSchedules(s);
    } catch {
      // Quiet failure — main panel surfaces its own load error.
    }
  }, [workspaceId]);

  useEffect(() => { load(); }, [load]);

  // Subscribe directly to SSE so we react to brief lifecycle and
  // deletions even when the operator isn't on a page that already
  // owns the global events stream. See RELEVANT_EVENTS doc above.
  useEffect(() => {
    const es = new EventSource('/api/events/stream');
    es.onmessage = (raw) => {
      try {
        if (raw.data.startsWith(':')) return;
        const evt = JSON.parse(raw.data) as { type?: string };
        if (evt.type && RELEVANT_EVENTS.has(evt.type)) load();
      } catch { /* ignore parse errors */ }
    };
    return () => es.close();
  }, [load]);

  const runById = useMemo(() => {
    const m = new Map<string, AgentRunSummary>();
    for (const r of runs) m.set(r.id, r);
    return m;
  }, [runs]);

  // Sort: pinned first (preserving pin order), then the rest in
  // their natural order.
  const sortedTopics = useMemo(() => {
    const pinSet = new Set(pinnedTopics);
    const pinned = pinnedTopics
      .map(id => topics.find(t => t.id === id))
      .filter((t): t is TopicSummary => !!t);
    const rest = topics.filter(t => !pinSet.has(t.id));
    return [...pinned, ...rest];
  }, [topics, pinnedTopics]);

  // topic_ids that have at least one active schedule attached.
  // Drives the small clock indicator next to the topic name.
  const scheduledTopicIds = useMemo(() => {
    const s = new Set<string>();
    for (const sc of schedules) {
      if (sc.topic_id && sc.status === 'active') s.add(sc.topic_id);
    }
    return s;
  }, [schedules]);

  const sortedBriefs = useMemo(() => {
    const pinSet = new Set(pinnedBriefs);
    const pinned = pinnedBriefs
      .map(id => briefs.find(b => b.id === id))
      .filter((b): b is BriefSummary => !!b);
    const rest = briefs.filter(b => !pinSet.has(b.id));
    return [...pinned, ...rest];
  }, [briefs, pinnedBriefs]);

  const isHub = pathname === '/research';
  const activeTopicId = matchPath(pathname, /^\/research\/topics\/([^/]+)/);
  const activeBriefId = matchPath(pathname, /^\/research\/briefs\/([^/]+)/);

  const drawers = (
    <>
      {createTopicOpen && (
        <CreateTopicDrawer
          open={createTopicOpen}
          onClose={() => setCreateTopicOpen(false)}
          workspaceId={workspaceId ?? ''}
          onCreated={() => { setCreateTopicOpen(false); load(); }}
        />
      )}
      {runBriefOpen && (
        <RunBriefDrawer
          open={runBriefOpen}
          onClose={() => setRunBriefOpen(false)}
          workspaceId={workspaceId ?? ''}
          topics={topics.filter(t => !t.archived_at)}
          defaultTopicId={null}
          onLaunched={() => { setRunBriefOpen(false); load(); }}
        />
      )}
      {suggestKind && (
        <SuggestPickerDrawer
          open={!!suggestKind}
          onClose={() => setSuggestKind(null)}
          workspaceId={workspaceId ?? ''}
          kind={suggestKind}
          onAccepted={() => { setSuggestKind(null); load(); }}
        />
      )}
    </>
  );

  if (!workspaceId) {
    return (
      <aside className="w-60 border-r border-mc-border bg-mc-bg-secondary shrink-0 p-3 text-xs text-mc-text-secondary">
        No workspace selected.
      </aside>
    );
  }

  if (collapsed) {
    return (
      <>
        <aside className="w-12 border-r border-mc-border bg-mc-bg-secondary shrink-0 flex flex-col items-center py-2 gap-1">
          <button
            type="button"
            onClick={toggleCollapsed}
            className="p-1.5 rounded-sm text-mc-text-secondary hover:text-mc-text hover:bg-mc-bg-tertiary"
            title="Expand rail"
            aria-label="Expand rail"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
          <Link
            href="/research"
            className={`p-1.5 rounded-sm ${isHub ? 'bg-mc-accent/15 text-mc-accent' : 'text-mc-text-secondary hover:text-mc-text hover:bg-mc-bg-tertiary'}`}
            title="All research"
          >
            <Search className="w-4 h-4" />
          </Link>
          <button
            type="button"
            onClick={() => setRunBriefOpen(true)}
            disabled={!preflight.ok && !preflight.loading}
            className="p-1.5 rounded-sm text-mc-text-secondary hover:text-mc-accent hover:bg-mc-bg-tertiary disabled:opacity-40"
            title="Run a brief"
          >
            <Zap className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={() => setSuggestKind('brief')}
            className="p-1.5 rounded-sm text-mc-text-secondary hover:text-mc-accent hover:bg-mc-bg-tertiary"
            title="Suggest briefs"
          >
            <Sparkles className="w-4 h-4" />
          </button>
        </aside>
        {drawers}
      </>
    );
  }

  return (
    <>
      <aside
        className="border-r border-mc-border bg-mc-bg-secondary shrink-0 flex flex-col relative"
        style={{ width: `${width}px` }}
      >
        {/* Header */}
        <div className="px-3 py-2 border-b border-mc-border flex items-center justify-between">
          <Link
            href="/research"
            className={`text-sm font-medium ${isHub ? 'text-mc-accent' : 'text-mc-text hover:text-mc-accent'}`}
          >
            Research
          </Link>
          <button
            type="button"
            onClick={toggleCollapsed}
            className="p-1 rounded-sm text-mc-text-secondary hover:text-mc-text hover:bg-mc-bg-tertiary"
            title="Collapse rail"
            aria-label="Collapse rail"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto py-1">
          {/* Hub link */}
          <Link
            href="/research"
            className={`mx-2 px-2 py-1.5 rounded-sm flex items-center gap-2 text-sm ${
              isHub ? 'bg-mc-accent/15 text-mc-accent' : 'text-mc-text-secondary hover:text-mc-text hover:bg-mc-bg-tertiary'
            }`}
          >
            <Search className="w-3.5 h-3.5 shrink-0" />
            <span className="truncate">All research</span>
          </Link>

          {/* Topics section */}
          <CollapsibleSection
            label="Topics"
            open={sections.topics}
            onToggle={() => toggleSection('topics')}
            count={topics.length}
            actions={
              <>
                <RailIconButton
                  icon={Sparkles}
                  onClick={() => setSuggestKind('topic')}
                  title="Suggest topics — ask the PM to propose long-lived areas"
                  aria-label="Suggest topics"
                />
                <RailIconButton
                  icon={Plus}
                  onClick={() => setCreateTopicOpen(true)}
                  title="Create topic from scratch"
                  aria-label="Create topic"
                  accent
                />
              </>
            }
          >
            <ul>
              {sortedTopics.map(t => {
                const active = activeTopicId === t.id;
                const pinned = pinnedTopics.includes(t.id);
                const hasSchedule = scheduledTopicIds.has(t.id);
                return (
                  <li key={t.id} className="group">
                    <div className={`mx-2 rounded-sm flex items-center ${
                      active ? 'bg-mc-accent/15' : 'hover:bg-mc-bg-tertiary'
                    }`}>
                      <Link
                        href={`/research/topics/${t.id}`}
                        className={`flex-1 px-2 py-1.5 flex items-center gap-2 text-sm min-w-0 ${
                          active ? 'text-mc-accent' : 'text-mc-text-secondary hover:text-mc-text'
                        }`}
                        title={t.description}
                      >
                        {pinned && <Pin className="w-3 h-3 shrink-0 text-mc-accent fill-mc-accent" />}
                        {t.archived_at && <Archive className="w-3 h-3 shrink-0 opacity-60" />}
                        <span className="truncate">{t.name}</span>
                        {hasSchedule && (
                          <Clock
                            className="w-3 h-3 shrink-0 text-mc-accent ml-auto"
                            aria-label="Has active schedule"
                          />
                        )}
                      </Link>
                      <PinToggle
                        pinned={pinned}
                        onClick={() => togglePinTopic(t.id)}
                        kind="topic"
                      />
                    </div>
                  </li>
                );
              })}
              {topics.length === 0 && (
                <li className="px-3 py-2 text-xs text-mc-text-secondary/60 italic">No topics yet.</li>
              )}
            </ul>
          </CollapsibleSection>

          {/* Briefs section */}
          <CollapsibleSection
            label="Briefs"
            open={sections.briefs}
            onToggle={() => toggleSection('briefs')}
            count={briefs.length}
            actions={
              <>
                <RailIconButton
                  icon={Sparkles}
                  onClick={() => setSuggestKind('brief')}
                  title="Suggest briefs — ask the PM to propose specific research questions"
                  aria-label="Suggest briefs"
                />
                <RailIconButton
                  icon={Zap}
                  onClick={() => setRunBriefOpen(true)}
                  title="Run a brief"
                  aria-label="Run a brief"
                  accent
                  disabled={!preflight.ok && !preflight.loading}
                />
              </>
            }
          >
            <ul>
              {sortedBriefs.slice(0, 20).map(b => {
                const active = activeBriefId === b.id;
                const pinned = pinnedBriefs.includes(b.id);
                const status = runById.get(b.agent_run_id)?.status;
                const StatusIcon = status ? STATUS_ICON[status] : FileText;
                const statusClass = status ? STATUS_COLOR[status] : 'text-mc-text-secondary';
                return (
                  <li key={b.id} className="group">
                    <div className={`mx-2 rounded-sm flex items-center ${
                      active ? 'bg-mc-accent/15' : 'hover:bg-mc-bg-tertiary'
                    }`}>
                      <Link
                        href={`/research/briefs/${b.id}`}
                        className={`flex-1 px-2 py-1.5 flex items-center gap-2 text-sm min-w-0 ${
                          active ? 'text-mc-accent' : 'text-mc-text-secondary hover:text-mc-text'
                        }`}
                        title={b.title}
                      >
                        {pinned && <Pin className="w-3 h-3 shrink-0 text-mc-accent fill-mc-accent" />}
                        <StatusIcon className={`w-3.5 h-3.5 shrink-0 ${statusClass}`} />
                        <span className="truncate">{b.title}</span>
                      </Link>
                      <PinToggle
                        pinned={pinned}
                        onClick={() => togglePinBrief(b.id)}
                        kind="brief"
                      />
                    </div>
                  </li>
                );
              })}
              {briefs.length === 0 && (
                <li className="px-3 py-2 text-xs text-mc-text-secondary/60 italic">No briefs yet.</li>
              )}
            </ul>
          </CollapsibleSection>
        </div>

        {/* Resize handle on the right edge */}
        <div
          onMouseDown={onDragStart}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize rail"
          title="Drag to resize"
          className="absolute top-0 right-0 w-1 h-full cursor-col-resize hover:bg-mc-accent/50 transition-colors"
        />
      </aside>
      {drawers}
    </>
  );
}

function CollapsibleSection({
  label,
  open,
  onToggle,
  count,
  actions,
  children,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
  count: number;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="mt-3">
      <div className="px-3 pb-1 flex items-center justify-between">
        <button
          type="button"
          onClick={onToggle}
          className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-mc-text-secondary/70 hover:text-mc-text"
          aria-expanded={open}
        >
          <ChevronDown className={`w-3 h-3 transition-transform ${open ? '' : '-rotate-90'}`} />
          {label}
          {count > 0 && <span className="text-mc-text-secondary/50">({count})</span>}
        </button>
        {actions && <div className="flex items-center gap-0.5">{actions}</div>}
      </div>
      {open && children}
    </div>
  );
}

function PinToggle({
  pinned,
  onClick,
  kind,
}: {
  pinned: boolean;
  onClick: () => void;
  kind: 'topic' | 'brief';
}) {
  return (
    <button
      type="button"
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); onClick(); }}
      className={`p-1 mr-1 rounded-sm shrink-0 ${
        pinned
          ? 'text-mc-accent hover:bg-mc-bg-tertiary'
          : 'text-mc-text-secondary/0 group-hover:text-mc-text-secondary/70 hover:text-mc-accent hover:bg-mc-bg-tertiary'
      }`}
      title={pinned ? `Unpin ${kind}` : `Pin ${kind} to top`}
      aria-label={pinned ? `Unpin ${kind}` : `Pin ${kind} to top`}
    >
      {pinned ? <PinOff className="w-3 h-3" /> : <Pin className="w-3 h-3" />}
    </button>
  );
}

function RailIconButton({
  icon: Icon,
  onClick,
  title,
  accent,
  disabled,
  ...rest
}: {
  icon: React.ComponentType<{ className?: string }>;
  onClick: () => void;
  title: string;
  accent?: boolean;
  disabled?: boolean;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      disabled={disabled}
      className={`p-1 rounded-sm hover:bg-mc-bg-tertiary disabled:opacity-40 disabled:cursor-not-allowed ${
        accent ? 'text-mc-accent' : 'text-mc-text-secondary hover:text-mc-accent'
      }`}
      {...rest}
    >
      <Icon className="w-4 h-4" />
    </button>
  );
}

function matchPath(pathname: string, re: RegExp): string | null {
  const m = re.exec(pathname);
  return m ? m[1] : null;
}
