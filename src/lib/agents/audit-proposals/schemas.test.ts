/**
 * Round-trip + rejection tests for the audit-proposal note schemas.
 *
 * Mirrors the spec §4 examples and the §10 Phase 1 acceptance criteria:
 *  - Each schema accepts a canonical example.
 *  - Missing required fields, wrong enums, and shape/action mismatches
 *    are rejected with a structured error.
 *  - validateAuditNoteBody wraps JSON.parse + schema check and returns
 *    a `{ ok, error }` shape the MCP handler can relay verbatim.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_AUDIT_NOTE_BODY_CHARS,
  auditManifestBodySchema,
  auditProposalBodySchema,
  auditSynthesisBodySchema,
  isAuditNoteKind,
  validateAuditNoteBody,
} from './schemas';

// ─── Canonical fixtures ─────────────────────────────────────────────

function manifestFixture() {
  return {
    version: 1 as const,
    root_initiative_id: '0c9419ff-d511-4511-86c6-57a6387e19f7',
    attempt: 11,
    previous_synthesis_run_group_id: null,
    summary: 'Refactor native alert() calls to a custom modal component.',
    nodes: [
      {
        initiative_id: '6379b104-aaaa-bbbb-cccc-dddddddddddd',
        title: 'Build AlertDialog mirroring ConfirmDialog',
        current_status: 'done',
        hypothesis: 'likely-drifted' as const,
        confidence: 'medium' as const,
        investigation_prompt: 'Verify AlertDialog landed somewhere in src/components.',
        scoped_evidence_hints: ['rg AlertDialog src/components'],
        skip: false,
      },
    ],
    cross_cutting_questions: ['Does the alert() shim still exist anywhere?'],
  };
}

interface ProposalFixture {
  version: 1;
  node_initiative_id: string;
  current_mc_status: string;
  current_mc_target_end: string | null;
  proposed_action: string;
  proposed_changes: Record<string, unknown>;
  repo_evidence: Array<{ kind: string; ref: string }>;
  rationale: string;
  confidence: 'low' | 'medium' | 'high';
  would_confirm_by: string | null;
  continuation_note_id: string | null;
}

function proposalFixture(): ProposalFixture {
  return {
    version: 1,
    node_initiative_id: '6379b104-aaaa-bbbb-cccc-dddddddddddd',
    current_mc_status: 'done',
    current_mc_target_end: '2026-05-13',
    proposed_action: 'modify_scope',
    proposed_changes: { description: 'Revised body documenting the actual landed scope.' },
    repo_evidence: [
      { kind: 'file', ref: 'src/components/AlertDialog.tsx:1' },
      { kind: 'git', ref: '0cc50ce' },
    ],
    rationale: 'Story marked done but scope drifted; description needs to reflect ship reality.',
    confidence: 'medium',
    would_confirm_by: 'Reading src/components/AlertDialog.tsx end-to-end.',
    continuation_note_id: null,
  };
}

interface SynthesisFixture {
  version: 1;
  root_initiative_id: string;
  attempt: number;
  completion_sentinel: string;
  epic_proposals: Array<Record<string, unknown>>;
  cross_node_proposals: Array<Record<string, unknown>>;
}

function synthesisFixture(): SynthesisFixture {
  return {
    version: 1,
    root_initiative_id: '0c9419ff-d511-4511-86c6-57a6387e19f7',
    attempt: 11,
    completion_sentinel:
      'Audit complete: 3 nodes — 1 keep, 1 modify_scope, 1 cancel; epic dates +14d',
    epic_proposals: [
      {
        proposed_action: 'modify_epic_dates',
        proposed_changes: { target_end: '2026-05-27' },
        rationale: 'Two stories are still open.',
        confidence: 'medium',
      },
    ],
    cross_node_proposals: [
      {
        proposed_action: 'merge_stories',
        subject_initiative_ids: [
          '6379b104-aaaa-bbbb-cccc-dddddddddddd',
          '9ab40f1f-aaaa-bbbb-cccc-dddddddddddd',
        ],
        rationale: 'Both close on the same alert-shim PR.',
        confidence: 'medium',
      },
    ],
  };
}

// ─── Round-trip ─────────────────────────────────────────────────────

test('auditManifestBodySchema: accepts canonical example', () => {
  const result = auditManifestBodySchema.safeParse(manifestFixture());
  assert.equal(result.success, true, JSON.stringify(result, null, 2));
});

test('auditProposalBodySchema: accepts canonical example', () => {
  const result = auditProposalBodySchema.safeParse(proposalFixture());
  assert.equal(result.success, true, JSON.stringify(result, null, 2));
});

test('auditSynthesisBodySchema: accepts canonical example', () => {
  const result = auditSynthesisBodySchema.safeParse(synthesisFixture());
  assert.equal(result.success, true, JSON.stringify(result, null, 2));
});

// ─── Manifest rejection ─────────────────────────────────────────────

test('auditManifestBodySchema: rejects bad hypothesis enum', () => {
  const m = manifestFixture();
  // @ts-expect-error — bad value on purpose.
  m.nodes[0].hypothesis = 'absolutely-done';
  const result = auditManifestBodySchema.safeParse(m);
  assert.equal(result.success, false);
});

test('auditManifestBodySchema: rejects missing summary', () => {
  const m = manifestFixture() as Partial<ReturnType<typeof manifestFixture>>;
  delete m.summary;
  const result = auditManifestBodySchema.safeParse(m);
  assert.equal(result.success, false);
});

// ─── Proposal rejection ─────────────────────────────────────────────

test('auditProposalBodySchema: rejects when proposed_changes shape mismatches action', () => {
  const p = proposalFixture();
  p.proposed_action = 'cancel';
  // proposed_changes still has the modify_scope shape (no `reason`).
  const result = auditProposalBodySchema.safeParse(p);
  assert.equal(result.success, false);
});

test('auditProposalBodySchema: rejects empty repo_evidence', () => {
  const p = proposalFixture();
  p.repo_evidence = [];
  const result = auditProposalBodySchema.safeParse(p);
  assert.equal(result.success, false);
});

test('auditProposalBodySchema: rejects unknown action enum', () => {
  const p = proposalFixture() as unknown as Record<string, unknown>;
  p.proposed_action = 'rewrite_history';
  const result = auditProposalBodySchema.safeParse(p);
  assert.equal(result.success, false);
});

test('auditProposalBodySchema: requires would_confirm_by when confidence < high', () => {
  const p = proposalFixture();
  p.confidence = 'low';
  p.would_confirm_by = '';
  const result = auditProposalBodySchema.safeParse(p);
  assert.equal(result.success, false);
});

test('auditProposalBodySchema: allows missing would_confirm_by when confidence=high', () => {
  const p = proposalFixture();
  p.confidence = 'high';
  p.would_confirm_by = null;
  const result = auditProposalBodySchema.safeParse(p);
  assert.equal(result.success, true);
});

test('auditProposalBodySchema: keep action requires empty proposed_changes', () => {
  const p = proposalFixture() as unknown as Record<string, unknown>;
  p.proposed_action = 'keep';
  p.proposed_changes = { reason: 'should not be here' };
  const result = auditProposalBodySchema.safeParse(p);
  assert.equal(result.success, false);
});

// ─── Synthesis rejection ────────────────────────────────────────────

test('auditSynthesisBodySchema: rejects merge_stories with <2 ids', () => {
  const s = synthesisFixture();
  s.cross_node_proposals[0] = {
    proposed_action: 'merge_stories' as const,
    subject_initiative_ids: ['only-one'],
    rationale: 'r',
    confidence: 'low' as const,
  };
  const result = auditSynthesisBodySchema.safeParse(s);
  assert.equal(result.success, false);
});

test('auditSynthesisBodySchema: rejects missing completion_sentinel', () => {
  const s = synthesisFixture() as Partial<ReturnType<typeof synthesisFixture>>;
  delete s.completion_sentinel;
  const result = auditSynthesisBodySchema.safeParse(s);
  assert.equal(result.success, false);
});

// ─── validateAuditNoteBody ──────────────────────────────────────────

test('validateAuditNoteBody: round-trip on canonical proposal', () => {
  const json = JSON.stringify(proposalFixture());
  const result = validateAuditNoteBody('audit_proposal', json);
  assert.equal(result.ok, true);
});

test('validateAuditNoteBody: returns structured error citing field path', () => {
  const broken = proposalFixture() as unknown as Record<string, unknown>;
  delete broken.rationale;
  const json = JSON.stringify(broken);
  const result = validateAuditNoteBody('audit_proposal', json);
  assert.equal(result.ok, false);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error, /audit_proposal/);
    assert.match(result.error, /rationale/);
  }
});

test('validateAuditNoteBody: rejects malformed JSON', () => {
  const result = validateAuditNoteBody('audit_manifest', '{not json');
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error, /JSON\.parse/);
  }
});

test('validateAuditNoteBody: refuses non-audit kinds defensively', () => {
  const result = validateAuditNoteBody('discovery', '{}');
  assert.equal(result.ok, false);
});

test('isAuditNoteKind: correct membership', () => {
  assert.equal(isAuditNoteKind('audit_manifest'), true);
  assert.equal(isAuditNoteKind('audit_proposal'), true);
  assert.equal(isAuditNoteKind('audit_synthesis'), true);
  assert.equal(isAuditNoteKind('discovery'), false);
  assert.equal(isAuditNoteKind('observation'), false);
});

test('MAX_AUDIT_NOTE_BODY_CHARS leaves headroom under DB cap', () => {
  // Spec §4.5: orchestrator caps at 2900, DB at 3000. Headroom is for a
  // tightening retry to land before hitting the hard cap.
  assert.equal(MAX_AUDIT_NOTE_BODY_CHARS, 2900);
});
