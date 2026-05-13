# Mission Control — Project Guide

Project-level conventions for Claude Code sessions in this repo. Keep edits here additive and concise; this file is loaded into every session's context.

## Package Manager

This project uses **yarn**. The lockfile is `yarn.lock`.

- Install: `yarn install`
- Add dep: `yarn add <pkg>` / `yarn add -D <pkg>`
- Run a script: `yarn <script>` (not `npm run <script>`)
- Same rule applies inside Dockerfiles and CI: never introduce `npm install` / `npm ci`.

The internal `npm run …` calls inside `package.json` scripts are legacy and work under yarn — leave them alone unless the task is explicitly to clean them up.

## Testing

Before declaring a change green, run the **full** suite once and inventory all failures up front. Do not iteratively add `--ignore` / `--skip` flags one failure at a time — that pattern hides pre-existing breakage and wastes cycles.

- Node/TS tests: `yarn test`
- MCP smoke: `yarn mcp:smoke`
- MCP integration: `yarn mcp:integration`

If the suite has pre-existing failures unrelated to the current change, list them explicitly in your status update (file + reason) before moving on. Don't silently ignore them.

## Pull Requests

**Target the fork.** All PRs go on `smb209/mission-control`, never upstream `crshdn/mission-control`. Always pass `--repo smb209/mission-control` to `gh pr create` so it can't auto-resolve to upstream.

```
gh pr create --repo smb209/mission-control --base main --head <branch> ...
```

**Stacked PR merge order.** When a PR is stacked on another, retarget each child PR's base to `main` **before** merging the parent with `--delete-branch`. Otherwise GitHub auto-closes the children when the parent branch is deleted.

**Before opening a PR**

1. Confirm the target repo is the fork (see above).
2. Run typecheck + the relevant test slice; surface any failures in the PR body rather than hiding them.
3. For UI or MCP-tool changes, run a preview-verify pass (see _Verification_ below) and paste the relevant excerpt into the PR description.

PR body uses `## Summary` / `## Changes` / `## Test plan` sections.

## Docker / Local Stack

There is one canonical compose file at the repo root: `docker-compose.yml`. If a task seems to require a different compose file, **stop and confirm** before editing — don't guess a path.

When a change needs to land in a running container:

1. `docker compose ps` to confirm which services are up.
2. Rebuild/restart the affected service.
3. Verify the change is actually live in the running container (curl an endpoint, hit the UI, or `docker compose exec` and inspect) — don't trust the local build alone.

Watch for **loopback URL drift**: services inside Docker can't reach `localhost`/`127.0.0.1` on the host. Use the configured service hostnames or host-gateway addresses; if you're touching one call site, grep for the rest.

## Dev Server (Next.js)

The user often browses the dev server from a different machine on the LAN. Next 15+ requires those origins to be listed in `next.config.mjs` under `allowedDevOrigins` (already configured for `192.168.50.95` and `*.local`) — without it, HMR/fonts return 403 and hydration hangs. If a new LAN host needs access, extend that array rather than chasing HMR or browser-cache theories.

**Ports.** Default dev port is `4010` (`yarn dev` honors `$PORT`).
Docker stable runs on `4001`. Port `4000` is reserved for the local
LiteLLM gateway — don't bind MC to it. Older docs may still reference
`4000` for dev; treat those as stale until scrubbed.

See [docs/DOGFOOD_PLAYBOOK.md](docs/DOGFOOD_PLAYBOOK.md) for how the
stable (`:4001`) and dev (`:4010`) instances coexist with separate
openclaw agent rosters.

## Database backups

A scheduled task in `instrumentation.ts` writes a rolling backup every
`MC_BACKUP_INTERVAL_HOURS` (default 24h) to `${dirname(DATABASE_PATH)}/backups/`,
retaining the newest `MC_BACKUP_RETAIN` files (default 14). First backup
runs ~30s after boot. Manual: `yarn db:backup` (one-off + retention),
`yarn db:backup:list` (enumerate). Off switch: `MC_BACKUP_DISABLED=1`.

WAL on macOS bind mounts has bitten us once with a transient
`SQLITE_CORRUPT` that disappeared on container restart — the file
itself was fine. Real corruption is rare; auto-backups exist mainly to
recover from operator mistakes (a bad migration, a wrong `db:reset`,
etc.) rather than file-level loss.

## UI Conventions

**No native `window.confirm()` / `alert()` / `prompt()`.** Use the reusable
dialogs in `src/components/`:

- `ConfirmDialog` — destructive or yes/no confirmations (delete, reset,
  irreversible actions). Pass `destructive` for red styling.
- `AlertDialog` — single-button informational alerts (also wired to the
  global `alert()` shim, so legacy `alert(...)` calls route through it).

Native modals block the JS event loop and aren't drivable from
preview/automation tooling, which surfaces as flaky verification runs.
Always thread the dialog through component state instead.

## Docs Tree

System documentation lives under `docs/`:

- [`docs/reference/`](docs/reference/) — current shipped capability docs (`status: current`). The canonical "how does X work today" surfaces.
- [`docs/proposals/`](docs/proposals/) — aspirational / not-yet-built designs (`status: aspirational`). Most are surfaced as SpecPage stubs in-app.
- [`docs/decisions/`](docs/decisions/) — immutable ADRs (architecture decision records). See its [README](docs/decisions/README.md).
- [`docs/archive/`](docs/archive/) — historical: shipped build plans, validation passes, superseded specs. Retained for context; not edited.

