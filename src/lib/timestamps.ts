/**
 * Timestamp formatting helpers, timezone-aware.
 *
 * Use these (or the `<Time>` component built on top) instead of bare
 * `new Date(...).toLocaleString()` calls. Reasons:
 *
 *  1. The DB layer normalizes SQLite datetimes to ISO-Z on read (PR
 *     #281), so every timestamp the app sees is a real instant. JS
 *     `new Date(iso)` parses it correctly. These helpers don't add
 *     parsing-correctness — they add **display consistency** across
 *     the app.
 *
 *  2. The operator can override the auto-detected timezone via the
 *     workspace settings page (`workspaces.display_timezone`). All
 *     formatting must respect that override. Bare
 *     `toLocaleString()` doesn't.
 *
 * See specs/timestamp-handling.md §PR-B.
 */

import { formatDistanceToNow, formatDistanceToNowStrict, parseISO } from 'date-fns';

/** Final fallback if the browser is somehow stripped of `Intl`. */
const ULTIMATE_FALLBACK_TZ = 'America/Los_Angeles';

/**
 * Resolve the timezone string to use for display. Precedence:
 *   1. The workspace-level override (if non-empty).
 *   2. The browser's auto-detected zone via Intl.
 *   3. America/Los_Angeles, as a last-resort fallback.
 *
 * Pass `null` / `undefined` for `workspaceTz` when the override isn't
 * known yet (SSR boundary, before context hydrates).
 */
export function resolveDisplayTimezone(
  workspaceTz?: string | null,
): string {
  const override = (workspaceTz ?? '').trim();
  if (override) return override;
  try {
    const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (detected) return detected;
  } catch {
    /* fall through to ultimate fallback */
  }
  return ULTIMATE_FALLBACK_TZ;
}

/**
 * Validate that a string is a usable IANA timezone identifier.
 * Returns true if the browser/runtime accepts it as a `timeZone`
 * option. Used by the workspace settings PATCH route to reject
 * garbage input before persisting it.
 */
export function isValidTimezone(tz: string): boolean {
  if (!tz || typeof tz !== 'string') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export type TimestampMode =
  /** "5 minutes ago" — relative, zone-agnostic */
  | 'relative'
  /** "May 8, 4:32 PM" — short absolute */
  | 'short'
  /** "May 8, 2026 at 4:32:07 PM PDT" — full absolute with zone */
  | 'absolute'
  /** "2026-05-08 16:32" — datetime-input-friendly */
  | 'datetime'
  /** "May 8, 2026" — date only */
  | 'date'
  /** "4:32 PM" — time only */
  | 'time';

export interface FormatOptions {
  /** Resolved IANA timezone. Use `resolveDisplayTimezone()` to get one. */
  tz?: string;
  /** Default 'short'. */
  mode?: TimestampMode;
}

/**
 * Format an ISO-Z (or any Date-parseable) timestamp string for
 * display. Returns `''` for nullish / unparseable inputs so callers
 * can render `{formatTimestamp(field)}` without conditional checks.
 */
export function formatTimestamp(
  iso: string | null | undefined,
  opts: FormatOptions = {},
): string {
  if (!iso) return '';
  const date = typeof iso === 'string' ? safeParse(iso) : null;
  if (!date) return '';

  const tz = opts.tz ?? resolveDisplayTimezone();
  const mode = opts.mode ?? 'short';

  if (mode === 'relative') {
    return relativeTime(iso);
  }

  const fmt: Intl.DateTimeFormatOptions = (() => {
    switch (mode) {
      case 'short':
        return { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };
      case 'absolute':
        return {
          year: 'numeric',
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
          second: '2-digit',
          timeZoneName: 'short',
        };
      case 'datetime':
        return {
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        };
      case 'date':
        return { year: 'numeric', month: 'short', day: 'numeric' };
      case 'time':
        return { hour: 'numeric', minute: '2-digit' };
      default:
        return { month: 'short', day: 'numeric' };
    }
  })();

  try {
    return new Intl.DateTimeFormat('en-US', { ...fmt, timeZone: tz }).format(date);
  } catch {
    // tz could be invalid (operator override that we somehow let
    // through). Retry with auto-detect; never throw out of a render.
    return new Intl.DateTimeFormat('en-US', fmt).format(date);
  }
}

/**
 * "5 minutes ago" / "in 2 hours". Wraps date-fns `formatDistanceToNow`
 * with `addSuffix:true` so past *and* future tenses come out right —
 * zone-independent because the underlying instant is what matters.
 */
export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = safeParse(iso);
  if (!d) return '';
  return formatDistanceToNow(d, { addSuffix: true });
}

/** Like `relativeTime` but without the trailing " ago" and using
 *  `Strict` (no rounding to "about"). For sites that build their own
 *  surrounding text. */
export function relativeTimeStrict(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = safeParse(iso);
  if (!d) return '';
  return formatDistanceToNowStrict(d);
}

function safeParse(iso: string): Date | null {
  // parseISO handles ISO-Z; new Date is the fallback for ad-hoc
  // formats that might still be in the wild.
  try {
    const d = parseISO(iso);
    if (!Number.isNaN(d.getTime())) return d;
  } catch {
    /* fall through */
  }
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}
