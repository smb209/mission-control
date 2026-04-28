# Gardener — memory curation, seeding, and dissemination

## Why

The memory layer (see [memory-layer.md](memory-layer.md)) gives every
agent grounded context at dispatch time. But a static store rots:

- Recurring decisions stay duplicated across siblings instead of being
  promoted to a parent or org scope where they'd inform peer work.
- Stale claims linger ("auth lives in `backend-app/internal/auth`")
  long after the codebase has moved on.
- Critical findings discovered in one task ("package `foo` has a
  CVE-2026-…") don't reach peer tasks that should know.
- Adoption is hard from a cold start: a new workspace's memory is
  empty until operators or agents dribble entries in over weeks.

The gardener is the curation role that closes those loops. It sees
**all** memory in a workspace (every scope, the full tree) — a
privileged view no individual builder/coordinator gets — and uses
that vantage to consolidate, prune, verify, seed, and disseminate.

This is a **role**, not necessarily a new agent. The defining property
is the cross-tree view; whether it lands as a dedicated `gardener`
agent or as a mode of the existing learner is an implementation
detail decided in the first PR.

## Responsibilities

Six jobs, in rough order of risk:

### 1. Promote (consolidation)

Detect recurring themes across siblings and lift them to the lowest
common ancestor that covers them.

Examples:
- Three story-scoped entries under the same epic each say "we use
  Postgres with the `pgx` driver" → promote to the epic.
- Five entries scattered across unrelated themes mention "demo to
  Sarah on Fridays" → promote to org.

Mechanism: cluster active entries by embedding similarity (configurable
threshold, default 0.85). For clusters of size ≥ N (default 3),
compute lowest common ancestor of their scopes. Emit a promote
proposal: new entry at the ancestor level, originals marked
`superseded_by` the new id.

### 2. Prune (rot management)

Mark entries stale based on:

- Time since `last_retrieved_at` (default >180 days never retrieved →
  candidate).
- Contradiction with newer entries (semantic similarity high, but
  conflicting tags or content keywords like "no longer", "deprecated",
  "moved").
- Supersession by accepted proposals (e.g. an initiative status
  change that contradicts a memory claim).

Stale entries are flagged via `archived_at` (not deleted) and excluded
from active retrieval. Operator can un-archive or delete. This is
distinct from `quarantined_at` — pruning means "low signal," quarantine
means "actively wrong." See job 6.

### 3. Verify (ground-truth checks)

Spot-check claims that name verifiable external state:

- Repo paths ("auth is in `backend-app/internal/auth`") — read the
  path against a checked-out worktree or via the GitHub read API
  (when that lands, see open question below).
- URLs / docs ("our brand guidelines live at notion.so/…") — HEAD
  request or fetch.
- Package status ("we use `foo@1.2`") — check npm/pypi/etc. for
  current version, deprecation flags, advisories.

Outcomes:
- Match → bump `last_verified_at`.
- Drift → emit a verify proposal with the discrepancy spelled out.
  Operator decides to update or reject.

Verification is **rate-limited and budgeted** — see "Context
discipline" below. Not every entry gets verified every cycle; the
gardener picks the highest-leverage K per run, weighted by retrieval
frequency.

### 4. Disseminate (cross-tree relevance)

The flagship case the operator called out: when one task discovers
something that peers need, the gardener routes it.

Examples:
- Researcher finds package `foo` is deprecated → gardener proposes an
  org-scope memory entry tagged `#deprecation:foo` and (optionally)
  files a `propose_changes` against the PM to slot a remediation
  initiative if the package is in heavy use.
- Builder learns "the staging DB has a 2GB row limit on `events`" →
  gardener promotes to the platform epic level if multiple stories
  underneath touch the same DB.

Mechanism: high-priority entries (`priority = 'critical'` set by the
writing agent or by gardener heuristics — security, deprecation,
data-loss keywords) bypass the periodic cycle and trigger an immediate
gardener pass, debounced ~30s to batch bursts.

### 5. Closure pass (initiative lifecycle)

When an initiative transitions to `done` or `cancelled`, the gardener
runs a focused pass over its subtree's memory. Each entry is classified
into one of three outcomes:

- **Promote** — the lesson generalizes (e.g. "Stripe webhooks are
  unreliable below 5min retry"). Lift to parent or org via the
  standard promote pipeline.
- **Archive** (`archived_at` set) — durable record, excluded from
  active retrieval but searchable for audit. Default outcome for
  `done` initiatives whose memory doesn't warrant promotion.
- **Quarantine** (`quarantined_at` set) — default outcome for
  `cancelled` initiatives. Cancellation usually means the embedded
  assumptions proved wrong; treating that memory as ground truth for
  unrelated future work is harmful. Operator can selectively
  un-quarantine the bits that are still valid.

The classifier is a subagent (per the context-discipline rules below):
reads each entry, the closure context (status, status_check_md,
recent activity), and outputs one of {promote, archive, quarantine}
with a short justification. Output goes through proposal review — the
operator sees a single batched proposal per closure rather than per
entry.

Trigger: a hook on `initiatives.status` transitions to `done` or
`cancelled` enqueues a closure run for that initiative_id.

### 6. Quarantine + blast-radius investigation

The case operators most need a backstop for: an agent saved a flawed
memory, peers grounded on it, downstream decisions inherited the error.
Targeted removal isn't enough — bad memory often *symptomizes* either a
flawed mental model from one agent in one period, or a confusing area
that produced multiple miscalibrated entries. Fix has to look wider
than the single entry.

When an entry is quarantined (operator clicks "Report bad memory" or
gardener heuristics flag) the gardener immediately runs a
blast-radius pass. Four candidate sets:

- **Direct downstream consumers** — query `memory_retrievals` for
  every task or proposal that grounded on the entry. Surface them so
  the operator can review whether the bad assumption affected the
  outcome.
- **Peer entries by the same author + time window** — same
  `created_by_agent_id` within ±N days (default 14). If one of agent
  X's entries from week Y was wrong, neighbors deserve a look.
- **Semantic neighbors** — embedding-similar entries across the
  workspace. A flawed mental model often produces multiple entries
  that cluster in vector space.
- **Downstream memories** — entries written by tasks that consumed
  the bad one (joined via `memory_retrievals` where
  `consumer_kind = 'memory_write'`). Inheritance of the flaw.

The investigation produces a *quarantine review queue* — a single
batched proposal listing each candidate with severity (direct vs peer
vs neighbor vs downstream-memory), rationale, and a suggested action
per candidate. Operator triages in one pass rather than chasing
per-entry.

This shares machinery with the closure pass — quarantine is a
narrower, operator-driven version of cancellation's bulk-quarantine
default. Both feed the same review-queue UX.

## Two-track operator trust contract

The gardener never silently rewrites operator-authored memory. Two
classes of action:

**Mechanical** (low risk) — applied directly, surfaced in a "gardener
log" the operator can scroll:
- Bump `last_retrieved_at`, `retrieval_count`, `last_verified_at`.
- Mark stale (recoverable, doesn't delete).
- Re-tag based on content (additive, not destructive).
- Dedupe near-identical entries within the same scope.

**Substantive** (needs review) — emitted as `pm_proposals` rows with
a new `trigger_kind = 'memory_curation'`:
- Promote (new entry + supersede chain).
- Verify drift (proposed update to an existing entry).
- New entry from research / seeding.
- Cross-tree dissemination.
- Closure classification batch (one proposal per closing initiative,
  enumerating promote/archive/quarantine actions for each attached
  entry).
- Quarantine review queue (one proposal per investigation, enumerating
  direct/peer/neighbor/downstream-memory candidates with suggested
  actions).

Reusing the proposal review pipeline gives free audit, accept/reject/
refine, and SSE notification. Operator stays in control.

## Seeding from external sources

The gardener can bootstrap a cold workspace's memory from existing
sources, on operator demand or as a periodic enrichment pass. **Never
required** — agents work fine on an empty memory store, just without
grounding.

Source adapters (each lives at `src/lib/gardener/sources/<name>.ts`):

- **Git history** — read commit messages + PR descriptions for
  configured repos. Distill recurring patterns: "tests run via
  `yarn test`", "we squash-merge", architectural decisions called out
  in commits.
- **Code structure** — read top-level READMEs, `package.json`,
  config files. Extract: stack, scripts, conventions.
- **Web pages** — operator-supplied URL list. Fetch + summarize.
  Useful for vendor docs, internal wikis, brand guidelines.
- **Email / chat exports** — operator-supplied JSON/MBOX dump.
  Distill recurring contacts, vendor relationships, decision history.
- **GitHub issues / PRs** — when the GitHub read path lands.

### Map-reduce pipeline (load-bearing for high-volume sources)

The hardest seeding cases — multi-year email archives, decade-long
commit histories — defeat any "feed it to one prompt" approach. The
adapter pipeline is fixed at six phases that all sources implement:

1. **Cull** (no LLM cost). Heuristic filters drop structurally noisy
   inputs: newsletters, automated notifications, "+1" replies for
   email; merge commits, dependabot, formatting-only commits for git.
   Eliminates 70-90% of volume before any model runs.
2. **Identity dictionary**. Extract a people/org table from senders,
   signatures, commit authors, GitHub handles. Built once before any
   content is read so downstream phases can disambiguate (`Sarah Chen
   <acme>` vs `Sarah Patel <recruiter>`). Without this, findings
   confidently conflate identities.
3. **Survey (map only)**. A single subagent reads a stratified sample
   (e.g. 200 threads spread across the time range) and returns a
   *taxonomy of recurring topics* — not findings, just an outline.
   The full corpus stays untouched.
4. **Targeted reduce**. For each topic in the taxonomy, dispatch a
   fresh subagent with a tight prompt and budget cap. Each returns
   ≤500 tokens of distilled findings + citations. Topics run in
   parallel within the per-cycle subagent cap.
5. **Recency + drift weighting**. Findings tagged with their evidence
   date range. Topics heavy in older periods but absent recently are
   flagged as likely stale, not ingested. Contradicting findings
   resolve to the most recent, with the older retained as supersede
   history.
6. **Privacy + safety gate**. Heuristic filters surface candidates
   that look personal (family domains, medical/legal-personal
   keywords) into a separate operator-only review track, never
   auto-ingested as memory. Conservative: false positives are far
   cheaper than false negatives.

Each adapter returns `SeedingCandidate[]`:

```ts
interface SeedingCandidate {
  body_md: string;
  suggested_scope: 'org' | { initiative_id: string };
  tags: string[];
  source_ref: string;        // citation: commit sha, URL, message-id, etc.
  confidence: number;         // 0..1, source-adapter-specific
  evidence_window: {          // recency context for the finding
    earliest: string;         // ISO date
    latest: string;
    occurrences: number;
  };
  flagged_personal?: boolean; // routed to separate operator review track
}
```

Candidates are ALL routed through proposal review, batched by topic
(one proposal per topic, not per finding). Cap initial seeding output
at ~30 proposals per workspace per run; second wave only after the
first is reviewed. No silent ingestion.

## Context discipline (load-bearing)

This is the critical constraint. Source material can be enormous —
tens of thousands of commits, hundreds of pages of docs, archives of
emails. Pulling all of it into a single gardener prompt is impossible.

**Strategy: scoped subagents that report distilled findings.** The
gardener orchestrates rather than reads directly. For each job it
identifies what it needs ("does package `foo` have a known CVE?",
"what conventions appear in the last 200 commits to `backend-app`?"),
spawns researcher subagents with tight prompts and budgeted tools,
and synthesises their distilled reports into memory proposals.

The orchestration contract — subagent identity, MCP-compliant
messaging (including `send_mail` for mid-flight check-ins), persona
gating, lifecycle, and fan-out collection — is defined in
[subagent-orchestration.md](subagent-orchestration.md). Gardener uses
that surface; it does not invent its own.

Gardener-specific budgets layered on top of the platform defaults:

- **Per-cycle subagent cap**: default 3 concurrent on local-LLM
  workspaces, 5 nightly / 20 weekly when the openclaw gateway is
  configured for cloud capacity. Workspace-tunable.
- **Per-subagent caps**: default 15 tool calls, 2k output tokens,
  120s deadline (local-LLM-friendly).
- **Verification prioritization**: verify subagents prioritize
  entries with high `retrieval_count` — value scales with how often
  peers depend on the claim.

## Cadence

- **Mechanical pass** — nightly cron. Cheap. No subagents needed for
  the dedup/stale/retag work.
- **Substantive pass** — weekly cron, or operator-triggered ("garden
  this initiative now" button on the Memory tab).
- **Verify / fill-gap** — on-demand, triggered by either:
  - Retrieval-time signal (`getRelevantMemory` returns thin results
    for a load-bearing query — log the miss, gardener picks it up).
  - Operator request ("verify all memory under epic X").
  - Disseminate-class triggers (high-priority finding posted by an
    in-flight builder/researcher).
- **Seeding** — operator-triggered the first time per source. Optional
  periodic re-runs (monthly) to catch new commits / new PRs.

## Implementation outline

### Storage additions

The `memory_entries` columns the gardener needs (`archived_at`,
`quarantined_at`, `quarantine_reason`, `last_verified_at`, `priority`,
`superseded_by`) and the `memory_retrievals` provenance table are
defined in [memory-layer.md](memory-layer.md). The gardener only adds
the cycle log:

```sql
CREATE TABLE gardener_runs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN
    ('mechanical','substantive','verify','seed','disseminate','closure','quarantine')),
  trigger_ref TEXT,                           -- initiative_id (closure) or memory_entry_id (quarantine)
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','complete','failed')),
  summary_md TEXT,                            -- distilled report for the operator
  subagents_spawned INTEGER NOT NULL DEFAULT 0,
  proposals_emitted INTEGER NOT NULL DEFAULT 0,
  error TEXT
);
CREATE INDEX idx_gardener_runs_workspace ON gardener_runs(workspace_id, started_at DESC);
```

### Code layout

```
src/lib/gardener/
  index.ts                  # public API: runMechanical, runSubstantive, runVerify, runSeed, runClosure, runQuarantine
  cluster.ts                # promotion clustering
  prune.ts                  # stale + contradiction detection (sets archived_at)
  verify.ts                 # subagent orchestration for ground-truth checks
  disseminate.ts            # cross-tree triggers
  closure.ts                # closure-pass classifier (promote/archive/quarantine per entry)
  quarantine.ts             # blast-radius investigation
  seed.ts                   # source-adapter orchestration (six-phase pipeline)
  sources/
    git-history.ts
    code-structure.ts
    web.ts
    email-export.ts
  subagent.ts               # spawn + budget + collect helper
  identity.ts               # shared identity-dictionary builder for seeding adapters
```

### Triggers

- Nightly cron registered in `instrumentation.ts` next to the
  `pm-pending-drain` worker.
- Weekly cron likewise.
- Operator button on `/memory` (workspace) and the initiative Memory
  tab — POSTs to `/api/gardener/run` with `{ kind, scope }`.
- High-priority memory write — when an agent saves a memory entry
  with `priority: 'critical'`, the dispatch path enqueues a
  disseminate run (debounced ~30s to batch bursts).
- **Initiative status hook** — transitions to `done` or `cancelled`
  enqueue a closure run for that subtree.
- **Quarantine hook** — operator's "Report bad memory" click (or
  gardener-driven quarantine) enqueues a blast-radius investigation
  for that entry.

### MCP surface

Two new tools, both gardener-restricted:

- `propose_memory_curation` — the gardener's analogue of
  `propose_changes`. Emits a `pm_proposals` row with
  `trigger_kind = 'memory_curation'` and a `proposed_changes` array of
  memory diffs.
- `record_gardener_finding` — short-circuit logging for mechanical
  ops that don't need review (writes to `gardener_runs.summary_md`).

Plus new diff kinds in `pm_proposals` for memory ops:
`memory_promote`, `memory_supersede`, `memory_update`, `memory_create`,
`memory_archive`, `memory_quarantine`, `memory_unquarantine`.
`acceptProposal` applies them transactionally.

### UI

Two surfaces:

- **Gardener log** — `/memory/gardener` lists runs (kind, status,
  proposals emitted, summary). Click into a run to see the
  subagent reports and resulting proposals. Closure and quarantine
  runs render their candidate tables inline so the operator can
  triage without leaving the page.
- **Memory entry detail** — when viewing an entry, show its
  provenance: source, supersede chain, last verified, retrieval
  count, and (via the `memory_retrievals` join) the list of tasks
  and proposals that consumed it. Operator actions: un-archive,
  un-quarantine, trigger a one-off verify, "Report bad memory"
  (kicks off a quarantine investigation).

## Tests

- `src/lib/gardener/cluster.test.ts` — promotion clustering with
  seeded multi-scope entries; lowest-common-ancestor logic.
- `src/lib/gardener/prune.test.ts` — staleness rules, contradiction
  detection, archive flagging.
- `src/lib/gardener/verify.test.ts` — fake subagent, asserts budget
  caps + drift-proposal emission.
- `src/lib/gardener/seed.test.ts` — fake source adapters, asserts
  six-phase pipeline (cull → identity → survey → reduce → recency
  → privacy gate); candidates → proposals routing (no direct writes).
- `src/lib/gardener/disseminate.test.ts` — high-priority memory
  write triggers a debounced run; cross-tree proposal emission.
- `src/lib/gardener/closure.test.ts` — initiative status transitions
  to `done` produce archive-default proposals; transitions to
  `cancelled` produce quarantine-default proposals; promote outcomes
  surface for entries that match cluster patterns above the closing
  initiative.
- `src/lib/gardener/quarantine.test.ts` — quarantining an entry
  produces a review-queue proposal listing direct consumers (from
  `memory_retrievals`), peer entries by author+time, semantic
  neighbors, and downstream-memory candidates with appropriate
  severity tags.
- E2E: seed an org with three sibling entries that should promote;
  run substantive pass; assert proposal exists; accept; assert the
  promoted entry exists at the parent and originals are superseded.

## Verification

- `yarn typecheck && yarn test`.
- MCP smoke: confirm `propose_memory_curation` registered.
- Preview pass:
  1. Seed a workspace with three sibling memory entries that should
     cluster.
  2. Trigger the substantive pass via `/api/gardener/run`.
  3. Open `/memory/gardener` → confirm run summary appears.
  4. Open the resulting proposal in the PM review pane → accept →
     confirm promoted entry exists at the parent scope.
- Manual: write a `priority: 'critical'` entry from a builder context;
  observe disseminate run firing within ~30s and a proposal landing.
- Manual closure: transition a story-level initiative to `cancelled`;
  observe a closure proposal listing its attached entries with
  quarantine-default classifications; accept; confirm entries become
  excluded from active retrieval for sibling tasks.
- Manual quarantine: from a dispatch log, click "Report bad memory"
  on a retrieved snippet; observe quarantine proposal listing
  downstream consumers and peer candidates within ~30s.

## Open questions

- **Gardener as named agent vs role on existing agents.** Naming a
  dedicated gardener agent gives it its own openclaw session and
  prompt — cleaner separation, but more agent roster overhead. Folding
  into the learner reuses an existing agent at the cost of a more
  complex prompt. Recommend: separate agent if the prompt complexity
  warrants (it likely will once seeding is in scope), folded otherwise.
  Decide at first-PR time.
- **Embedding re-runs on model change.** If a workspace switches
  embedding provider (e.g. Ollama `nomic-embed-text` → cloud
  `voyage-3-lite`), all entries need re-embedding. Gardener owns the
  migration pass — define the contract before adopting a second
  provider.
- **Cross-workspace gardening.** Out of scope for v1. A future
  org-of-workspaces view might want a meta-gardener that promotes
  patterns across workspaces, but that's a separate design.
- **GitHub read path coupling.** The verify + seed jobs benefit from
  GitHub API access (commit history, PR bodies, issue search). Spec
  is independent — gardener works without it, just with thinner
  source coverage. If GitHub read lands, verify/seed get richer.

## Out of scope (followups)

- A "memory diff" view across supersede chains (audit-grade).
- Operator-driven "force promote" / "force prune" buttons that
  bypass proposal review.
- Multi-modal memory (screenshots, voice notes) — text-only for v1.
- Per-tag retrieval boosts ("entries tagged `#critical` always
  surface").
- Gardener-driven initiative reorg (gardener sees patterns suggesting
  an initiative restructure → emits PM proposals). Tempting, out of
  scope here — current spec keeps gardener bounded to memory.
