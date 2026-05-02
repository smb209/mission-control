# FOIA Pipeline — Agent-Managed Discover → Draft → Submit → Track

**Status:** Draft v0
**Date:** 2026-05-02
**Workspace:** FOIA (`workspace_path: ~/.tmp/workspace/deliverables/foia`)
**Convention reference:** workspace `context_md` (see `/workspace/foia/settings`)

---

## 1. Goal & non-goals

**Goal.** Stand up an end-to-end pipeline where Mission Control agents
discover construction & utility contracts to FOIA, profile the relevant
agencies, draft narrowly-scoped requests, gate every submission on
operator approval, and track responses against statutory deadlines.

**Non-goals (v0).**
- No automatic submission. Every `submit` action requires an explicit
  operator approval click (UI button + audit row).
- No portal automation. v0 covers email + clipboard-to-portal; portal
  form-fill is a v1 follow-up.
- No PII handling beyond requester contact info. Records containing
  third-party PII flag and stop, never publish to a shared report.
- No fee payment automation. Operator handles every $ flow manually.

The current FOIA workspace already has an initiative tree under
`Discovery for FOIA Request Pipeline` (Agency Profile Schema, Governing
Statute, Intake Channel Detection, Fee Policy, Profile Validation,
Cache Persistence, Implementation, Verification). This spec assumes
those stories drive the build order; nothing here re-plans them.

---

## 2. Pipeline stages

```
   ┌───────────┐   ┌───────────┐   ┌──────────────┐   ┌──────────┐
   │ Discovery │──▶│  Drafting │──▶│ Approval gate│──▶│Submission│──▶ Tracking
   └───────────┘   └───────────┘   └──────────────┘   └──────────┘
       │               │                  ▲                │           │
       │               │                  │                │           ▼
       ▼               ▼                  │                ▼      ┌─────────┐
  agencies.yaml    requests/       (operator click)  correspondence│Response │
  contracts.yaml   <id>/draft.md                     /             │received │
  precedents/                                                      └─────────┘
```

**Discovery.** Researcher agent surveys jurisdictions (federal, state,
municipal), finds candidate agencies + capital projects + utility
contracts, populates `knowledge/agencies.yaml` and a target-contracts
queue (`research/contracts.yaml`).

**Drafting.** Writer agent picks one queued contract target, looks up
the agency profile (statute, FOIA officer, intake channel, fee policy),
selects a template from `knowledge/templates/`, drafts a narrowly-scoped
request, writes `requests/<request-id>/draft.md` + `metadata.json`.

**Approval gate.** Status flips to `awaiting_approval`. UI shows a
"Submit" button on the request page. Operator reviews `draft.md`,
edits if needed, clicks Submit. Server computes `submitted.md`
(immutable copy of the text actually sent), `submitted_at`, and
`deadline_at` from the agency's response window.

**Submission.** v0: server formats the request as an email body and
opens a `mailto:` link with the agency's FOIA email pre-populated, OR
copies the text to clipboard for paste into the agency portal.
Submission is logged but the actual send is operator-mediated.

**Tracking.** Coordinator scans `metadata.json` files daily, surfaces
deadline-approaching alerts (T-1 day) and overdue items, updates status
when responses arrive (operator drops them into `correspondence/`),
generates a weekly report.

---

## 3. Data model

New SQLite tables (workspace-scoped — every row carries `workspace_id`
and the existing `tasks` / `initiatives` tables already have it):

### `foia_agencies`
| col | type | notes |
|---|---|---|
| id | text PK | `<jurisdiction>:<agency-slug>` (e.g. `ca:sfpuc`) |
| workspace_id | text FK → workspaces.id | |
| jurisdiction | text | `federal`, `ca`, `ny`, `ny:nyc`, etc. |
| name | text | display name |
| foia_officer_name | text? | |
| foia_officer_email | text? | |
| portal_url | text? | |
| mailing_address | text? | |
| accepted_intake_channels | text (JSON array) | `["email","portal","mail"]` |
| fee_schedule | text (JSON) | `{"free_tier_pages": 50, "per_page_cents": 25}` |
| statute_id | text FK → foia_statutes.id | |
| profile_verified_at | text? | ISO timestamp; refresh after 30d stale |
| profile_evidence | text (JSON array) | screenshots / source URLs |
| created_at / updated_at | text | |

