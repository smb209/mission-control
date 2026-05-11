# Audit → PM bridge via `audit_verdict` note kind

## Motivation

Today the narrow `initiative_audit` flow (one researcher dispatch via
`POST /api/initiatives/:id/investigate`) writes a free-form
`take_note(kind='observation', audience='pm')` and exits. The PM only
picks up the finding on the operator's next move — Plan, Decompose, or
manual `Ask PM to propose` ([src/app/api/initiatives/[id]/ask-pm-from-notes](src/app/api/initiatives/[id]/ask-pm-from-notes/route.ts)).

That's the design called out as "out of scope" in [specs/initiative-investigate.md](initiative-investigate.md):

> Auto-applying audit findings as proposals (operator decides + clicks Plan).

It produces a clean audit trail but leaves obvious work on the table:
when an audit's verdict is unambiguous (`done in entirety`,
`never built`, `cancelled-in-effect`), the operator has to manually
hand the note off to PM via the Ask-PM button. With many audits
running, that bottleneck becomes the place reminders pile up. The four
audits run on 2026-05-10 illustrate the gap: three of the four had
clear `done`/`cancel` verdicts and none became proposals overnight.

## Scope

Add an opt-in bridge from narrow audits to PM proposals:

1. The narrow auditor emits a **second** take_note next to its
   observation: `kind='audit_verdict'`, with a small structured body —
   `verdict`, `action_recommended` (bool), optional `recommended_action_hint`,
   short rationale, pointer to the paired observation note.
2. When the workspace setting `audit_auto_spawn_pm` is on AND
   `action_recommended === true` (OR `verdict === 'audit_failed'`),
   the `take_note` MCP handler dispatches a `notes_intake` PM session
   whose trigger_text bundles the verdict + the paired observation
   body. The resulting `pm_proposal_id` is recorded onto the
   audit_verdict note via the existing `appendNoteProposalId` helper.
3. The setting defaults **off**; operator turns it on per workspace.
   Dogfood usage: on for the dev workspace, off for prod, mirroring
   the dogfood split.
4. Existing manual operator path (`Ask PM to propose` button calling
   `/api/initiatives/:id/ask-pm-from-notes`) stays the way to hand
   things off when auto-spawn is off, or to re-ask after a rejected
   first attempt. No new route.

Out of scope:

- Subtree audits already auto-synthesize via the L3 synthesizer
  ([subtree-audit.ts:677](src/lib/agents/subtree-audit.ts:677)); this
  spec targets the narrow path only.
- Giving the narrow auditor `propose_changes` directly. The auditor
  stays single-purpose; PM still authors the proposals.
- Auto-rejecting empty (`proposed_changes=[]`) PM follow-ups. They
  land as drafts; the queue UI shows "PM found nothing to do" and
  the operator dismisses.

## Validation against existing code

| Claim | Where | Evidence |
| --- | --- | --- |
| Narrow audit emits observation-only by design | [audit-prompt.ts:300-308](src/lib/agents/audit-prompt.ts) | "Don't call propose_changes; you don't have it on your mount." |
| `/investigate` is fire-and-forget | [investigate/route.ts:367-383](src/app/api/initiatives/[id]/investigate/route.ts) | `void dispatchScope(...).catch(...)` — no post-completion hook in the route. |
| Operator-driven Ask-PM path already exists | [ask-pm-from-notes/route.ts](src/app/api/initiatives/[id]/ask-pm-from-notes/route.ts) | Takes `note_ids[]`, formats trigger_text, calls `dispatchPm({trigger_kind: 'notes_intake'})`, marks notes consumed, links `pm_proposal_id` back via `appendNoteProposalId`. |
| `take_note` MCP handler already validates audit-kind bodies | [mcp/groups/core.ts:440-469](src/lib/mcp/groups/core.ts) | Calls `validateAuditNoteBody(kind, body)`; rejects with `audit_body_invalid` on mismatch. |
| `agent_notes.pm_proposal_ids` column already wired | migration 084 + [agent-notes.ts:80-83](src/lib/db/agent-notes.ts) | `appendNoteProposalId(note_id, proposal_id)` is the existing helper. |
| Workspace audit settings pattern established | [workspaces.ts:57-78](src/lib/db/workspaces.ts) | `getAuditSettings(workspace_id)` reads `audit_per_node_timeout_ms` + `audit_subtree_concurrency` columns. |
| importance=2 already auto-pings PM Chat | [core.ts:506-524](src/lib/mcp/groups/core.ts) | Best-effort `postPmChatMessage` after `createNote`. Our auto-spawn slot is the same place. |

So everything we need exists; this PR wires the missing piece —
auditor emits a structured verdict, take_note fires the existing PM
dispatch when the verdict + workspace setting align.

## Schema

### Migration

- Extend `agent_notes.kind` CHECK to include `audit_verdict`
  (table-swap recipe, same as migration 087).
- Add `workspaces.audit_auto_spawn_pm INTEGER NOT NULL DEFAULT 0`.

### NoteKind union

```ts
// src/lib/db/agent-notes.ts
export type NoteKind =
  | …existing…
  | 'audit_verdict';

export const AUDIT_NOTE_KINDS = [
  'audit_manifest',
  'audit_proposal',
  'audit_synthesis',
  'audit_verdict',   // ← new; excluded from cross-audit reads
];
```

### Body schema

`src/lib/agents/audit-proposals/schemas.ts`:

