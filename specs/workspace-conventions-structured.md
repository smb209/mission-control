# Workspace Conventions: Structured Fields + Templates + Refine

The workspace `conventions` text on `/workspace/<slug>/settings` is one freeform markdown blob. Operators end up rewriting the same boilerplate per project (paths, repo URL, base branch, package manager, port reservations). The blob also gets duplicated visually inside `<AgentPromptPreview>` on the same page, eating vertical space in narrow viewports.

This spec replaces "one big textarea + a memory-prone copy each time" with **a tiny set of structured fields + templates + variable substitution + an optional agent-driven refine step.** Existing workspaces are unchanged until the operator opts in.

## What stays the same

- `workspaces.context_md` is still the canonical narrative store. Templates write into it; the dispatch route still reads it.
- `get_workspace_context` MCP tool keeps its current shape — agents see the same structure.
- The settings page keeps its layout; we add controls *above* the conventions textarea.

## What's new

### 1. Required structured fields (already exist on the table)

| Field | Existing column | Notes |
|-------|-----------------|-------|
| `name` | `workspaces.name` | unchanged |
| `workspace_path` | `workspaces.workspace_path` | unchanged |
| `deliverables_path` | `workspaces.deliverables_path` | unchanged; defaults to `workspace_path` if blank (existing behavior) |

No schema migration needed for the required-fields slice. Bare-minimum-functional ships in PR 1.

### 2. Optional structured fields (new columns)

| Field | Type | Purpose |
|-------|------|---------|
| `repo_url` | TEXT | drives `gh pr create --repo` enforcement guidance, UI chip ("fork → upstream") |
| `default_base_branch` | TEXT | drives `--base` enforcement guidance |
| `local_repo_init` | INTEGER (0/1) | when true, server-side `git init` runs at save time inside `workspace_path` (idempotent — no-op if `.git/` already exists) |

All nullable. Migration: PR 2.

### 3. Variable substitution (`{{...}}`)

Postman / standard-template syntax. The resolver replaces these tokens at render time:

| Token | Source |
|-------|--------|
| `{{name}}` | `workspaces.name` |
| `{{working_dir}}` | `workspaces.workspace_path` |
| `{{deliverables}}` | `workspaces.deliverables_path` (falls back to `workspace_path`) |
| `{{repo_url}}` | `workspaces.repo_url` (PR 2; before PR 2 lands, expands to empty + warning) |
| `{{base_branch}}` | `workspaces.default_base_branch` (PR 2; same fallback) |

