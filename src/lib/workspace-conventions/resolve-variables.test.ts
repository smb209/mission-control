/**
 * Variable resolver — unit tests.
 *
 * See docs/reference/workspace-conventions-structured.md §3.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  KNOWN_VARIABLES,
  inventoryVariables,
  resolveVariables,
} from './resolve-variables';

const SRC = {
  name: 'Test Workspace',
  working_dir: '/Users/op/projects/x',
  deliverables: '/Users/op/Deliverables',
  repo_url: 'https://github.com/op/x',
  base_branch: 'main',
};

test('resolveVariables: known tokens expand', () => {
  const text = 'cwd: {{working_dir}}; repo: {{repo_url}}; base: {{base_branch}}';
  assert.equal(
    resolveVariables(text, SRC),
    'cwd: /Users/op/projects/x; repo: https://github.com/op/x; base: main',
  );
});

test('resolveVariables: name + deliverables resolve', () => {
  assert.equal(
    resolveVariables('Hi from {{name}} → {{deliverables}}', SRC),
    'Hi from Test Workspace → /Users/op/Deliverables',
  );
});

test('resolveVariables: deliverables falls back to working_dir when blank', () => {
  const fallback = { ...SRC, deliverables: null };
  assert.equal(
    resolveVariables('{{deliverables}}', fallback),
    '/Users/op/projects/x',
  );
});

test('resolveVariables: empty optional value renders empty silently', () => {
  const blankRepo = { ...SRC, repo_url: null };
  // Note: we don't insert ⚠️ here — that's the preview pane's job.
  assert.equal(resolveVariables('see {{repo_url}} for source', blankRepo), 'see  for source');
});

test('resolveVariables: unknown token preserved verbatim', () => {
  assert.equal(resolveVariables('{{not_a_token}} stays', SRC), '{{not_a_token}} stays');
});

test('resolveVariables: tolerates whitespace inside the braces', () => {
  assert.equal(resolveVariables('{{ working_dir }}', SRC), '/Users/op/projects/x');
});

test('resolveVariables: null/undefined input returns empty string', () => {
  assert.equal(resolveVariables(null, SRC), '');
  assert.equal(resolveVariables(undefined, SRC), '');
});

test('resolveVariables: multiple occurrences all replaced', () => {
  const text = '{{name}} :: {{name}} :: {{name}}';
  assert.equal(resolveVariables(text, SRC), 'Test Workspace :: Test Workspace :: Test Workspace');
});

test('inventoryVariables: classifies known/unknown/empty', () => {
  const blankRepo = { ...SRC, repo_url: '' };
  const text = '{{name}} {{repo_url}} {{garbage}} {{name}}';
  const usage = inventoryVariables(text, blankRepo);
  assert.deepEqual(usage, [
    { variable: 'name', known: true, empty: false },
    { variable: 'repo_url', known: true, empty: true },
    { variable: 'garbage', known: false },
  ]);
});

test('KNOWN_VARIABLES export matches resolver coverage', () => {
  // Belt-and-braces: every advertised variable resolves to a non-null
  // value (i.e. the lookup() switch knows it).
  for (const v of KNOWN_VARIABLES) {
    const resolved = resolveVariables(`{{${v}}}`, SRC);
    assert.notStrictEqual(resolved, `{{${v}}}`, `Expected ${v} to be a known variable`);
  }
});
