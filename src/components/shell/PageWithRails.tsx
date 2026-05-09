'use client';

/**
 * PageWithRails — three-column page shell.
 *
 * Why this exists: most detail / settings / activity pages were locked at
 * `max-w-3xl` and left huge dead bands on either side at typical desktop
 * widths. Stretching the form column to `max-w-7xl` doesn't fix that —
 * it just wraps long text awkwardly. The right answer is to put real
 * content in the side bands: section nav, a live preview, related items,
 * a sibling outline.
 *
 * The primitive itself is opaque about what goes in the rails — the page
 * author renders whatever fits the page (a section anchor nav, a markdown
 * preview, a master-detail list, etc). The shell just handles layout,
 * stickiness, and graceful collapse on narrow viewports.
 *
 * Layout rules:
 *  - On `lg+` (≥1024px) the page is a 3-column flex row inside a
 *    `max-w-screen-2xl` outer container so on huge monitors there's still
 *    breathing room.
 *  - Left rail (`w-64`) and right rail (default `w-[28rem]`) are sticky
 *    to the top of the viewport so they remain in view as the main column
 *    scrolls.
 *  - Below `lg` the rails stack: left rail collapses into a `<details>`
 *    jumplist above main, right rail drops below main labeled by its
 *    `rightRailTitle`.
 *  - The main column is `flex-1 min-w-0` so it absorbs free space; an
 *    optional `mainMaxWidth` caps it so prose-style pages don't grow
 *    line-length past readable.
 *
 * Pages without a useful left rail can omit it; same for the right rail.
 * If both rails are omitted the result is just a centered single column
 * — same shape the page had before, with consistent outer padding.
 */

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { clsx } from 'clsx';

interface PageWithRailsProps {
  /** Sticky page header strip — breadcrumb, title, primary action. Optional. */
  header?: ReactNode;
  /** Left rail content (typically section anchor nav or a sibling outline). */
  leftRail?: ReactNode;
  /** Right rail content (typically live preview, related items, or activity). */
  rightRail?: ReactNode;
  /** Label for the right rail when collapsed below main on narrow viewports. */
  rightRailTitle?: string;
  /** Cap the main column's width so prose stays readable. Defaults to `max-w-4xl`. */
  mainMaxWidth?: string;
  /** Left rail width on `lg+`. Defaults to `w-64` (~256px). Pages with a
   *  tree / list as their left rail typically want `w-80` or `w-96`. */
  leftRailWidth?: string;
  /** Right rail width on `lg+`. Defaults to `w-[28rem]` (~448px). */
  rightRailWidth?: string;
  /** Outer container max-width (Tailwind class). Defaults to
   *  `max-w-screen-2xl` (centered on huge monitors). Pass `null` for
   *  edge-to-edge layouts where the left rail should pin flush to the
   *  AppNav with no horizontal centering. */
  outerMaxWidth?: string | null;
  /** Outer horizontal padding. Defaults to `px-4 sm:px-6`. Edge-to-edge
   *  pages typically want `px-0` so the left rail starts at viewport x=0
   *  (right after the AppNav). */
  outerPaddingX?: string;
  /** Make the left rail user-resizable via a drag handle on its right
   *  edge. Width is persisted to localStorage under
   *  `leftRailStorageKey` (required when this is on so per-page widths
   *  don't collide). Initial width comes from `leftRailWidth` if no
   *  saved value exists; min/max clamps below. */
  resizableLeftRail?: boolean;
  /** localStorage key used to persist the dragged left-rail width. */
  leftRailStorageKey?: string;
  /** Minimum left-rail width in pixels when resizable. Default 240. */
  leftRailMinWidth?: number;
  /** Maximum left-rail width in pixels when resizable. Default 720. */
  leftRailMaxWidth?: number;
  /** When true, the left rail can be collapsed to a thin icon column
   *  via a chevron toggle at its top edge. Mirrors the research-rail
   *  pattern. Collapsed state persists at
   *  `${leftRailStorageKey}.collapsed` when a storage key is provided.
   *  Default false. */
  collapsibleLeftRail?: boolean;
  /** Breakpoint above which the right rail renders side-by-side; below
   *  it the rail stacks under main with a labeled section header (the
   *  same `<details>`-style fallback used for the left rail).
   *  Default 'lg' — pages with a wide right rail or narrow main column
   *  can pass 'xl' / '2xl' to defer the 3-col layout until the viewport
   *  has the room for it. */
  rightRailMinViewport?: 'lg' | 'xl' | '2xl';
  children: ReactNode;
}

const RIGHT_RAIL_VISIBLE_CLASS: Record<NonNullable<PageWithRailsProps['rightRailMinViewport']>, string> = {
  lg: 'hidden lg:block',
  xl: 'hidden xl:block',
  '2xl': 'hidden 2xl:block',
};

