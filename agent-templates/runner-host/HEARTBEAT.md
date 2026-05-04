# HEARTBEAT.md — mc-runner (intentionally empty)

# This file is intentionally empty for the neutral runner. The runner
# is a session host, not a scheduled actor — heartbeat tasks belong
# on workspace PMs (`mc-pm-<slug>(-dev)`) or specific role agents.
#
# Keep this file empty (only comments) to skip heartbeat API calls.
# Don't add tasks here without a corresponding ADR — the runner's job
# is to react to MC dispatches, not to drive its own schedule.
#
# Managed by `agent-templates/runner-host/HEARTBEAT.md` in the MC repo;
# `yarn runner-host:reseed` will overwrite this file with the canonical
# empty stub on each run.
