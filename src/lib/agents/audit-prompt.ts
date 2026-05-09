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
import type {
  AuditManifestBody,
  AuditProposalBody,
} from '@/lib/agents/audit-proposals/schemas';
import { summarizeProposalForBriefing } from './subtree-audit-summarize';

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
  /**
   * Direct child initiatives (epics' stories, themes' epics, etc.).
   * Critical for narrow-mode audits on parent kinds: an epic's actual
   * decomposed scope lives in these rows. Pass `[]` for leaf-kind
   * targets (stories) — the renderer just omits the section.
   */
  childInitiatives?: ReadonlyArray<{
    id: string;
    title: string;
    kind: string;
    status: string;
  }>;
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
  /**
   * Audit flavor. Defaults to 'narrow'.
   * - 'narrow' — single-node audit (PR 2 / unchanged).
   * - 'survey' — L1 surveyor (Phase 2).
   * - 'subtree-proposal' — L2 per-node typed proposal (Phase 3).
   * - 'synthesis' — L3 synthesizer (Phase 4).
   *
   * The legacy 'subtree' mode was removed in Phase 4 (hard cutover —
   * see specs/subtree-audit-proposals-spec.md §6.3).
   */
  mode?: 'narrow' | 'survey' | 'subtree-proposal' | 'synthesis';
  /**
   * Per-node briefing inputs for `mode: 'subtree-proposal'` (Phase 3).
   * The orchestrator threads in the manifest entry so the auditor sees
   * the surveyor's hypothesis + scoped investigation prompt.
   */
  proposalInput?: {
    rootId: string;
    attempt: number;
    manifestNode: {
      hypothesis: string;
      confidence: 'low' | 'medium' | 'high';
      investigation_prompt: string;
      scoped_evidence_hints: ReadonlyArray<string>;
    };
  };
  /**
   * Surveyor-only inputs (mode: 'survey'). Carried in the briefing so
   * the L1 surveyor doesn't have to walk the tree itself. See
   * specs/subtree-audit-proposals-spec.md §3.1.
   */
  surveyInput?: {
    rootId: string;
    attempt: number;
    /** Bottom-up flattened descendants the surveyor should consider. */
    descendants: ReadonlyArray<{
      id: string;
      title: string;
      kind: string;
      status: string;
      parent_initiative_id: string | null;
    }>;
    /** Pre-pulled `git log --oneline -20` excerpt or empty string. */
    gitActivity?: string | null;
    /**
     * Compact ref to the most recent prior `audit_synthesis` note on
     * the root, used as a delta-baseline. Null when no prior audit
     * exists or the prior body failed to validate. The orchestrator
     * pre-resolves the timestamp + run_group_id from the DB row so the
     * surveyor doesn't have to walk notes itself.
     *
     * Spec: specs/subtree-audit-proposals-spec.md §7, §10 Phase 5.
     */
    priorSynthesis?: {
      created_at: string;
      run_group_id: string;
      completion_sentinel: string;
    } | null;
  };
  /**
   * L3 synthesizer briefing inputs (mode: 'synthesis'). The orchestrator
   * pre-loads the manifest + every L2 proposal body so the synthesizer
   * agent doesn't need tree-walk tools. See spec §3.3 / §4.4.
   */
  synthesisInput?: {
    rootId: string;
    attempt: number;
    /** Verbatim L1 manifest body, or null if surveyor failed/fallback. */
    manifest: AuditManifestBody | null;
    /** Per-node L2 proposal summaries (synthetic + real). */
    proposalSummaries: ReadonlyArray<{
      noteId: string;
      initiativeId: string;
      initiativeTitle: string;
      body: AuditProposalBody;
    }>;
  };
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
    childInitiatives = [],
    guidance,
    priorFindings = [],
    childFindings = [],
    mode = 'narrow',
    surveyInput,
    proposalInput,
    synthesisInput,
  } = input;

  if (mode === 'survey') {
    return buildSurveyPrompt({ initiative, guidance: guidance ?? null, surveyInput });
  }

  if (mode === 'subtree-proposal') {
    return buildSubtreeProposalPrompt({
      initiative,
      tasks,
      childInitiatives,
      guidance: guidance ?? null,
      childFindings,
      proposalInput,
    });
  }

  if (mode === 'synthesis') {
    return buildSynthesisPrompt({
      initiative,
      guidance: guidance ?? null,
      synthesisInput,
    });
  }

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

  // Child-initiative block. Themes have epics, epics have stories,
  // stories may have child stories. Without this, narrow audits on
  // parent kinds saw "no child tasks" and had to greenfield-discover
  // the decomposition from git history (see chat-mc-runner-...md).
  const childInitiativesBlock =
    childInitiatives.length === 0
      ? '_(this initiative has no direct child initiatives)_'
      : childInitiatives
          .map(
            (c) =>
              `- [${c.kind}] ${c.title} (${c.status}) [initiative ${c.id}]`,
          )
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

