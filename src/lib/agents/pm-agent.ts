/**
 * PM agent definition + soul_md loader.
 *
 * Phase 5 of the roadmap & PM-agent feature (docs/reference/roadmap-and-pm-spec.md).
 * The PM is a planning-layer agent: one per workspace, role='pm', seeded
 * via migration. It reacts to operator-dropped disruptions and produces
 * `pm_proposals` rows. It never writes to the execution board.
 *
 * The system prompt is kept in `pm-soul.md` so it's readable and editable
 * without touching code. We read it at module init and bake it into the
 * exported constant — migrations call `getPmSoulMd()` synchronously and
 * the file lives next to this module.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Initiative } from '@/lib/db/initiatives';
import type { PmDiff } from '@/lib/db/pm-proposals';
import type { RoadmapSnapshot } from '@/lib/db/roadmap';

let _cache: string | null = null;

/**
 * Returns the PM agent's system prompt (soul_md) loaded from
 * `pm-soul.md`. Cached after first read. If the file is missing
 * (shouldn't happen in production — it's part of the source tree), we fall
 * back to a stub so seeds still succeed and the operator can fix it later.
 */
export function getPmSoulMd(): string {
  if (_cache) return _cache;
  try {
    // __dirname-equivalent for both bundled and unbundled callers. In
    // dev/test the file resolves alongside this TS file; under
    // `next build` the assets are co-located via the standalone bundler.
    const filePath = path.join(__dirname, 'pm-soul.md');
    _cache = fs.readFileSync(filePath, 'utf8');
  } catch {
    _cache = PM_SOUL_FALLBACK;
  }
  return _cache!;
}

/**
 * Hardcoded fallback — keeps seeds working even when the .md file isn't
 * reachable from the bundle path (e.g. some Next.js packaging modes). This
 * is intentionally a short summary rather than the full prompt; if the
 * file ever becomes unreadable in production we want the operator to
 * notice.
 */
const PM_SOUL_FALLBACK = `# PM Agent (fallback prompt)

You are the workspace PM. Read the roadmap snapshot, analyze the
operator's disruption, and call \`propose_changes\` with an impact
summary plus a structured diff. Never edit the execution board directly.
This is a stub fallback prompt; restore src/lib/agents/pm-soul.md to use
the full version.`;

export const PM_AGENT_NAME = 'PM';
export const PM_AGENT_AVATAR = '📋';
export const PM_AGENT_ROLE = 'pm';
export const PM_AGENT_DESCRIPTION =
  'Workspace project manager — maintains the roadmap, analyzes disruptions, proposes structured changes the operator approves.';

// ─── Polish B: Guided synthesizers ──────────────────────────────────
//
// Two new synthesize seams matching the LLM-swap-in pattern of
// `synthesizeImpactAnalysis` (pm-dispatch.ts). v1 is deterministic so
// the proposal lifecycle is testable without an LLM dependency. v2 will
// route through an LLM using the same input/output shape.

export interface PlanInitiativeDraft {
  title: string;
  description?: string | null;
  kind?: 'theme' | 'milestone' | 'epic' | 'story';
  complexity?: 'S' | 'M' | 'L' | 'XL' | null;
  parent_initiative_id?: string | null;
  target_start?: string | null;
  target_end?: string | null;
}

export interface PlanInitiativeSuggestions {
  refined_description: string;
  complexity: 'S' | 'M' | 'L' | 'XL';
  target_start: string | null;
  target_end: string;
  dependencies: Array<{
    depends_on_initiative_id: string;
    kind: 'finish_to_start' | 'informational';
    note: string;
  }>;
  status_check_md: string;
  owner_agent_id: string | null;
}

export interface SynthesizePlanResult {
  impact_md: string;
  suggestions: PlanInitiativeSuggestions;
  /** Stored on the proposal as `proposed_changes` for audit. The
   *  acceptProposal handler treats plan_initiative as advisory and never
   *  applies these — they exist as a snapshot of what the PM suggested. */
  changes: PmDiff[];
}

