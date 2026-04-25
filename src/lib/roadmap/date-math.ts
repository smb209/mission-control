/**
 * Pure date-math helpers for the roadmap timeline (Phase 3).
 *
 * The timeline canvas maps dates to pixels along the X axis. We always
 * normalize to "day buckets" — the canvas resolution is one day. Higher
 * zoom levels (week/month/quarter) just change how many pixels-per-day
 * we render at; the math stays the same.
 *
 * All functions are pure, deterministic, and timezone-agnostic. Inputs
 * may be Date objects or ISO-8601 date strings ("YYYY-MM-DD" or full
 * ISO timestamps). Outputs are pixel offsets relative to a `windowStart`
 * anchor (also normalized to UTC midnight).
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export type ZoomLevel = 'week' | 'month' | 'quarter';

/** Pixels per day for each zoom level. Tuned for ~1280px viewports. */
export const PX_PER_DAY: Record<ZoomLevel, number> = {
  week: 32,    // 1 day = 32px → 1 week ≈ 224px
  month: 8,    // 1 day = 8px  → 1 month ≈ 240px
  quarter: 3,  // 1 day = 3px  → 1 quarter ≈ 270px
};

/**
 * Normalize a date input to a UTC-midnight Date. Accepts:
 *   - Date instances (any time)
 *   - ISO date strings "YYYY-MM-DD"
 *   - Full ISO timestamps "YYYY-MM-DDTHH:MM:SS..."
 *
 * Throws on invalid input.
 */