Start at [`docs/README.md`](docs/README.md) for the index.

## Spec Frontmatter Contract

Reference docs (`docs/reference/`, `docs/proposals/`) carry YAML frontmatter
with `status`, `last-verified`, `code-anchors`, `mcp-tools`, `db-tables`,
and `related-specs`. Files without frontmatter are skipped by the check,
so the codebase can migrate gradually.

Before editing a file under `src/`, grep `docs/reference/` and
`docs/proposals/` for that path appearing in a `code-anchors` block:

```
grep -rln "src/lib/foo.ts" docs/reference/ docs/proposals/
```

If a spec references the file, update the spec in the same PR — at
minimum bump `last-verified` to today's date. Fix the anchor too if
the referenced code moved or was deleted.

Frontmatter validity is enforced by `yarn docs:check`: `status` must
be one of `current` / `aspirational` / `archived` / `superseded`,
`last-verified` must be `YYYY-MM-DD`, and every `code-anchors` path
must exist on disk (line-range suffixes like `:42-58` are stripped
before the existence check). New docs should adopt this pattern —
file goes in `docs/reference/` if the code ships, `docs/proposals/` if
it's aspirational.

### Architecture Decisions

Non-obvious decisions — the kind where the *why* can't be recovered
from code alone — live as short ADRs under [`docs/decisions/`](docs/decisions/).
Write one when a spec consolidation or "we picked A over B because Z"
moment surfaces a decision a future subagent would otherwise have to
re-deliberate. ADRs are **immutable once `status: accepted`**: to
change a decision, add a new ADR that supersedes the old one (set the
old one's status to `superseded` and add `superseded-by: NNN`).
`yarn docs:check` validates the same frontmatter on `docs/decisions/`
plus the `adr-number` ↔ filename match.

## Verification (MCP Preview)

After multi-file changes that touch UI or MCP tool surfaces, verify before opening a PR:

1. `preview_start` if no server is running.
2. `preview_eval` a smoke scenario covering the change.
3. `preview_logs` / `preview_console_logs` for runtime errors.
4. `preview_snapshot` or `preview_screenshot` for visual confirmation.

Treat `preview_logs` as the ground-truth signal, not Claude's self-assessment. If the preview can't exercise the change (different runtime, types-only edit, etc.), say so explicitly instead of running an irrelevant smoke test.

## Communication Style

Keep responses tight. Prefer code-only edits and 1–3-line status updates over prose recaps. Long narrative summaries blow the output token budget on big sessions and stall progress.

- One sentence before a tool call to say what's coming.
- Brief updates at decision points or blockers; otherwise stay quiet and work.
- End-of-turn summary: ≤ 2 sentences. What changed, what's next.

## Spec-First for Non-Trivial Refactors

For multi-layer changes (DB migration + service + MCP tool + UI), follow audit → spec → implement → verify rather than editing inline:

1. **Audit**: grep/read the affected files; list current behavior and gaps.
2. **Spec**: write a short design doc under `docs/proposals/` (aspirational) or `docs/reference/` (if you'll ship in the same change) citing specific files/lines and the migration/test strategy.
3. **Implement**: execute against the spec, committing per logical slice.
4. **Verify**: tests + preview smoke before opening the PR.

For genuinely independent slices, consider fanning out parallel subagents (one per slice) in worktrees rather than sequencing by hand.

## Long Unattended Feature Development

When the operator says "go build this in a structured way, I won't review in between," follow the contract in [docs/reference/long-unattended-feature-dev.md](docs/reference/long-unattended-feature-dev.md). It codifies the 4-doc pattern (build plan + `<feature>-validation/` directory with baseline / pre-check / test plan / criteria / results) used successfully for `scope-keyed-sessions` and `autonomous-flow-tightening`. Use it for any feature that is multi-slice, real-agent-exercisable, and ships behind stacked PRs without per-slice operator review.

## MCP Server

The MCP server wrapping this app's API for openclaw workers is named `sc-mission-control`. Use that exact name when referencing it in configs, prompts, or docs.

## Inspecting openclaw sessions directly

When MC logs reference an openclaw session (session_key, session UUID, correlation_id, scope key), read the session straight from disk — no need to ask the operator to download and paste it.

Layout:

```
~/.openclaw/agents/<gateway-agent-id>/sessions/
  <session-uuid>.jsonl              # chat messages (user / assistant turns)
  <session-uuid>.trajectory.jsonl   # full event stream — tool calls, tool results, model changes, timestamps
  <session-uuid>.trajectory-path.json
```

Mapping from MC log fields:

- **session_key** like `agent:mc-runner-dev:task-<id>` → `<gateway-agent-id>` is the middle segment (`mc-runner-dev`); session UUID isn't in the key, so grep for a unique substring:
  ```sh
  grep -rl '<task_id-or-correlation_id>' ~/.openclaw/agents/<gateway-agent-id>/sessions/
  ```
  Returns the matching `.trajectory.jsonl`(s).
- **Session UUID** logged directly → straight file read at the path above.
- **Only a task_id / correlation_id / scope key** → same grep, across all agent dirs if you don't know the gateway agent: `grep -rl '<id>' ~/.openclaw/agents/*/sessions/`.

The trajectory file is the right source for tool-call-level reasoning; the bare `.jsonl` is enough for "what did the agent say." Both are append-only newline-delimited JSON, so `head -n 50` / `tail -n 50` is fine for spot-checks.
