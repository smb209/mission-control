'use client';

/**
 * Single source of truth for rendering a timestamp in the UI. Wraps
 * the helpers in `src/lib/timestamps.ts` and reads the workspace
 * display-timezone override from `useDisplayTimezone`.
 *
 * Use `<Time iso={row.created_at} mode="relative" />` instead of bare
 * `formatDistanceToNow(new Date(row.created_at))`. The latter has
 * shipped two zone-mismatch bugs already (#280; the LiveFeed sweep
 * in PR-B); this component closes the door on a third.
 *
 * SSR note: when there's no provider the hook falls back to
 * `Intl.DateTimeFormat().resolvedOptions().timeZone`, which is the
 * server's zone in SSR. To avoid hydration mismatch on absolute
 * timestamps, set `mode="relative"` for SSR-rendered lists or render
 * absolute timestamps client-only.
 */

import { useEffect, useState } from 'react';
import {
  formatTimestamp,
  relativeTime,
  type TimestampMode,
} from '@/lib/timestamps';
import { useDisplayTimezone } from '@/hooks/useDisplayTimezone';

export interface TimeProps {
  /** ISO-Z (or any Date-parseable) string. Nullish renders empty. */
  iso: string | null | undefined;
  /** Default 'short'. */
  mode?: TimestampMode;
  /** Optional className for the wrapping <time>. */
  className?: string;
  /** Tooltip override. Default: full absolute formatting. */
  title?: string;
  /**
   * If true, the relative text refreshes every minute. Use for
   * always-visible feeds. Default: false (re-renders only on parent
   * state changes).
   */
  live?: boolean;
}

export function Time({ iso, mode = 'short', className, title, live = false }: TimeProps) {
  const tz = useDisplayTimezone();
  const [, tick] = useState(0);

  useEffect(() => {
    if (!live || mode !== 'relative') return;
    const id = setInterval(() => tick((n) => n + 1), 60_000);
    return () => clearInterval(id);
  }, [live, mode]);

  if (!iso) return null;

  const text = mode === 'relative' ? relativeTime(iso) : formatTimestamp(iso, { tz, mode });
  const fullTitle = title ?? formatTimestamp(iso, { tz, mode: 'absolute' });

  return (
    <time className={className} dateTime={iso} title={fullTitle}>
      {text}
    </time>
  );
}