export function toUtcDay(input: Date | string): Date {
  let d: Date;
  if (input instanceof Date) {
    d = input;
  } else if (typeof input === 'string') {
    // Accept "YYYY-MM-DD" by appending T00:00:00Z (Date parses it as UTC).
    const isoDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(input);
    d = new Date(isoDateOnly ? `${input}T00:00:00.000Z` : input);
  } else {
    throw new Error(`Invalid date input: ${String(input)}`);
  }
  if (isNaN(d.getTime())) {
    throw new Error(`Invalid date: ${String(input)}`);
  }
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** Number of whole days between two date inputs (b - a). */
export function daysBetween(a: Date | string, b: Date | string): number {
  const ad = toUtcDay(a).getTime();
  const bd = toUtcDay(b).getTime();
  return Math.round((bd - ad) / MS_PER_DAY);
}

/** Add `n` days to a date, returning a new UTC-midnight Date. */
export function addDays(d: Date | string, n: number): Date {
  const base = toUtcDay(d);
  return new Date(base.getTime() + n * MS_PER_DAY);
}

/** ISO "YYYY-MM-DD" format for a date. */
export function toIsoDay(d: Date | string): string {
  const utc = toUtcDay(d);
  return utc.toISOString().slice(0, 10);
}

/**
 * Convert a date to a pixel offset along the timeline.
 *   px = daysBetween(windowStart, date) * pxPerDay
 * Negative if `date` is before `windowStart`.
 */
export function dateToPx(
  date: Date | string,
  windowStart: Date | string,
  pxPerDay: number,
): number {
  return daysBetween(windowStart, date) * pxPerDay;
}

/**
 * Inverse of dateToPx. Snaps to the nearest day. Returns a UTC-midnight Date.
 */
export function pxToDate(
  px: number,
  windowStart: Date | string,
  pxPerDay: number,
): Date {
  if (pxPerDay <= 0) {
    throw new Error('pxPerDay must be positive');
  }
  const days = Math.round(px / pxPerDay);
  return addDays(windowStart, days);
}

/**
 * Width in pixels of a [start, end] range.
 * Convention: end is inclusive (so a 1-day bar with start==end has width pxPerDay).
 * If end < start, returns 0 (degenerate ranges don't render).
 */
export function rangeWidthPx(
  start: Date | string,
  end: Date | string,
  pxPerDay: number,
): number {
  const days = daysBetween(start, end);
  if (days < 0) return 0;
  return (days + 1) * pxPerDay;
}

/**
 * Snap a date to the start of a day (alias for toUtcDay, for callers
 * that prefer reading `snapToDay(...)` at the drag-end site).
 */
export function snapToDay(input: Date | string): Date {
  return toUtcDay(input);
}

/**
 * Returns true if the [aStart, aEnd] window overlaps [bStart, bEnd].
 * All inclusive. Either side may be null/undefined → treat as unbounded
 * on that side. If both sides of one window are missing, returns true
 * (no-filter semantics).
 */
export function windowsOverlap(
  aStart: Date | string | null | undefined,
  aEnd: Date | string | null | undefined,
  bStart: Date | string | null | undefined,
  bEnd: Date | string | null | undefined,
): boolean {
  // Missing both ends on side A or side B → no constraint, overlap is true.
  const aS = aStart != null ? toUtcDay(aStart).getTime() : null;
  const aE = aEnd != null ? toUtcDay(aEnd).getTime() : null;
  const bS = bStart != null ? toUtcDay(bStart).getTime() : null;
  const bE = bEnd != null ? toUtcDay(bEnd).getTime() : null;

  // a ends before b starts.
  if (aE != null && bS != null && aE < bS) return false;
  // b ends before a starts.
  if (bE != null && aS != null && bE < aS) return false;
  return true;
}

/**
 * Compute a default render window around a list of dates. Used to choose
 * the canvas bounds when filters don't pin them. Pads by ~14 days on each
 * side and ensures `today` is included.
 */
export function defaultWindow(
  dates: Array<Date | string | null | undefined>,
  today: Date | string = new Date(),
): { start: Date; end: Date } {
  const stamps: number[] = [];
  for (const d of dates) {
    if (d == null) continue;
    try {
      stamps.push(toUtcDay(d).getTime());
    } catch {
      // Ignore unparseable strings — they shouldn't influence the window.
    }
  }
  const todayMs = toUtcDay(today).getTime();
  stamps.push(todayMs);

  const min = Math.min(...stamps);
  const max = Math.max(...stamps);
  return {
    start: new Date(min - 14 * MS_PER_DAY),
    end: new Date(max + 14 * MS_PER_DAY),
  };
}

/**
 * Tick generator for the time axis. Returns sorted UTC-midnight dates that
 * land on natural boundaries for the chosen zoom level.
 *
 *   - week: every Monday in window
 *   - month: 1st of every month in window
 *   - quarter: 1st of every quarter (Jan/Apr/Jul/Oct)
 */
export function axisTicks(
  start: Date | string,
  end: Date | string,
  zoom: ZoomLevel,
): Date[] {
  const s = toUtcDay(start);
  const e = toUtcDay(end);
  const ticks: Date[] = [];
  if (e < s) return ticks;

  if (zoom === 'week') {
    // Roll forward to next Monday (UTC). getUTCDay: 0=Sun..6=Sat. Monday=1.
    const cursor = new Date(s);
    const dow = cursor.getUTCDay();
    const offset = (1 - dow + 7) % 7;
    cursor.setUTCDate(cursor.getUTCDate() + offset);
    while (cursor <= e) {
      ticks.push(new Date(cursor));
      cursor.setUTCDate(cursor.getUTCDate() + 7);
    }
  } else if (zoom === 'month') {
    const cursor = new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth(), 1));
    if (cursor < s) cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    while (cursor <= e) {
      ticks.push(new Date(cursor));
      cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    }
  } else {
    // quarter
    const month = s.getUTCMonth();
    const qStart = month - (month % 3);
    const cursor = new Date(Date.UTC(s.getUTCFullYear(), qStart, 1));
    if (cursor < s) cursor.setUTCMonth(cursor.getUTCMonth() + 3);
    while (cursor <= e) {
      ticks.push(new Date(cursor));
      cursor.setUTCMonth(cursor.getUTCMonth() + 3);
    }
  }
  return ticks;
}

/**
 * Format a tick date for the axis label, given a zoom level.
 *   week: "Apr 27"
 *   month: "Apr" or "Apr 2026" on Jan
 *   quarter: "Q2 2026"
 */
export function formatTick(d: Date, zoom: ZoomLevel): string {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const m = d.getUTCMonth();
  const y = d.getUTCFullYear();
  if (zoom === 'week') {
    return `${months[m]} ${d.getUTCDate()}`;
  }
  if (zoom === 'month') {
    return m === 0 ? `${months[m]} ${y}` : months[m];
  }
  const q = Math.floor(m / 3) + 1;
  return `Q${q} ${y}`;
}