/**
 * Plan a draft initiative — produce a refined description + suggested
 * scaffolding the operator can apply to the form.
 *
 * v1 heuristics (DETERMINISTIC):
 *   - description: capitalize first letter, trim, append a "Goals" bullet
 *     stub if the input is too short to read as goals.
 *   - complexity: respect the operator's choice; otherwise infer from
 *     description word count + keywords:
 *       contains "platform"/"rebuild"/"migrate" → XL
 *       contains "redesign"/"refactor"/"system" → L
 *       contains "tweak"/"copy"/"text"/"fix"   → S
 *       0-30 words → S, 31-100 → M, 101-300 → L, 300+ → XL
 *   - target_start: today (or operator's value).
 *   - target_end: target_start + complexity-derived offset:
 *       S=7d, M=14d, L=28d, XL=56d.
 *   - dependencies: scan workspace initiatives for noun overlap with the
 *     draft title. We split on whitespace, drop stopwords, dedupe, and
 *     emit informational dep suggestions (operator confirms which become
 *     finish_to_start). Capped at 3 to avoid noise.
 *   - status_check_md: scaffolded with three operator-fillable bullets
 *     (Linked PR / Waiting on / Demo plan).
 *   - owner_agent_id: null (v1 doesn't suggest owners — the agent picker
 *     is the operator's call).
 *
 * The LLM swap-in seam is this whole function: replace the body with a
 * model call that returns the same `SynthesizePlanResult` shape.
 *
 * `velocityOverrides`/`availabilityOverrides` are accepted for parity with
 * `synthesizeImpactAnalysis` but unused in v1.
 */
export function synthesizePlanInitiative(
  snapshot: RoadmapSnapshot,
  draft: PlanInitiativeDraft,
  opts: {
    velocityOverrides?: unknown;
    availabilityOverrides?: unknown;
    /**
     * The initiative being planned, when this is a re-plan / refinement
     * against an existing row. Excluded from the dependency-suggestion
     * candidate set so the heuristic doesn't propose the initiative depend
     * on itself when its title overlaps with itself (the §2.3 self-dep bug).
     */
    targetInitiativeId?: string | null;
  } = {},
): SynthesizePlanResult {
  const title = draft.title.trim();
  const rawDesc = (draft.description ?? '').trim();
  const wordCount = rawDesc ? rawDesc.split(/\s+/).filter(Boolean).length : 0;

  // ─── Refined description ─────────────────────────────────────────
  let refined: string;
  if (rawDesc.length === 0) {
    // Stub — give the operator a starting structure.
    refined =
      `${capitalizeFirst(title)}.\n\n` +
      `**Goals**\n- (define the primary user value here)\n\n` +
      `**Out of scope**\n- (call out what this is NOT)\n\n` +
      `**Success criteria**\n- (one measurable outcome)`;
  } else {
    refined = capitalizeFirst(rawDesc);
  }

  // ─── Complexity heuristic ────────────────────────────────────────
  const lowerCorpus = `${title} ${rawDesc}`.toLowerCase();
  let complexity: 'S' | 'M' | 'L' | 'XL';
  if (draft.complexity) {
    complexity = draft.complexity;
  } else if (/\b(platform|rebuild|migrate|migration|overhaul)\b/.test(lowerCorpus)) {
    complexity = 'XL';
  } else if (/\b(redesign|refactor|system|architecture|integrate)\b/.test(lowerCorpus)) {
    complexity = 'L';
  } else if (/\b(tweak|copy|text|fix|typo|polish)\b/.test(lowerCorpus)) {
    complexity = 'S';
  } else if (wordCount <= 30) complexity = 'S';
  else if (wordCount <= 100) complexity = 'M';
  else if (wordCount <= 300) complexity = 'L';
  else complexity = 'XL';

  // ─── Target window ───────────────────────────────────────────────
  const offsetDays: Record<typeof complexity, number> = { S: 7, M: 14, L: 28, XL: 56 };
  const today = new Date();
  const start = draft.target_start ?? isoDate(today);
  const startDate = new Date(start + 'T00:00:00Z');
  const end = isoDate(addDays(startDate, offsetDays[complexity]));

  // ─── Dependency suggestions (keyword overlap) ────────────────────
  const dependencies: PlanInitiativeSuggestions['dependencies'] = [];
  const titleNouns = extractNouns(title);
  if (titleNouns.length > 0) {
    const seen = new Set<string>();
    const titleLower = title.toLowerCase();
    for (const i of snapshot.initiatives) {
      // Skip the target itself (re-plan / refinement) so we don't propose
      // a self-dep — the §2.3 regression that produced
      // "Title shares 'smart, snappy' — confirm if this is a real dependency."
      if (opts.targetInitiativeId && i.id === opts.targetInitiativeId) continue;
      if (i.id === draft.parent_initiative_id) continue;
      if (i.status === 'done' || i.status === 'cancelled') continue;
      // Belt-and-suspenders for the non-target case: skip any candidate
      // whose title is an exact case-insensitive match for the draft —
      // that's almost always self-reference, not a real dependency.
      if (i.title.trim().toLowerCase() === titleLower) continue;
      const otherNouns = extractNouns(i.title);
      const overlap = titleNouns.filter(n => otherNouns.includes(n));
      if (overlap.length === 0) continue;
      if (seen.has(i.id)) continue;
      seen.add(i.id);
      dependencies.push({
        depends_on_initiative_id: i.id,
        kind: 'informational',
        note: `Title shares "${overlap.join(', ')}" — confirm if this is a real dependency.`,
      });
      if (dependencies.length >= 3) break;
    }
  }

  // ─── Status check scaffolding ────────────────────────────────────
  const statusCheckMd =
    `### Status check\n` +
    `- **Linked PR / branch:** _(none yet)_\n` +
    `- **Waiting on:** _(nothing)_\n` +
    `- **Demo plan:** _(TBD)_`;

  const suggestions: PlanInitiativeSuggestions = {
    refined_description: refined,
    complexity,
    target_start: start,
    target_end: end,
    dependencies,
    status_check_md: statusCheckMd,
    owner_agent_id: null,
  };

  // ─── Compose impact_md (audit-friendly summary) ──────────────────
  const lines: string[] = [
    `### PM plan suggestion`,
    ``,
    `- **Title:** ${title}`,
    `- **Suggested complexity:** ${complexity}` +
      (draft.complexity ? ' (operator-set)' : ' (inferred)'),
    `- **Suggested window:** ${start} → ${end}`,
  ];
  if (dependencies.length > 0) {
    lines.push(`- **Possible dependencies (${dependencies.length}):**`);
    for (const d of dependencies) {
      const t = snapshot.initiatives.find(i => i.id === d.depends_on_initiative_id)?.title ?? d.depends_on_initiative_id;
      lines.push(`  - "${t}" — ${d.note}`);
    }
  } else {
    lines.push(`- **Dependencies:** none inferred`);
  }
  lines.push(
    ``,
    `_Advisory only — accept to record the suggestion; apply the form fields client-side._`,
  );

  // Embed the structured suggestions inside an HTML comment so the
  // client can parse them out of any /api/pm/proposals/[id]/refine
  // response (which returns only the proposal row). Markdown renderers
  // ignore HTML comments, so this is invisible to humans.
  lines.push('', `<!--pm-plan-suggestions ${JSON.stringify(suggestions)} -->`);

  // No DB-applied changes for plan_initiative — proposed_changes stays
  // empty so the advisory short-circuit in acceptProposal has nothing
  // to apply. The audit lives in trigger_text + impact_md.
  const changes: PmDiff[] = [];

  return { impact_md: lines.join('\n'), suggestions, changes };
}