### `foia_statutes`
| col | type | notes |
|---|---|---|
| id | text PK | e.g. `ca-cpra`, `ny-foil`, `federal-foia` |
| jurisdiction | text | |
| citation | text | "Cal. Gov't Code § 7920 et seq." |
| response_window_days | int | 5 for CA CPRA, 20 for federal |
| business_days | int (0/1) | calendar vs business |
| common_exemptions | text (JSON array) | known reasons for denial |

### `foia_requests`
| col | type | notes |
|---|---|---|
| id | text PK | `<jurisdiction>-<agency>-<YYYYMMDD>-<topic-slug>` |
| workspace_id | text FK | |
| agency_id | text FK → foia_agencies.id | |
| task_id | text FK → tasks.id | the MC task driving this request |
| status | text | `draft`, `awaiting_approval`, `submitted`, `acknowledged`, `partial_response`, `complete`, `denied`, `appealed`, `withdrawn` |
| draft_path | text | relative to workspace_path: `requests/<id>/draft.md` |
| submitted_path | text? | populated on submit |
| submitted_at | text? | |
| deadline_at | text? | computed at submission |
| response_summary | text? | operator or Reviewer fills on response receipt |
| created_at / updated_at | text | |

### `foia_correspondence`
| col | type | notes |
|---|---|---|
| id | text PK | uuid |
| request_id | text FK → foia_requests.id | |
| direction | text | `outgoing` (us → agency), `incoming` (agency → us) |
| received_at | text | |
| medium | text | `email`, `portal`, `mail` |
| body_path | text | `requests/<id>/correspondence/<n>-<direction>.md` |
| files_dir | text? | attachments folder if any |

Cascade: deleting a workspace cascades through agencies/requests
naturally via existing `ON DELETE CASCADE` workspace_id FKs.

---

## 4. MCP tool surface

New tools exposed to the FOIA agents via the existing
`sc-mission-control` MCP server. Names follow the same convention as
existing tools (verb_noun, snake_case).

| tool | who uses | purpose |
|---|---|---|
| `search_agencies` | Researcher | find existing profiles by jurisdiction / agency-name fragment |
| `upsert_agency` | Researcher | create/update an agency profile (Discovery output) |
| `lookup_statute` | Writer, Researcher | fetch the statute row by jurisdiction |
| `enqueue_contract_target` | Researcher | append to `research/contracts.yaml` |
| `list_contract_queue` | Writer | next-up draftable contracts |
| `create_foia_request` | Writer | create a draft request (status=draft) |
| `update_foia_draft` | Writer | edit `draft.md` |
| `request_for_approval` | Writer | flip status → awaiting_approval, notify operator |
| `mark_submitted` | UI / operator | flip status → submitted, freeze submitted.md, compute deadline |
| `record_response` | Coordinator / operator | ingest incoming correspondence, update status |
| `list_open_requests` | Coordinator, Reviewer | for tracking sweeps |
| `list_overdue_requests` | Coordinator | deadline-passed cohort |

Every tool scopes by `workspace_id` (per the recent isolation work in
#141). Approval-gate tools (`mark_submitted`, anything that mutates an
already-submitted request) require the request to be in a permitted
prior status — server-side enforcement, not just UI.

---

## 5. Agent roles & flow

Reuses the existing roster (Builder / Coordinator / Learner / PM /
Researcher / Reviewer / Tester / Writer) seeded in the FOIA workspace.

| stage | primary | supporting |
|---|---|---|
| Discovery (agency + contracts) | Researcher | Reviewer (verify agency profile freshness) |
| Drafting | Writer | Reviewer (statute citation, scope tightness) |
| Approval gate | (operator) | — |
| Submission | (operator) | Coordinator (records `submitted_at`) |
| Tracking | Coordinator | Reviewer (response analysis) |
| Response analysis | Reviewer | Writer (drafts appeal if denied) |
| Weekly report | PM | — |

