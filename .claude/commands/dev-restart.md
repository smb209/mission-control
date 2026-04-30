---
description: Restart the dev server on port 4010
allowed-tools: Bash
---

Restart the Mission Control dev server: run the `/dev-stop` flow, then the `/dev-start` flow.

- Stop: kill any process on port 4010 (graceful, then `-9` after 2s if needed). Skip if nothing is running.
- Start: `yarn dev` in the background with output to `/tmp/mc-dev.log`, then verify `http://localhost:4010` is responding.
- Report the new PID. One line.
