/**
 * Zod schemas for the subtree-audit proposal pipeline.
 *
 * See docs/archive/subtree-audit-proposals-spec.md §4 (note kinds + body
 * schemas). All three schemas describe JSON payloads stored in
 * `agent_notes.body` (a TEXT column with a 3000-char cap). The
 * orchestrator's pre-cap budget is `MAX_AUDIT_NOTE_BODY_CHARS` (2900),
 * leaving ~100 chars of headroom under the underlying take_note cap.
 *
 * Validation runs in the MCP `take_note` handler iff
 * `kind ∈ {audit_manifest, audit_proposal, audit_synthesis}` so
 * auditor agents get immediate, structured feedback they can recover
 * from on the same dispatch (mirrors the cancelled-run guard pattern
 * at src/lib/mcp/groups/core.ts).
 */

import { z } from 'zod';

import type { NoteKind } from '@/lib/db/agent-notes';

// ─── Constants ──────────────────────────────────────────────────────

/**
 * Pre-cap budget for audit note bodies. The underlying DB column /
 * take_note cap is 3000 chars; the orchestrator instructs auditors to
 * stay under 2900 so a tightening retry has room to land. See
 * spec §4.5.
 */
export const MAX_AUDIT_NOTE_BODY_CHARS = 2900;

// ─── Shared fragments ───────────────────────────────────────────────

const confidenceEnum = z.enum(['low', 'medium', 'high']);

const hypothesisEnum = z.enum([
  'likely-done',
  'likely-drifted',
  'likely-cancelled',
  'no-evidence',
  'needs-deep-dive',
]);

// Repo evidence refs are loosely structured — `{kind, ref}` with non-empty
// ref. We deliberately do NOT enforce per-kind ref shapes here: this same
// schema is used at both write-time (take_note validator) and read-time
// (proposal-queue render). A stricter regex would be correct at write but
// would retroactively invalidate already-stored rows on read, silently
// dropping them from the queue — that's data loss without operator signal.
//
// Defense-in-depth lives elsewhere: the L2 prompt teaches per-kind ref
// shapes (use `kind:'file'` for negative findings, never put grep output
// in `kind:'git'`), and the renderer guards the SHA-slice with a regex
// check so non-SHA `kind:'git'` refs render as full text rather than as
// gibberish chips.
const evidenceRefSchema = z.object({
  kind: z.enum(['file', 'git', 'pr', 'note']),
  ref: z.string().min(1),
});

const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD');

// ─── §4.2 — audit_manifest body schema (L1 surveyor output) ─────────

const manifestNodeSchema = z.object({
  initiative_id: z.string().min(1),
  title: z.string().min(1),
  current_status: z.string().min(1),
  hypothesis: hypothesisEnum,
  confidence: confidenceEnum,
  investigation_prompt: z.string().min(1),
  scoped_evidence_hints: z.array(z.string()).default([]),
  skip: z.boolean(),
});

export const auditManifestBodySchema = z.object({
  version: z.literal(1),
  root_initiative_id: z.string().min(1),
  attempt: z.number().int().nonnegative(),
  previous_synthesis_run_group_id: z.string().nullable(),
  summary: z.string().min(1),
  nodes: z.array(manifestNodeSchema),
  cross_cutting_questions: z.array(z.string()).default([]),
});

export type AuditManifestBody = z.infer<typeof auditManifestBodySchema>;
export type AuditManifestNode = z.infer<typeof manifestNodeSchema>;

// ─── §4.3 — audit_proposal body schema (L2 + synthetic skip-keeps) ──