export interface SynthesizeDecomposeResult {
  impact_md: string;
  changes: PmDiff[];
}

/**
 * Decompose an existing epic/milestone into 3-7 child initiatives.
 *
 * v1 templates (DETERMINISTIC):
 *   - Title starts with "Build"/"Feature"/"Implement" →
 *       [Design X, Implement core X, Wire X to UI, Test X end-to-end, Document X]
 *   - Title starts with "Launch" or kind=milestone →
 *       [Finalize scope for X, Engineering for X, Marketing for X, QA for X, Go-live for X]
 *   - Otherwise → [Discovery for X, Implementation for X, Verification for X]
 *
 * Children are stories by default. The first child has no deps, each
 * subsequent child depends on its predecessor (pre-wired chain) so the
 * decomposed work has a sensible default ordering. Operators can edit
 * before accepting.
 *
 * `hint` is appended to the description of every child as context.
 *
 * The LLM swap-in seam is this whole function — same pattern as
 * `synthesizePlanInitiative`. v2 reads the parent's description + dep
 * graph and produces richer breakdowns.
 */
export function synthesizeDecompose(
  parent: Initiative,
  hint?: string,
  _opts: {
    velocityOverrides?: unknown;
    availabilityOverrides?: unknown;
  } = {},
): SynthesizeDecomposeResult {
  const x = parent.title;
  const lowerTitle = parent.title.toLowerCase();
  const isLaunch = lowerTitle.startsWith('launch') || parent.kind === 'milestone';
  const isBuild = /^(build|feature|implement|create|add)\b/i.test(parent.title);

  let titles: string[];
  if (isBuild) {
    titles = [
      `Design ${x}`,
      `Implement core ${x}`,
      `Wire ${x} to UI`,
      `Test ${x} end-to-end`,
      `Document ${x}`,
    ];
  } else if (isLaunch) {
    titles = [
      `Finalize scope for ${x}`,
      `Engineering for ${x}`,
      `Marketing for ${x}`,
      `QA for ${x}`,
      `Go-live for ${x}`,
    ];
  } else {
    titles = [
      `Discovery for ${x}`,
      `Implementation for ${x}`,
      `Verification for ${x}`,
    ];
  }

  const baseDesc = parent.description?.trim() ?? '';
  const hintBlock = hint ? `\n\n_Operator hint: ${hint.trim()}_` : '';

  // Default child_kind is one tier below the parent: theme→milestone,
  // milestone→epic, epic→story. Theme is never proposed as a child.
  const childKind: 'milestone' | 'epic' | 'story' =
    parent.kind === 'theme' ? 'milestone'
    : parent.kind === 'milestone' ? 'epic'
    : 'story';

  const changes: PmDiff[] = [];
  for (let i = 0; i < titles.length; i++) {
    const t = titles[i];
    // Pre-wire each child to depend on the prior sibling — the operator
    // can prune. We use placeholder ids `$0`, `$1`, … which resolve to
    // real ids at apply time inside acceptProposal.
    const deps = i === 0 ? [] : [`$${i - 1}`];
    changes.push({
      kind: 'create_child_initiative',
      parent_initiative_id: parent.id,
      title: t,
      description:
        `${t} for parent initiative "${x}".` +
        (baseDesc ? `\n\nParent context:\n${baseDesc}` : '') +
        hintBlock,
      child_kind: childKind,
      complexity: 'M',
      sort_order: i,
      depends_on_initiative_ids: deps,
    });
  }

  const lines: string[] = [
    `### PM decomposition for "${x}"`,
    ``,
    `Proposed ${changes.length} children (${isLaunch ? 'launch template' : isBuild ? 'build template' : 'generic template'}):`,
    ``,
  ];
  for (const c of changes) {
    if (c.kind === 'create_child_initiative') {
      lines.push(`- ${c.title}`);
    }
  }
  if (hint) {
    lines.push(``, `_Operator hint applied: "${hint.trim()}"._`);
  }
  lines.push(
    ``,
    `Apply to insert these as children. You can edit titles or remove rows before accepting.`,
  );

  return { impact_md: lines.join('\n'), changes };
}

