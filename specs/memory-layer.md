# Memory layer — grounding agents in workspace + initiative context

## Why

Today's MC has a knowledge surface (`knowledge_entries`) that's
workspace-scoped and untyped beyond a small enum (`failure | fix |
pattern | checklist`). When a builder/coordinator dispatches, it
receives the task row plus the top-K workspace lessons by confidence.
That's a flat retrieval that ignores where the task sits in the
initiative tree, and it forces all knowledge into a single global pool.

Two gaps follow:

1. **No durable workspace context**. There's no place for an operator to
   write down "frontend lives in `frontend-app`, backend lives in
   `backend-app`, we use yarn, our content schedule template lives at
   `/docs/content/template.md`." Agents have to rediscover this every
   task.
2. **No scoped project context**. An epic-level decision ("we rejected
   webhooks for billing, using polling instead") cannot be attached to
   that epic so it informs every story underneath without leaking to
   unrelated work.

The fix is a memory store that mirrors how operators and agents
already think — markdown notes scoped to a node in the initiative tree,
retrieved by similarity, injected into dispatch prompts.

This spec covers storage, retrieval, dispatch integration, and the
operator editor surface. The agentic curator that promotes / prunes /
verifies / seeds memory is a separate concern — see
[gardener.md](gardener.md).

## Design summary

```
operator + learner + coordinator + builder
        ↓ write_memory MCP / editor UI
memory_entries (markdown + embedding, scoped to org or initiative)
        ↑ getRelevantMemory({workspace_id, initiative_id?, query, k})
        ↑ tree walk: org + ancestor chain entries, ranked by similarity
dispatch prompt
  ## Workspace context (org entries)
  ## Initiative context (matched ancestor entries)
```

Two scopes: **org** (workspace-wide, NULL `initiative_id`) and
**project** (attached to a specific initiative; inherited by the entire
subtree below). Retrieval at task dispatch time pulls org entries plus
all ancestor-chain project entries above the task's initiative, ranks
by cosine similarity to the task description, and injects the top-K
into the prompt.

Memory entries are **untyped by topic**. Org memory can hold repo
conventions, vendor contacts, brand guidelines, oncall rotation, legal
SLAs, anything. The agent reads the relevant snippets and grounds its
plan accordingly — if the task is "update checkout copy" the retrieved
memory will mention repos; if it's "schedule next week's influencer
outreach" it will mention vendors. The dispatch helper does not know
the difference and does not need to.

## Data model

### New table `memory_entries`

```sql
CREATE TABLE memory_entries (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  initiative_id TEXT,                         -- NULL = org scope
  body_md TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',            -- JSON array of strings
  embedding BLOB,                              -- Float32Array, nullable until backfilled
  embedding_model TEXT,                        -- e.g. 'voyage-3-lite'
  source TEXT NOT NULL DEFAULT 'manual'        -- 'manual' | 'agent' | 'gardener' | 'seeded'
    CHECK (source IN ('manual','agent','gardener','seeded')),
  created_by_agent_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_retrieved_at TEXT,                      -- gardener input (prune signal), not retrieval internals
  retrieval_count INTEGER NOT NULL DEFAULT 0,  -- gardener input (value signal)
  last_verified_at TEXT,                       -- gardener verify pass timestamp
  superseded_by TEXT,                          -- id of newer entry; gardener promote/dedupe sets this
  archived_at TEXT,                            -- set when attached initiative closes 'done'
  quarantined_at TEXT,                         -- set when entry is flagged actively wrong
  quarantine_reason TEXT,                      -- short operator/gardener note
  priority TEXT NOT NULL DEFAULT 'normal'
    CHECK (priority IN ('normal','critical')), -- 'critical' triggers disseminate run
  FOREIGN KEY (initiative_id) REFERENCES initiatives(id) ON DELETE CASCADE
);

CREATE INDEX idx_memory_workspace_org
  ON memory_entries(workspace_id) WHERE initiative_id IS NULL;
CREATE INDEX idx_memory_initiative
  ON memory_entries(initiative_id) WHERE initiative_id IS NOT NULL;
CREATE INDEX idx_memory_active
  ON memory_entries(workspace_id)
  WHERE superseded_by IS NULL AND archived_at IS NULL AND quarantined_at IS NULL;
```

`tags` are agent-suggested annotations (`#repo:backend-app`,
`#vendor:acme`, `#convention:testing`) — useful for filtering and
dedup but **not load-bearing for retrieval**. Embeddings do the work.

Lifecycle columns and what they mean:

- `superseded_by` — chain history. Gardener promote/dedupe writes a new
  entry and supersedes originals rather than deleting; the operator can
  audit the chain.
- `archived_at` — durable record, excluded from active retrieval. Set
  by the gardener's closure pass when an initiative transitions to
  `done` and the attached entry doesn't warrant promotion. Still
  searchable for audit.
- `quarantined_at` + `quarantine_reason` — actively wrong, may have
  caused harm. Distinct from `stale_at` / "outdated"; quarantine
  excludes from retrieval immediately and triggers a blast-radius
  investigation (see gardener.md).
- `priority = 'critical'` — high-importance findings (CVE, deprecation,
  data-loss-class facts). Bypass the periodic gardener cycle and
  trigger an immediate disseminate run.
- `last_retrieved_at` + `retrieval_count` — gardener inputs only.
  Retrieval-frequency heuristics drive prune candidacy and verify
  prioritization. Not consumed by the retrieval pipeline itself.
- `last_verified_at` — set by gardener verify pass when a claim is
  spot-checked against ground truth.

### New table `memory_retrievals` — provenance graph

Every dispatch and proposal that grounds itself in memory writes one
row per consumed entry. Cheap, indexed, and the foundation of
blast-radius investigation: given a quarantined memory, find every
consumer that saw it.

```sql
CREATE TABLE memory_retrievals (
  id TEXT PRIMARY KEY,
  memory_entry_id TEXT NOT NULL,
  consumer_kind TEXT NOT NULL
    CHECK (consumer_kind IN ('task_dispatch','pm_proposal','memory_write')),
  consumer_id TEXT NOT NULL,                   -- task_id, proposal_id, or memory_entry_id
  rerank_score REAL NOT NULL,                  -- final ranking score after rerank step
  retrieved_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (memory_entry_id) REFERENCES memory_entries(id) ON DELETE CASCADE
);
CREATE INDEX idx_memory_retrievals_entry
  ON memory_retrievals(memory_entry_id);
CREATE INDEX idx_memory_retrievals_consumer
  ON memory_retrievals(consumer_kind, consumer_id);
```

The `memory_write` kind covers the case where one memory is grounded
in earlier memory — agent reads memory M1 while writing memory M2;
quarantining M1 surfaces M2 as a downstream candidate.

### Migration 056

Add both tables. No backfill needed — `knowledge_entries` continues
to exist for now. (Whether to merge them is a follow-up; see
"Open questions" below.)

## Retrieval

Use a textbook hybrid retrieval + rerank pipeline rather than rolling
custom ranking. The pieces are mature and well-benchmarked; what's
MC-specific is the **scope filter** (org + ancestor chain, exclude
archived/quarantined/superseded) — applied as metadata pre-filtering
before the standard pipeline runs.

### Pipeline

```
query
  ↓ embed (Voyage voyage-3-lite or similar)
  ↓ scope filter: (initiative_id IN ancestor_chain OR initiative_id IS NULL)
                  AND superseded_by IS NULL
                  AND archived_at IS NULL
                  AND quarantined_at IS NULL
  ├─ vector ANN (sqlite-vec) → top-50
  └─ BM25 / FTS5 keyword search → top-50
  ↓ reciprocal rank fusion → top-25
  ↓ cross-encoder rerank (Voyage rerank-2 or Cohere rerank-3) → top-K
  → return split as org[] + project[]
```

Concrete stack:

- **Vector store**: `sqlite-vec` extension. Co-located with the main
  DB, no new infra.
- **Keyword search**: SQLite FTS5 virtual table mirroring `body_md +
  tags`. Built-in, free.
- **RRF**: ~10-line utility merging the two ranked lists.
- **Embedding model + reranker**: pluggable providers (see below).
  Defaults are self-hostable; cloud providers are swap-in.

If the workspace ever migrates to Postgres, the same pipeline rewrites
to `pgvector` + `tsvector` with no change to the surrounding code.

### Local-first provider defaults

MC is designed to be self-hostable end-to-end. Models we depend on
directly **must** have a viable local-LLM path; cloud APIs are
optional accelerators, never load-bearing requirements. This applies
to embeddings, rerankers, and any future LLM call from MC's own code
(distinct from agent reasoning, which already runs on whatever model
the workspace's openclaw gateway is wired to).

Default providers, both runnable on a developer laptop or a single
self-hosted box:

- **Embeddings (default)**: `nomic-embed-text` via Ollama (768-dim,
  CPU-friendly, ~100MB), or `bge-base-en-v1.5` for slightly higher
  quality. Both run inside the existing local-inference stack the
  workspace likely already has for openclaw.
- **Reranker (default)**: `bge-reranker-v2-m3` via a small local
  inference server (TEI / text-embeddings-inference, or llama.cpp).
  Cross-encoder, runs comfortably on CPU for the ~25-candidate batch
  size the pipeline needs.

Cloud providers (Voyage, Cohere, OpenAI) plug into the same
interfaces and are workspace-config opt-in. They give better quality
in exchange for egress + API key — useful for trial workspaces, not
required.

### `getRelevantMemory(input)` — `src/lib/memory/retrieval.ts`

```ts
interface MemoryRetrievalInput {
  workspace_id: string;
  initiative_id?: string | null;       // task's parent initiative
  query: string;                        // typically the task title + description
  k?: number;                           // default 8
  consumer?: {                          // for provenance logging
    kind: 'task_dispatch' | 'pm_proposal' | 'memory_write';
    id: string;
  };
}

interface MemoryHit {
  entry: MemoryEntry;
  rerank_score: number;                 // post-rerank score, the canonical ranking signal
  scope: 'org' | 'ancestor';
  ancestor_initiative_id?: string;     // for project hits
}

interface RelevantMemory {
  org: MemoryHit[];
  project: MemoryHit[];                 // sorted by rerank_score desc
}
```

The reranker score (typically 0..1) is the only ranking signal exposed
to callers. There is no hardcoded floor cutoff — that's a tunable on
top of rerank, not an architectural decision. v1 default: keep
everything from the rerank top-K; tune later if needed.

When `consumer` is provided, retrieval writes one `memory_retrievals`
row per returned hit. This is the provenance graph the gardener uses
for blast-radius investigations; missing it makes that flow blind.

### Embedding + reranker provider interfaces

Both interfaces are designed for swap-in. Selection is workspace-
config, not per-entry. Default implementations land for the local
options listed above; cloud adapters are added incrementally.

```ts
interface EmbeddingProvider {
  id: string;                  // 'ollama:nomic-embed-text', 'voyage:voyage-3-lite', etc.
  model: string;
  dimensions: number;
  endpoint?: string;           // for HTTP-based providers (Ollama, TEI, OpenAI-compatible)
  embed(texts: string[]): Promise<Float32Array[]>;
}

interface Reranker {
  id: string;                  // 'tei:bge-reranker-v2-m3', 'cohere:rerank-3', etc.
  model: string;
  endpoint?: string;
  rerank(
    query: string,
    candidates: { id: string; text: string }[],
  ): Promise<{ id: string; score: number }[]>;
}
```

The interfaces are deliberately thin: `endpoint` covers any
OpenAI-compatible HTTP API (Ollama, TEI, llama.cpp's server,
LM Studio, vLLM, OpenAI itself), and named SaaS adapters
(Voyage, Cohere) are separate classes implementing the same shape.

Provider config lives in workspace settings (`embedding_provider_id`,
`reranker_provider_id` plus an endpoint/key map). The retrieval helper
resolves at call time so a workspace can change providers without
code changes — only the embedding-backfill cost (re-embed everything
on model switch).

Backfill path: a one-shot script `yarn memory:embed-backfill` walks
entries with NULL or stale-model `embedding` and fills them in.
Re-embedding on model change is the gardener's job (see
[gardener.md](gardener.md)).

## Dispatch integration

### Builder + coordinator + decomp prompts

When the master orchestrator hands off to a worker, the dispatch prompt
gets a new section block, BEFORE the task description:

```markdown
## Workspace context

> [org memory snippet 1]
> [org memory snippet 2]
…

## Initiative context

> [project memory snippet — from epic "Stripe migration"]
> [project memory snippet — from theme "Billing"]
…

(Above context is retrieved memory. Treat as ground truth from prior
work on this workspace. If memory is silent on something load-bearing
for your plan, say so explicitly rather than guessing.)
```

Implementation: `buildDispatchContext(taskId)` in
`src/lib/memory/dispatch-context.ts`, called from the existing dispatch
prompt builder. Returns a markdown block ready to splice in. Empty
when retrieval returns nothing — agents see no section rather than a
"no memory found" placeholder. Always passes `consumer: { kind:
'task_dispatch', id: taskId }` so the provenance log is populated.

### PM dispatch (decompose, plan_initiative)

Same hook: PM's decompose and plan-initiative prompts get the workspace
+ initiative-ancestor memory bundle. Lets the PM ground decomposition
in prior decisions ("epic uses polling not webhooks → don't propose a
webhook-handler story") without explicit operator restating.

### Greenfield tasks

If retrieval comes back empty (no org memory yet, no project memory
above this initiative), dispatch proceeds without a context block. The
prompt phrasing handles silence gracefully — there's no "no memory
found" placeholder that would invite hallucination.

## Write paths

Three ways memory enters the store:

1. **Operator (editor UI)** — primary surface for org memory.
   Markdown editor, free-text body, optional tags. `source = 'manual'`.
2. **Agent during work (`save_memory` MCP tool)** — replaces
   `save_knowledge` for new writes. Tool input: `{ scope: 'org' |
   { initiative_id }, body_md, tags? }`. `source = 'agent'`.
3. **Gardener** — proposes promotions, supersedes stale entries,
   inserts seeded findings. Goes through the proposal review machinery
   (see gardener.md) for substantive changes; mechanical changes
   (mark stale, dedupe) write directly. `source = 'gardener'` or
   `'seeded'`.

`save_memory` is persona-gated like other write tools. Builders +
coordinators + researchers + learner can write. PM cannot (PM
proposes; gardener applies).

## Editor UX

Two surfaces, both in the existing app shell:

### Workspace memory page (`/memory`)

Shows org-scoped entries. Operator can:
- Create entry (markdown editor, tags input).
- Edit / delete existing.
- Filter by tag.
- See `last_retrieved_at` + `retrieval_count` (signal of usefulness).
- See `source` (manual vs agent vs seeded) so it's clear where each
  entry came from.

Pattern matches the existing workspace settings pages — no new shell.

### Initiative detail panel — Memory tab

On each initiative detail page, a "Memory" tab lists project-scoped
entries for that initiative (not the subtree — only entries directly
attached). Same CRUD affordances as the workspace page. A small "see
inherited" toggle expands to show ancestor entries that would be
retrieved at dispatch time, read-only. Archived and quarantined
entries are hidden by default with a toggle to surface them for audit.

### "Report bad memory" surface

Every memory snippet rendered in dispatch logs or proposal review has
a one-click "Report bad memory" action. Clicking it:

1. Sets `quarantined_at` + `quarantine_reason` on the entry (excluded
   from retrieval immediately).
2. Triggers a gardener blast-radius investigation (see gardener.md)
   that lands as a review proposal within ~30s.

This is the bridge between operator-driven flagging and the gardener's
investigation flow. Without it, bad memory only gets caught when
operators manually scrub the editor pages.

### What we're NOT building yet

- Diff view across superseded chains.
- Memory search UI for operators (the agents search; operators browse).
- Bulk import flow — that's gardener territory (seeding from external
  sources).

## Migration of existing `knowledge_entries`

For now, leave them in place. The retrieval helper checks both tables
and unions results, with `knowledge_entries` mapped to the same
`MemoryHit` shape (workspace-scoped, no embedding initially).

Once the gardener is up and proves out, a one-shot migration moves
`knowledge_entries` rows into `memory_entries` (workspace-scoped),
generates embeddings, and drops the old table. Out of scope here.

## Open questions

- **`knowledge_entries` deprecation timing.** Cohabitation works but
  doubles the surface area for retrieval. Prefer to deprecate in the
  same PR as the gardener's first promote pass — that's also when
  embeddings get generated for old rows.
- **Per-tag access control?** Probably no. Memory is workspace-private
  already; the operator decides what's safe to write.
- **Cloud providers as optional accelerators.** Local defaults
  (Ollama-hosted embeddings + TEI-hosted reranker) are the supported
  path. Cloud adapters (Voyage, Cohere, OpenAI) are kept buildable
  but not required, and CI must continue to pass with cloud keys
  absent.

## Tests

- `src/lib/memory/retrieval.test.ts` — fake embedding + reranker;
  scope filter (ancestor walk + archived/quarantined exclusion);
  RRF merge of vector + BM25 lists; empty-result returns empty
  struct (not error); provenance row written when `consumer` set.
- `src/lib/memory/dispatch-context.test.ts` — block formatting with
  org-only, project-only, both, empty.
- `src/lib/db/memory-entries.test.ts` — CRUD + supersede + archive +
  quarantine state transitions.
- `src/lib/db/memory-retrievals.test.ts` — provenance log round-trip;
  cascade delete on entry removal.
- `src/lib/mcp/save_memory.test.ts` — persona gates; tag normalization.
- E2E: dispatch a task under a seeded initiative, assert the prompt
  built by the dispatcher contains the expected memory block AND the
  provenance log has one row per included entry.

## Verification

- `yarn typecheck && yarn test`.
- Migration smoke: fresh DB → seed two org entries + an initiative-
  scoped entry → call retrieval helper → confirm both surface.
- Preview pass: open `/memory`, write a workspace memory entry, dispatch
  a builder task on a child initiative, screenshot the resulting agent
  prompt logs to confirm the block lands.

## Out of scope (handled in gardener.md)

- Promotion (lifting recurring child entries to a parent or org scope).
- Pruning (marking stale, contradiction detection).
- Verification (spot-checking claims against ground truth).
- Seeding from external sources (commit history, websites, emails).
- Cross-tree consolidation.
