---
status: current
last-verified: 2026-05-11
audience: ai-subagents-primary, operator-secondary
code-anchors:
  - src/lib/timestamps.ts
  - src/components/Time.tsx
  - src/lib/db/index.ts
  - src/lib/db/migrations.ts:4520
  - src/app/api/workspaces/[id]/route.ts
db-tables: [workspaces]
migrations:
  - "086 workspaces_display_timezone — migrations.ts:4520"
related-specs:
  - workspace-conventions-structured.md — shares workspaces table + settings page
  - cascade-rules.md — DB-layer discipline
---

# Timestamp handling: UTC drift fix + display timezone setting

## Why

`SQLite`'s `datetime('now')` returns `"YYYY-MM-DD HH:MM:SS"` — UTC by
sqlite convention, but with no timezone marker. JS `new Date(s)` parses
that as **local** time, producing dates that drift by the local UTC
offset. PR #280 fixed one site (the InvestigateModal cooldown banner)
by hand-coercing to ISO-Z, but the codebase has:

- ~50 DB write sites using `datetime('now')`
- Zero centralized API normalization (rows go straight to JSON)
- ~13 unprotected `new Date(field)` reads on the client (LiveFeed,
  ActivityLog, MissionQueue, ScheduleRow, several chat tabs at the
  non-display call site, etc.) — all off by the local UTC offset
- ~6 ad-hoc `endsWith('Z') ? s : s + 'Z'` workarounds scattered around
- No shared `<Time>` / `formatTimestamp` helper

Even where the UTC math is correct, display is inconsistent: some
sites use `toLocaleString` (system zone), some use raw `Date` math
(implicit local), and the operator has no way to override the zone if
auto-detect is wrong.

## Goal

1. **Strings flow as ISO-Z everywhere.** The drift bug stops being a
   thing.
2. **Display zone is auto-detected from the browser**, with a
   workspace-level override the operator can set when auto-detect is
   wrong (default fallback: `America/Los_Angeles`).
3. **One canonical helper / component** for rendering timestamps so
   future contributors don't reinvent the workarounds.

## Plan: two stacked PRs

### PR-A — Server-side normalization at the DB boundary

**Single fix, central place.** In `src/lib/db/index.ts`, wrap
`queryAll` / `queryOne` so any string field whose value matches
`/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/` is rewritten to ISO-Z
(`replace(' ', 'T') + 'Z'`) before the row is returned to the caller.

Also patch `run()` is **not** needed — that's only used for writes.
Reads go through `queryAll` / `queryOne`, plus the `prepare(...).all()`
/ `.get()` calls that bypass these helpers — those get a separate
inventory + migrated to the helpers, or wrapped.

**Why this layer**: it's the choke point. Every read path — API
responses, server components, internal helpers — gets the normalized
value. No frontend code change needed; existing `new Date(field)`
calls just start working, and the ad-hoc workarounds become harmless
idempotent no-ops (`new Date("...Z")` is parseable; coercing again is
safe).

**Risk**: anyone comparing a raw row datetime back to a parameter via
SQL string equality (`WHERE created_at = ?` with a value plucked from
a previous row read) would now compare ISO-Z to the original SQL
format. Mitigation:
- Grep first: `=\s*\?\s*.*created_at|created_at\s*=` etc. across
  `src/lib/db/**`.
- Round-trip test: insert a row, read it back via `queryAll`, then
  `WHERE created_at = ?` against the read value — confirm match still
  works (the writer would re-parse ISO-Z back to UTC; sqlite compares
  strings, so this WILL break naive code). If any callers rely on
  this, fix them to use `<` / `>` ranges instead, or convert in SQL.

**Tests**:
- `queryAll` / `queryOne` rewrite bare datetimes to ISO-Z.
- Subsecond precision is preserved (`"2026-05-08 16:00:37.123"` →
  `"2026-05-08T16:00:37.123Z"`).
- Non-datetime strings are untouched.
- Already-Z values are untouched (idempotent).
- NULL fields stay NULL.

**Out of scope of PR-A**: any UI or display change. This PR alone
fixes the drift bug for every site that already calls `new Date(s)`.

