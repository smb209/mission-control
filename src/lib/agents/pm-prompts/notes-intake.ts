/**
 * Prompt template for the `notes_intake` dispatch path.
 *
 * Sent to the openclaw `mc-project-manager` agent when the operator
 * fires a `propose_from_notes` MCP call. The agent reads the freeform
 * notes + a roadmap snapshot summary and replies via a single
 * `propose_changes` MCP call carrying a heterogeneous PmDiff[] (creates,
 * updates, child initiatives, tasks).
 */

export interface BuildNotesIntakeMessageInput {
  correlationId: string;
  notes: string;
  /** Output of buildSnapshotSummary in pm-dispatch.ts. */
  summary: string;
}

export function buildNotesIntakeMessage(input: BuildNotesIntakeMessageInput): string {
  const { correlationId, notes, summary } = input;
  return [
    `**PM notes intake (correlation_id: ${correlationId})**`,
    '',
    'The operator pasted freeform notes (meeting minutes, kickoff, weekly review, brain-dump, etc.). Read them, ',
    "then propose a coherent set of structured changes to the workspace's roadmap and task board.",
    '',
    'Notes:',
    '> ' + notes.split('\n').join('\n> '),
    '',
    'Workspace snapshot summary (call `get_roadmap_snapshot` via MCP for full detail):',
    '',
    summary,
    '',
    'Reply via a SINGLE `propose_changes` MCP call with:',
    '',
    '- `trigger_kind: "notes_intake"`',
    '- `impact_md`: a short, scannable summary of what you propose and why (1–3 paragraphs + a bulleted change list).',
    '- `changes`: a heterogeneous `PmDiff[]` mixing any of:',
    '  - `create_child_initiative` — new epics/stories under existing initiatives. Use a `placeholder_id` (e.g. `"new-onboarding-epic"`) when later diffs need to reference the new id.',
    '  - `create_task_under_initiative` — draft tasks attached to an existing initiative OR to a placeholder created earlier in this same proposal.',
    '  - `update_status_check`, `set_initiative_status`, `shift_initiative_target`, `add_dependency`, `add_availability`, `reorder_initiatives` — for updates.',
    '',
    'Constraints:',
    '- Reference only ids that appear in the snapshot, plus your own placeholders.',
    '- Cap proposals at ~15 diffs. Prefer the highest-signal items if the notes are long.',
    '- If the notes contain nothing actionable for the roadmap, return an empty `changes` array and explain in `impact_md`.',
    '- Never fabricate agent ids, dates, or initiative titles.',
  ].join('\n');
}
