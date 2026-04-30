---
description: Stop the dev server running on port 4010
allowed-tools: Bash
---

Stop the Mission Control dev server.

1. Find the PID(s) with `lsof -ti :4010`.
2. If none, tell the user nothing is running on 4010 and stop.
3. Otherwise, kill them with `kill <pid>` (try graceful first; only escalate to `kill -9` if a PID is still listening after 2 seconds).
4. Confirm port 4010 is free and report what was stopped. One line.
