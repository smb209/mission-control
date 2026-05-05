<h1 align="center">Sextant</h1>

<p align="center">
  <em>An autonomous systems-engineering team for software products</em>
</p>

<p align="center">
  <strong>Plan, decompose, dispatch, verify — with humans in the loop where it matters.</strong><br>
  Initiatives → Tasks → Build → Test → Review → PR, with a PM agent on the bridge.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Next.js-16-black?style=flat-square&logo=next.js" alt="Next.js 16" />
  <img src="https://img.shields.io/badge/React-19-149eca?style=flat-square&logo=react" alt="React 19" />
  <img src="https://img.shields.io/badge/TypeScript-6-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript 6" />
  <img src="https://img.shields.io/badge/Tailwind-4-38B2AC?style=flat-square&logo=tailwindcss&logoColor=white" alt="Tailwind 4" />
  <img src="https://img.shields.io/badge/SQLite-3-003B57?style=flat-square&logo=sqlite&logoColor=white" alt="SQLite" />
  <img src="https://img.shields.io/badge/MCP-sc--mission--control-orange?style=flat-square" alt="MCP" />
  <img src="https://img.shields.io/badge/license-MIT-green?style=flat-square" alt="MIT" />
</p>

<p align="center">
  <a href="#-what-sextant-is">What Sextant is</a> •
  <a href="#-the-loop-today">The loop today</a> •
  <a href="#-capabilities-today">Capabilities</a> •
  <a href="#-architecture">Architecture</a> •
  <a href="#-where-sextant-is-going">Roadmap</a> •
  <a href="#-quick-start">Quick Start</a> •
  <a href="#-docker">Docker</a> •
  <a href="#-configuration">Configuration</a>
</p>

---

## 🛰 What Sextant is

Sextant is a self-hosted control surface for an AI-driven engineering team. A **PM agent** sits between you and the build/test/review agents on an OpenClaw gateway: you talk to it about initiatives, it helps decompose them into tasks, dispatches the work, and watches whether the results still match what you asked for. Cost and agent health are tracked as you go.

