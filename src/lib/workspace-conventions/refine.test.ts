/**
 * refine.ts — parser unit tests.
 *
 * The dispatch path is exercised by hand via the Refine modal in
 * settings; these tests cover the JSON parser so a rogue agent reply
 * doesn't crash the route.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { RefineDispatchError, parseRefineReply, buildRefineTrigger } from './refine';

test('parseRefineReply: replacement reply round-trips', () => {
  const raw = JSON.stringify({
    kind: 'replacement',
    body: '## Repos\n- working tree: {{working_dir}}',
    rationale: 'Streamlines the section headings.',
  });
  const parsed = parseRefineReply(raw);
  assert.equal(parsed.kind, 'replacement');
  assert.match(parsed.body!, /working tree/);
  assert.equal(parsed.rationale, 'Streamlines the section headings.');
});

test('parseRefineReply: questions reply caps at 5', () => {
  const raw = JSON.stringify({
    kind: 'questions',
    questions: ['q1', 'q2', 'q3', 'q4', 'q5', 'q6'],
  });
  const parsed = parseRefineReply(raw);
  assert.equal(parsed.kind, 'questions');
  assert.equal(parsed.questions!.length, 5);
});

test('parseRefineReply: tolerates leading prose before JSON', () => {
  const raw = `Sure, here is my proposed refinement:\n\n${JSON.stringify({
    kind: 'replacement',
    body: 'X',
  })}`;
  const parsed = parseRefineReply(raw);
  assert.equal(parsed.kind, 'replacement');
  assert.equal(parsed.body, 'X');
});

test('parseRefineReply: tolerates ```json fences', () => {
  const raw = '```json\n' + JSON.stringify({ kind: 'replacement', body: 'X' }) + '\n```';
  const parsed = parseRefineReply(raw);
  assert.equal(parsed.kind, 'replacement');
});

test('parseRefineReply: rejects missing kind', () => {
  assert.throws(
    () => parseRefineReply(JSON.stringify({ body: 'no kind' })),
    RefineDispatchError,
  );
});

test('parseRefineReply: rejects replacement with empty body', () => {
  assert.throws(
    () => parseRefineReply(JSON.stringify({ kind: 'replacement', body: '' })),
    RefineDispatchError,
  );
});

test('parseRefineReply: rejects questions with no strings', () => {
  assert.throws(
    () => parseRefineReply(JSON.stringify({ kind: 'questions', questions: [123, null] })),
    RefineDispatchError,
  );
});

test('parseRefineReply: rejects raw without JSON', () => {
  assert.throws(() => parseRefineReply('not json at all'), RefineDispatchError);
});

test('buildRefineTrigger: includes workspace facts + operator note', () => {
  const trigger = buildRefineTrigger({
    workspace: {
      id: 'ws1',
      name: 'My WS',
      workspace_path: '/Users/a/b',
      repo_url: 'https://github.com/a/b',
      default_base_branch: 'main',
    },
    current_conventions: '## hello',
    operator_note: 'tighten the testing section',
  });
  assert.match(trigger, /Working tree: \/Users\/a\/b/);
  assert.match(trigger, /Repo URL: https:\/\/github\.com\/a\/b/);
  assert.match(trigger, /tighten the testing section/);
  assert.match(trigger, /## Current conventions/);
});

test('buildRefineTrigger: omits operator-note section when blank', () => {
  const trigger = buildRefineTrigger({
    workspace: {
      id: 'ws1',
      name: 'My WS',
      workspace_path: null,
      repo_url: null,
      default_base_branch: null,
    },
    current_conventions: '',
    operator_note: null,
  });
  assert.doesNotMatch(trigger, /## Operator note/);
  assert.match(trigger, /\(empty\)/);
});