## Direct child initiatives (decomposed scope)

${childInitiativesBlock}

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

/**
 * Build the L1 surveyor briefing. The surveyor reads the supplied
 * subtree summary + git activity hints + (optional) prior synthesis,
 * then emits exactly one `audit_manifest` note whose JSON-string body
 * conforms to `auditManifestBodySchema`.
 *
 * Spec: specs/subtree-audit-proposals-spec.md §3.1, §4.2.
 */
function buildSurveyPrompt(args: {
  initiative: BuildAuditPromptInput['initiative'];
  guidance: string | null;
  surveyInput?: BuildAuditPromptInput['surveyInput'];
}): string {
  const { initiative, guidance, surveyInput } = args;
  if (!surveyInput) {
    throw new Error('buildAuditPrompt(mode=survey): surveyInput is required');
  }
  const { rootId, attempt, descendants, gitActivity, priorSynthesis } = surveyInput;

  const descBlock =
    descendants.length === 0
      ? '_(no non-terminal descendants — root is the only audit target)_'
      : descendants
          .map(
            (d) =>
              `- [${d.kind}] ${d.title} (status=${d.status}, id=${d.id}, parent=${d.parent_initiative_id ?? 'none'})`,
          )
          .join('\n');

  const gitBlock = gitActivity?.trim()
    ? `\n## Recent repo activity (cheap skim)\n\n\`\`\`\n${gitActivity.trim()}\n\`\`\`\n`
    : '\n## Recent repo activity\n\n_(none provided — surveyor briefing did not include a git-log excerpt; do not greenfield git work)_\n';

  // Phase 5: always render a `## Prior audit` section so the surveyor
  // is unambiguously instructed about delta-mode behavior — present or
  // absent. With a prior, encourage `skip: true` for unchanged nodes;
  // without one, force a fresh full-fanout investigation.
  const priorBlock = priorSynthesis
    ? `\n## Prior audit\n\nA prior audit completed at ${priorSynthesis.created_at}.\nLast sentinel: "${priorSynthesis.completion_sentinel}"\n\nUse this as a delta baseline. For each descendant in your manifest:\n- If you can confidently say nothing meaningful has changed since the\n  prior audit (no MC status flip, no scope change in the description,\n  no recent activity hinting at a re-investigation), set\n  \`hypothesis: 'likely-done'\` (or whatever was established) AND\n  \`skip: true\` AND \`confidence: 'high'\`. The orchestrator will skip\n  those nodes and emit a synthetic keep proposal.\n- If anything has changed (MC status, description text, target dates,\n  or there's recent activity), set \`skip: false\` regardless of\n  hypothesis. Do not skip on uncertainty.\n\nThis is a delta-run optimization. When in doubt, do not skip.\n\nIn your emitted manifest, set \`previous_synthesis_run_group_id\` to\nexactly: \`"${priorSynthesis.run_group_id}"\`\n`
    : `\n## Prior audit\n\n(no prior audit synthesis on this root — investigate every node\nfreshly).\n\nIn your emitted manifest, set \`previous_synthesis_run_group_id: null\`.\n`;

  const guidanceBlock = guidance?.trim()
    ? `\n## Operator focus\n\n${guidance.trim()}\n`
    : '';

  // Schema example, kept short. The auditor benefits from seeing the
  // exact JSON shape; the Zod validator will reject anything off.
  const schemaExample = `{
  "version": 1,
  "root_initiative_id": "${rootId}",
  "attempt": ${attempt},
  "previous_synthesis_run_group_id": ${priorSynthesis ? `"${priorSynthesis.run_group_id}"` : 'null'},
  "summary": "1-paragraph framing of the epic's intent and current state",
  "nodes": [
    {
      "initiative_id": "<descendant-id>",
      "title": "<descendant-title>",
      "current_status": "in_progress",
      "hypothesis": "needs-deep-dive",
      "confidence": "medium",
      "investigation_prompt": "<scoped per-node ask for the L2 auditor>",
      "scoped_evidence_hints": ["git log --oneline -- <path>", "rg <symbol> <dir>"],
      "skip": false
    }
  ],
  "cross_cutting_questions": []
}`;

  const takeNoteCall = `take_note({
  agent_id: '<your agent_id>',
  kind: 'audit_manifest',
  initiative_id: '${rootId}',
  scope_key: '<from briefing>',
  role: 'auditor',
  run_group_id: '<from briefing>',
  audience: 'pm',
  importance: 1,
  body: JSON.stringify(<the JSON object above>),
})`;

  return `**Initiative audit — L1 SURVEYOR (mode: survey)**

You are running the *survey* stage. Your only job is to emit one
\`audit_manifest\` note whose JSON-string body plans the per-node
fan-out the orchestrator will run next. Do **not** deeply audit
anything yourself — the surveyor reads, doesn't grep-storm.

Target root: ${initiative.title} (kind=${initiative.kind}, status=${initiative.status}, id=${initiative.id})
Attempt: ${attempt}

## Subtree (non-terminal descendants)

${descBlock}
${gitBlock}${priorBlock}${guidanceBlock}
## Contract

- Slice: emit a manifest that narrows the per-node fan-out for this audit.
- Expected deliverable: exactly ONE \`take_note\` call:
  - kind: 'audit_manifest'
  - initiative_id: '${rootId}'
  - audience: 'pm'
  - importance: 1
  - body: JSON.stringify of an object conforming to the schema below.
- Acceptance criteria:
  * Body parses as JSON and matches the audit_manifest v1 schema.
  * \`nodes\` covers each non-terminal descendant listed above (one entry each).
  * Each node has a \`hypothesis\` ∈ {likely-done, likely-drifted, likely-cancelled, no-evidence, needs-deep-dive}.
  * Each node has a \`confidence\` ∈ {low, medium, high}.
  * \`skip: true\` is used sparingly — only when you're highly confident the node needs no deeper audit (e.g. obvious "already done with PR" or "obviously orphaned"). Combined with \`confidence: 'high'\`, the orchestrator will NOT dispatch an auditor for that node and will instead emit a synthetic \`keep\` proposal.
- Expected duration: < 60s wall clock. You are the *plan*; the audit is the layers that follow.

## Schema (audit_manifest v1)

\`\`\`jsonc
${schemaExample}
\`\`\`

## How to emit

\`\`\`
${takeNoteCall}
\`\`\`

## Discipline

- One note. No \`breadcrumb\`/\`discovery\`/\`question\` chatter.
- Do **not** call \`update_task_status\`, \`update_initiative\`, or \`register_deliverable\` — auditors are read-only.
- The body MUST be a JSON string (\`JSON.stringify(...)\`). The MCP \`take_note\` handler validates it; off-shape bodies are rejected and you'll have to retry.
- If the subtree above is empty, still emit the manifest with \`nodes: []\` and a one-line \`summary\`.

## End of turn

After \`take_note\` returns successfully, emit ONE short assistant
message (e.g. \`Manifest <noteId>.\`) and STOP. That terminal text is
what the gateway promotes to \`state: 'final'\` — without it the
orchestrator's dispatch waits the full timeout. Do NOT keep working
after the manifest is accepted; do NOT call additional tools.
`;
}

