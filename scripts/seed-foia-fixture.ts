/**
 * Seeds the canonical FOIA initiative tree fixture used by the
 * scope-keyed-sessions validation pack. See
 * `specs/scope-keyed-sessions-validation/01-pre-check-initialization.md` §6.
 *
 * Idempotent: re-running against an existing FOIA workspace updates titles
 * but does not duplicate rows. Safe to run after `yarn db:reset`.
 *
 * Tree shape (mirrors the production fixture seen in dispatch traces):
 *   FOIA Request Pipeline                    (milestone)
 *   ├── Discovery for FOIA Request Pipeline  (epic)
 *   │   ├── Agency Profile Schema & Data Model
 *   │   ├── Governing Statute & Records Officer Lookup
 *   │   ├── Intake Channel Detection (Email, Portal Form, Mail)
 *   │   ├── Fee Policy & Statutory Response Deadline Extraction
 *   │   ├── Profile Validation & Screenshot Evidence
 *   │   ├── Cache Persistence & Query Layer
 *   │   └── Verification for FOIA Request Pipeline
 *   └── Implementation for FOIA Request Pipeline (story sibling)
 *
 * Output: prints workspace_id and a tree summary on stdout. Captures the
 * initiative ids to stderr (one per line) for downstream test scripts.
 */

import { closeDb, getDb, queryAll, queryOne, run } from '../src/lib/db';
import { createInitiative } from '../src/lib/db/initiatives';
import { ensurePmAgent } from '../src/lib/bootstrap-agents';
import { v4 as uuidv4 } from 'uuid';

interface SeededInitiative {
  id: string;
  kind: 'milestone' | 'epic' | 'story';
  title: string;
  parent: string | null;
}

const STORIES_UNDER_DISCOVERY = [
  'Agency Profile Schema & Data Model',
  'Governing Statute & Records Officer Lookup',
  'Intake Channel Detection (Email, Portal Form, Mail)',
  'Fee Policy & Statutory Response Deadline Extraction',
  'Profile Validation & Screenshot Evidence',
  'Cache Persistence & Query Layer',
  'Verification for FOIA Request Pipeline',
];

function ensureFoiaWorkspace(): string {
  const existing = queryOne<{ id: string }>(
    `SELECT id FROM workspaces WHERE slug = 'foia' LIMIT 1`,
  );
  if (existing) return existing.id;

  const id = uuidv4();
  run(
    `INSERT INTO workspaces (id, name, slug, created_at)
     VALUES (?, 'FOIA', 'foia', datetime('now'))`,
    [id],
  );
  return id;
}

function findInitiativeByTitle(workspaceId: string, title: string): { id: string } | null {
  return queryOne<{ id: string }>(
    `SELECT id FROM initiatives WHERE workspace_id = ? AND title = ? LIMIT 1`,
    [workspaceId, title],
  ) ?? null;
}

function ensureInitiative(
  workspaceId: string,
  kind: 'milestone' | 'epic' | 'story',
  title: string,
  parentId: string | null,
  extras: { description?: string; target_end?: string } = {},
): string {
  const existing = findInitiativeByTitle(workspaceId, title);
  if (existing) return existing.id;
  const created = createInitiative({
    workspace_id: workspaceId,
    kind,
    title,
    parent_initiative_id: parentId,
    description: extras.description ?? null,
    target_end: extras.target_end ?? null,
  });
  return created.id;
}

function plus90Days(): string {
  const d = new Date();
  d.setDate(d.getDate() + 90);
  return d.toISOString().slice(0, 10);
}

function seedFoiaFixture(): void {
  // Touch the DB once up-front so migrations run if this is a fresh DB.
  getDb();

  const workspaceId = ensureFoiaWorkspace();
  ensurePmAgent(workspaceId);

  const seeded: SeededInitiative[] = [];

  const milestoneId = ensureInitiative(
    workspaceId,
    'milestone',
    'FOIA Request Pipeline',
    null,
    {
      description:
        'End-to-end pipeline for filing, tracking, and reasoning over public-records requests. Reaches every US state + federal agencies.',
      target_end: plus90Days(),
    },
  );
  seeded.push({ id: milestoneId, kind: 'milestone', title: 'FOIA Request Pipeline', parent: null });

  const discoveryId = ensureInitiative(
    workspaceId,
    'epic',
    'Discovery for FOIA Request Pipeline',
    milestoneId,
    {
      description:
        'Pre-build research and schema discovery: agency profiles, statutes, intake channels, fees, validation.',
    },
  );
  seeded.push({
    id: discoveryId,
    kind: 'epic',
    title: 'Discovery for FOIA Request Pipeline',
    parent: milestoneId,
  });

  for (const title of STORIES_UNDER_DISCOVERY) {
    const id = ensureInitiative(workspaceId, 'story', title, discoveryId);
    seeded.push({ id, kind: 'story', title, parent: discoveryId });
  }

  const implementationId = ensureInitiative(
    workspaceId,
    'story',
    'Implementation for FOIA Request Pipeline',
    milestoneId,
    {
      description:
        'Build phase. Picks up after Discovery hands off agency cache + statute set + channel detector.',
    },
  );
  seeded.push({
    id: implementationId,
    kind: 'story',
    title: 'Implementation for FOIA Request Pipeline',
    parent: milestoneId,
  });

  // Output summary to stdout (machine-parseable).
  console.log(JSON.stringify({ workspace_id: workspaceId, initiatives: seeded }, null, 2));

  // Pretty-print to stderr for human consumption.
  process.stderr.write(`\nFOIA fixture ready in workspace ${workspaceId}\n\n`);
  for (const init of seeded) {
    const indent = init.kind === 'milestone' ? '' : init.kind === 'epic' ? '  ' : '    ';
    process.stderr.write(`${indent}${init.kind.padEnd(9)} ${init.id}  ${init.title}\n`);
  }

  const counts = queryAll<{ kind: string; n: number }>(
    `SELECT kind, COUNT(*) AS n FROM initiatives WHERE workspace_id = ? GROUP BY kind`,
    [workspaceId],
  );
  process.stderr.write('\nCounts: ');
  process.stderr.write(counts.map((c) => `${c.kind}=${c.n}`).join(', '));
  process.stderr.write('\n');

  closeDb();
}

seedFoiaFixture();
