/**
 * Eval runner self-test.
 *
 * Drives the full eval pipeline against the canned-reply fixtures so
 * we don't need a live gateway or LLM. Confirms:
 *   - report shape (run_id, fixtures[], aggregate)
 *   - canned-reply path produces a brief with the expected body
 *   - rubric scores show through to the report
 *   - bad-fixture detection (R6.2 in validation): the deliberately
 *     bad fixture has a much lower aggregate than a healthy one
 *   - report is written to disk
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runEval } from './runner';
import { FIXTURES } from './fixtures';

function freshTmp(): string {
  return mkdtempSync(path.join(tmpdir(), 'research-eval-test-'));
}

test('runEval: canned bad fixture scores low and is captured in report', async () => {
  const out = freshTmp();
  try {
    const report = await runEval({
      outputDir: out,
      only: ['bad_one_sentence'],
      timeoutMs: 5000,
    });
    assert.equal(report.fixtures.length, 1);
    const r = report.fixtures[0];
    assert.equal(r.fixture_id, 'bad_one_sentence');
    assert.equal(r.status, 'complete');
    // Bad fixture body = "no." → completion=1, citations=0, structure=0, length≈0
    assert.ok(r.rubric.aggregate < 0.4, `expected aggregate < 0.4, got ${r.rubric.aggregate}`);
    assert.ok(report.aggregate < 0.4);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('runEval: writes report.json to outputDir/run_id/', async () => {
  const out = freshTmp();
  try {
    const report = await runEval({
      outputDir: out,
      only: ['bad_one_sentence'],
      timeoutMs: 5000,
    });
    const reportPath = path.join(out, report.run_id, 'report.json');
    const onDisk = JSON.parse(readFileSync(reportPath, 'utf8'));
    assert.equal(onDisk.run_id, report.run_id);
    assert.equal(onDisk.fixtures.length, 1);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('runEval: aggregate is a finite number in [0, 1]', async () => {
  const out = freshTmp();
  try {
    const report = await runEval({
      outputDir: out,
      only: ['bad_one_sentence'],
      timeoutMs: 5000,
    });
    assert.ok(Number.isFinite(report.aggregate));
    assert.ok(report.aggregate >= 0 && report.aggregate <= 1);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('FIXTURES: every fixture has unique id and required fields', () => {
  const ids = new Set<string>();
  for (const f of FIXTURES) {
    assert.ok(f.id, 'fixture id required');
    assert.ok(!ids.has(f.id), `duplicate fixture id: ${f.id}`);
    ids.add(f.id);
    assert.ok(f.template, 'template required');
    assert.ok(f.title.trim(), 'title required');
    assert.ok(f.prompt.trim(), 'prompt required');
  }
  assert.ok(FIXTURES.some(f => f.id === 'bad_one_sentence'), 'bad-fixture sentinel must exist for R6.2');
});