// §4.3.1 — discriminated union by `proposed_action`.
const proposedChangesByAction = z.discriminatedUnion('proposed_action', [
  z.object({
    proposed_action: z.literal('keep'),
    // `keep` proposes no mutation — the changes object must be empty.
    // We validate this via superRefine below rather than relying on
    // .strict() inside an intersection, which doesn't preserve strict
    // mode reliably across all zod chains.
    proposed_changes: z.record(z.string(), z.unknown()),
  }),
  z.object({
    proposed_action: z.literal('mark_done'),
    proposed_changes: z.object({ note: z.string().min(1) }).strict(),
  }),
  z.object({
    proposed_action: z.literal('cancel'),
    proposed_changes: z.object({ reason: z.string().min(1) }).strict(),
  }),
  z.object({
    proposed_action: z.literal('modify_scope'),
    proposed_changes: z
      .object({
        title: z.string().min(1).optional(),
        description: z.string().min(1).optional(),
      })
      .strict()
      .refine(
        (v) => v.title !== undefined || v.description !== undefined,
        'modify_scope requires at least one of {title, description}',
      ),
  }),
  z.object({
    proposed_action: z.literal('modify_dates'),
    proposed_changes: z
      .object({
        target_start: isoDateSchema.optional(),
        target_end: isoDateSchema.optional(),
      })
      .strict()
      .refine(
        (v) => v.target_start !== undefined || v.target_end !== undefined,
        'modify_dates requires at least one of {target_start, target_end}',
      ),
  }),
]);

const proposalCommonSchema = z.object({
  version: z.literal(1),
  node_initiative_id: z.string().min(1),
  current_mc_status: z.string().min(1),
  current_mc_target_end: z.string().nullable(),
  repo_evidence: z
    .array(evidenceRefSchema)
    .min(1, 'repo_evidence must have at least one entry'),
  rationale: z.string().min(1),
  confidence: confidenceEnum,
  would_confirm_by: z.string().nullable().optional(),
  continuation_note_id: z.string().nullable().optional(),
});

export const auditProposalBodySchema = proposalCommonSchema
  .and(proposedChangesByAction)
  .superRefine((data, ctx) => {
    // Spec §4.3: when confidence < high, would_confirm_by is required.
    if (
      data.confidence !== 'high' &&
      (data.would_confirm_by == null || data.would_confirm_by.trim() === '')
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'would_confirm_by is required when confidence is low or medium',
        path: ['would_confirm_by'],
      });
    }
    // §4.3.1: `keep` proposes no mutation — proposed_changes must be {}.
    if (
      data.proposed_action === 'keep' &&
      Object.keys(data.proposed_changes as Record<string, unknown>).length > 0
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "proposed_changes must be an empty object when proposed_action is 'keep'",
        path: ['proposed_changes'],
      });
    }
  });

export type AuditProposalBody = z.infer<typeof auditProposalBodySchema>;

// ─── §4.4 — audit_synthesis body schema (L3 synthesizer output) ─────

const epicProposalSchema = z.discriminatedUnion('proposed_action', [
  z.object({
    proposed_action: z.literal('modify_epic_dates'),
    proposed_changes: z
      .object({
        target_start: isoDateSchema.optional(),
        target_end: isoDateSchema.optional(),
      })
      .strict()
      .refine(
        (v) => v.target_start !== undefined || v.target_end !== undefined,
        'modify_epic_dates requires at least one of {target_start, target_end}',
      ),
    rationale: z.string().min(1),
    confidence: confidenceEnum,
  }),
  z.object({
    proposed_action: z.literal('modify_epic_scope'),
    proposed_changes: z
      .object({
        title: z.string().min(1).optional(),
        description: z.string().min(1).optional(),
      })
      .strict()
      .refine(
        (v) => v.title !== undefined || v.description !== undefined,
        'modify_epic_scope requires at least one of {title, description}',
      ),
    rationale: z.string().min(1),
    confidence: confidenceEnum,
  }),
]);

const crossNodeProposalSchema = z.discriminatedUnion('proposed_action', [
  z.object({
    proposed_action: z.literal('merge_stories'),
    subject_initiative_ids: z.array(z.string().min(1)).min(2),
    rationale: z.string().min(1),
    confidence: confidenceEnum,
  }),
  z.object({
    proposed_action: z.literal('split_story'),
    subject_initiative_ids: z.array(z.string().min(1)).length(1),
    rationale: z.string().min(1),
    confidence: confidenceEnum,
  }),
  z.object({
    proposed_action: z.literal('new_story'),
    proposed_new_node: z.object({
      kind: z.enum(['epic', 'story']),
      title: z.string().min(1),
      description: z.string().min(1),
      estimated_effort_hours: z.number().nonnegative().optional(),
    }),
    rationale: z.string().min(1),
    confidence: confidenceEnum,
  }),
]);

export const auditSynthesisBodySchema = z.object({
  version: z.literal(1),
  root_initiative_id: z.string().min(1),
  attempt: z.number().int().nonnegative(),
  completion_sentinel: z.string().min(1),
  epic_proposals: z.array(epicProposalSchema).default([]),
  cross_node_proposals: z.array(crossNodeProposalSchema).default([]),
});