// ─── Story → tasks decomposition ─────────────────────────────────────
//
// Sibling of `synthesizeDecompose`, but the parent is a story-kind
// initiative and the output is a convoy DAG (not a flat task list).
// Per the PM convoy mandate (docs/reference/pm-convoy-mandate.md), all
// decompose-flow proposals route through `create_convoy_under_initiative`
// so dep + AC gates apply at the task-graph level.
//
// LLM swap-in seam: the named PM agent supersedes this synth with a
// richer slice DAG via `propose_changes` with trigger_kind='decompose_story'.
// The synth here is the deterministic offline floor and the placeholder
// the operator sees while the agent runs.

export interface SynthesizeStoryTasksResult {
  impact_md: string;
  changes: PmDiff[];
}

interface SliceTemplate {
  id: string;
  role: 'builder' | 'tester' | 'reviewer';
  title: string;
  /** 1-indexed positions in the titles array that this slice depends on. */
  depsOn?: number[];
  /** Per-slice expected duration. */
  minutes: number;
}

function slugifySliceId(title: string, fallback: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30);
  return slug || fallback;
}

export function synthesizeStoryToTasks(
  parent: Initiative,
  hint?: string,
): SynthesizeStoryTasksResult {
  const x = parent.title;
  const lowerTitle = parent.title.toLowerCase();
  const isBuild = /^(build|feature|implement|create|add|wire)\b/i.test(parent.title);
  const isFix = /^(fix|repair|debug)\b/i.test(parent.title);
  const isRefactor = /^(refactor|rewrite|migrate|clean\s*up)\b/i.test(lowerTitle);

  // Pick a template. Each entry chains to the previous slice (depsOn:
  // [i-1]) by default — the synth fallback is intentionally a linear
  // pipeline. The named PM agent emits richer DAGs.
  let template: SliceTemplate[];
  let templateLabel: string;
  if (isFix) {
    templateLabel = 'fix template';
    template = [
      { id: 'reproduce',  role: 'builder', title: `Reproduce: ${x}`,                   minutes: 30 },
      { id: 'patch',      role: 'builder', title: `Patch: ${x}`,                       minutes: 60, depsOn: [1] },
      { id: 'regression', role: 'tester',  title: `Regression test for ${x}`,          minutes: 30, depsOn: [2] },
    ];
  } else if (isRefactor) {
    templateLabel = 'refactor template';
    template = [
      { id: 'inventory',  role: 'builder', title: `Inventory current behavior for ${x}`, minutes: 30 },
      { id: 'refactor',   role: 'builder', title: `Land the refactor for ${x}`,          minutes: 90, depsOn: [1] },
      { id: 'verify',     role: 'tester',  title: `Verify no behavior change in ${x}`,   minutes: 30, depsOn: [2] },
    ];
  } else if (isBuild) {
    templateLabel = 'build template';
    template = [
      { id: 'scaffold',   role: 'builder', title: `Scaffold the data + types for ${x}`, minutes: 30 },
      { id: 'core',       role: 'builder', title: `Implement the core logic for ${x}`,  minutes: 60, depsOn: [1] },
      { id: 'ui',         role: 'builder', title: `Wire ${x} into the UI`,              minutes: 60, depsOn: [2] },
      { id: 'tests',      role: 'tester',  title: `Add tests for ${x}`,                 minutes: 30, depsOn: [3] },
    ];
  } else {
    templateLabel = 'generic template';
    template = [
      { id: 'plan',       role: 'builder', title: `Plan ${x}`,      minutes: 30 },
      { id: 'implement',  role: 'builder', title: `Implement ${x}`, minutes: 60, depsOn: [1] },
      { id: 'verify',     role: 'tester',  title: `Verify ${x}`,    minutes: 30, depsOn: [2] },
    ];
  }

  // Resolve slice ids (slugged from title with disambiguation), then
  // resolve depsOn-by-index into depends_on slice-id arrays.
  const seenIds = new Set<string>();
  const sliceIds: string[] = template.map((t, i) => {
    const base = t.id || slugifySliceId(t.title, `slice-${i + 1}`);
    let candidate = base;
    let n = 2;
    while (seenIds.has(candidate)) {
      candidate = `${base}-${n++}`;
    }
    seenIds.add(candidate);
    return candidate;
  });

  const baseDesc = parent.description?.trim() ?? '';
  const hintBlock = hint ? `\n\n_Operator hint: ${hint.trim()}_` : '';

  const slices = template.map((t, i) => {
    const dependsOn = (t.depsOn ?? []).map(d => sliceIds[d - 1]).filter(Boolean);
    return {
      id: sliceIds[i],
      role: t.role,
      slice: t.title,
      message:
        `${t.title}\n\nFor story "${x}".` +
        (baseDesc ? `\n\nStory context:\n${baseDesc}` : '') +
        hintBlock,
      expected_deliverables: [
        // Single placeholder deliverable; the agent supersedes with the
        // real shape (file paths, deliverable kinds).
        { title: `${t.title} — primary deliverable`, kind: 'file' as const },
      ],
      acceptance_criteria: [
        // One generic, operator-readable AC per slice. Spec section
        // "DAG smell checklist" calls these contract-shaped, which is
        // the smell — the named PM agent should supersede with
        // feature-shaped ACs.
        `${t.title} ships per the parent story's intent.`,
      ],
      expected_duration_minutes: t.minutes,
      ...(dependsOn.length > 0 ? { depends_on: dependsOn } : {}),
    };
  });

  const changes: PmDiff[] = [
    {
      kind: 'create_convoy_under_initiative',
      initiative_id: parent.id,
      parent_acceptance_criteria: [
        // Generic operator-facing parent AC. The named PM supersedes
        // with feature-level criteria.
        `Story "${x}" is shippable end-to-end and meets the parent's stated intent.`,
      ],
      slices,
    } as PmDiff,
  ];

  const lines: string[] = [
    `### Convoy plan for story "${x}"`,
    ``,
    `Proposed ${slices.length}-slice convoy (${templateLabel}):`,
    ``,
    ...slices.map(s => {
      const deps = (s as { depends_on?: string[] }).depends_on;
      return `- \`${s.id}\` · ${s.role} · ~${s.expected_duration_minutes}min` +
        (deps && deps.length > 0 ? ` · depends on ${deps.map(d => `\`${d}\``).join(', ')}` : '') +
        ` — ${s.slice}`;
    }),
  ];
  if (hint) {
    lines.push(``, `_Operator hint applied: "${hint.trim()}"._`);
  }
  lines.push(
    ``,
    `Accept to materialize the convoy: parent task auto-created with \`status=convoy_active\`, slices dispatched in topological order.`,
  );

  return { impact_md: lines.join('\n'), changes };
}

// ─── Helpers ────────────────────────────────────────────────────────

function capitalizeFirst(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setUTCDate(r.getUTCDate() + n);
  return r;
}

const STOPWORDS = new Set([
  'a','an','the','and','or','but','of','to','in','on','for','with','at','by',
  'from','up','as','is','it','be','do','we','our','i','my','this','that',
  'plan','build','add','create','launch','new','setup','make','feature',
]);

function extractNouns(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 4 && !STOPWORDS.has(w));
}
