/**
 * Tests for POST /api/initiatives/:id/investigate/resynthesize.
 *
 * Phase 4 of docs/archive/subtree-audit-proposals-spec.md (§6.1). Covers:
 *   - happy path: existing manifest + proposals → L3 fires (via test
 *     seam) and the response carries the new synthesis_note_id.
 *   - missing manifest: 400 with the documented error.
 *   - missing runner: 503.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { v4 as uuidv4 } from 'uuid';
import { NextRequest } from 'next/server';
import { POST, __setSynthesizerOverrideForTests } from './route';
import { run } from '@/lib/db';
import { createInitiative } from '@/lib/db/initiatives';
import { createNote, listNotes } from '@/lib/db/agent-notes';
import type { SynthesizerResult } from '@/lib/agents/audit-synthesizer';

function freshWorkspace(): string {
  const id = `ws-rs-${uuidv4().slice(0, 8)}`;
  run(
    `INSERT OR IGNORE INTO workspaces (id, name, slug, created_at) VALUES (?, ?, ?, datetime('now'))`,
    [id, id, id],
  );
  return id;
}

function clearRunner(): void {
  run(`DELETE FROM agents WHERE gateway_agent_id IN ('mc-runner','mc-runner-dev')`);
}

function ensureRunner(): void {
  run(
    `INSERT OR REPLACE INTO agents
       (id, name, role, workspace_id, gateway_agent_id, source, created_at, updated_at)
     VALUES (?, ?, ?, 'default', 'mc-runner-dev', 'test', datetime('now'), datetime('now'))`,
    [`agent-${uuidv4().slice(0, 8)}`, 'runner', 'researcher'],
  );
}

async function callPost(id: string, body: unknown = {}): Promise<Response> {
  const req = new NextRequest(
    `http://localhost/api/initiatives/${id}/investigate/resynthesize`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  return await POST(req, { params: Promise.resolve({ id }) });
}

test.afterEach(() => {
  __setSynthesizerOverrideForTests(null);
  clearRunner();
});

test('resynthesize: missing manifest → 400 with clear error', async () => {
  const ws = freshWorkspace();
  const i = createInitiative({ workspace_id: ws, kind: 'epic', title: 'no-manifest root' });
  ensureRunner();
  const res = await callPost(i.id);
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /no audit_manifest exists/i);
  assert.match(body.error, /run a full audit first/i);
});

test('resynthesize: missing runner → 503', async () => {
  const ws = freshWorkspace();
  const i = createInitiative({ workspace_id: ws, kind: 'epic', title: 'no-runner root' });
  clearRunner();
  const res = await callPost(i.id);
  assert.equal(res.status, 503);
});

test('resynthesize: happy path — synthesizer fires and note id returned', async () => {
  const ws = freshWorkspace();
  const root = createInitiative({ workspace_id: ws, kind: 'epic', title: 'rs root' });
  const leaf = createInitiative({
    workspace_id: ws,
    kind: 'story',
    title: 'rs leaf',
    parent_initiative_id: root.id,
  });
  ensureRunner();

  // Seed an audit_manifest on the root.
  const manifestBody = JSON.stringify({
    version: 1,
    root_initiative_id: root.id,
    attempt: 1,
    previous_synthesis_run_group_id: null,
    summary: 'seed',
    nodes: [
      {
        initiative_id: leaf.id,
        title: leaf.title,
        current_status: 'in_progress',
        hypothesis: 'needs-deep-dive',
        confidence: 'medium',
        investigation_prompt: 'dig',
        scoped_evidence_hints: [],
        skip: false,
      },
    ],
    cross_cutting_questions: [],
  });
  createNote({
    workspace_id: ws,
    agent_id: null,
    initiative_id: root.id,
    scope_key: `initiative-${root.id}:audit-survey:1`,
    role: 'auditor',
    run_group_id: uuidv4(),
    kind: 'audit_manifest',
    audience: 'pm',
    body: manifestBody,
    importance: 1,
  });

  // Seed a leaf audit_proposal so the synthesizer briefing has input.
  const propBody = JSON.stringify({
    version: 1,
    node_initiative_id: leaf.id,
    current_mc_status: 'in_progress',
    current_mc_target_end: null,
    proposed_action: 'mark_done',
    proposed_changes: { note: 'shipped via PR #999' },
    repo_evidence: [{ kind: 'pr', ref: 'https://example/pull/999' }],
    rationale: 'shipped',
    confidence: 'high',
    would_confirm_by: null,
    continuation_note_id: null,
  });
  createNote({
    workspace_id: ws,
    agent_id: null,
    initiative_id: leaf.id,
    scope_key: `initiative-${root.id}:audit:1`,
    role: 'auditor',
    run_group_id: uuidv4(),
    kind: 'audit_proposal',
    audience: 'pm',
    body: propBody,
    importance: 2,
  });

  // Override the synthesizer: write the synthesis note + return ok.
  let dispatchCount = 0;
  __setSynthesizerOverrideForTests(async (args): Promise<SynthesizerResult> => {
    dispatchCount += 1;
    const synthBody = JSON.stringify({
      version: 1,
      root_initiative_id: args.rootId,
      attempt: args.attempt,
      completion_sentinel:
        'Audit complete: 1 node — 1 mark_done; epic dates unchanged',
      epic_proposals: [],
      cross_node_proposals: [],
    });
    const note = createNote({
      workspace_id: args.workspaceId,
      agent_id: null,
      initiative_id: args.rootId,
      scope_key: `initiative-${args.rootId}:audit-synthesis:${args.attempt}`,
      role: 'auditor',
      run_group_id: uuidv4(),
      kind: 'audit_synthesis',
      audience: 'pm',
      body: synthBody,
      importance: 2,
    });
    return {
      synthesis: JSON.parse(synthBody),
      synthesisNoteId: note.id,
      dispatchOutcome: 'ok',
    };
  });

  const res = await callPost(root.id);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.dispatch_outcome, 'ok');
  assert.equal(typeof body.synthesis_note_id, 'string');
  assert.equal(dispatchCount, 1);

  // Verify the synthesis note actually landed.
  const synthNotes = listNotes({
    initiative_id: root.id,
    kinds: ['audit_synthesis'],
    limit: 5,
  });
  assert.equal(synthNotes.length, 1);
  assert.equal(synthNotes[0].id, body.synthesis_note_id);
});
