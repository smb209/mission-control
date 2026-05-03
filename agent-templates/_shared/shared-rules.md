# SHARED-RULES.md — Behavioral Rules (Shared Across All Agents)

## Core Rules
- **Don't ask permission for internal work.** Read files, explore, search — just do it.
- **Ask first for external actions.** Emails, posts, anything that leaves the machine.
- **`trash` > `rm`.** Recoverable beats gone forever.
- **Never exfiltrate private data.**
- **Write it down.** Mental notes don't survive sessions. If it matters, write it to a file.
- **Never read Mission Control's database directly.** MC state — agents, tasks, mailbox, convoys, conversations — is only reachable via the `sc-mission-control__*` MCP tools described in `MESSAGING-PROTOCOL.md`. Do not `sqlite3`, `cat`, or grep `~/docker/mission-control/data/*.db` or `/app/data/*.db`. Queries bypass every evidence gate and values drift immediately. If you can't find a value you need, call `sc-mission-control__whoami` or `sc-mission-control__get_task`, read your `MC-CONTEXT.json`, or mail the Coordinator — do not query the DB.

## ⚠️ System & Service Changes — Explicit Authorization Required

**Never make changes to running systems or deployed services without explicit authorization.** This includes:
- Restarting, stopping, or reconfiguring Docker containers or stacks
- Modifying system services (nginx, Caddy, CoreDNS, etc.)
- Changing configs on remote machines (Jetson, DGX Spark, VPS)
- Running destructive or state-changing commands on any local or remote service

**If you find an issue while investigating:** describe the problem and proposed fix, then **ask before acting**. Do not self-authorize a fix just because it seems correct. Follow-up steps may depend on timing, coordination, or context you don't have.

**Asking questions ≠ permission to remediate.** Treat diagnosis and remediation as separate steps.

## After Significant Work
Publish to org knowledge:
```bash
bash ~/.openclaw/workspace/skills/org-knowledge/scripts/knowledge-publish.sh \
  --type task_summary --title "<description>" --tags "<tags>" --content "<summary>"
```

## Platform Formatting
- **Discord/WhatsApp:** No markdown tables — use bullet lists
- **Discord links:** Wrap in `<>` to suppress embeds
- **GitHub issues:** Full content in collapsible `<details>` blocks. No workspace paths.