```ts
export const auditVerdictBodySchema = z.object({
  version: z.literal(1),
  // The free-form observation note this verdict was emitted alongside.
  // Used by the auto-spawn hook to bundle both notes into the PM
  // trigger_text. Auditor passes the observation's note id.
  observation_note_id: z.string().min(1),
  verdict: z.enum([
    'on_track',
    'partially_done',
    'stale_rescope',
    'never_built',
    'done_in_entirety',
    'cancelled_in_effect',
    'audit_failed',
  ]),
  action_recommended: z.boolean(),
  // Optional hint to PM. Maps roughly to the audit_proposal action
  // enum, minus 'keep' (action_recommended=false means keep).
  recommended_action_hint: z
    .enum([
      'cancel',
      'mark_done',
      'decompose',
      'modify_scope',
      'modify_dates',
      'investigate_further',
    ])
    .nullish(),
  short_rationale: z.string().min(20).max(800),
});
```

### isAuditNoteKind

Extend the discriminator to include `audit_verdict` so the
`take_note` handler routes it through `validateAuditNoteBody`.

## Auditor prompt update

In [audit-prompt.ts](src/lib/agents/audit-prompt.ts), narrow mode adds
a paragraph after the existing observation instruction:

> Then call `take_note` a second time with `kind='audit_verdict'`,
> referencing the observation note id you just created. The body must
> be a JSON string matching the audit_verdict v1 schema:
>
> - `verdict`: one of `on_track | partially_done | stale_rescope | never_built | done_in_entirety | cancelled_in_effect | audit_failed`.
> - `action_recommended`: true only when the verdict implies the
>   operator should act now (`partially_done` w/ stale scope,
>   `stale_rescope`, `never_built`, `done_in_entirety`,
>   `cancelled_in_effect`). `on_track` → false.
> - `recommended_action_hint`: optional pointer to the kind of PM
>   action this likely warrants.
> - `short_rationale`: 20–800 chars summarizing the verdict.
>
> The verdict note is structured signal for downstream tooling. The
> observation carries the prose; the verdict carries the dispatch.

## Auto-spawn hook

In the `take_note` MCP handler ([core.ts](src/lib/mcp/groups/core.ts))
after the existing `createNote` call:

```ts
if (note.kind === 'audit_verdict') {
  maybeAutoSpawnPmFromVerdict(note).catch((err) => {
    console.warn('[take_note] audit auto-spawn failed:', (err as Error).message);
  });
}
```

`maybeAutoSpawnPmFromVerdict(verdictNote)`:

1. Parse the body; bail if `action_recommended === false` AND
   `verdict !== 'audit_failed'`.
2. Read `workspaces.audit_auto_spawn_pm` via a new getter
   `getAuditAutoSpawn(workspace_id)`. Return early when off.
3. Resolve the paired observation note by id from the body.
4. Build the trigger_text:

   ```
   Audit verdict for initiative {id} ({title}): {verdict}.
   action_recommended=true, hint={recommended_action_hint ?? 'none'}.

   Rationale: {short_rationale}

   --- Full audit observation (note {observation_note_id}) ---

   {observation.body}
   ```
5. Call `dispatchPm({ workspace_id, trigger_text, trigger_kind: 'notes_intake', allowFallback: true })` — matches the disruption path. When the gateway is offline the synth row gives the operator something to react to and is later superseded by the real PM reply via SSE.
6. `markNoteConsumed(observation.id, 'pm_proposal')`,
   `markNoteConsumed(verdict.id, 'pm_proposal')`,
   `appendNoteProposalId(verdict.id, result.proposal.id)`,
   `appendNoteProposalId(observation.id, result.proposal.id)`.

Best-effort throughout: the verdict note is the durable artifact; a
failed dispatch leaves the note intact and the operator's manual
Ask-PM button still works.

## Workspace setting

`src/lib/db/workspaces.ts` adds:

```ts
export function getAuditAutoSpawn(workspaceId: string): boolean { … }
export function setAuditAutoSpawn(workspaceId: string, on: boolean): void { … }
```

UI surface: a checkbox under the existing "Audit defaults" subsection
on the workspace settings page. Label: "Auto-send audit findings to
PM when an audit recommends action."

## Out-of-scope follow-ups

- A dedicated `audit_verdict` UI chip on `NoteCard` w/ `Send to PM`
  button when auto-spawn is off. The existing `Ask PM to propose`
  button on observation notes already covers this; a verdict-specific
  affordance is purely a UX polish.
- Filtering the proposal queue by "from auto-spawn" — useful once we
  have a few weeks of auto-spawn data to validate false-positive
  rate, but not needed for v1.
- `audit_failed` verdicts spawning a different trigger_text shape
  ("audit could not complete; recommend retry or operator review").
  v1 just bundles the audit_failed rationale into the standard
  trigger_text and lets PM decide.

## Tests

- Migration roundtrip: insert an `audit_verdict` note (legal body),
  reject the same note when `agent_notes.kind` constraint excludes
  it on a pre-migration snapshot.
- `validateAuditNoteBody('audit_verdict', …)`: happy path + each
  required-field rejection + invalid enum value.
- `take_note` MCP handler: writing `audit_verdict` with a bad body
  shape rejects via the existing `audit_body_invalid` channel.
- `maybeAutoSpawnPmFromVerdict`:
  - `action_recommended=false` → no dispatch.
  - workspace setting off → no dispatch.
  - happy path: dispatches, records `pm_proposal_ids` on both notes,
    marks both consumed.
  - dispatch failure: leaves notes intact, logs warning, doesn't
    throw.
- A regression test on the narrow audit prompt covering the
  audit_verdict instruction (string-match the load-bearing fields).

## Verification

- `yarn tsc --noEmit` + `yarn test` (full suite once).
- Manual smoke after migration runs: re-trigger one of the 4 audits
  from 2026-05-10 against the dev DB with auto-spawn ON; confirm
  the audit lands two notes and a `pm_proposals` row appears.