/**
 * Build the L2 per-node briefing for `mode: 'subtree-proposal'` (Phase 3
 * of specs/subtree-audit-proposals-spec.md). Mirrors the
 * Delegation-Contract shape from §3.2 of
 * specs/coordinator-delegation-via-convoy-spec.md: slice / deliverables /
 * acceptance criteria. Includes the §4.3 audit_proposal schema reminder
 * + retry guidance.
 */
function buildSubtreeProposalPrompt(args: {
  initiative: BuildAuditPromptInput['initiative'];
  tasks: BuildAuditPromptInput['tasks'];
  childInitiatives: NonNullable<BuildAuditPromptInput['childInitiatives']>;
  guidance: string | null;
  childFindings: NonNullable<BuildAuditPromptInput['childFindings']>;
  proposalInput?: BuildAuditPromptInput['proposalInput'];
}): string {
  const { initiative, tasks, childInitiatives, guidance, childFindings, proposalInput } = args;
  if (!proposalInput) {
    throw new Error('buildAuditPrompt(mode=subtree-proposal): proposalInput is required');
  }
  const { manifestNode } = proposalInput;

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
      : tasks.map((t) => `- ${t.title} (${t.status}) [task ${t.id}]`).join('\n');

  const childInitiativesBlock =
    childInitiatives.length === 0
      ? '_(this initiative has no direct child initiatives)_'
      : childInitiatives
          .map((c) => `- [${c.kind}] ${c.title} (${c.status}) [initiative ${c.id}]`)
          .join('\n');

  const guidanceBlock = guidance?.trim()
    ? `\n## Operator focus\n\n${guidance.trim()}\n`
    : '';

  const childBlock =
    childFindings.length === 0
      ? ''
      : `\n## Findings from child initiatives (already audited)\n\nThese summaries came from per-node auditors we dispatched against this initiative's children in a prior layer. Synthesize them — don't re-audit each child from scratch — and roll their signal into your proposal for THIS node.\n\n${childFindings
          .map((f, i) => {
            const banner = f.failed
              ? '> **Audit failed for this child.** Treat as an explicit gap.\n\n'
              : '';
            return `### Child ${i + 1}: ${f.childTitle} (id=${f.childId})\n\n${banner}${f.body.trim()}\n`;
          })
          .join('\n---\n\n')}\n`;

  const hintsBlock =
    manifestNode.scoped_evidence_hints.length === 0
      ? '_(none)_'
      : manifestNode.scoped_evidence_hints.map((h) => `- \`${h}\``).join('\n');

  const exampleBody = `{
  "version": 1,
  "node_initiative_id": "${initiative.id}",
  "current_mc_status": "${initiative.status}",
  "current_mc_target_end": ${initiative.target_end ? `"${initiative.target_end}"` : 'null'},
  "proposed_action": "keep",
  "proposed_changes": {},
  "repo_evidence": [
    { "kind": "file", "ref": "path/to/file.ts:42" },
    { "kind": "git",  "ref": "0cc50ce" }
  ],
  "rationale": "1-paragraph narrative — why this action.",
  "confidence": "medium",
  "would_confirm_by": "Reading X to confirm Y.",
  "continuation_note_id": null
}`;

  const takeNoteCall = `take_note({
  agent_id: '<your agent_id>',
  kind: 'audit_proposal',
  initiative_id: '${initiative.id}',
  scope_key: '<from briefing>',
  role: 'auditor',
  run_group_id: '<from briefing>',
  audience: 'pm',
  importance: 2,
  body: JSON.stringify(<the JSON object above>),
})`;

  const fallbackCall = `take_note({
  agent_id: '<your agent_id>',
  kind: 'observation',
  initiative_id: '${initiative.id}',
  scope_key: '<from briefing>',
  role: 'auditor',
  run_group_id: '<from briefing>',
  audience: 'pm',
  importance: 2,
  body: '<short reason — what you found, why no clean proposal>',
})`;

  return `**Initiative audit — L2 PER-NODE (mode: subtree-proposal)**

You are auditing ONE node of a subtree. The L1 surveyor has already
narrowed the slice for you (see Contract below). Your job is to emit
exactly one structured \`audit_proposal\` note for this node.

Target: ${initiative.title}  (kind=${initiative.kind}, status=${initiative.status}, id=${initiative.id})

Description:
> ${description.replace(/\n/g, '\n> ')}

Status check:
${statusCheck}

Target window: ${targetWindow}

## Direct child initiatives (decomposed scope)

${childInitiativesBlock}

## Direct child tasks

${tasksBlock}
${guidanceBlock}${childBlock}
## Contract

- Slice: ${manifestNode.investigation_prompt}
- Hypothesis: ${manifestNode.hypothesis} (confidence: ${manifestNode.confidence})
- Expected deliverables: 1 \`take_note(kind='audit_proposal', initiative_id='${initiative.id}')\`, body matches the audit_proposal v1 schema (§4.3).
- Acceptance criteria:
  * Body parses as the audit_proposal v1 schema.
  * \`repo_evidence\` has ≥1 entry of kind ∈ {file, git, pr, note}.
  * If \`confidence\` is \`low\` or \`medium\`, \`would_confirm_by\` is non-empty.
  * If \`proposed_action\` is \`keep\`, \`proposed_changes\` is the empty object \`{}\`.
- Expected duration: ≤ 5 minutes. You are scoped to this node — don't audit siblings.

## Scoped evidence hints (from surveyor)

${hintsBlock}

## Schema reminder (audit_proposal v1)

Top-level fields:
- \`version\`: literal \`1\`.
- \`node_initiative_id\`: this node's initiative id (\`${initiative.id}\`).
- \`current_mc_status\`: current MC status string.
- \`current_mc_target_end\`: ISO \`YYYY-MM-DD\` or \`null\`.
- \`proposed_action\`: one of \`keep\` | \`mark_done\` | \`cancel\` | \`modify_scope\` | \`modify_dates\`.
- \`proposed_changes\`: shape depends on action:
  * \`keep\` → \`{}\`
  * \`mark_done\` → \`{ note: string }\`
  * \`cancel\` → \`{ reason: string }\`
  * \`modify_scope\` → \`{ title?: string, description?: string }\` (≥1 required)
  * \`modify_dates\` → \`{ target_start?: 'YYYY-MM-DD', target_end?: 'YYYY-MM-DD' }\` (≥1 required)
- \`repo_evidence\`: array (min 1) of \`{ kind: 'file'|'git'|'pr'|'note', ref: string }\`.
  Per-kind ref shape (validator-enforced):
  * \`file\` → repo-relative path, optionally with line: \`src/foo/bar.ts\`, \`src/foo/bar.ts:42\`, \`src/foo/bar.ts:42-58\`.
  * \`git\`  → commit SHA only (7-40 hex chars), optionally \`<sha>:<path>\`. **Never** put grep output, search misses, or "no matching file" sentences here — the schema rejects it.
  * \`pr\`   → PR URL or short ref like \`apps#33297\`.
  * \`note\` → another note id (e.g. the audit_manifest you were briefed with).
  **Negative evidence:** if you grepped and found nothing, still cite \`kind:'file'\` with the path you searched (or the path the story description named, even if the file is absent). Put the actual finding ("file does not exist", "no matches in src/") in \`rationale\`. The evidence array records *what you looked at*, not *what you found*.
- \`rationale\`: 1-paragraph string.
- \`confidence\`: \`low\` | \`medium\` | \`high\`.
- \`would_confirm_by\`: required (non-empty string) when confidence is \`low\` or \`medium\`; may be \`null\` when high.
- \`continuation_note_id\`: \`null\` unless overflow splitting (rare).

Example body:

\`\`\`jsonc
${exampleBody}
\`\`\`

## How to emit

\`\`\`
${takeNoteCall}
\`\`\`

## Retries on validation failure

The MCP \`take_note\` handler validates the body against the schema +
the 3000-char cap. On failure it returns a structured error naming the
failing field. **Retry up to 2 times** with a tightened body. After 2
failures, fall back to:

\`\`\`
${fallbackCall}
\`\`\`

The orchestrator will detect the missing \`audit_proposal\` row and emit
a synthetic \`keep\` proposal with \`confidence: 'low'\` so the proposal
queue retains full coverage.

## Discipline

- ONE \`audit_proposal\` note for this node. No \`breadcrumb\` /
  \`discovery\` / \`question\` chatter during the audit.
- Auditors are read-only. Do **not** call \`update_task_status\`,
  \`update_initiative\`, or \`register_deliverable\`.
- Stay under ~2900 chars in the body so a tightening retry has room.
- If the node has no associated code (planned-only), emit a \`keep\`
  proposal with \`confidence: 'low'\` and a one-line rationale +
  \`would_confirm_by\`. Don't burn ten minutes greenfield-grepping.

## End of turn

After \`take_note\` returns successfully (proposal OR fallback
observation), emit ONE short assistant message (e.g.
\`Proposal <noteId>.\`) and STOP. That terminal text is what the
gateway promotes to \`state: 'final'\` — without it the orchestrator's
dispatch waits the full per-node timeout. Do NOT keep working after
the proposal is accepted; do NOT call additional tools.
`;
}

