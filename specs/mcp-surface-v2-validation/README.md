# MCP surface v2 — validation pack

Validation pack for [`../mcp-surface-v2-build-plan.md`](../mcp-surface-v2-build-plan.md) against [`../mcp-surface-review.md`](../mcp-surface-review.md).

## Order to read

1. [`00-baseline-observations.md`](./00-baseline-observations.md) — state before any slice lands
2. [`01-pre-check-initialization.md`](./01-pre-check-initialization.md) — destructive runbook to reach a clean baseline
3. [`02-test-plan.md`](./02-test-plan.md) — V1–V6 scenarios with setup/action/observation
4. [`03-validation-criteria.md`](./03-validation-criteria.md) — gates per scenario + globals
5. [`04-e2e-run-results.md`](./04-e2e-run-results.md) — verdict + evidence (written after run)

## How this pack is used

Per [`../long-unattended-feature-dev.md`](../long-unattended-feature-dev.md): every slice has its own per-PR test plan in the PR body for spot-checking; this pack is what the operator reads to decide "ship the stack." All real-agent dispatches use `spark-lb/agent`.

Capture root: `/tmp/mc-validation/mcp-surface-v2/<scenario>/`.
