/**
 * Gate config loader tests.
 *
 * Covers: explicit `.mc/gates.json` parse, package.json auto-discovery,
 * malformed config fallback, placeholder substitution, role mapping.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  loadGateConfig,
  substitutePlaceholders,
  getPrescribedCommandsForRole,
  ROLE_REQUIRED_GATES,
} from './config';

function tmpRepo(): string {
  return mkdtempSync(join(tmpdir(), 'mc-gates-'));
}

test('loadGateConfig returns source=none when path has no package.json or .mc', () => {
  const repo = tmpRepo();
  const cfg = loadGateConfig(repo);
  assert.equal(cfg.source, 'none');
  assert.equal(cfg.build_fast, undefined);
});

test('loadGateConfig parses an explicit .mc/gates.json', () => {
  const repo = tmpRepo();
  mkdirSync(join(repo, '.mc'));
  writeFileSync(
    join(repo, '.mc', 'gates.json'),
    JSON.stringify({
      gates: {
        build_fast: {
          commands: ['yarn tsc --noEmit', 'yarn eslint ${CHANGED_FILES}'],
          budget_ms: 60000,
        },
        test_full: { commands: ['yarn test'], budget_ms: 90000 },
      },
    }),
  );
  const cfg = loadGateConfig(repo);
  assert.equal(cfg.source, 'file');
  assert.deepEqual(cfg.build_fast?.commands, [
    'yarn tsc --noEmit',
    'yarn eslint ${CHANGED_FILES}',
  ]);
  assert.equal(cfg.test_full?.budget_ms, 90000);
});

test('loadGateConfig falls back to discovery on malformed gates.json', () => {
  const repo = tmpRepo();
  mkdirSync(join(repo, '.mc'));
  writeFileSync(join(repo, '.mc', 'gates.json'), '{ this is not json');
  writeFileSync(
    join(repo, 'package.json'),
    JSON.stringify({ scripts: { test: 'jest' } }),
  );
  const cfg = loadGateConfig(repo);
  assert.equal(cfg.source, 'discovered');
  assert.ok(cfg.test_full);
});

test('loadGateConfig discovers test_full from package.json `test` script', () => {
  const repo = tmpRepo();
  writeFileSync(
    join(repo, 'package.json'),
    JSON.stringify({ scripts: { test: 'jest', typecheck: 'tsc --noEmit' } }),
  );
  writeFileSync(join(repo, 'yarn.lock'), '');
  const cfg = loadGateConfig(repo);
  assert.equal(cfg.source, 'discovered');
  assert.deepEqual(cfg.test_full?.commands, ['yarn test']);
  assert.deepEqual(cfg.build_fast?.commands, ['yarn typecheck']);
});

test('loadGateConfig picks pnpm when pnpm-lock.yaml is present', () => {
  const repo = tmpRepo();
  writeFileSync(
    join(repo, 'package.json'),
    JSON.stringify({ scripts: { test: 'vitest' } }),
  );
  writeFileSync(join(repo, 'pnpm-lock.yaml'), '');
  const cfg = loadGateConfig(repo);
  assert.deepEqual(cfg.test_full?.commands, ['pnpm test']);
});

test('loadGateConfig rejects gate spec without budget_ms', () => {
  const repo = tmpRepo();
  mkdirSync(join(repo, '.mc'));
  writeFileSync(
    join(repo, '.mc', 'gates.json'),
    JSON.stringify({
      gates: { build_fast: { commands: ['yarn tsc'] } }, // no budget_ms
    }),
  );
  const cfg = loadGateConfig(repo);
  assert.equal(cfg.build_fast, undefined);
});

test('substitutePlaceholders fills in CHANGED_FILES', () => {
  const out = substitutePlaceholders(
    ['yarn eslint ${CHANGED_FILES}', 'yarn jest --findRelatedTests ${CHANGED_FILES}'],
    { changedFiles: ['src/a.ts', 'src/b.ts'] },
  );
  assert.deepEqual(out, [
    'yarn eslint src/a.ts src/b.ts',
    'yarn jest --findRelatedTests src/a.ts src/b.ts',
  ]);
});

test('substitutePlaceholders leaves command unchanged when no placeholder', () => {
  const out = substitutePlaceholders(['yarn test'], { changedFiles: ['x.ts'] });
  assert.deepEqual(out, ['yarn test']);
});

test('getPrescribedCommandsForRole returns build_fast for builder', () => {
  const repo = tmpRepo();
  mkdirSync(join(repo, '.mc'));
  writeFileSync(
    join(repo, '.mc', 'gates.json'),
    JSON.stringify({
      gates: {
        build_fast: {
          commands: ['yarn tsc --noEmit', 'yarn jest --findRelatedTests ${CHANGED_FILES}'],
          budget_ms: 60000,
        },
        test_full: { commands: ['yarn test'], budget_ms: 90000 },
      },
    }),
  );
  const out = getPrescribedCommandsForRole(repo, 'builder', {
    changedFiles: ['src/foo.ts'],
  });
  assert.deepEqual(out.gates.build_fast?.commands, [
    'yarn tsc --noEmit',
    'yarn jest --findRelatedTests src/foo.ts',
  ]);
  assert.equal(out.gates.test_full, undefined); // not a builder gate
});

test('getPrescribedCommandsForRole returns test_full + runtime_smoke for tester', () => {
  const repo = tmpRepo();
  mkdirSync(join(repo, '.mc'));
  writeFileSync(
    join(repo, '.mc', 'gates.json'),
    JSON.stringify({
      gates: {
        test_full: { commands: ['yarn test'], budget_ms: 90000 },
        runtime_smoke: { commands: ['curl -fsS http://localhost/health'], budget_ms: 30000 },
      },
    }),
  );
  const out = getPrescribedCommandsForRole(repo, 'tester');
  assert.ok(out.gates.test_full);
  assert.ok(out.gates.runtime_smoke);
});

test('getPrescribedCommandsForRole returns empty gates for reviewer', () => {
  const repo = tmpRepo();
  mkdirSync(join(repo, '.mc'));
  writeFileSync(
    join(repo, '.mc', 'gates.json'),
    JSON.stringify({
      gates: { build_fast: { commands: ['yarn tsc'], budget_ms: 60000 } },
    }),
  );
  const out = getPrescribedCommandsForRole(repo, 'reviewer');
  assert.equal(Object.keys(out.gates).length, 0);
});

test('ROLE_REQUIRED_GATES sanity', () => {
  assert.deepEqual([...ROLE_REQUIRED_GATES.builder], ['build_fast']);
  assert.deepEqual([...ROLE_REQUIRED_GATES.tester], ['test_full']);
  assert.deepEqual([...ROLE_REQUIRED_GATES.reviewer], []);
});