Builder + Tester are not in the per-request loop; they're for
implementing the pipeline itself (the Discovery initiative's stories).

---

## 6. UI surfaces

v0 minimum:

- **`/workspace/foia` (existing)** — task board carries the build work.
  No FOIA-specific UI here.
- **`/initiatives` (existing)** — already shows the FOIA Request
  Pipeline tree. No changes needed.
- **`/requests` (NEW)** — list view of `foia_requests` for the active
  workspace. Master-detail on `PageWithRails`: list rows on the left
  (request id, status badge, agency, deadline countdown), full request
  in the right pane (draft.md preview, statute citation, agency profile
  card, correspondence timeline, Submit button when status =
  awaiting_approval).
- **`/agencies` (NEW)** — table of profiled agencies; click opens an
  edit drawer for `foia_agencies` rows.

Both new surfaces follow the established `PageWithRails` patterns
(left rail flush against AppNav, master-detail).

---

## 7. Safety rails

These map directly to the workspace `context_md` already saved:

- `mark_submitted` requires `status === 'awaiting_approval'`. No tool
  call from an agent can bypass operator approval.
- `update_foia_draft` only valid while `status === 'draft'`. After
  approval, edits require an explicit operator unlock that drops back
  to draft.
- Submission medium recorded on the row so audit can show "we sent X
  on date D via email Y" — never just "submitted."
- PII detection in `record_response`: if response text matches an SSN /
  DOB / phone-number regex, the row gets a `pii_flagged` flag and the
  response is excluded from any cross-request reports.

---

## 8. Build order (suggested slices)

The existing initiative tree already enumerates stories. Suggested
order to make them ship-able end-to-end:

1. **Migration + DAO** — `foia_agencies`, `foia_statutes`, `foia_requests`,
   `foia_correspondence` tables + helpers in `src/lib/db/foia.ts`.
2. **Seed statutes** — `foia_statutes` seeded with federal FOIA + 5-10
   common state statutes (CPRA, NY FOIL, OPRA, Texas PIA, FL Sunshine,
   IL FOIA, MA PRL, WA PRA, OR PRL, CO CORA).
3. **MCP tools** — wire the table above into `src/lib/mcp/tools.ts`,
   with workspace scoping per tool.
4. **`/agencies` page** — operator-editable, used to validate the data
   model before agents start writing to it.
5. **`/requests` page** — list + detail, Submit button, audit log of
   the approval click.
6. **Researcher prompt** — task that runs `enqueue_contract_target`s
   for a target jurisdiction.
7. **Writer prompt** — picks one queued contract, does the lookup,
   writes the draft.
8. **Coordinator daily sweep** — uses the existing scheduled-tasks
   infra to call `list_overdue_requests` + emit notifications.

Each slice merges independently; the pipeline becomes useful at slice
5 (operator can write requests by hand and track them) and fully agent
-driven by slice 7.

---

## 9. Open questions

1. **Submission medium — email vs portal.** v0 plan: `mailto:` link +
   clipboard fallback. Some big agencies (federal, large cities)
   require their portal. Do we want a v0.5 that screen-recordings the
   portal flow once so an operator can replay without re-learning each
   site?
2. **Multi-jurisdictional rollups.** The same contract (e.g. PG&E)
   spans multiple counties. Do we model "campaign" → many `foia_requests`
   in one row, or keep them per-request and let the UI group them by
   `agency_id` prefix?
3. **Cost caps.** Some statutes allow agencies to charge for copies.
   Should the operator set a per-request $-cap upfront, with the agent
   refusing to draft a broader request than the cap allows? (Probably
   yes for v1.)
4. **Response ingestion automation.** Operator forwards agency emails
   to a dedicated address; a parser drops them into `correspondence/`
   automatically? Or strictly manual? (Manual for v0.)
5. **Appeals.** When a request is denied or partially fulfilled, do
   we model `appeal` as a new `foia_request` row with a `parent_id`,
   or as a status transition on the original? (Probably parent_id —
   appeals can themselves be denied + re-appealed.)

---

## 10. Out of scope (track separately)

- Lobbyist-style "what bills are about to be voted on" surfacing.
- Court-records integration (PACER, state court systems).
- Any non-FOIA records workflow (subpoenas, depositions).
- Auto-summarization of received records into briefs.
