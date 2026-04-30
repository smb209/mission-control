---
description: Wipe dev DB, sync agents from openclaw, and import prod data with mc-* → mc-*-dev remap
allowed-tools: Bash
---

Refresh the dev DB to a clean prod-shaped baseline. Used for validating
changes against real workspaces / tasks / convoys without inheriting
prod's gateway-bound agent identities.

End state:
- Dev DB has prod's workspaces, products, tasks, convoys, deliverables, etc.
- Dev's own openclaw-synced agents (`mc-*-dev`) replace prod's (`mc-*`).
- Every FK that pointed at a prod agent is rewritten to its dev equivalent — no NULLed columns, no deleted bridge rows.
- `PRAGMA foreign_key_check` clean. Migrations 058/059/060 applied.

## Procedure

1. **Ensure dev MC is stopped.** `lsof -ti :4010` — if a PID is returned, kill it and wait until the port is free (the import refuses to run while MC is bound).

2. **Wipe dev DB.** `rm -f mission-control.db mission-control.db-shm mission-control.db-wal`.

3. **Start dev MC in the background** so openclaw sync runs. `yarn dev > /tmp/mc-dev.log 2>&1 &` with `run_in_background: true`. Wait until port 4010 is bound (poll `lsof -ti :4010` once a second, up to ~30s).

4. **Wait for the agent sync.** Sleep ~10 seconds after the port comes up so `syncGatewayAgentsToCatalog({reason: 'startup'})` completes. Confirm with `sqlite3 mission-control.db "SELECT COUNT(*) FROM agents;"` — expect 17 (8 prod-style `mc-*` + 8 dev-style `mc-*-dev` + `main`). The dual roster is expected; we filter in the next step.

5. **Stop dev MC.** Kill the pid from step 3, wait until the port is free.

6. **Drop prod-style agents** synced into dev (we only want the `-dev` variants and `main`):

   ```
   sqlite3 mission-control.db "DELETE FROM agents WHERE gateway_agent_id NOT LIKE '%-dev' AND gateway_agent_id != 'main' AND name != 'main';"
   ```

   Confirm: `SELECT COUNT(*) FROM agents;` — expect 9.

7. **Snapshot prod** from the running stable container:

   ```
   mkdir -p /tmp/mc-prod-snap
   docker cp mission-control:/app/data/mission-control.db /tmp/mc-prod-snap/prod.db
   ```

   If the `mission-control` container isn't running, ask the user how they'd like to provide a prod snapshot before proceeding.

8. **Import + remap.**

   ```
   yarn db:import-from-prod \
     --source /tmp/mc-prod-snap/prod.db \
     --agent-suffix=-dev \
     --yes
   ```

   Watch the log for `agent name remap (suffix='-dev'): N matched, M unmatched` — `unmatched` should be 0. If it's nonzero, surface which prod agents weren't matched.

9. **Final integrity check.** Run:

   ```
   sqlite3 mission-control.db "PRAGMA foreign_key_check;"
   sqlite3 mission-control.db "SELECT id FROM _migrations ORDER BY id DESC LIMIT 3;"
   sqlite3 mission-control.db "SELECT t.id, t.status, a.name, a.gateway_agent_id FROM tasks t LEFT JOIN agents a ON a.id = t.assigned_agent_id;"
   ```

   `foreign_key_check` should be empty. The migrations list should include `060`. Tasks should have non-null assignees with `mc-*-dev` gateway ids.

## Report

The import tool prints a side-by-side BEFORE/AFTER table covering all
the substantive surfaces — initiatives, PM proposals, ideas, tasks,
deliverables, evidence, knowledge, agent_chat_messages, agent_mailbox,
rollcalls, events, etc. **Surface this table verbatim in your reply
so the operator can see exactly what came across — not a hand-picked
slice.**

After the table, end with one line summarizing the agent remap,
FK-fixup counts, and integrity status. Example:

> Synced. 9 dev agents preserved (8 mc-*-dev + main), 9/9 source agents
> remapped, all FKs rewritten (no NULLed columns, no deleted bridge
> rows). 71 initiatives, 15 PM proposals, 49 rollcall entries, 42
> mailbox rows, 25 agent chat messages, 1379 events imported.
> PRAGMA foreign_key_check clean. Migrations through 060.

Do not start MC at the end — leave the operator to start it when
they're ready to validate.
