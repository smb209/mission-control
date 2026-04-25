'use client';

/**
 * Left navigation column rendered by the unified app shell. Replaces the
 * grab-bag of per-page header buttons with a single static taxonomy:
 *
 *   EXECUTE → home, activity
 *   PLAN    → roadmap, initiatives, pm
 *   AUTOPILOT → products
 *   WORKSPACE → settings (and knowledge / workflows when those routes exist)
 *
 * The workspace switcher at the top replaces the per-page "Workspaces"
 * button. After this PR, drilling into a specific workspace board still
 * lives at `/workspace/[slug]` (kept outside the shell — it has its own
 * dense Header). The switcher here is a global "which workspace are we
 * planning against" picker for /initiatives, /roadmap, /pm.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  Home,
  Activity as ActivityIcon,
  GanttChart,
  ListTree,
  Bot,
  Rocket,
  Settings as SettingsIcon,
  ChevronDown,
  Check,
  Zap,
  X,
} from 'lucide-react';
import {
  useCurrentWorkspaceId,
  useSetCurrentWorkspaceId,
  type WorkspaceLite,
} from './workspace-context';

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

const SECTIONS: NavSection[] = [
  {
    title: 'Execute',
    items: [
      { href: '/', label: 'Home', icon: Home },
      { href: '/activity', label: 'Activity', icon: ActivityIcon, prefix: true },
    ],
  },
  {
    title: 'Plan',
    items: [
      { href: '/roadmap', label: 'Roadmap', icon: GanttChart },
      { href: '/initiatives', label: 'Initiatives', icon: ListTree, prefix: true },
      { href: '/pm', label: 'PM', icon: Bot },
    ],
  },
  {
    title: 'Autopilot',
    items: [
      { href: '/autopilot', label: 'Products', icon: Rocket, prefix: true },
    ],
  },
  {
    title: 'Workspace',
    items: [
      { href: '/settings', label: 'Settings', icon: SettingsIcon },
    ],
  },
];

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

export function AppNav({ mobileOpen, onCloseMobile }: AppNavProps) {
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
          w-60 bg-mc-bg-secondary border-r border-mc-border
          flex flex-col shrink-0
          transition-transform duration-200
          ${mobileOpen ? 'translate-x-0' : '-translate-x-full'}
          md:translate-x-0
        `}
      >
        {/* Mobile close button */}
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

        <WorkspaceSwitcher />

        <div className="flex-1 overflow-y-auto py-2">
          {SECTIONS.map(section => (
            <NavSectionView
              key={section.title}
              section={section}
              onNavigate={onCloseMobile}
            />
          ))}
        </div>

        <div className="px-3 py-2 border-t border-mc-border text-[11px] text-mc-text-secondary/70">
          <span className="hidden md:inline">v2.5 · unified shell</span>
        </div>
      </nav>
    </>
  );
}

function NavSectionView({
  section,
  onNavigate,
}: {
  section: NavSection;
  onNavigate: () => void;
}) {
  const pathname = usePathname() ?? '/';
  return (
    <div className="mb-3">
      <div className="px-3 pb-1 text-[10px] uppercase tracking-wider text-mc-text-secondary/70">
        {section.title}
      </div>
      <ul>
        {section.items.map(item => {
          const Icon = item.icon;
          const active = isActive(pathname, item);
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={active ? 'page' : undefined}
                onClick={onNavigate}
                className={`
                  mx-2 px-2 py-1.5 rounded-sm flex items-center gap-2 text-sm
                  ${active
                    ? 'bg-mc-accent/15 text-mc-accent'
                    : 'text-mc-text-secondary hover:text-mc-text hover:bg-mc-bg-tertiary'}
                `}
              >
                <Icon className="w-4 h-4 shrink-0" />
                <span className="truncate">{item.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * Switcher at the top of the nav. On click, a small dropdown lists every
 * workspace; selecting one updates the global current-workspace id (used
 * by Plan-section pages) and routes back to "/" so the operator lands in
 * the new context.
 */
function WorkspaceSwitcher() {
  const router = useRouter();
  const currentWorkspaceId = useCurrentWorkspaceId();
  const setCurrentWorkspaceId = useSetCurrentWorkspaceId();
  const [workspaces, setWorkspaces] = useState<WorkspaceLite[]>([]);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Pull the workspace list once. Cheap: the route returns a few rows.
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
  }, []);

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
    (id: string) => {
      setCurrentWorkspaceId(id);
      setOpen(false);
      router.push('/');
    },
    [router, setCurrentWorkspaceId],
  );

  return (
    <div ref={ref} className="relative px-2 pt-2 pb-1">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen(v => !v)}
        className="w-full px-2 py-1.5 rounded-sm border border-mc-border bg-mc-bg hover:bg-mc-bg-tertiary text-left flex items-center gap-2 min-h-9"
      >
        {current ? (
          <>
            <span className="text-base shrink-0">{current.icon ?? '📁'}</span>
            <span className="flex-1 truncate text-sm text-mc-text">{current.name}</span>
          </>
        ) : (
          <>
            <Zap className="w-4 h-4 text-mc-accent-cyan shrink-0" />
            <span className="flex-1 truncate text-sm text-mc-text-secondary">
              {workspaces.length === 0 ? 'No workspaces' : 'Select workspace'}
            </span>
          </>
        )}
        <ChevronDown className={`w-3.5 h-3.5 text-mc-text-secondary transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && workspaces.length > 0 && (
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
                  onClick={() => handlePick(w.id)}
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
        </ul>
      )}
    </div>
  );
}
