# 01 — Pre-check initialization

Destructive runbook to reach a known-good baseline before each E2E run. Halt on first failure.

## 0. Branch + working tree

```sh
cd /Users/snappytwo/snappytwo-sandbox/mission-control
git status                           # expect: clean
git rev-parse --abbrev-ref HEAD      # expect: feat/mcp-surface-v2 (or active slice branch)
```

If dirty, stash; if on wrong branch, halt.

## 1. Test-suite baseline pass

```sh
yarn test 2>&1 | tee /tmp/mc-validation/mcp-surface-v2/precheck-test.log
yarn mcp:smoke 2>&1 | tee /tmp/mc-validation/mcp-surface-v2/precheck-mcp-smoke.log
```

List any pre-existing failures (file + reason) in the run results doc — never silently ignore.

## 2. Dev DB reset

```sh
yarn db:backup
yarn db:reset
```

Dev DB is independent of prod (`project_dev_prod_db_split.md`); `db:reset` is routine.

## 3. Dev server restart (so new MCP routes register)

```sh
# In a separate terminal or background:
yarn dev   # listens on :4010 per project_lan_dev_origins.md
```

Wait until `Compiled successfully`.

## 4. MCP endpoint sanity

```sh
TOKEN=$(grep MC_API_TOKEN .env.local | cut -d= -f2)
curl -sS -H "Authorization: Bearer $TOKEN" -H "Accept: application/json, text/event-stream" \
  -X POST http://localhost:4010/api/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' \
  | tee /tmp/mc-validation/mcp-surface-v2/baseline/tools-list-default.json

# After PR 2:
curl ... http://localhost:4010/api/mcp/pm    > /tmp/.../tools-list-pm.json
curl ... http://localhost:4010/api/mcp/crud  > /tmp/.../tools-list-crud.json
```

Tool counts: pre-PR1 = 47 on default. Post-PR1 = 47 on default. Post-PR4 = 45. Post-PR5 = 44. Post-PR2 = ~16 on `/api/mcp/pm`, ~16 on `/api/mcp/crud`.

## 5. Openclaw config sanity (PR 3 / PR 3.5 onward)

```sh
yarn openclaw:apply-mc-servers --dry-run    > /tmp/.../openclaw-apply-dryrun.txt
yarn openclaw:sync-named-agents --dry-run   > /tmp/.../sync-named-dryrun.txt
```

Empty diff after live runs = idempotent ✅.

## 6. PM gateway alive

Browse to `http://localhost:4010/pm` (or LAN equivalent). Confirm the chat panel renders, no console errors.

## 7. Capture roots

```sh
mkdir -p /tmp/mc-validation/mcp-surface-v2/{baseline,V1,V2,V3,V4,V5,V6}
```

## Halt conditions

- `yarn test` regresses vs baseline → halt, surface failures.
- MCP `tools/list` count off-by-one from expected → halt, diff against baseline.
- Dev server fails to start → halt.
- openclaw.json edit not idempotent on second `--dry-run` → halt, debug script.
