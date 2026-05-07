---
title: Ops / runbook
description: Operational work — incident response, scheduled maintenance, system tending.
intended_for: ops / on-call agents
---
## Working area

- Working tree: `{{working_dir}}`
- Runbook outputs (post-mortems, change records, incident notes) go in `{{deliverables}}`.

## Source control

Operational logs benefit from being version-controlled — they form an auditable trail. Commit each significant action in its own commit (one action ↔ one commit) so the timeline is legible. If `{{repo_url}}` is set, push branches there.

## On-call rules

- _(operator: describe escalation contacts and pager / Slack channels.)_
- Never make changes during a freeze window without explicit operator approval.
- Read-only investigation is always safe. Mutations require operator sign-off unless the runbook explicitly pre-authorizes them.

## Change windows

- _(operator: list approved windows — e.g. "weekdays 10:00–16:00 PT, no Fridays".)_

## Verification

After every change, confirm it landed in the *running* system — not just in the local config. Curl the endpoint, exec into the container, query the DB. A clean local edit is not proof.

## Incident response

- Don't paper over a failure with a retry loop or an `--ignore` flag.
- If the root cause isn't clear, surface what you saw, what you tried, and what you'd try next — let the operator decide before mutations.

## Communication

- Tight updates at decision points. Long narratives belong in the post-mortem deliverable, not in chat.
- End-of-turn: ≤ 2 sentences (what changed, what's next / what's blocked).