This project is a fork of [crshdn/mission-control](https://github.com/crshdn/mission-control) (Autensa). Where upstream optimizes for autonomous *shipping* — research → swipe → PR while you sleep — Sextant is shifting the focus toward autonomous *engineering*: structured planning, an explicit roadmap layer, an MCP tool surface for agents, and a PM agent that actually plans with you. Same gateway underneath, different control plane on top.

Where it's heading is the more interesting story: a real systems-engineering discipline on top of the agent runtime — requirements artifacts with traceability, a risk register, program-level monitoring, V&V plans tied to verification methods. Most of that doesn't exist yet. The current capabilities are described below as they are, and the [roadmap](#-where-sextant-is-going) section is honest about the gap.

Three things distinguish this fork from upstream today:

1. **Initiatives layer above tasks.** A roadmap with parent/child relationships, target windows, and a drift scan that flags when tasks stop laddering to their parent. It's a goal/scope tree — *not* a requirements baseline (yet).
2. **MCP-native dispatch.** Gateway agents call `sc-mission-control` as a typed tool surface (`spawn_subtask`, `propose_changes`, `propose_from_notes`, `save_knowledge`, `send_mail`, `create_child_initiative`, …) instead of bespoke HTTP. Exercisable via an end-to-end harness.
3. **A PM agent you actually plan with.** Lives at `/pm`, persists drafts per initiative, gets a fresh gateway session per conversation, and converts freeform notes into structured proposals via a defer-and-replay queue.

---

## 🔁 The loop today

```
        ┌─────────────────── you ───────────────────┐
        ▼                                           │
    INITIATIVES ─► DECOMPOSE ─► DISPATCH ─► BUILD ─► TEST ─► REVIEW ─► PR
    (roadmap +     (PM agent    (MCP +     (build   (test   (review
     drift scan)    + tasks)     gateway)   agent)   agent)  agent)
        ▲                                                       │
        └─────────────── drift scan / proposals ◄────────────────┘
```

Each leg is implemented (see [Capabilities](#-capabilities-today)). The drift scan and PM agent close the loop by flagging when work no longer matches the parent initiative and proposing changes — but this is goal-level, not requirement-level. There's no shall-statement, no allocation table, and no formal V&V plan tying tests back to specific requirements. The [roadmap](#-where-sextant-is-going) section calls out what would have to exist for that.

---

## 🧭 Capabilities today

Plain feature description — no SE-discipline overlay. Where a feature *resembles* a systems-engineering practice but doesn't actually implement it, the [roadmap](#-where-sextant-is-going) section calls out the gap.

### Initiatives & roadmap
- Initiatives have parent/child relationships, target windows, owners, descriptions, and an inline-edit detail page.
- A roadmap timeline view spans the tree.
- Promotion endpoints turn approved ideas or PM-captured notes into initiatives.
- Tasks are initiative-aware; the PM can spawn `create_child_initiative` proposals to add structure under a parent.
- A drift scan flags when tasks no longer ladder cleanly to their parent initiative.

> Initiatives are goal/scope objects. They are *not* requirements — there are no shall-statements, no allocation tables, and nothing tying a downstream test to a specific clause. The drift scan compares task content to initiative content; it doesn't check coverage.

### PM agent
- Lives at `/pm`, backed by the named openclaw agent `mc-project-manager`.
- Drafts persist per-initiative and resume on re-open; rejected on dismiss so stale drafts don't leak forward.
- Fresh gateway session per plan/decompose conversation and per disruption dispatch — no context bleed across initiatives.
- Structured `plan_suggestions` stored in their own column; chat carries the suggestions sidecar without leaking JSON into the readable summary.
- Async dispatch with a reconciler that recovers when the gateway mislabels `trigger_kind` on returned proposals.
- `propose_from_notes`: paste raw notes, the PM converts them into structured proposals; a defer-and-replay queue holds input when the agent is busy.
- Context-window indicator + "New chat" controls on `/pm` so you can see when to recycle.

### Decomposition & convoy execution
- `spawn_subtask` is the single fan-out primitive — every fan-out is a tracked convoy subtask, not a fire-and-forget call.
- The PM-driven decompose flow has resume, dedup, and crash guards on partial decomposes.
- Convoy mode runs subtasks against a dependency DAG: independents in parallel, dependents wait, the graph is visible in the UI.

> This is task decomposition. There is no requirements decomposition because there are no requirements artifacts to decompose *from* or allocate *to*.

### Planning flow
- A validation-first phased planner with explicit Lock & Dispatch — no implicit "the agent decided to start" steps.
- Per-option clarifier inputs on plan choices, plus a freetext clarify shape for anything that doesn't fit multiple-choice.
- A "With guidance" split-button on AI helper actions captures human steering at the moment a choice is made.

> The clarify flow records the chosen option but doesn't store alternatives-considered, weighted criteria, or rationale in a structured way. It's planning, not a trade study.

### MCP tool surface
- `sc-mission-control` is the MCP server inside this app; gateway agents call it as typed tools (`spawn_subtask`, `propose_changes`, `propose_from_notes`, `save_knowledge`, `send_mail`, `create_child_initiative`, …). The plugin name is stable.
- An adapter dashboard at `/debug/mcp` shows tool calls.
- An end-to-end harness (`yarn mcp:integration`, `yarn mcp:e2e:next`) spawns `next dev` and exercises `/api/mcp` so contracts are tested, not just type-checked.
- A shared service layer means MCP and HTTP routes execute the same business logic.

> These are typed tool definitions, not versioned interface control documents. There's no compatibility matrix, no formal change-control on the tool surface, and no consumer registry.

### Build / test / review pipeline
- The pipeline is Build agent → Test agent → Review agent → PR.
- A spec-reconciling evidence gate checks that coordinator delegations actually fired and that outputs match the locked spec before review passes.
- A preview-test flow exercises UI- and MCP-touching changes against a real `next dev` server and captures telemetry on the task.

> The review agent compares output to the spec it was handed. There is no formal verification plan, no test-to-requirement mapping, and no validation step distinct from review.

### Deliverables
- First-class artifacts on the task with friendly folder names.
- Markdown deliverables render in-browser; a dedicated `/deliverables` page lists everything; archives are downloadable.

### Monitoring & resilience
- Per-agent health: stall detection, auto-nudge, send/receive ping indicator that fades in the sidebar.
- Stalled-task scanner + admin endpoint for manual release.
- Checkpoint save/restore — work resumes from the last checkpoint after a crash.
- `/debug` console with opt-in capture of MC↔agent traffic and JSON/JSONL event export.
- Live activity feed (SSE) at the shell level: dispatch, build, test, review, cost, PR creation.
- Actionable diagnostics when an MCP launcher connect fails.

> Monitoring is per-agent today. There are no program-level KPIs (schedule variance, cost variance, V&V coverage, requirements churn) and no anomaly detection on the telemetry stream.

### Workspace & session isolation
- Per-task workspace isolation: git worktrees for repo-backed projects, sandboxes for everything else.
- Per-task agent sessions: each dispatch gets its own `openclaw_sessions` row keyed by `task_id`, so parallel tasks on the same agent don't share a context window.
- Migrations run on startup with timestamped pre-migration backups; cascade-FK behavior has guardrail tests.
- Workspace switcher with global vs per-workspace settings, including a Danger Zone.

### Cost tracking & automation tiers
- Per-task, per-product, and daily/monthly cost aggregates.
- Cost caps auto-pause dispatch when exceeded.
- Per-product automation tier:

  | Tier | Behavior | Best for |
  |:--|:--|:--|
  | **Supervised** | PRs created automatically. You review and merge manually. | Production apps |
  | **Semi-Auto** | PRs auto-merge when CI passes and review agent approves. | Staging & trusted repos |
  | **Full Auto** | End-to-end: idea → deployed feature, no human gate. | Side projects & MVPs |

### Knowledge base
- A `Learner` agent captures lessons from completed build cycles.
- The `save_knowledge` MCP tool lets agents write entries directly; knowledge is opt-in per dispatch and mail flooding is capped.

### Autopilot (inherited from upstream)
- Tinder-style swipe deck, Maybe Pool, preference learning, Product Program (Karpathy AutoResearch pattern), product schedules, autonomous research and ideation. All still functional; treated as one input source feeding the initiative tree alongside `propose_from_notes` and direct `/pm` planning.

---

## 🏗 Architecture

```
┌─────────────────────────────── YOUR MACHINE ────────────────────────────────┐
│                                                                             │
│  ┌──────────────────────────┐       ┌─────────────────────────────────┐     │
│  │  Sextant (Next.js, :4000) │◄────►│  OpenClaw Gateway (:18789)       │     │
│  │                          │  WS   │                                 │     │
│  │  ┌───────────────────┐   │       │  ┌───────────────────────────┐  │     │
│  │  │ /pm — PM agent UI │   │       │  │ build / test / review /   │  │     │
│  │  │ /roadmap          │   │       │  │ learner / mc-project-mgr  │  │     │
│  │  │ /agents /debug    │   │       │  └───────────────────────────┘  │     │
│  │  └───────────────────┘   │       │             ▲                   │     │
│  │           │              │       │             │ MCP tools         │     │
│  │           ▼              │       │             ▼                   │     │
│  │  ┌──────────────────────┐ │      │  ┌───────────────────────────┐  │     │
│  │  │ /api/mcp             │◄┼──────┼──┤ sc-mission-control client │  │     │
│  │  │ (sc-mission-control) │ │      │  └───────────────────────────┘  │     │
│  │  └──────────┬───────────┘ │      └─────────────────────────────────┘     │
│  │             ▼              │                  │                          │
│  │  ┌──────────────────────┐ │                  ▼                          │
│  │  │ SQLite               │ │      ┌─────────────────────────────────┐    │
│  │  │ (initiatives, tasks, │ │      │ AI Providers                    │    │
│  │  │  pm_proposals, costs,│ │      │ (Anthropic / OpenAI / via       │    │
│  │  │  convoys, deliverbls)│ │      │  OpenRouter)                    │    │
│  │  └──────────────────────┘ │      └─────────────────────────────────┘    │
│  └───────────────────────────┘                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Sextant** = control plane (this project). **OpenClaw Gateway** = agent runtime ([separate project](https://github.com/openclaw/openclaw)). **`sc-mission-control`** = MCP server inside Sextant that gateway agents call as tools. The MCP plugin name is stable — use it exactly when wiring openclaw configs.

---

## 🚧 Where Sextant is going

This is where the systems-engineering framing actually lives. None of the items below ship today — they're aspirations. Each one names what the current code does, the gap to the SE-grade version, and what would have to be built.

### 1. Real requirements & traceability

- **Today.** Initiatives are goal/scope objects with a parent/child tree. The drift scan compares task content to initiative content and flags divergence. There are no requirement records, no allocations, no formal trace.
- **Gap.** No shall-statements. No requirement IDs. No allocation table mapping requirements to initiatives, tasks, components, or tests. No bidirectional traceability (requirement → design → implementation → verification → result). No orphan detection at the requirement level. Stakeholders can't answer "where is requirement R-042 implemented and how was it verified?"
- **What it would take.** A `requirements` artifact (separate from initiatives), allocation tables, requirement-to-test linkage in the V&V pipeline, an audit-trail view, and a "review mode" decomposition pass that flags coverage gaps as missing-child proposals. Sizable feature; nothing in the codebase resembles it today beyond the drift scan as a distant cousin.

### 2. Risk management

- **Today.** Nothing structured. The PM agent surfaces ambiguity and dependency conflicts in chat; the dispatch reconciler recovers from gateway errors. Both are anomaly handling, not risk management.
- **Gap.** No risk register. No likelihood × impact scoring. No mitigation owners or due dates. No rollup of risks per initiative or program. Ambiguities the PM detects vanish into chat history.
- **What it would take.** A risk record type tied to initiatives and tasks, scoring, mitigation tracking, an MCP tool for the PM to open structured risks during planning, and a dashboard view. The PM's existing ambiguity detection is the natural source.

### 3. Program-level monitoring

- **Today.** Per-agent monitoring (stall, ping, checkpoint) and cost aggregates. Live activity feed via SSE. Useful for "is the agent stuck?" — not for "is this initiative in trouble?"
- **Gap.** No schedule variance against initiative target windows. No cost variance against caps as a trend. No V&V coverage metric. No orphan-task or requirements-churn signal. No anomaly detection on the telemetry stream.
- **What it would take.** A rollup layer over the existing data sources, threshold definitions, and a program dashboard. The data is mostly already collected; what's missing is aggregation, anomaly thresholds, and a UI.

### Other systems-engineering practices we'd grow into

Smaller items where the gap is real but the lift is more contained:

- **V&V plan vs review.** Today the review agent compares output to the locked spec. A real V&V pipeline would have a verification plan with verification methods (test, inspection, analysis, demonstration) per requirement, a separate validation step against the originating need, and stored evidence linked back to specific requirement IDs. Builds on the existing review agent + evidence gate but requires the requirements artifact above.
- **Interface control on the MCP surface.** Today the MCP tools are typed function definitions. SE-grade interface control would version each tool, track which gateway agents consume which version, and require change-control sign-off on breaking changes. Would build on the existing MCP harness.
- **Trade studies & decision records.** Today the clarify flow records which option was chosen. A trade study would store alternatives considered, criteria with weights, scores per alternative, rationale, and a decision record linked to the resulting initiative or task. Builds on the existing per-option clarifier inputs.
- **Configuration management beyond workspaces.** Today workspaces and sessions are isolated and migrations are backed up. CM in the SE sense would add a configuration item registry, baseline freezes per release, change requests against frozen baselines, and an audit log. The schema-cascade tests are a tiny seed.

---

## 🚀 Quick Start

### Prerequisites

- **Node.js** v18+
- **OpenClaw Gateway** — see [openclaw/openclaw](https://github.com/openclaw/openclaw)
- **Yarn** — this project uses yarn (lockfile is `yarn.lock`)
- **AI API key** — Anthropic (recommended), OpenAI, or anything reachable through OpenRouter

### Install

```bash
git clone https://github.com/smb209/mission-control.git sextant
cd sextant
yarn install
cp .env.example .env.local
```

Edit `.env.local`:

```env
OPENCLAW_GATEWAY_URL=ws://127.0.0.1:18789
OPENCLAW_GATEWAY_TOKEN=your-token-here
```

> **Where to find the token:** check `~/.openclaw/openclaw.json` under `gateway.token`.

### Run

```bash
# Terminal 1 — agent runtime
openclaw gateway start

# Terminal 2 — Sextant
yarn dev
```

Open **http://localhost:4000**.

### Production

```bash
yarn build
yarn start
```

---

## 🐳 Docker

The repo ships a single canonical compose file at the root.

### 1. Configure

```bash
cp .env.example .env
```

Set at least:

```env
OPENCLAW_GATEWAY_URL=ws://host.docker.internal:18789
OPENCLAW_GATEWAY_TOKEN=your-token-here
```

Use `host.docker.internal` when OpenClaw runs on the same host. For a remote gateway, point `OPENCLAW_GATEWAY_URL` at its reachable `ws://` or `wss://` address.

### 2. Build and start

```bash
docker compose up -d --build
```

Open **http://localhost:4000**.

### 3. Useful commands

```bash
docker compose logs -f mission-control   # tail logs
docker compose ps                        # what's up
docker compose down                      # stop
docker compose down -v                   # stop + delete SQLite/workspace volumes
```

### Data persistence

- `mission-control-data` — SQLite at `/app/data`
- `mission-control-workspace` — workspace files at `/app/workspace`
- Bind-mount: `${MC_DELIVERABLES_HOST_DIR:-$HOME/mission-control/deliverables}` → `/app/deliverables` (so finished deliverables are downloadable from the host)
- Bind-mount: `${OPENCLAW_WORKSPACES_HOST_DIR:-$HOME/.openclaw/workspaces}` → `/app/openclaw-workspaces` (so MC can drop `MC-CONTEXT.json` into each agent's workspace)

---

## ⚙️ Configuration

### Environment variables

| Variable | Required | Default | Description |
|:--|:--:|:--|:--|
| `OPENCLAW_GATEWAY_URL` | ✅ | `ws://127.0.0.1:18789` | WebSocket URL to the OpenClaw Gateway |
| `OPENCLAW_GATEWAY_TOKEN` | ✅ | — | Auth token for the gateway |
| `MODEL_DISCOVERY` | — | `auto` | `remote` (RPC), `local` (config file), or `auto` |
| `PORT` | — | `4000` | HTTP port |
| `DATABASE_PATH` | — | `./mission-control.db` | SQLite location |
| `WORKSPACE_BASE_PATH` | — | `~/Documents/Shared` | Base directory for workspace files |
| `PROJECTS_PATH` | — | `~/Documents/Shared/projects` | Per-project subdirectories |
| `MC_DELIVERABLES_HOST_DIR` | — | `~/mission-control/deliverables` | Host path bind-mounted into the container as `/app/deliverables` |
| `OPENCLAW_WORKSPACES_HOST_DIR` | — | `~/.openclaw/workspaces` | Host path to openclaw's agent workspaces (for `MC-CONTEXT.json` drops) |
| `PLANNING_TIMEOUT_MS` | — | `30000` | Wait time for planner responses |
| `PLANNING_POLL_INTERVAL_MS` | — | `2000` | Poll cadence during planning |
| `MC_API_TOKEN` | — | — | Enables bearer auth on the HTTP API |
| `WEBHOOK_SECRET` | — | — | HMAC secret for webhook validation |
| `MISSION_CONTROL_URL` | — | auto | Override for remote/custom deployments |

### Security (production)

```bash
openssl rand -hex 32   # use for MC_API_TOKEN
openssl rand -hex 32   # use for WEBHOOK_SECRET
```

When `MC_API_TOKEN` is set:
- External API calls require `Authorization: Bearer <token>`.
- The browser UI works automatically (same-origin requests are allowed).
- SSE streams accept the token as a query param.

### Multi-machine (Tailscale recommended)

```env
OPENCLAW_GATEWAY_URL=wss://your-machine.tailnet-name.ts.net
OPENCLAW_GATEWAY_TOKEN=your-shared-token
```

---

## 🗄 Database

SQLite, auto-created at `./mission-control.db`. Migrations run on startup; a timestamped backup is taken before any pending migration runs.

```bash
yarn db:seed              # seed a fresh DB
yarn db:backup            # checkpoint + copy
yarn db:restore           # restore from latest backup
yarn db:reset             # blow it away and reseed
yarn db:checkpoint        # named checkpoint
yarn db:checkpoint:list   # list checkpoints
```

Key tables (post-fork additions): `initiatives`, `initiative_dependencies`, `pm_proposals`, `pm_pending_notes`, `roadmap_*`, `owner_availability`, `convoys`, `convoy_subtasks`, `agent_health`, `work_checkpoints`, `agent_mailbox`, `agent_pings`, `cost_events`, `cost_caps`, `deliverables`, `openclaw_sessions`, plus the upstream `products`, `research_cycles`, `ideas`, `swipe_history`, `preference_models`, `maybe_pool`, `product_feedback`, `product_schedules`.

---

## 📁 Project structure

```
mission-control/
├── src/
│   ├── app/
│   │   ├── api/
│   │   │   ├── pm/                # PM agent endpoints (proposals, plan, decompose, dispatch)
│   │   │   ├── initiatives/       # Roadmap layer CRUD + promotion
│   │   │   ├── initiative-dependencies/
│   │   │   ├── roadmap/           # Timeline + drift scan
│   │   │   ├── mcp/               # sc-mission-control MCP server
│   │   │   ├── tasks/             # Task CRUD, planning, dispatch, convoy, chat
│   │   │   ├── convoy/            # Convoy mail
│   │   │   ├── agents/            # Agents, health, mailbox, discovery
│   │   │   ├── autopilot/         # Research, ideation, swipe, scheduling
│   │   │   ├── products/          # Products + autopilot config
│   │   │   ├── ideas/             # Idea CRUD + Maybe Pool
│   │   │   ├── deliverables/      # Deliverables
│   │   │   ├── costs/             # Tracking + caps
│   │   │   ├── debug/             # Event capture + export
│   │   │   ├── webhooks/          # Agent completion webhooks
│   │   │   ├── owner-availability/
│   │   │   └── openclaw/          # Gateway proxy
│   │   └── (app)/                 # Route group for the authed UI shell
│   │       ├── pm/                # /pm — PM agent UI (+ /pm/proposals/[id])
│   │       ├── initiatives/       # /initiatives + detail page
│   │       ├── agents/            # /agents
│   │       ├── autopilot/         # /autopilot — research/ideation/swipe
│   │       ├── debug/mcp/         # /debug/mcp adapter dashboard
│   │       ├── settings/          # Global settings
│   │       └── workspace/[slug]/  # Per-workspace dashboard
│   ├── components/                # Kanban, planning, agents, debug, costs UI
│   └── lib/
│       ├── agents/
│       │   ├── pm-agent.ts        # mc-project-manager link
│       │   ├── pm-dispatch.ts     # async dispatch + reconciler
│       │   ├── pm-pending-drain.ts
│       │   ├── pm-standup.ts      # proactive standup + drift scan
│       │   ├── pm-prompts/        # PM agent prompts
│       │   └── pm-soul.md         # PM agent persona/charter
│       ├── mcp/                   # MCP server + tool surface
│       ├── db/                    # Migrations + initiative/proposal/roadmap repos
│       ├── openclaw/              # Gateway client + sendChatToAgent helper
│       ├── autopilot/             # Research, ideation, swipe, maybe-pool, scheduling
│       ├── costs/                 # Tracker, caps, reporting
│       ├── deliverables/          # Artifact handling
│       ├── convoy.ts              # Convoy orchestration
│       ├── agent-health.ts        # Health monitoring + auto-nudge
│       ├── checkpoint.ts          # Save/restore
│       ├── master-orchestrator.ts # Cross-cutting dispatch coordination
│       ├── learner.ts             # Knowledge base / learner
│       └── …
├── docs/
│   ├── AGENT_PROTOCOL.md
│   ├── HOW-THE-PIPELINE-WORKS.md
│   ├── MCP-QUICKSTART.md
│   ├── ORCHESTRATION_WORKFLOW.md
│   ├── PREVIEW_TEST_FLOW.md
│   └── PREVIEW_TEST_FINDINGS.md
├── mcp-launcher/                  # MCP smoke-test launcher
├── scripts/                       # Test harnesses, db checkpoints, integration runners
└── specs/                         # Feature specs
```

---

## ✅ Verification

Sextant ships several test slices. Use them in this order before opening a PR:

```bash
yarn test              # full TS test suite (parallel-safe per-process DBs)
yarn mcp:smoke         # MCP launcher smoke test
yarn mcp:integration   # MCP integration harness
yarn mcp:e2e:next      # spawns `next dev` and exercises /api/mcp end-to-end
```

For UI- or MCP-tool-touching changes, run a preview-verify pass per [`docs/PREVIEW_TEST_FLOW.md`](docs/PREVIEW_TEST_FLOW.md):

1. Start a preview server.
2. Drive the change with the MCP preview tools.
3. Treat preview logs as ground-truth — paste the relevant excerpt into the PR description.

If a change can't be exercised by the preview (different runtime, types-only, etc.), say so explicitly in the PR rather than running an irrelevant smoke test.

---

## 🔧 Troubleshooting

**Can't connect to OpenClaw Gateway**

1. `openclaw gateway status` to confirm it's running.
2. Verify URL and token in `.env.local`.
3. Check that nothing is blocking port `18789`.

**Planning questions never load**

1. Check OpenClaw logs: `openclaw gateway logs`.
2. Verify your AI API key is valid.
3. Refresh and retry.

**Port 4000 already in use**

```bash
lsof -i :4000
kill -9 <PID>
```

**Agent callbacks failing behind a proxy (502 errors)**

If you're behind an HTTP proxy (corporate VPN, Hiddify, etc.), agent callbacks to `localhost` may be intercepted. Bypass localhost:

```bash
export NO_PROXY=localhost,127.0.0.1
# Docker: pass -e NO_PROXY=localhost,127.0.0.1
```

See [Issue #30](https://github.com/crshdn/mission-control/issues/30) on upstream.

**HMR / fonts return 403 from another machine on the LAN**

Next 15+ requires explicit `allowedDevOrigins` in `next.config.mjs`. Add the LAN host or `*.local` entry rather than chasing browser-cache theories.

---

## 🛡 Privacy

Sextant is open source and self-hosted. The project does **not** include ad trackers, third-party analytics beacons, or a centralized data collector. Your initiatives, tasks, research, ideas, swipe history, deliverables, and PM transcripts stay in your own deployment (SQLite + workspace). If you connect external services (AI providers, remote gateways), only what you explicitly send leaves your environment.

---

## 🤝 Contributing

1. Fork this repo.
2. Branch: `git checkout -b feat/your-thing`.
3. Commit. Use conventional prefixes (`feat:`, `fix:`, `refactor:`, `docs:`, …).
4. Push and open a PR against `main` on this fork.

Before opening a PR:

- `yarn test` (full suite — list any pre-existing failures explicitly rather than ignoring them).
- For UI/MCP changes, run the preview-verify pass and paste the excerpt into the PR body.
- Use `## Summary` / `## Changes` / `## Test plan` sections.

See [CLAUDE.md](CLAUDE.md) for the full project conventions used by AI assistants and humans alike.

---

## 👏 Contributors & Lineage

Sextant builds on the work of the upstream [crshdn/mission-control](https://github.com/crshdn/mission-control) (Autensa) community. Credit to everyone listed in the upstream README for the original autopilot pipeline, convoy mode, swipe loop, cost tracking, gateway integration, Docker support, and dozens of bug fixes along the way.

Fork-specific work (initiative tree, MCP cutover, PM agent, spec-reconciling evidence gate, async dispatch, preview-test flow) lives entirely in this repo's git history — see [merged PRs on the fork](https://github.com/smb209/mission-control/pulls?q=is%3Apr+is%3Amerged).

---

## 📜 License

MIT — see [LICENSE](LICENSE).

---

## 🙏 Acknowledgments

- The upstream **Autensa** project (crshdn/mission-control) for the agent runtime, autopilot loop, and the architectural bones this fork builds on.
- **[Andrej Karpathy's AutoResearch](https://github.com/karpathy/autoresearch)** — pattern that inspired the Product Program concept.
- **[OpenClaw Gateway](https://github.com/openclaw/openclaw)** — the AI agent runtime Sextant dispatches to.

---

<p align="center">
  <strong>Stop juggling a backlog. Start running a program.</strong>
</p>