Behavior:
- Unknown tokens render as literal `{{whatever}}` with a `⚠️` chip in the preview pane so typos are visible.
- Empty values render as the empty string but emit a `⚠️ {{repo_url}} (empty)` chip in the preview pane only — the dispatched agent prompt swallows the warning silently (we don't want noisy `⚠️` lines mid-prompt).
- Resolver is one regex pass; no template engine.

Resolver lives at `src/lib/workspace-conventions/resolve-variables.ts`. Wired into:
- `<AgentPromptPreview>` (settings page)
- `get_workspace_context` MCP tool
- Dispatch route (`src/app/api/tasks/[id]/dispatch/route.ts`)

### 4. Templates

Pre-written `.md` files with frontmatter under `src/lib/workspace-templates/`. Each file:

```md
---
slug: code
title: Code project
description: Repository-backed codebase with tests, PRs, and a build pipeline.
intended_for: developers / coding agents
---

## Repos
- Working tree: {{working_dir}}
- Repo: {{repo_url}} (default base: {{base_branch}})
...
```

Initial set:
- `blank.md` — empty body; minimal frontmatter.
- `code.md` — repo / language-agnostic version of today's mission-control conventions.
- `research.md` — sources / output format / style guide / review path.
- `writing.md` — tone / voice / draft locations / review path.
- `ops.md` — runbook locations / on-call rules / change windows.

Templates are read at request time (no bundling step). A small server-side function `listTemplates()` parses frontmatter via gray-matter (already a transitive dep via Next? — check; otherwise add). UI shows a `<select>` of templates by `title`; selecting one inserts the body into the conventions textarea.

Switching templates after the textarea has content prompts the operator via `ConfirmDialog` ("replace existing conventions?") — same project rule, no native `confirm`.

### 5. Local-repo init checkbox

**Path translation note (PR 4).** The `workspace_path` column stores the **host** path so host-side gateway agents can find the working tree. When MC itself runs in Docker (prod at `:4001`), that host path isn't valid inside the container. The `git init` runner therefore translates host → container via the existing `hostPathToContainerPath` helper, which uses the bind mount declared by `MC_DELIVERABLES_HOST_PATH` / `MC_DELIVERABLES_CONTAINER_PATH`. When MC runs natively (`yarn dev` at `:4010`) the translator is a no-op (host root === container root). Paths outside the bind mount surface a clear error ("translated to X inside MC ... is the bind mount configured?") rather than silently failing.

**Original §5 below.**



In the Repo section of the settings page (PR 1 lands the checkbox even though `repo_url` itself ships in PR 2 — the use case is "I have a folder, no remote yet, just init git for me"):

- Single boolean field `local_repo_init` (column added in PR 2; pre-PR-2 the checkbox writes to a transient state and only takes effect on PR-2 save).
- Wait — to avoid this footgun, **PR 1 ships the column too** (one-line schema migration alongside the resolver work). Actual use of `repo_url` etc. waits for PR 2.
- On save, server runs:
  ```js
  if (settings.local_repo_init && !existsSync(join(workspace_path, '.git'))) {
    await execFile('git', ['init', '-b', settings.default_base_branch ?? 'main'], { cwd: workspace_path });
  }
  ```
- Failure surfaces as a non-blocking warning toast — the workspace save still succeeds.

### 6. Refine button (PR 3)

Operator clicks **"Refine with agent"** under the conventions textarea. Flow:

1. Modal opens: shows the current conventions body and a one-line operator note ("optional — what would you like the agent to focus on?").
2. On submit: `POST /api/workspaces/:id/refine-conventions` with `{ current_conventions, operator_note }`.
3. Route dispatches a writer/coder agent in a fresh session via `dispatchScope` with `scope_type='conventions_refine'`. New agent role; uses any available code/writer agent in the roster.
4. Agent receives:
   - The current conventions text
   - Workspace facts (name, paths, repo_url, base_branch)
   - Available `{{...}}` variables list
   - System prompt: "Review the conventions for clarity, completeness, and consistency. Either propose a fully-rewritten replacement (markdown) OR ask up to 5 clarifying questions. Return JSON `{ kind: 'replacement' | 'questions', body: string, questions?: string[] }`."
5. Agent's reply is parsed and returned to the operator as a proposal — modal swaps to a review pane:
   - **Replacement**: shows side-by-side diff (or "swap" button if diff lib is heavy); operator clicks Accept (writes body to `context_md`) or Discard.
   - **Questions**: shows the questions; operator types answers inline; clicking "Send answers" re-dispatches with the answers appended to operator_note.
6. Persistence: a transient `pm_proposals`-shaped row? **No** — too much overlap with PM. Use a new lightweight table `workspace_conventions_proposals` with columns `id`, `workspace_id`, `kind`, `body`, `questions_json`, `status`, `created_at`. Default status `'open'`; `'accepted'` on apply; `'discarded'` on close.

### 7. Settings UI cleanup (in PR 1)

While we're touching the page:
- `<AgentPromptPreview>` collapses by default in narrow viewports (under ~900px). Operator clicks "Show prompt preview" to expand. Above the threshold, current side-by-side layout is preserved.

## Schema (PR 2 migration)

```sql
-- migration 082_workspace_repo_fields.ts
ALTER TABLE workspaces ADD COLUMN repo_url TEXT;
ALTER TABLE workspaces ADD COLUMN default_base_branch TEXT;
ALTER TABLE workspaces ADD COLUMN local_repo_init INTEGER NOT NULL DEFAULT 0;
```

Optional follow-up index if `repo_url` ends up filtered (unlikely): skip.

## API surface

- `GET /api/workspace-templates` — returns `[{ slug, title, description, intended_for, body }]`. Static read of the templates dir.
- Existing `PATCH /api/workspaces/:id/settings` route grows fields for `repo_url`, `default_base_branch`, `local_repo_init` (PR 2). Server-side `git init` runs on save when `local_repo_init` flips true.
- `POST /api/workspaces/:id/refine-conventions` (PR 3).

## MCP tool changes

- `get_workspace_context` (PR 1) extends its return shape: `{ workspace_id, workspace_name, context_md, present, working_dir, deliverables, repo_url?, base_branch?, resolved_context_md }`. The new `resolved_context_md` is `context_md` with `{{...}}` expanded — agents prefer this; existing fields preserved for back-compat.
- Existing dispatch route already prepends `## Workspace conventions`; switch to `resolved_context_md` so agents stop seeing `{{working_dir}}` literally.

## Non-goals (named so we don't drift)

- No multi-template stacking. One template at a time. Operator can hand-merge multiple if desired.
- No template versioning. Updates to templates ship in the repo; operators re-pick if they want updates.
- No live re-render of `{{...}}` mid-keystroke in the textarea — only in the preview pane and at dispatch time. Keeps the editor predictable.
- No template editing UI. Templates are repo-shipped only; if an operator wants a custom template they edit the file directly (or refine inline).

## Verification gates

Per the project's spec-first rule, each PR has a preview-verify gate before opening:

**PR 1**
1. Settings page renders the template dropdown + checkbox.
2. Picking a template inserts text into the textarea.
3. `<AgentPromptPreview>` shows resolved `{{working_dir}}` etc.
4. Save with `local_repo_init` checked on a path without `.git` runs `git init`; second save no-ops.
5. `get_workspace_context` returns `resolved_context_md`.
6. Existing dispatch flow still works (no regressions on a real Investigate or PM-chat dispatch).

**PR 2**
1. Migration applies cleanly on dogfood DB.
2. Settings page shows the Repo subsection; values save and round-trip.
3. Templates referencing `{{repo_url}}` / `{{base_branch}}` resolve correctly.
4. Existing workspace dispatches unchanged when fields are blank.

**PR 3**
1. Refine button opens the modal.
2. Submit dispatches an agent (verify with a real run; capture proposal output).
3. Replacement-kind reply: accept replaces `context_md`; discard leaves it.
4. Question-kind reply: operator can answer + re-dispatch; second reply settles.
5. `workspace_conventions_proposals` rows lifecycle (open → accepted/discarded).

## Out of scope (followups)

- Variable substitution in template *frontmatter* (only body is resolved).
- Bulk re-template across many workspaces.
- "Default workspace" presets stored at user level.
- A composer for the AI-fill-from-blank flow (the user's earlier idea — the refine flow covers iteration but not from-zero generation).
