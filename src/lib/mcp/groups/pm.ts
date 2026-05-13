/**
 * PM-specific MCP tools (proposals, derivation preview, availability).
 *
 * Behavior is unchanged from the legacy `roadmap-tools.ts`; this is a
 * pure relocation as part of the MCP surface refactor (PR 1).
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { queryOne, run } from '@/lib/db';
import { createOwnerAvailability } from '@/lib/db/owner-availability';
import { getRoadmapSnapshot } from '@/lib/db/roadmap';
import { previewDerivation } from '@/lib/roadmap/apply-derivation';
import {
  createProposal,
  refineProposal as refineProposalDb,
  tryAdoptOrphanedPlaceholder,
  type PmDiff,
} from '@/lib/db/pm-proposals';
import {
  dispatchPm,
  PmDispatchGatewayUnavailableError,
  postPmChatMessage,
} from '@/lib/agents/pm-dispatch';
import { getOpenClawClient } from '@/lib/openclaw/client';
import { enqueuePendingNote } from '@/lib/db/pm-pending-notes';
import { broadcast } from '@/lib/events';

import {
  agentIdArg,
  safeWrap,
  safeWrapAsync,
  DiffSchema,
} from '../shared';

export function registerPmTools(server: McpServer): void {
  server.registerTool(
    'add_owner_availability',
    {
      title: 'Add an owner-availability window',
      description:
        'Records that an agent is unavailable in a window. The PM may use this when the operator stated an availability fact directly; otherwise the PM proposes the change via propose_changes.',
      inputSchema: {
        agent_id: agentIdArg,
        for_agent_id: z
          .string()
          .min(1)
          .describe(
            'Agent whose availability is being recorded (target). Distinct from agent_id, which identifies the calling PM.',
          ),
        start: z
          .string()
          .min(1)
          .describe(
            'Inclusive start of the unavailable window. ISO 8601 (YYYY-MM-DD or full datetime).',
          ),
        end: z
          .string()
          .min(1)
          .describe(
            'Exclusive end of the unavailable window. ISO 8601 (YYYY-MM-DD or full datetime).',
          ),
        reason: z
          .string()
          .optional()
          .describe('One-line reason ("vacation", "PTO", "on-call rotation"). Surfaces in the schedule UI.'),
      },
      annotations: { destructiveHint: true, openWorldHint: false },
    },
    async (args) => safeWrap(() =>
      createOwnerAvailability({
        agent_id: args.for_agent_id,
        unavailable_start: args.start,
        unavailable_end: args.end,
        reason: args.reason,
      }),
    ),
  );

  server.registerTool(
    'propose_changes',
    {
      title: 'PM: propose roadmap changes',
      description:
        "The PM agent's primary write path. Creates a `pm_proposals` row in `draft` status with a markdown impact summary and a structured diff list. The operator approves at the proposal level — never call any of the other write tools to push changes through; always go through this one.",
      inputSchema: {
        agent_id: agentIdArg,
        workspace_id: z
          .string()
          .min(1)
          .describe('Workspace this proposal targets. Use the id from your whoami payload.'),
        trigger_text: z
          .string()
          .min(1)
          .max(20000)
          .describe(
            'REQUIRED. The operator statement, audit excerpt, or freeform note that prompted this proposal. Stored on the pm_proposals row so reviewers see what you were responding to. Markdown OK.',
          ),
        trigger_kind: z
          .enum([
            'manual',
            'scheduled_drift_scan',
            'disruption_event',
            'status_check_investigation',
            'plan_initiative',
            'decompose_initiative',
            'decompose_story',
            'notes_intake',
          ])
          .optional()
          .describe(
            'How this proposal originated. Defaults to "manual". Use "notes_intake" when responding to operator notes / audit findings, "disruption_event" for shifts triggered by an availability change, "scheduled_drift_scan" for daily standup output.',
          ),
        impact_md: z
          .string()
          .min(1)
          .max(20000)
          .describe(
            'REQUIRED. Markdown summary the operator reads in the proposal review UI. Lead with the headline change in 1–2 sentences, then bullet the schedule/scope impact. Quantify everything (days, percentages, status changes).',
          ),
        // Tolerate stringified-array payloads coming from agent tool-use
        // serialization layers that occasionally JSON-stringify array args.
        // We unwrap-then-validate so the agent doesn't have to retry just
        // because its caller chose strings over arrays.
        changes: z
          .preprocess(
            (val) => {
              if (typeof val === 'string') {
                try {
                  return JSON.parse(val);
                } catch {
                  return val;
                }
              }
              return val;
            },
            z.array(DiffSchema),
          )
          .describe(
            'REQUIRED. Array of structured diffs (PmDiff[]). Each entry has a `kind` discriminator — see set_initiative_status, shift_initiative_target, add_dependency, remove_dependency, create_child_initiative, etc. Empty arrays are rejected.',
          ),
        parent_proposal_id: z
          .string()
          .nullish()
          .describe(
            'Optional. When refining a prior proposal, set this to its id so the chain is preserved.',
          ),
        /**
         * Structured planning suggestions for plan_initiative proposals.
         * Pass the suggestions object here directly rather than embedding
         * JSON in impact_md — avoids all sidecar parsing problems.
         * Required fields: refined_description, complexity.
         * Optional: target_start, target_end, status_check_md, dependencies.
         */
        plan_suggestions: z
          .preprocess((val) => {
            if (typeof val === 'string') {
              try {
                return JSON.parse(val);
              } catch {
                return val;
              }
            }
            return val;
          }, z.record(z.string(), z.unknown()))
          // .nullish() lives OUTSIDE the preprocess so the JSON-schema
          // export marks the field as optional. With .nullish() inside
          // the preprocess the agent saw it as required, forcing a
          // useless retry on every proposal that wasn't a plan_initiative.
          .nullish()
          .describe(
            'Optional — only populate for plan_initiative proposals. Object with `refined_description` + `complexity` (required when present), plus optional `target_start`, `target_end`, `status_check_md`, `dependencies`. Omit entirely (or send null) for any other proposal kind.',
          ),
      },
      annotations: { destructiveHint: false, openWorldHint: false },
    },
    async (args) => safeWrap(() => {
      // Some LLM tool-use serializers (and the relay path between the
      // gateway and our MCP server) double-escape newline / tab chars,
      // so impact_md arrives with literal "\n" (two characters) instead
      // of an actual newline. Unescape on the way in so the proposal
      // page's ReactMarkdown renders paragraph breaks rather than the
      // string "\n" inline with the prose. Conservative: only the
      // canonical JSON whitespace escapes — leaves \\, \", \uXXXX, and
      // anything else untouched.
      const unescapeWhitespace = (s: string): string =>
        s.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t');

      const created = createProposal({
        workspace_id: args.workspace_id,
        trigger_text: args.trigger_text,
        trigger_kind: args.trigger_kind,
        impact_md: unescapeWhitespace(args.impact_md),
        proposed_changes: args.changes as PmDiff[],
        plan_suggestions: args.plan_suggestions ?? null,
        parent_proposal_id: args.parent_proposal_id ?? null,
      });

      // Retroactive supersede: if a synth placeholder is still
      // orphaned (in-flight reconciler timed out before the agent's
      // tool call arrived — happens under heavy ML-server load), adopt
      // it now. The agent caller didn't pass parent_proposal_id, so
      // only run this when the row is unlinked.
      if (!created.parent_proposal_id) {
        try {
          const adoptedPlaceholderId = tryAdoptOrphanedPlaceholder(created.id);
          if (adoptedPlaceholderId) {
            // Re-echo the agent's (richer) impact_md into chat anchored
            // to the new agent-row id. Mirrors the in-flight reconciler
            // path in pm-dispatch.ts.
            try {
              postPmChatMessage({
                workspace_id: created.workspace_id,
                content: created.impact_md,
                proposal_id: created.id,
                role: 'assistant',
                context: {
                  trigger_kind: created.trigger_kind,
                  target_initiative_id: created.target_initiative_id ?? null,
                  parent_proposal_id: adoptedPlaceholderId,
                  origin: 'pm_dispatch',
                },
              });
            } catch (err) {
              console.warn(
                '[propose_changes] retroactive chat re-echo failed:',
                (err as Error).message,
              );
            }
            broadcast({
              type: 'pm_proposal_replaced',
              payload: {
                workspace_id: created.workspace_id,
                old_id: adoptedPlaceholderId,
                new_id: created.id,
                target_initiative_id: created.target_initiative_id ?? null,
                trigger_kind: created.trigger_kind,
              },
            });
            console.log(
              `[propose_changes] retroactively adopted orphan placeholder ${adoptedPlaceholderId} ` +
                `← agent row ${created.id} (workspace=${created.workspace_id}, ` +
                `trigger_kind=${created.trigger_kind})`,
            );
          }
        } catch (err) {
          console.warn(
            '[propose_changes] orphan-adopt failed (non-fatal):',
            (err as Error).message,
          );
        }
      }

      return created;
    }),
  );

  server.registerTool(
    'propose_from_notes',
    {
      title: 'PM: propose roadmap + task changes from freeform notes',
      description:
        "Hand the PM a paragraph (or several) of freeform text — meeting notes, kickoff transcript, weekly review, brain-dump — and the PM agent reads it, consults the roadmap snapshot, and replies with a single `propose_changes` MCP call carrying a coherent set of structured diffs (creates/updates on initiatives plus draft tasks under them). Returns `{status: 'dispatched', proposal_id}` on success. If the openclaw gateway is unreachable, the request is enqueued in `pm_pending_notes` and replayed automatically when the gateway comes back; in that case `{status: 'queued', pending_id}` is returned. There is NO deterministic fallback: a regex parser on freeform notes is worse than nothing.",
      inputSchema: {
        agent_id: agentIdArg,
        workspace_id: z
          .string()
          .min(1)
          .describe('Workspace these notes belong to.'),
        notes_text: z
          .string()
          .min(1)
          .max(20000)
          .describe(
            'Freeform paragraphs the PM will read. Meeting notes, kickoff transcripts, weekly reviews, brain-dumps. Markdown is fine. Cap is 20K chars.',
          ),
        scope_hint: z
          .object({
            target_initiative_id: z
              .string()
              .optional()
              .describe('Focus the PM on this initiative when interpreting the notes.'),
            include_tasks: z
              .boolean()
              .optional()
              .describe('When true, the PM may propose task-level diffs alongside initiative changes.'),
          })
          .optional()
          .describe('Optional hints that bias the PM toward a specific initiative or scope.'),
      },
      annotations: { destructiveHint: false, openWorldHint: false },
    },
    async (args) => safeWrapAsync(async () => {
      // Health check before dispatch. When the gateway is down, enqueue
      // and bail — no synth fallback for this path.
      const gw = getOpenClawClient();
      if (!gw.isConnected()) {
        const queued = enqueuePendingNote({
          workspace_id: args.workspace_id,
          agent_id: args.agent_id,
          notes_text: args.notes_text,
          scope_hint: args.scope_hint ?? null,
        });
        return { status: 'queued' as const, pending_id: queued.id };
      }
      try {
        const result = dispatchPm({
          workspace_id: args.workspace_id,
          trigger_text: args.notes_text,
          trigger_kind: 'notes_intake',
          allowFallback: false,
        });
        // Wait for the agent's reply so callers don't get back a synth
        // placeholder that masquerades as a successful dispatch. notes_intake
        // strictly requires the named agent (regex on freeform notes is
        // worse than nothing).
        const settled = await result.completion;
        if (!settled.used_named_agent) {
          // Agent never replied within the tail window — clean up the
          // placeholder and queue for replay so we don't keep a misleading
          // draft around.
          try { run(`DELETE FROM pm_proposals WHERE id = ?`, [result.proposal.id]); } catch { /* best-effort */ }
          const queued = enqueuePendingNote({
            workspace_id: args.workspace_id,
            agent_id: args.agent_id,
            notes_text: args.notes_text,
            scope_hint: args.scope_hint ?? null,
          });
          return { status: 'queued' as const, pending_id: queued.id };
        }
        return { status: 'dispatched' as const, proposal_id: settled.final.id };
      } catch (err) {
        if (err instanceof PmDispatchGatewayUnavailableError) {
          // Gateway dropped between the health check and dispatch — queue
          // it so the request isn't lost.
          const queued = enqueuePendingNote({
            workspace_id: args.workspace_id,
            agent_id: args.agent_id,
            notes_text: args.notes_text,
            scope_hint: args.scope_hint ?? null,
          });
          return { status: 'queued' as const, pending_id: queued.id };
        }
        throw err;
      }
    }),
  );

  server.registerTool(
    'refine_proposal',
    {
      title: 'PM: refine a prior proposal with an additional constraint',
      description:
        "Marks the parent superseded and creates a fresh draft. Use this when the operator says 'refine — keep launch on schedule, defer analytics'.",
      inputSchema: {
        agent_id: agentIdArg,
        proposal_id: z
          .string()
          .min(1)
          .describe('ID of the proposal to refine. Marked superseded; a fresh draft is created from it.'),
        additional_constraint: z
          .string()
          .min(1)
          .max(5000)
          .describe(
            'The new constraint or steer the operator added — e.g. "keep launch on schedule, defer analytics", "no scope cuts; push target_end instead". One paragraph max.',
          ),
      },
      annotations: { destructiveHint: false, openWorldHint: false },
    },
    async (args) => safeWrapAsync(async () => {
      // The DB helper creates an empty child slot; the dispatch path
      // fills it with a freshly-synthesized impact + changes.
      const parent = queryOne<{ workspace_id: string }>(
        'SELECT workspace_id FROM pm_proposals WHERE id = ?',
        [args.proposal_id],
      );
      if (!parent) throw new Error(`proposal ${args.proposal_id} not found`);
      refineProposalDb(args.proposal_id, args.additional_constraint);
      // Re-dispatch so the new draft has impact_md + changes filled in.
      // We do this here (instead of relying on the API route refine
      // path) so MCP-driven refines also work.
      const result = dispatchPm({
        workspace_id: parent.workspace_id,
        trigger_text: args.additional_constraint,
        trigger_kind: 'manual',
      });
      return { refined_proposal: result.proposal };
    }),
  );

  server.registerTool(
    'preview_derivation',
    {
      title: 'PM: read-only schedule what-if',
      description:
        'Run the derivation engine against the current snapshot with optional velocity / availability overrides, WITHOUT writing. Use this to estimate impact before composing a propose_changes call.',
      inputSchema: {
        agent_id: agentIdArg,
        workspace_id: z
          .string()
          .min(1)
          .describe('Workspace whose roadmap snapshot you want to derive against.'),
        velocity_overrides: z
          .record(z.string(), z.number().min(0).max(10))
          .optional()
          .describe(
            'Map of agent_id → velocity-multiplier (0..10). Use to model "what if this agent works at half speed for the next sprint?". Omit to use historical velocity.',
          ),
        availability_overrides: z
          .array(
            z.object({
              agent_id: z
                .string()
                .min(1)
                .describe('Agent the override applies to.'),
              unavailable_start: z
                .string()
                .min(1)
                .describe('Inclusive start of the unavailable window. ISO 8601.'),
              unavailable_end: z
                .string()
                .min(1)
                .describe('Exclusive end of the unavailable window. ISO 8601.'),
              reason: z
                .string()
                .optional()
                .describe('Optional one-line reason for the operator-facing diff.'),
            }),
          )
          .optional()
          .describe(
            'Hypothetical availability windows layered over the real ones for this preview. Doesn\'t persist.',
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => safeWrap(() => {
      const snapshot = getRoadmapSnapshot({ workspace_id: args.workspace_id });
      const result = previewDerivation(snapshot, {
        velocityOverrides: args.velocity_overrides,
        availabilityOverrides: (args.availability_overrides ?? []).map(a => ({
          agent_id: a.agent_id,
          unavailable_start: a.unavailable_start,
          unavailable_end: a.unavailable_end,
          reason: a.reason ?? null,
        })),
      });
      // Strip the schedule Map (not JSON-serializable) — diffs already
      // capture the differences; cycle/warnings are still useful.
      return {
        diffs: result.diffs,
        drifts: result.drifts,
        cycle: result.derived.cycle,
        no_effort_initiative_ids: result.derived.noEffort,
        warnings: result.derived.warnings,
      };
    }),
  );
}
