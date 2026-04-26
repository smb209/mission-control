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

Default dev port is `4000` (`yarn dev` honors `$PORT`).

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
2. **Spec**: write a short design doc under `specs/` citing specific files/lines and the migration/test strategy.
3. **Implement**: execute against the spec, committing per logical slice.
4. **Verify**: tests + preview smoke before opening the PR.

For genuinely independent slices, consider fanning out parallel subagents (one per slice) in worktrees rather than sequencing by hand.

## MCP Server

The MCP server wrapping this app's API for openclaw workers is named `sc-mission-control`. Use that exact name when referencing it in configs, prompts, or docs.
