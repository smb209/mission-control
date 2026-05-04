'use client';

/**
 * Left navigation column rendered by the unified app shell. Replaces the
 * grab-bag of per-page header buttons with a single static taxonomy:
 *
 *   PROJECT   → pm, initiatives, roadmap, task board
 *   AUTOPILOT → products
 *   WORKSPACE → activity, agents, settings, debug
 *
 * EXECUTE / PLAN used to be separate sections; consolidated into
 * PROJECT because they share an operator mental model (planning →
 * shipping the same project). Activity + Agents moved into WORKSPACE
 * because they're workspace-scoped views/configuration, not project-
 * scoped action surfaces.
 *
 * The workspace switcher at the top is the single source of "which
 * workspace are we operating against?" — selecting one routes to that
 * workspace's task board (`/workspace/[slug]`).
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  Activity as ActivityIcon,
  GanttChart,
  ListTree,
  Bot,
  Rocket,
  Settings as SettingsIcon,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Check,
  Zap,
  X,
  Plus,
  KanbanSquare,
  Bug,
  Users,
  Package,
  History,
  Search,
  ShieldAlert,
  Calendar as CalendarIcon,
  Megaphone,
  Lightbulb,
  Brain,
  Workflow,
  AlertCircle,
} from 'lucide-react';
import {
  useCurrentWorkspaceId,
  useSetCurrentWorkspaceId,
  type WorkspaceLite,
} from './workspace-context';
import { useResearchPreflight } from '@/components/research/useResearchPreflight';
import { CreateWorkspaceDrawer } from './CreateWorkspaceDrawer';
import type { Workspace } from '@/lib/types';

interface NavItem {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  /**
   * If `true`, treat the route as active when the pathname starts with `href`
   * (so /initiatives/abc highlights "Initiatives"). Plain "/" only matches
   * an exact pathname.
   */
  prefix?: boolean;
}

interface NavSection {
  title: string;
  items: NavItem[];
}

function buildSections(taskBoardHref: string, workspaceSettingsHref: string): NavSection[] {
  return [
    {
      title: 'Project',
      items: [
        // Order is project-lifecycle: ideate (PM) → plan (Initiatives) →
        // schedule (Roadmap) → ship (Task Board) → ship-output
        // (Deliverables). Deliverables used to live in the right rail
        // of the workspace task board where it competed for vertical
        // space; promoted to its own page so it stays reachable on
        // small viewports too.
        { href: '/pm', label: 'PM', icon: Bot },
        { href: '/pm/activity', label: 'PM activity', icon: History },
        { href: '/initiatives', label: 'Initiatives', icon: ListTree, prefix: true },
        { href: '/roadmap', label: 'Roadmap', icon: GanttChart },
        { href: taskBoardHref, label: 'Task Board', icon: KanbanSquare, prefix: taskBoardHref !== '/' },
        { href: '/deliverables', label: 'Deliverables', icon: Package, prefix: true },
      ],
    },
    {
      title: 'Autopilot',
      items: [
        { href: '/autopilot', label: 'Products', icon: Rocket, prefix: true },
        { href: '/workflows', label: 'Workflows', icon: Workflow, prefix: true },
      ],
    },
    {
      // Knowledge: long-lived artifacts the project produces and reasons
      // over. All entries currently render a spec markdown file from
      // `specs/` — replace with real surfaces as each feature lands.
      title: 'Knowledge',
      items: [
        { href: '/research', label: 'Research', icon: Search, prefix: true },
        { href: '/risks', label: 'Risks', icon: ShieldAlert, prefix: true },
        { href: '/calendar', label: 'Calendar', icon: CalendarIcon, prefix: true },
        { href: '/stakeholders', label: 'Stakeholders', icon: Megaphone, prefix: true },
        { href: '/decisions', label: 'Decisions', icon: Lightbulb, prefix: true },
        { href: '/memory', label: 'Memory', icon: Brain, prefix: true },
      ],
    },
    {
      title: 'Workspace',
      items: [
        // Workspace-scoped views + configuration. Activity used to be
        // a top-level "EXECUTE" entry that landed on a workspace
        // picker; it now redirects to the current workspace's activity
        // dashboard so this entry skips the extra click. Agents are
        // workspace-scoped configuration, so they belong here too.
        { href: '/activity', label: 'Activity', icon: ActivityIcon, prefix: true },
        { href: '/agents', label: 'Agents', icon: Users, prefix: true },
        // Settings here is scoped to the current workspace
        // (/workspace/<slug>/settings). Global / cross-workspace
        // settings (API URL, default paths, backups, environment)
        // live behind the gear icon in the top bar at /settings.
        { href: workspaceSettingsHref, label: 'Settings', icon: SettingsIcon, prefix: workspaceSettingsHref !== '/settings' },
        { href: '/debug', label: 'Debug', icon: Bug, prefix: true },
      ],
    },
  ];
}