const RIGHT_RAIL_STACK_CLASS: Record<NonNullable<PageWithRailsProps['rightRailMinViewport']>, string> = {
  lg: 'lg:hidden',
  xl: 'xl:hidden',
  '2xl': '2xl:hidden',
};

export function PageWithRails({
  header,
  leftRail,
  rightRail,
  rightRailTitle = 'Preview',
  mainMaxWidth = 'max-w-4xl',
  leftRailWidth = 'w-64',
  rightRailWidth = 'w-[28rem]',
  outerMaxWidth = 'max-w-screen-2xl',
  outerPaddingX = 'px-4 sm:px-6',
  resizableLeftRail = false,
  leftRailStorageKey,
  leftRailMinWidth = 240,
  leftRailMaxWidth = 720,
  collapsibleLeftRail = false,
  rightRailMinViewport = 'lg',
  children,
}: PageWithRailsProps) {
  const COLLAPSED_KEY = leftRailStorageKey ? `${leftRailStorageKey}.collapsed` : null;
  const [leftRailCollapsed, setLeftRailCollapsed] = useState(false);
  useEffect(() => {
    if (!collapsibleLeftRail || !COLLAPSED_KEY) return;
    try {
      setLeftRailCollapsed(window.localStorage.getItem(COLLAPSED_KEY) === '1');
    } catch { /* ignore */ }
  }, [collapsibleLeftRail, COLLAPSED_KEY]);
  const toggleLeftRailCollapsed = useCallback(() => {
    setLeftRailCollapsed(c => {
      const next = !c;
      if (COLLAPSED_KEY) {
        try { window.localStorage.setItem(COLLAPSED_KEY, next ? '1' : '0'); } catch { /* ignore */ }
      }
      return next;
    });
  }, [COLLAPSED_KEY]);
  // Drag-resizable rail width. Off → null (rail uses leftRailWidth
  // tailwind class). On → state-driven inline pixel width persisted to
  // localStorage so the operator's preferred rail size sticks. We
  // restore from storage in an effect (not initial state) to avoid
  // SSR/CSR hydration mismatch on the inline style.
  const [resizedWidth, setResizedWidth] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    if (!resizableLeftRail || !leftRailStorageKey) return;
    try {
      const raw = window.localStorage.getItem(leftRailStorageKey);
      if (!raw) return;
      const n = parseInt(raw, 10);
      if (Number.isFinite(n)) {
        setResizedWidth(Math.max(leftRailMinWidth, Math.min(leftRailMaxWidth, n)));
      }
    } catch {
      /* private mode — ignore */
    }
  }, [resizableLeftRail, leftRailStorageKey, leftRailMinWidth, leftRailMaxWidth]);

  const startDrag = useCallback(
    (startEvent: React.PointerEvent<HTMLDivElement>) => {
      if (!resizableLeftRail) return;
      startEvent.preventDefault();
      const railEl = (startEvent.currentTarget.previousElementSibling as HTMLElement) ?? null;
      const startX = startEvent.clientX;
      const startWidth = railEl?.getBoundingClientRect().width ?? leftRailMinWidth;
      setDragging(true);
      const onMove = (e: PointerEvent) => {
        const next = Math.max(
          leftRailMinWidth,
          Math.min(leftRailMaxWidth, startWidth + (e.clientX - startX)),
        );
        setResizedWidth(next);
      };
      const onUp = (e: PointerEvent) => {
        setDragging(false);
        const next = Math.max(
          leftRailMinWidth,
          Math.min(leftRailMaxWidth, startWidth + (e.clientX - startX)),
        );
        if (leftRailStorageKey) {
          try {
            window.localStorage.setItem(leftRailStorageKey, String(Math.round(next)));
          } catch {
            /* ignore */
          }
        }
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    },
    [resizableLeftRail, leftRailStorageKey, leftRailMinWidth, leftRailMaxWidth],
  );

  return (
    <div className="min-h-screen bg-mc-bg text-mc-text flex flex-col">
      {header && (
        <div className="sticky top-0 z-20 bg-mc-bg/95 backdrop-blur-sm border-b border-mc-border/60">
          <div className={clsx(outerMaxWidth, outerMaxWidth && 'mx-auto', outerPaddingX, 'py-3')}>
            {header}
          </div>
        </div>
      )}

      <div className={clsx('flex-1 w-full', outerMaxWidth, outerMaxWidth && 'mx-auto', outerPaddingX, 'py-6')}>
        <div className="flex gap-6 items-start">
          {leftRail && (
            <>
              <aside
                className={clsx(
                  'hidden lg:block shrink-0',
                  // When collapsed, override the configured width with
                  // a thin chevron-only column. Otherwise fall back to
                  // the tailwind class (resizable mode replaces this
                  // via inline style once dragged).
                  leftRailCollapsed ? 'w-12' : leftRailWidth,
                  'sticky top-[4.5rem] self-start max-h-[calc(100vh-5.5rem)] overflow-y-auto',
                )}
                style={!leftRailCollapsed && resizableLeftRail && resizedWidth != null ? { width: resizedWidth } : undefined}
              >
                {collapsibleLeftRail && (
                  <div className={clsx(
                    'flex items-center px-1.5 py-1 border-b border-mc-border/60 mb-2',
                    leftRailCollapsed ? 'justify-center' : 'justify-end',
                  )}>
                    <button
                      type="button"
                      onClick={toggleLeftRailCollapsed}
                      className="p-1 rounded-sm text-mc-text-secondary hover:text-mc-text hover:bg-mc-bg-tertiary"
                      title={leftRailCollapsed ? 'Expand sections' : 'Collapse sections'}
                      aria-label={leftRailCollapsed ? 'Expand sections' : 'Collapse sections'}
                      aria-expanded={!leftRailCollapsed}
                    >
                      {leftRailCollapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
                    </button>
                  </div>
                )}
                {!leftRailCollapsed && leftRail}
              </aside>
              {resizableLeftRail && !leftRailCollapsed && (
                <div
                  onPointerDown={startDrag}
                  role="separator"
                  aria-orientation="vertical"
                  aria-label="Resize left rail"
                  title="Drag to resize"
                  className={clsx(
                    'hidden lg:block shrink-0 w-1 -mx-1.5 cursor-col-resize',
                    'sticky top-[4.5rem] self-stretch z-10',
                    'before:absolute before:inset-y-0 before:left-1/2 before:-translate-x-1/2 before:w-px before:bg-mc-border before:hover:bg-mc-accent/60',
                    dragging && 'before:bg-mc-accent',
                  )}
                />
              )}
            </>
          )}

          <main className={clsx('flex-1 min-w-0', mainMaxWidth, 'mx-auto lg:mx-0')}>
            {leftRail && (
              // Below the lg breakpoint the dedicated left aside is
              // hidden; this <details> is the fallback nav. Pin it to
              // the top of the viewport (just under the page header at
              // top-0 / z-20) so the operator can collapse/expand the
              // tree-controls panel without scrolling back up. Solid
              // background — translucent + backdrop-blur let scrolling
              // content read THROUGH the toggle, which the operator
              // (correctly) called out as visually weird.
              <details className="lg:hidden mb-4 rounded-lg border border-mc-border/60 bg-mc-bg-secondary sticky top-[4.5rem] z-10">
                <summary className="px-3 py-2 text-xs uppercase tracking-wide text-mc-text-secondary cursor-pointer">
                  Sections
                </summary>
                <div className="p-3 border-t border-mc-border/60 max-h-[calc(100vh-9rem)] overflow-y-auto">
                  {leftRail}
                </div>
              </details>
            )}
            {children}
            {rightRail && (
              <section className={clsx(
                RIGHT_RAIL_STACK_CLASS[rightRailMinViewport],
                'mt-6 rounded-lg border border-mc-border/60 bg-mc-bg-secondary',
              )}>
                <header className="px-4 py-2 border-b border-mc-border/60">
                  <h2 className="text-xs uppercase tracking-wide text-mc-text-secondary">
                    {rightRailTitle}
                  </h2>
                </header>
                <div className="p-4">{rightRail}</div>
              </section>
            )}
          </main>

          {rightRail && (
            <aside
              className={clsx(
                RIGHT_RAIL_VISIBLE_CLASS[rightRailMinViewport],
                'shrink-0',
                rightRailWidth,
                'sticky top-[4.5rem] self-start max-h-[calc(100vh-5.5rem)] overflow-y-auto',
              )}
            >
              {rightRail}
            </aside>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Convenience: section anchor nav for the left rail. Pass an array of
 * `{ id, label }` matching the `id` of each `<Section>` on the page.
 * Click jumps; the active section is tracked via IntersectionObserver.
 */
export function SectionNav({
  sections,
}: {
  sections: Array<{ id: string; label: string }>;
}) {
  return (
    <nav className="text-sm">
      <div className="text-[10px] uppercase tracking-wide text-mc-text-secondary/70 mb-2 px-2">
        On this page
      </div>
      <ul className="space-y-0.5">
        {sections.map(s => (
          <li key={s.id}>
            <a
              href={`#${s.id}`}
              className="block px-2 py-1.5 rounded text-mc-text-secondary hover:text-mc-text hover:bg-mc-bg-secondary transition-colors"
            >
              {s.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
