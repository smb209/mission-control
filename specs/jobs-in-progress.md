# Jobs in Progress

A unified queue surface for every in-flight agent dispatch in the workspace — PM chats, plan/decompose dispatches, initiative audits (narrow + subtree fan-out nodes), recurring-job ticks, brief runs. Operators currently have no single place to see "what is the system doing right now," and parallel dispatches (subtree audits dispatch 5+ researchers; recurring jobs tick alongside live PM turns) make the gap visible.

## Operator intent

> "There can be multiple things going at a time. I want a queue of tasks in progress, task state, agent assigned, session, etc."

The page answers, in order:

1. **Right now** — what is currently running, who's running it, how long has it been running.
2. **Up next** — what's scheduled to fire soon (recurring jobs).
3. **Recently** — what finished in the last 24h, with pass/fail and cost.

Failure-mode signal is part of the design: if the same recurring scope keeps failing, the page surfaces it before the operator has to dig.

## Why not the existing tables

Today four overlapping surfaces partially track in-flight work; none answers the question end-to-end:

| Table | Coverage | Gap |
|---|---|---|
| `mc_sessions` | Every dispatch upserts one. | `status='active'` means "row exists for this scope_key," not "agent is currently computing." 1383 rows for `pm_chat` today, all `active`. |
| `agent_runs` | Right lifecycle enum (`queued/running/complete/failed/cancelled`), cost columns, indexed. | Locked to `kind='brief'` by CHECK constraint. |
| `pm_proposals.dispatch_state` | `pending_agent` → `agent_complete` / `synth_only`. | Only the PM-proposal subset. Audit, recurring, brief, coord don't write here. |
| `recurring_jobs` | `next_run_at`, `last_run_at`, `consecutive_failures`. | Schedule definitions, not runs. |

`agent_runs` is the closest fit — already has the lifecycle, cost ceiling, openclaw_session_id, error_md. We extend it instead of inventing a sibling table.

## Architecture

### Schema change (one migration)

Migration `080_extend_agent_runs.ts`:

```sql
-- Relax the kind CHECK to cover every dispatch path.
-- Rebuild table because SQLite can't ALTER CHECK in place.
CREATE TABLE agent_runs_new (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN (
    'brief',              -- legacy / morning brief
    'pm_chat',            -- one operator turn against PM
    'plan',               -- plan_initiative dispatch
    'decompose',          -- decompose_initiative dispatch
    'initiative_audit',   -- narrow or subtree-node researcher
    'recurring',          -- recurring_jobs tick
    'task_coord',         -- per-task coordinator turn
    'task_role'           -- per-task role subagent turn
  )),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN (
    'queued','running','complete','failed','cancelled'
  )),
  source_kind TEXT NOT NULL DEFAULT 'manual' CHECK (source_kind IN (
    'manual','schedule','event','fanout'
  )),
  source_ref TEXT,                 -- recurring_job_id, parent agent_run id (for fanout), etc.
  scope_key TEXT,                  -- NEW: link to mc_sessions
  scope_type TEXT,                 -- NEW: denormalized for cheap filtering
  role TEXT,                       -- NEW: pm | researcher | coordinator | role | ...
  agent_id TEXT,                   -- NEW: which agent row was dispatched
  initiative_id TEXT REFERENCES initiatives(id) ON DELETE SET NULL,  -- NEW
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,              -- NEW
  parent_run_id TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,   -- NEW: subtree fan-out
  label TEXT,                      -- NEW: display label snapshot at dispatch time
  openclaw_session_id TEXT,
  model_used TEXT,
  cost_cents INTEGER,
  cost_ceiling_cents INTEGER,
  error_md TEXT,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO agent_runs_new (id, workspace_id, kind, status, source_kind, source_ref,
  openclaw_session_id, model_used, cost_cents, cost_ceiling_cents, error_md,
  started_at, completed_at, created_at, updated_at)
SELECT id, workspace_id, kind, status, source_kind, source_ref,
  openclaw_session_id, model_used, cost_cents, cost_ceiling_cents, error_md,
  started_at, completed_at, created_at, updated_at
FROM agent_runs;

DROP TABLE agent_runs;
ALTER TABLE agent_runs_new RENAME TO agent_runs;

CREATE INDEX idx_agent_runs_workspace_status ON agent_runs(workspace_id, status);
CREATE INDEX idx_agent_runs_kind_status     ON agent_runs(kind, status);
CREATE INDEX idx_agent_runs_created         ON agent_runs(created_at);
CREATE INDEX idx_agent_runs_scope_key       ON agent_runs(scope_key) WHERE scope_key IS NOT NULL;
CREATE INDEX idx_agent_runs_initiative      ON agent_runs(initiative_id) WHERE initiative_id IS NOT NULL;
CREATE INDEX idx_agent_runs_task            ON agent_runs(task_id) WHERE task_id IS NOT NULL;
CREATE INDEX idx_agent_runs_parent          ON agent_runs(parent_run_id) WHERE parent_run_id IS NOT NULL;
CREATE INDEX idx_agent_runs_active          ON agent_runs(status, started_at) WHERE status IN ('queued','running');
```

