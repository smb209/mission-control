---
description: Show whether the dev server is running and recent log lines
allowed-tools: Bash
---

Report dev server status.

1. `lsof -ti :4010` — running? show PID(s). If nothing, say so.
2. If running, `curl -sS -o /dev/null -w "%{http_code}" http://localhost:4010` to show responsiveness.
3. If `/tmp/mc-dev.log` exists, show the last 20 lines.