export type AuditSynthesisBody = z.infer<typeof auditSynthesisBodySchema>;

// ─── audit_verdict body schema (narrow audit) ──────────────────────
// Structured signal emitted by the narrow `initiative_audit` auditor
// alongside its free-form observation note. The take_note handler
// reads this row to decide whether to auto-dispatch a notes_intake PM
// session (gated by the workspace `audit_auto_spawn_pm` setting).
// See docs/archive/audit-action-recommended.md.

export const VERDICT_VALUES = [
  'on_track',
  'partially_done',
  'stale_rescope',
  'never_built',
  'done_in_entirety',
  'cancelled_in_effect',
  'audit_failed',
] as const;
export type AuditVerdictValue = (typeof VERDICT_VALUES)[number];

export const RECOMMENDED_ACTION_HINTS = [
  'cancel',
  'mark_done',
  'decompose',
  'modify_scope',
  'modify_dates',
  'investigate_further',
] as const;

export const auditVerdictBodySchema = z.object({
  version: z.literal(1),
  /**
   * The free-form observation note this verdict was emitted alongside.
   * The auto-spawn hook reads it to bundle observation body + verdict
   * rationale into the PM trigger_text.
   */
  observation_note_id: z.string().min(1),
  verdict: z.enum(VERDICT_VALUES),
  /**
   * True only when the verdict implies the operator should act now.
   * `on_track` → false; `audit_failed` may also be true if the auditor
   * thinks a follow-up dispatch is warranted.
   */
  action_recommended: z.boolean(),
  recommended_action_hint: z.enum(RECOMMENDED_ACTION_HINTS).nullish(),
  short_rationale: z.string().min(20).max(800),
});

export type AuditVerdictBody = z.infer<typeof auditVerdictBodySchema>;

// ─── Validation helper ──────────────────────────────────────────────

export type AuditNoteKind =
  | 'audit_manifest'
  | 'audit_proposal'
  | 'audit_synthesis'
  | 'audit_verdict';

export function isAuditNoteKind(kind: NoteKind): kind is AuditNoteKind {
  return (
    kind === 'audit_manifest' ||
    kind === 'audit_proposal' ||
    kind === 'audit_synthesis' ||
    kind === 'audit_verdict'
  );
}

export type ValidateAuditNoteResult =
  | { ok: true; parsed: unknown }
  | { ok: false; error: string };

/**
 * Parse a JSON-stringified body and validate it against the Zod schema
 * for the given audit kind. Returns a structured result the MCP
 * `take_note` handler relays to the auditor agent so retry logic can
 * key on the failing field path.
 *
 * No-op (returns `{ ok: false, error: 'not an audit kind' }`) when
 * called with a non-audit kind — the handler should pre-filter via
 * `isAuditNoteKind` so this branch is defensive.
 */
export function validateAuditNoteBody(
  kind: NoteKind,
  bodyJson: string,
): ValidateAuditNoteResult {
  if (!isAuditNoteKind(kind)) {
    return { ok: false, error: `not an audit kind: ${kind}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyJson);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: `body must be a JSON string for kind=${kind} — JSON.parse failed: ${msg}`,
    };
  }

  const schema =
    kind === 'audit_manifest'
      ? auditManifestBodySchema
      : kind === 'audit_proposal'
        ? auditProposalBodySchema
        : kind === 'audit_synthesis'
          ? auditSynthesisBodySchema
          : auditVerdictBodySchema;

  const result = schema.safeParse(parsed);
  if (result.success) {
    return { ok: true, parsed: result.data };
  }

  // Compact, agent-readable error: "field.path: message; field.path: message".
  // Avoids dumping the full ZodError tree.
  const issues = result.error.issues.slice(0, 5).map((iss) => {
    const path = iss.path.length > 0 ? iss.path.join('.') : '<root>';
    return `${path}: ${iss.message}`;
  });
  const more =
    result.error.issues.length > issues.length
      ? ` (+${result.error.issues.length - issues.length} more)`
      : '';
  return {
    ok: false,
    error:
      `body failed ${kind} schema validation — ${issues.join('; ')}${more}`,
  };
}