Backfill: existing `kind='brief'` rows preserved as-is; new columns are NULL on old rows. No retro-attribution — historical PM chats etc. simply aren't represented (and don't need to be — this is for live + 24h scrollback).

### Single write site: `dispatch-scope.ts`

`dispatchScope()` already wraps every openclaw round-trip. We add one helper around it:

```ts
// src/lib/db/agent-runs.ts (extend)
export function startAgentRun(input: {
  workspace_id: string;
  kind: AgentRunKind;
  scope_key: string;
  scope_type: ScopeType;
  role: string;
  agent_id: string;
  initiative_id?: string | null;
  task_id?: string | null;
  parent_run_id?: string | null;
  source_kind?: 'manual' | 'schedule' | 'event' | 'fanout';
  source_ref?: string | null;
  cost_ceiling_cents?: number | null;
  label?: string | null;
}): string;  // returns id

export function completeAgentRun(id: string, opts: {
  openclaw_session_id?: string | null;
  model_used?: string | null;
  cost_cents?: number | null;
}): void;

export function failAgentRun(id: string, error_md: string): void;
```

Wired into `dispatchScope`:

```ts
export async function dispatchScope(input: DispatchScopeInput): Promise<DispatchScopeResult> {
  // …existing scope_key + upsertSession…

  const runId = startAgentRun({
    workspace_id: input.workspace_id,
    kind: scopeTypeToRunKind(scopeType),  // pure mapping
    scope_key,
    scope_type: scopeType,
    role: input.role,
    agent_id: input.agent.id,
    initiative_id: input.initiative_id ?? null,
    task_id: input.task_id ?? null,
    parent_run_id: input.parent_run_id ?? null,
    source_kind: input.source_kind ?? 'manual',
    source_ref: input.source_ref ?? null,
    label: input.label ?? null,
  });

  try {
    const reply = await sendChatAndAwaitReply({ … });
    completeAgentRun(runId, {
      openclaw_session_id: reply.session_id,
      model_used: reply.model,
      cost_cents: reply.cost_cents ?? null,
    });
    return { …, run_id: runId, reply };
  } catch (err) {
    failAgentRun(runId, err instanceof Error ? err.message : String(err));
    throw err;
  }
}
```

`dry_run` skips the run entirely. The handful of dispatch sites that bypass `dispatchScope` (audit any references) get migrated in the same PR.

### Subtree fan-out: parent linkage

`subtree-audit.ts` already knows the root dispatch. It passes `parent_run_id` to each per-node child dispatch so the UI can render the tree:

```
[running] Initiative Audit — Onboarding Epic            12s
  ├─ [complete] Story: Welcome screen                  4.1s ✓
  ├─ [running]  Story: Stripe webhook                  9.3s
  └─ [running]  Story: Email verification              9.3s
```

### API

`GET /api/jobs?status=live` — returns:
```ts
{
  live: AgentRun[];        // status IN ('queued','running')
  scheduled: {              // recurring_jobs.status='active', next ≤ 24h
    job_id, name, next_run_at, last_run_at, consecutive_failures, role
  }[];
  recent: AgentRun[];       // status IN ('complete','failed','cancelled') AND completed_at >= now-24h, limit 100
}
```

Single endpoint, polled by the page every 2s (cheap — indexed). SSE upgrade is a follow-up if polling cost becomes an issue.

`POST /api/jobs/:id/cancel` — sets status to `cancelled` and (best-effort) closes the openclaw session. Behind explicit operator click.

### UI

`/jobs` page, three stacked sections:

**Live** — table sorted by `started_at` asc.
| Kind | Label | Agent (role · id) | Scope | Started | Elapsed | Actions |

Subtree audits collapse parent + children into a tree row. Long-running rows (>5min) flagged amber.

**Scheduled (next 24h)** — `recurring_jobs` ordered by `next_run_at`.
| Name | Next run | Last run | Streak | Role |