### PR-B — Timezone setting + `<Time>` helper + display sweep

Built on PR-A.

#### 1. Storage

Migration **086**: `workspaces.display_timezone TEXT` (nullable; NULL =
auto-detect from browser). No backfill — empty means use the
browser's zone.

#### 2. API

- `GET /api/workspaces/[id]` surfaces `display_timezone`.
- `PATCH /api/workspaces/[id]` accepts a `display_timezone` field;
  validated by attempting `new Intl.DateTimeFormat('en-US', {
  timeZone: value })` and rejecting any value that throws.

#### 3. UI

In the workspace settings page (`src/app/(app)/workspace/[slug]/settings/page.tsx`):
- New "Display timezone" field, free-text input with a small
  datalist of common zones (`America/Los_Angeles`, `America/New_York`,
  `Europe/London`, `Asia/Tokyo`, etc.).
- Placeholder shows the auto-detected browser zone, with hint text:
  "Leave blank to use your browser's timezone (auto-detected:
  America/Los_Angeles)".
- Save commits the value; clear-to-blank reverts to auto-detect.

#### 4. Client helper

`src/lib/timestamps.ts`:
- `resolveDisplayTimezone(workspaceTz: string | null | undefined): string`
  — returns workspaceTz if set, else
  `Intl.DateTimeFormat().resolvedOptions().timeZone`, else
  `'America/Los_Angeles'` (final fallback for environments where Intl
  is somehow stripped — defensive only).
- `formatTimestamp(iso: string, opts: { tz: string; mode?:
  'absolute' | 'short' | 'datetime' | 'date' }): string` — wraps
  `Intl.DateTimeFormat` with the resolved zone.
- `relativeTime(iso: string): string` — uses `formatDistanceToNow`
  from date-fns. (No tz needed — relative is zone-agnostic for past
  events, and the underlying parse is now ISO-Z thanks to PR-A.)

`src/components/Time.tsx`:
- `<Time iso={s} mode="relative" />` — `formatDistanceToNow(s) + ' ago'`
- `<Time iso={s} mode="absolute" />` — full date+time in resolved tz
- `<Time iso={s} mode="short" />` — compact "May 8, 4:32 PM"
- `<Time iso={s} mode="datetime" />` — ISO-like in resolved tz
- `title` attribute always shows the absolute datetime (so hovering
  any relative timestamp shows the full).

The component reads tz from a `WorkspaceTimezoneContext` provider
threaded into the app shell. SSR-safe: if no context, falls back to
the auto-detect path on the client (server renders relative-only or
empty placeholder, then hydrates).

#### 5. Sweep

Migrate the unprotected sites identified in the audit:
- LiveFeed.tsx, ActivityLog.tsx, MissionQueue.tsx,
  AgentActivityDashboard.tsx, DebugEventRow.tsx, ScheduleRow.tsx,
  TaskChatTab.tsx (line 54), AgentChatTab.tsx (line 60),
  ChatConversation.tsx (line 49), ChatInbox.tsx, MaybePool.tsx,
  ResearchReport.tsx, SessionsList.tsx.

For each: replace `formatDistanceToNow(new Date(field))` with
`<Time iso={field} mode="relative" />` (or call `relativeTime(field)`
if it has to stay a string). Replace `toLocaleTimeString()` calls
with `formatTimestamp(field, { tz, mode: 'short' })`.

The ad-hoc `.endsWith('Z')` workarounds can be left in place (no-op
post-PR-A) or stripped during the sweep — either is fine. I'll strip
them as they show up in diffed files.

#### 6. Tests

- TZ override flows: PATCH workspace with `display_timezone:
  'America/New_York'`, GET returns it, invalid zone rejected with 400.
- `formatTimestamp` renders the same instant differently in two
  zones.
- `<Time>` snapshot for relative + absolute modes.
- Workspace settings page renders the picker and persists the value.

### Out of scope

- Backend rendering of timestamps (we keep all formatting on the
  client; server stays zone-agnostic).
- Per-user timezone (we have one operator per workspace; per-user
  preference would require a sessions/users table that doesn't exist
  yet).
- Migration of older raw datetime strings already stored — PR-A
  rewrites on read, so this is automatic.
