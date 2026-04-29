# Followups

Small tasks flagged inline during sessions. **Most of the items that
used to live here have been promoted to the [Quality of life & minor
bugs](#) theme on prod MC** (theme `ee3c4dbe`). Once that theme exists
on the live roadmap, this doc shrinks to:

1. Items that haven't been triaged into the theme yet (drop them here
   first, decide later).
2. Items whose scope is genuinely larger than QoL but haven't earned
   their own theme — flagged "may graduate."

When you do triage an item to MC, leave a one-line breadcrumb here so
the trail is greppable.

## Promoted to MC initiatives (theme: Quality of life & minor bugs)

These have been moved from this doc to live initiatives under theme
`ee3c4dbe-55f2-481e-87c4-630e4eb02173` on prod. Edit / track them
there, not here.

- ~~Refactor browser-style alerts to a custom modal~~ → epic 1
  (Operator UX polish)
- ~~Add 'Hide offline gateway agents' toggle on /agents~~ → epic 1
- ~~`yarn openclaw:sync` prune for orphaned `-dev` agents~~ → epic 2
  (Dogfood-loop tooling)
- ~~`yarn agents:resync` CLI + 'Resync now' button~~ → epic 2
- ~~`refine_proposal` LLM-less for decompose_initiative~~ → epic 3
  (PM correctness)
- ~~Verify proposal review handles unknown diff kinds gracefully~~ →
  epic 3
- ~~Retire `synthesizeImpactAnalysis` fallback~~ → epic 3
- ~~Scrub stale `localhost:4000` references in older docs~~ → epic 4
  (Docs hygiene)

Plus, born straight as a story under epic 1 (UX polish):

- ~~Add draggable column widths on /roadmap~~ — surfaced 2026-04-29
  during the dogfood roadmap walkthrough; titles get truncated when
  many initiatives are visible.

## May-graduate items (not in QoL theme)

These were raised here but their scope is genuinely larger than QoL.
Holding them for a future dedicated theme rather than dumping into
the QoL bucket.

- [ ] **Roadmap-style preview on proposal review cards.** Today the
  `create_child_initiative` diff list (PR #101) shows a structured
  per-row view with $N + complexity badge + dep arrow. That's good
  for triage. What it doesn't show is the *shape* of the resulting
  work: critical-path depth, parallelism opportunities, where an XL
  decomposition is going to bottleneck. A speculative Gantt view
  that forecasts story duration from complexity (M = N days, L = M
  days, etc.) and chains via `depends_on_initiative_ids` would
  catch "this is too sequential" or "you XL'd everything" before
  accept. Plugs into the same derivation engine that drives real
  initiatives (`derived_*` fields). **Epic-sized** — naive forecast
  is one PR, velocity-driven (per agent/role/availability) is
  several. Surfaced during the dogfood theme decompose review.
  Anchor for a future "Planning UX" theme rather than a story under
  QoL.

- [ ] **`import-workspace` to reload from JSON export.** Out of scope
  on PR #93 (export-only). Output is INSERT-shaped, so an importer
  iterates `tables` in dependency order. Open question: workspace_id
  collision policy (overwrite, rename, abort). Real design space and
  not a paper-cut — waits until the round-trip use case is concrete
  enough to drive the collision-policy call.

## New / not yet triaged

(empty — drop new inline-flagged items here as we hit them, then
sweep into MC during triage.)

## Promotion criteria

If a followup grows in scope (e.g. "rewire all alerts" turns into "MC
notification system with toasts + modals + Toast queue"), it graduates
out of this doc and becomes an initiative in the prod MC roadmap with
a real description and decomposition. The bar is rough: ≥1 day of work,
or touches more than one subsystem, or wants a design doc — promote.

The May-graduate section above is for items that have *already* hit
that bar but want their own theme rather than slotting into QoL.