function isActive(pathname: string, item: NavItem): boolean {
  if (item.href === '/') return pathname === '/';
  if (item.prefix) return pathname === item.href || pathname.startsWith(item.href + '/');
  return pathname === item.href;
}

interface AppNavProps {
  /** Mobile drawer open state — desktop nav ignores this. */
  mobileOpen: boolean;
  onCloseMobile: () => void;
}

const DESKTOP_COLLAPSED_KEY = 'mc.appnav.collapsed';
const SECTIONS_OPEN_KEY = 'mc.appnav.sections';

export function AppNav({ mobileOpen, onCloseMobile }: AppNavProps) {
  const [workspaces, setWorkspaces] = useState<WorkspaceLite[]>([]);
  const [refreshKey, setRefreshKey] = useState(0);
  const [collapsed, setCollapsed] = useState(false);
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({});
  const currentWorkspaceId = useCurrentWorkspaceId();

  // Restore the desktop collapse preference. Mobile drawer is a
  // separate axis (full-width overlay) — ignored here.
  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem(DESKTOP_COLLAPSED_KEY) === '1');
      const raw = localStorage.getItem(SECTIONS_OPEN_KEY);
      if (raw) setOpenSections(JSON.parse(raw) as Record<string, boolean>);
    } catch { /* ignore */ }
  }, []);

  const toggleCollapsed = useCallback(() => {
    setCollapsed(c => {
      const next = !c;
      try { localStorage.setItem(DESKTOP_COLLAPSED_KEY, next ? '1' : '0'); } catch { /* ignore */ }
      return next;
    });
  }, []);

  const toggleSection = useCallback((title: string) => {
    setOpenSections(prev => {
      // Default-open: a section is open unless explicitly stored
      // false. Toggle flips that.
      const currentlyOpen = prev[title] !== false;
      const next = { ...prev, [title]: !currentlyOpen };
      try { localStorage.setItem(SECTIONS_OPEN_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }, []);

  // Fetch workspaces in the parent so we can derive the active task-board
  // href and pass the same list to the switcher.
  useEffect(() => {
    let cancelled = false;
    fetch('/api/workspaces')
      .then(r => (r.ok ? r.json() : []))
      .then((rows: WorkspaceLite[]) => {
        if (cancelled || !Array.isArray(rows)) return;
        setWorkspaces(rows);
      })
      .catch(() => { /* ignore — switcher just stays empty */ });
    return () => { cancelled = true; };
  }, [refreshKey]);

  const activeWorkspace =
    workspaces.find(w => w.id === currentWorkspaceId) ?? workspaces[0];
  const taskBoardHref = activeWorkspace ? `/workspace/${activeWorkspace.slug}` : '/';
  // When no workspace is selected yet (e.g. zero workspaces), fall
  // back to the global settings page — it's the closest meaningful
  // surface and avoids dead nav links during onboarding.
  const workspaceSettingsHref = activeWorkspace
    ? `/workspace/${activeWorkspace.slug}/settings`
    : '/settings';
  const sections = buildSections(taskBoardHref, workspaceSettingsHref);

  return (
    <>
      {/* Mobile drawer overlay */}
      {mobileOpen && (
        <button
          type="button"
          aria-label="Close navigation"
          className="md:hidden fixed inset-0 bg-black/60 z-30"
          onClick={onCloseMobile}
        />
      )}

      <nav
        aria-label="Primary"
        className={`
          fixed md:static z-40 inset-y-0 left-0
          bg-mc-bg-secondary border-r border-mc-border
          flex flex-col shrink-0
          transition-transform duration-200
          ${mobileOpen ? 'translate-x-0 w-60' : '-translate-x-full w-60'}
          md:translate-x-0 ${collapsed ? 'md:w-12' : 'md:w-60'}
        `}
      >
        {/* Mobile close button (mobile drawer always shows full width) */}
        <div className="md:hidden flex items-center justify-between px-3 py-2 border-b border-mc-border">
          <span className="flex items-center gap-2 text-sm font-semibold text-mc-text">
            <Zap className="w-4 h-4 text-mc-accent-cyan" />
            Mission Control
          </span>
          <button
            type="button"
            aria-label="Close navigation"
            onClick={onCloseMobile}
            className="p-1.5 rounded hover:bg-mc-bg-tertiary text-mc-text-secondary"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Desktop header: brand + collapse toggle. Sits at the top
            so the chevron is reachable in both states without
            scrolling, and brand fills what would otherwise be dead
            space when expanded. */}
        <div className={`hidden md:flex items-center px-2 py-1 border-b border-mc-border ${
          collapsed ? 'justify-center' : 'justify-between'
        }`}>
          {!collapsed && (
            <span className="flex items-center gap-1.5 text-sm font-semibold text-mc-text min-w-0">
              <Zap className="w-4 h-4 text-mc-accent-cyan shrink-0" />
              <span className="truncate">Mission Control</span>
            </span>
          )}
          <button
            type="button"
            onClick={toggleCollapsed}
            className="p-1 rounded-sm text-mc-text-secondary hover:text-mc-text hover:bg-mc-bg-tertiary shrink-0"
            title={collapsed ? 'Expand navigation' : 'Collapse navigation'}
            aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'}
          >
            {collapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
          </button>
        </div>

        <WorkspaceSwitcher
          workspaces={workspaces}
          onWorkspaceCreated={() => setRefreshKey(k => k + 1)}
          collapsed={collapsed}
        />

        <div className="flex-1 overflow-y-auto py-2">
          {sections.map(section => (
            <NavSectionView
              key={section.title}
              section={section}
              onNavigate={onCloseMobile}
              collapsed={collapsed}
              open={openSections[section.title] !== false}
              onToggleOpen={() => toggleSection(section.title)}
            />
          ))}
        </div>

        <div className="px-3 py-2 border-t border-mc-border text-[11px] text-mc-text-secondary/70">
          {!collapsed && <span className="hidden md:inline">v2.6 · unified shell</span>}
        </div>
      </nav>
    </>
  );
}

function NavSectionView({
  section,
  onNavigate,
  collapsed,
  open,
  onToggleOpen,
}: {
  section: NavSection;
  onNavigate: () => void;
  collapsed: boolean;
  open: boolean;
  onToggleOpen: () => void;
}) {
  const pathname = usePathname() ?? '/';
  // `collapsed` is a desktop-only preference. On mobile the nav
  // renders as a full-width drawer regardless, so labels must stay
  // visible there. We gate label hiding behind `md:` so the drawer
  // is unaffected.
  //
  // Mobile drawer + desktop-expanded: items follow `open`.
  // Desktop-collapsed (icons-only): the header is hidden, so we
  // ignore `open` and keep the icons visible — otherwise the user
  // would have no way to re-expand the section.
  const ulClass =
    open ? ''
    : collapsed ? 'hidden md:block'
    : 'hidden';
  return (
    <div className="mb-3">
      <button
        type="button"
        onClick={onToggleOpen}
        aria-expanded={open}
        className={`w-full px-3 pb-1 flex items-center gap-1 text-[10px] uppercase tracking-wider text-mc-text-secondary/70 hover:text-mc-text ${
          collapsed ? 'md:hidden' : ''
        }`}
      >
        <ChevronDown className={`w-3 h-3 transition-transform ${open ? '' : '-rotate-90'}`} />
        <span className="flex-1 text-left">{section.title}</span>
      </button>
      <ul className={ulClass}>
        {section.items.map(item => {
          const Icon = item.icon;
          const active = isActive(pathname, item);
          return (
            <li key={`${section.title}:${item.label}`}>
              <Link
                href={item.href}
                aria-current={active ? 'page' : undefined}
                onClick={onNavigate}
                title={collapsed ? item.label : undefined}
                className={`
                  ${collapsed ? 'mx-2 md:mx-1 md:justify-center' : 'mx-2'}
                  px-2 py-1.5 rounded-sm flex items-center gap-2 text-sm
                  ${active
                    ? 'bg-mc-accent/15 text-mc-accent'
                    : 'text-mc-text-secondary hover:text-mc-text hover:bg-mc-bg-tertiary'}
                `}
              >
                <Icon className="w-4 h-4 shrink-0" />
                <span className={`truncate flex-1 ${collapsed ? 'md:hidden' : ''}`}>{item.label}</span>
                {item.href === '/research' && (
                  <span className={collapsed ? 'md:hidden' : ''}>
                    <ResearchPreflightDot />
                  </span>
                )}
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * Renders a small amber AlertCircle to the right of the Research nav
 * label when the current workspace can't dispatch briefs (no
 * researcher in roster, or no runner registered). Silent when
 * everything's healthy so the nav stays quiet.
 *
 * Lives in AppNav rather than the page so the indicator is visible
 * even when the operator is on another route — the whole point of
 * surfacing it on the nav is "you don't have to be on /research to
 * notice."
 */
function ResearchPreflightDot() {
  const workspaceId = useCurrentWorkspaceId();
  const preflight = useResearchPreflight(workspaceId);
  if (preflight.loading || preflight.ok) return null;
  const reason = !preflight.hasResearcher
    ? 'No researcher in this workspace — add one in Agents'
    : !preflight.hasRunner
      ? 'No runner agent registered'
      : 'Openclaw gateway is reconnecting';
  return (
    <span title={reason} aria-label={reason} className="ml-1 shrink-0">
      <AlertCircle className="w-3.5 h-3.5 text-amber-400" />
    </span>
  );
}

/**
 * Switcher at the top of the nav. On click, a small dropdown lists every
 * workspace; selecting one updates the global current-workspace id and
 * routes to that workspace's task board. A "+ New Workspace" entry at
 * the bottom opens the create drawer.
 */
function WorkspaceSwitcher({
  workspaces,
  onWorkspaceCreated,
  collapsed,
}: {
  workspaces: WorkspaceLite[];
  onWorkspaceCreated: () => void;
  collapsed: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const currentWorkspaceId = useCurrentWorkspaceId();
  const setCurrentWorkspaceId = useSetCurrentWorkspaceId();
  const [open, setOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close the dropdown when clicking outside.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  const current = workspaces.find(w => w.id === currentWorkspaceId)
    ?? workspaces[0]
    ?? null;

  const handlePick = useCallback(
    (w: WorkspaceLite) => {
      setCurrentWorkspaceId(w.id);
      setOpen(false);
      // Slug-scoped routes (/workspace/[slug]/*) need the slug segment
      // rewritten so the page refetches against the new workspace.
      // Context-scoped routes (/initiatives, /roadmap, /pm, etc.) read
      // workspace from the localStorage-backed context and refetch via
      // the useCurrentWorkspaceId hook — no navigation needed.
      const m = pathname?.match(/^\/workspace\/[^/]+(\/.*)?$/);
      if (m) {
        const tail = m[1] ?? '';
        router.push(`/workspace/${w.slug}${tail}`);
      }
    },
    [router, setCurrentWorkspaceId, pathname],
  );

  const handleCreated = useCallback(
    (_w: Workspace) => {
      onWorkspaceCreated();
    },
    [onWorkspaceCreated],
  );

  return (
    <>
      <div ref={ref} className={`relative pt-2 pb-1 ${collapsed ? 'px-1 md:px-1' : 'px-2'}`}>
        <button
          type="button"
          aria-haspopup="listbox"
          aria-expanded={open}
          onClick={() => setOpen(v => !v)}
          title={collapsed ? (current?.name ?? 'Select workspace') : undefined}
          className={`w-full rounded-sm border border-mc-border bg-mc-bg hover:bg-mc-bg-tertiary text-left flex items-center gap-2 min-h-9 ${
            collapsed ? 'px-2 md:justify-center md:px-1' : 'px-2 py-1.5'
          }`}
        >
          {current ? (
            <>
              <span className="text-base shrink-0">{current.icon ?? '📁'}</span>
              <span className={`flex-1 truncate text-sm text-mc-text ${collapsed ? 'md:hidden' : ''}`}>{current.name}</span>
            </>
          ) : (
            <>
              <Zap className="w-4 h-4 text-mc-accent-cyan shrink-0" />
              <span className={`flex-1 truncate text-sm text-mc-text-secondary ${collapsed ? 'md:hidden' : ''}`}>
                {workspaces.length === 0 ? 'No workspaces' : 'Select workspace'}
              </span>
            </>
          )}
          <ChevronDown className={`w-3.5 h-3.5 text-mc-text-secondary transition-transform ${open ? 'rotate-180' : ''} ${collapsed ? 'md:hidden' : ''}`} />
        </button>
        {open && (
          <ul
            role="listbox"
            className="absolute left-2 right-2 mt-1 z-50 max-h-72 overflow-y-auto rounded-sm border border-mc-border bg-mc-bg-secondary shadow-lg"
          >
            {workspaces.map(w => {
              const selected = current?.id === w.id;
              return (
                <li key={w.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={selected}
                    onClick={() => handlePick(w)}
                    className={`w-full text-left px-2 py-1.5 flex items-center gap-2 text-sm hover:bg-mc-bg-tertiary
                      ${selected ? 'text-mc-accent' : 'text-mc-text'}`}
                  >
                    <span className="text-base shrink-0">{w.icon ?? '📁'}</span>
                    <span className="flex-1 truncate">{w.name}</span>
                    {selected && <Check className="w-3.5 h-3.5 shrink-0" />}
                  </button>
                </li>
              );
            })}
            {/* Divider + create entry */}
            <li className="border-t border-mc-border" aria-hidden="true" />
            <li>
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  setCreateOpen(true);
                }}
                className="w-full text-left px-2 py-1.5 flex items-center gap-2 text-sm text-mc-accent hover:bg-mc-bg-tertiary"
              >
                <Plus className="w-3.5 h-3.5 shrink-0" />
                <span className="flex-1 truncate">New workspace</span>
              </button>
            </li>
          </ul>
        )}
      </div>

      <CreateWorkspaceDrawer
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={handleCreated}
      />
    </>
  );
}