`consecutive_failures > 0` → red streak chip with the last error_md from the most recent `agent_runs` row.

**Recent (24h)** — `agent_runs` finished, paginated. Same columns + `Cost`, `Status`. Click → drill-down: trigger body, error_md, link to scope_key reset.

Sidebar pip on the main nav: live count.

## Coverage map (every dispatch path → run kind)

| Caller | scope_type | run kind | source_kind |
|---|---|---|---|
| Operator types in PM chat | `pm_chat` | `pm_chat` | `manual` |
| `Plan with PM` modal | `plan` | `plan` | `manual` |
| `Decompose with PM` modal | `decompose` (or `decompose_story`) | `decompose` | `manual` |
| `Investigate` narrow | `initiative_audit` | `initiative_audit` | `manual` |
| `Investigate` subtree (each node) | `initiative_audit` | `initiative_audit` | `fanout` (child rows have `parent_run_id`) |
| `recurring_jobs` tick | `recurring` | `recurring` | `schedule` (source_ref=job_id) |
| Daily standup | `pm_chat` | `pm_chat` | `schedule` |
| Brief dispatch | (existing) | `brief` | (existing) |
| Per-task coordinator | `task_coord` | `task_coord` | `manual` or `event` |
| Per-task role subagent | `task_role` | `task_role` | `manual` |

Anything that doesn't go through `dispatchScope` today (audit during PR 1) gets migrated.

## Schedule

Five PRs, each verifiable end-to-end:

**PR 1 — schema + write site.** Migration 080. `startAgentRun`/`completeAgentRun`/`failAgentRun` helpers. `dispatchScope` wires them. Migrate any straggler dispatch sites. Verify: trigger one of each kind, `agent_runs` populated end-to-end, `kind='brief'` rows still readable.

**PR 2 — `GET /api/jobs` + minimal UI.** `/jobs` page renders live/scheduled/recent, polls every 2s. No cancel yet, no tree view. Verify: dispatch a PM chat + a narrow audit + wait for a recurring tick; all three appear live, settle to recent.

**PR 3 — subtree tree view + amber-flag long runs.** `parent_run_id` rendered as nested rows. `consecutive_failures` chip. Verify: subtree audit on the fixture epic shows root + leaves; one mid-run cancel (manually killed openclaw session) flips the leaf to `failed` with error_md.

**PR 4 — `POST /api/jobs/:id/cancel`.** Behind ConfirmDialog. Wires through to openclaw session-close. Verify: cancel a live PM chat mid-stream, row flips `cancelled`, pm_proposals row goes to `synth_only` (existing fallback).

**PR 5 — sidebar nav pip + drill-down detail.** Live-count badge on `/jobs` link. Click a run → side panel with trigger_body, error_md, session reset link.

## Verification pipeline

Same dogfood loop as `initiative-investigate.md`:

1. `yarn db:checkpoint` before each PR's verify step.
2. Drive each scenario via preview tools (PM chat, Investigate narrow + subtree, manual recurring tick).
3. Inspect `agent_runs` between every step.
4. `yarn db:checkpoint:restore` to repeat.

Pre-existing failures inventoried up-front per the project CLAUDE.md rule.

## Out of scope

- **Historical backfill** of pre-migration dispatches. Live + 24h is the product.
- **Per-row log streaming.** The drill-down links to the existing scope_key reset / openclaw transcript view; we don't build a new log surface.
- **Resource attribution beyond cost_cents.** Tokens-by-model, latency percentiles, etc. are dashboard work — separate spec.
- **Cross-workspace view.** `/jobs` is workspace-scoped, like every other MC page.

## Resolved questions

1. **Pre-openclaw failures land as `agent_runs` rows with `status='failed'`.** Operator wants every failure visible from `/jobs`, not buried in `recurring_jobs.consecutive_failures` only. `startAgentRun` happens before any health check; if the dispatch never reaches openclaw, `failAgentRun` records the wrapper-side error_md.
2. **PM chat mode-B turns each get a row, auto-collapsed in UI.** Live list groups by `scope_key` for `kind='pm_chat'`: one row per session showing "N turns in last hour" with the most recent `started_at`. The recent (24h) section shows individual turns ungrouped so audit/postmortem stays granular. Plan/decompose/audit dispatches stay one-row-per-run (low volume).
3. **Cost ceiling enforcement is out of scope.** Local-model deployment today; no spend pressure. `cost_cents` / `cost_ceiling_cents` columns stay populated when openclaw reports them but no enforcement gate. Revisit if/when hosted-model usage grows.
