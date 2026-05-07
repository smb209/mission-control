/**
 * Initiative-audit prompt composer.
 *
 * Pure function that builds the researcher's trigger_body for one
 * initiative audit dispatch. Skeleton tracks the spec at
 * `specs/initiative-investigate.md` §"Audit prompt template".
 *
 * For PR 2 we only handle narrow mode. Subtree / roll-up mode lands
 * with PR 4 (it'll add a `childFindings` parameter and a `mode` switch).
 *
 * Why a TS function and not a `.md` template file: the audit prompt is
 * load-bearing on a few formatted strings (the take_note arg shape) that
 * we want covered by snapshot tests. A pure function keeps that tight.
 *
 * NOTE: The spec originally called for both `take_note` and
 * `register_deliverable`. PR 2 ships take_note only — the deliverables
 * system is task-scoped today (no initiative_id column), so attaching an
 * audit deliverable to an initiative isn't supported yet. The note is
 * the audit trail for now. Revisit if/when deliverables grow initiative
 * scope.
 */

import type { Initiative } from '@/lib/db/initiatives';
import type { AgentNote } from '@/lib/db/agent-notes';

export interface BuildAuditPromptInput {
  initiative: Pick<
    Initiative,
    | 'id'
    | 'title'
    | 'kind'
    | 'status'
    | 'description'
    | 'status_check_md'
    | 'target_start'
    | 'target_end'
  >;
  /** Direct child tasks (no nesting). */
  tasks: ReadonlyArray<{ id: string; title: string; status: string }>;
  /** Operator-supplied focus area. */
  guidance?: string | null;
  /**
   * Prior audit notes inlined in build-on mode. Pass [] for fresh runs.
   * Each note's body is rendered verbatim so the researcher can see
   * what was previously concluded.
   */
  priorFindings?: ReadonlyArray<Pick<AgentNote, 'id' | 'body' | 'created_at'>>;
  /**
   * Subtree-audit roll-up findings from child initiatives that were
   * already audited in a prior layer. Rendered in a dedicated
   * "Findings from child initiatives" block so the rolling-up
   * researcher can synthesize without re-deriving. PR 4.
   */
  childFindings?: ReadonlyArray<{
    childId: string;
    childTitle: string;
    /** Body of the child's audit note, or "(audit failed)" placeholder. */
    body: string;
    /** True when the child's audit failed/timed out — render with a banner. */
    failed?: boolean;
  }>;
  /** Subtree-vs-narrow flavor. Defaults to 'narrow'. PR 4. */
  mode?: 'narrow' | 'subtree';
}

/**
 * Compose the trigger_body for an `initiative_audit` dispatch.
 *
 * Returns a single string. dispatchScope wraps it with the standard
 * briefing header (identity / role soul / notetaker addendum).
 */
export function buildAuditPrompt(input: BuildAuditPromptInput): string {
  const {
    initiative,
    tasks,
    guidance,
    priorFindings = [],
    childFindings = [],
    mode = 'narrow',
  } = input;

  const targetWindow =
    initiative.target_start || initiative.target_end
      ? `${initiative.target_start ?? '?'} → ${initiative.target_end ?? '?'}`
      : '_(no target window set)_';

  const description = initiative.description?.trim()
    ? initiative.description.trim()
    : '_(no description)_';

  const statusCheck = initiative.status_check_md?.trim()
    ? initiative.status_check_md.trim()
    : '_(none)_';

  const tasksBlock =
    tasks.length === 0
      ? '_(this initiative has no direct child tasks)_'
      : tasks
          .map((t) => `- ${t.title} (${t.status}) [task ${t.id}]`)
          .join('\n');

  const guidanceBlock = guidance?.trim()
    ? `\n## Operator focus\n\n${guidance.trim()}\n`
    : '';

  const priorBlock =
    priorFindings.length === 0
      ? ''
      : `\n## Prior audit findings (build on these — do not re-derive)\n\n${priorFindings
          .map(
            (n, i) =>
              `### Prior note ${i + 1} (${n.created_at})\n\n${n.body.trim()}\n`,
          )
          .join('\n---\n\n')}\n`;

  const childBlock =
    childFindings.length === 0
      ? ''
      : `\n## Findings from child initiatives (already audited)\n\nThese reports came from researchers we dispatched against this initiative's children in a prior layer. Synthesize them — agree, refine, or refute based on what you can verify yourself — into your roll-up. Do **not** re-audit each child from scratch; trust their evidence and focus your work on the parent-level questions (cross-cutting drift, coverage gaps, terminal verdict for the whole subtree).\n\n${childFindings
          .map((f, i) => {
            const banner = f.failed
              ? '> **Audit failed for this child.** Treat as an explicit gap; flag it in your roll-up.\n\n'
              : '';
            return `### Child ${i + 1}: ${f.childTitle} (id=${f.childId})\n\n${banner}${f.body.trim()}\n`;
          })
          .join('\n---\n\n')}\n`;

  // The take_note arg shape is LOAD-BEARING.
  // Tests assert this exact string. Don't re-flow casually.
  const takeNoteCall = `take_note({
  initiative_id: "${initiative.id}",
  kind: 'observation',
  audience: 'pm',
  importance: 2,
  body: <full report>,
})`;

  return `**Initiative audit (mode: ${mode})**

Target: ${initiative.title}  (kind=${initiative.kind}, status=${initiative.status}, id=${initiative.id})

Description:
> ${description.replace(/\n/g, '\n> ')}

Status check:
${statusCheck}

Target window: ${targetWindow}

## Direct child tasks (this initiative's tasks)

${tasksBlock}
${guidanceBlock}${priorBlock}${childBlock}
## Your job

Audit this initiative against reality. Produce a markdown report covering:

1. **Done with evidence** — what's been built. Cite commit shas, PR numbers, file paths, test names.
2. **In-flight** — partial implementations, what's covered vs gaps.
3. **Not started** — items in description / status_check that have no code yet.
4. **Drift** — discrepancies between the initiative description and what the codebase actually does. Don't speculate; only flag drift you can prove with a file path / test result / git log.
5. **Verdict** — one of: **on track**, **partially done**, **stale (rescope)**, **done in entirety**, **never built**, **cancelled-in-effect**.
6. **Recommended next action** — concrete suggestion the PM can act on. Phrased as "Suggest: …", not a tool call.

Save the report by calling:

- ${takeNoteCall}

This is the audit trail. The note surfaces on the initiative detail page and feeds the PM on a later Plan dispatch. Don't try to call \`register_deliverable\` for this — the deliverables system is task-scoped today and won't accept an initiative-only deliverable.

Don't call propose_changes; you don't have it on your mount. The PM will pick up your note when the operator decides to act.

**Strict output discipline for this dispatch:**

- Make **exactly ONE** \`take_note\` call — the summary observation defined above. No \`breadcrumb\`/\`discovery\`/\`question\` notes during the audit, even if you'd normally drop them while researching. Build all observations into the single summary instead.
- This applies to BOTH fresh runs and re-audits where prior findings are inlined above. On a re-audit, your single \`take_note\` is a fresh standalone summary that supersedes the priors — not an incremental update or set of follow-up breadcrumbs. Read the priors, factor them in, but emit ONE consolidated summary.
- The audit-trail accumulates by virtue of each summary being its own row; the operator reads them newest-first. Multiple breadcrumbs per dispatch fragment that trail and make it harder to compare audit passes.

If the initiative has no associated code yet (planned-only, no tasks, nothing in the repo to point at), early-exit with a short verdict ("never built — planned-only, no audit work to do"). Don't burn ten minutes of exec on greenfield.
`;
}