/**
 * Build the L3 synthesizer briefing (mode: 'synthesis'). The orchestrator
 * pre-loads the L1 manifest + every L2 audit_proposal body, summarizes
 * the proposals via `summarizeProposalForBriefing`, and lays out the §4.4
 * audit_synthesis schema with a concrete example.
 *
 * Spec: specs/subtree-audit-proposals-spec.md §3.3, §4.4.
 */
function buildSynthesisPrompt(args: {
  initiative: BuildAuditPromptInput['initiative'];
  guidance: string | null;
  synthesisInput?: BuildAuditPromptInput['synthesisInput'];
}): string {
  const { initiative, guidance, synthesisInput } = args;
  if (!synthesisInput) {
    throw new Error('buildAuditPrompt(mode=synthesis): synthesisInput is required');
  }
  const { rootId, attempt, manifest, proposalSummaries } = synthesisInput;

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

  const guidanceBlock = guidance?.trim()
    ? `\n## Operator focus\n\n${guidance.trim()}\n`
    : '';

  const manifestBlock = manifest
    ? `\n## L1 Manifest (verbatim)\n\n\`\`\`json\n${JSON.stringify(manifest, null, 2)}\n\`\`\`\n`
    : '\n## L1 Manifest\n\n_(manifest unavailable — surveyor used fallback or failed; reason in operator focus if any)_\n';

  const proposalsBlock =
    proposalSummaries.length === 0
      ? '\n## L2 Proposals\n\n_(no L2 proposals were emitted — empty or unaudited subtree)_\n'
      : `\n## L2 Proposals (one per descendant node)\n\nEach summary below comes from a per-node \`audit_proposal\` note. Read across them — your job is *cross-cutting* reasoning, not re-deriving the per-node verdicts.\n\n${proposalSummaries
          .map(
            (p, i) =>
              `### Proposal ${i + 1} — ${p.initiativeTitle} (id=${p.initiativeId}, note=${p.noteId})\n\n${summarizeProposalForBriefing(p.body)}\n`,
          )
          .join('\n---\n\n')}\n`;

  const exampleBody = `{
  "version": 1,
  "root_initiative_id": "${rootId}",
  "attempt": ${attempt},
  "completion_sentinel": "Audit complete: 7 nodes — 1 done, 2 cancel, 1 keep, 2 modify_scope, 1 new_story; epic dates +14d",
  "epic_proposals": [
    {
      "proposed_action": "modify_epic_dates",
      "proposed_changes": { "target_end": "2026-05-27" },
      "rationale": "Two stories slipped; realistic finish is 2 weeks out.",
      "confidence": "medium"
    },
    {
      "proposed_action": "modify_epic_scope",
      "proposed_changes": { "description": "…revised body…" },
      "rationale": "Body still references the old shim path that was removed.",
      "confidence": "high"
    }
  ],
  "cross_node_proposals": [
    {
      "proposed_action": "merge_stories",
      "subject_initiative_ids": ["6379b104-…", "9ab40f1f-…"],
      "rationale": "Both reference the same alert-shim; one PR closes both.",
      "confidence": "medium"
    },
    {
      "proposed_action": "new_story",
      "proposed_new_node": {
        "kind": "story",
        "title": "Audit + remove dead alert hook in extensions/browser",
        "description": "…",
        "estimated_effort_hours": 2
      },
      "rationale": "Found in repo grep but absent from the epic.",
      "confidence": "medium"
    }
  ]
}`;

  const takeNoteCall = `take_note({
  agent_id: '<your agent_id>',
  kind: 'audit_synthesis',
  initiative_id: '${rootId}',
  scope_key: '<from briefing>',
  role: 'auditor',
  run_group_id: '<from briefing>',
  audience: 'pm',
  importance: 2,
  body: JSON.stringify(<the JSON object above>),
})`;

  return `**Initiative audit — L3 SYNTHESIZER (mode: synthesis)**

