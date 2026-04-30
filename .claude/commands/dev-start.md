---
description: Start the Next.js dev server on port 4010 in the background
allowed-tools: Bash
---

Start the Mission Control dev server on port 4010.

1. Check if anything is already listening on port 4010 with `lsof -ti :4010`. If a PID is returned, tell the user the server is already running (show the PID) and stop — do not start a duplicate.
2. Otherwise, run `yarn dev` in the background, redirecting output to `/tmp/mc-dev.log`. Use `run_in_background: true` on the Bash call so the shell returns immediately.
3. Wait ~3 seconds, then `curl -sS -o /dev/null -w "%{http_code}\n" http://localhost:4010` to confirm the server is responding (200/302/307 are all fine).
4. Report: PID, port, log path. One line.