You are running the *synthesis* stage. The L1 surveyor produced a
manifest; the L2 per-node auditors produced one \`audit_proposal\` each.
Your only job is to emit ONE \`audit_synthesis\` note carrying the
cross-cutting + epic-level reasoning the per-node auditors couldn't see.

Target root: ${initiative.title}  (kind=${initiative.kind}, status=${initiative.status}, id=${initiative.id})
Attempt: ${attempt}

Description:
> ${description.replace(/\n/g, '\n> ')}

Status check:
${statusCheck}

Target window: ${targetWindow}
${guidanceBlock}${manifestBlock}${proposalsBlock}
## Contract

- Slice: cross-cutting + epic-level reasoning across the L2 proposals.
- Expected deliverable: exactly ONE \`take_note\` call:
  - kind: 'audit_synthesis'
  - initiative_id: '${rootId}'
  - audience: 'pm'
  - importance: 2
  - body: JSON.stringify of an object conforming to the audit_synthesis v1 schema.
- Acceptance criteria:
  * Body parses as the audit_synthesis v1 schema.
  * \`completion_sentinel\` is the FIRST line of the body's narrative — required, single line, ≥1 char, summary of audit results across nodes (e.g., "Audit complete: 7 nodes — 1 done, 2 cancel, 1 keep, 2 modify_scope, 1 new_story; epic dates +14d").
  * \`epic_proposals\` carries only \`modify_epic_dates\` and \`modify_epic_scope\`. No other actions.
  * \`cross_node_proposals\` carries only \`merge_stories\` (≥2 subjects), \`split_story\` (exactly 1 subject), and \`new_story\` (no existing node). Per-node verdicts (keep/mark_done/cancel/modify_scope/modify_dates) are NOT duplicated here — the queue UI derives them from the L2 proposals.
- Expected duration: < 5 minutes wall clock. You're synthesizing; you're not re-grepping the repo.

## Schema (audit_synthesis v1)

Top-level fields:
- \`version\`: literal \`1\`.
- \`root_initiative_id\`: this root's initiative id (\`${rootId}\`).
- \`attempt\`: the L3 attempt number (\`${attempt}\`).
- \`completion_sentinel\`: required single-line summary; the queue UI surfaces this in feed views.
- \`epic_proposals\`: array (may be empty) of \`{ proposed_action: 'modify_epic_dates' | 'modify_epic_scope', proposed_changes, rationale, confidence }\`.
- \`cross_node_proposals\`: array (may be empty) of \`{ proposed_action: 'merge_stories' | 'split_story' | 'new_story', ..., rationale, confidence }\`.

Example body:

\`\`\`jsonc
${exampleBody}
\`\`\`

## How to emit

\`\`\`
${takeNoteCall}
\`\`\`

## Retries on validation failure

The MCP \`take_note\` handler validates the body against the schema +
the 3000-char cap. On failure it returns a structured error naming the
failing field. **Retry up to 2 times** with a tightened body (drop a
weak proposal, shorten a rationale). After 2 failures, give up — the
operator still has the L2 proposal queue and a "synthesis missing"
affordance to re-run just L3.

## Discipline

- ONE \`audit_synthesis\` note. No \`breadcrumb\` / \`discovery\` /
  \`question\` chatter during the synthesis.
- Auditors are read-only. Do **not** call \`update_task_status\`,
  \`update_initiative\`, or \`register_deliverable\`.
- Do **not** re-derive per-node verdicts here. If a per-node proposal
  looks wrong, that's a queue-review concern, not a synthesis concern.
- Stay under ~2900 chars in the body so a tightening retry has room.
- It is OK to emit empty \`epic_proposals\` and \`cross_node_proposals\`
  arrays if the subtree shows no cross-cutting drift — but the
  \`completion_sentinel\` must still summarize the overall verdict.

## End of turn

After \`take_note\` returns successfully, emit ONE short assistant
message (e.g. \`Synthesis <noteId>.\`) and STOP. That terminal text is
what the gateway promotes to \`state: 'final'\` — without it the
orchestrator's dispatch waits the full timeout. Do NOT keep working
after the synthesis is accepted; do NOT call additional tools.
`;
}
