/**
 * Tests for scripts/sync-named-agent-workspaces.mjs.
 *
 * Builds a fixture workspaces tree + templates tree under tmpdir, runs
 * the script via execFileSync, and asserts on file contents + exit
 * codes. Validates idempotence (second dry-run must exit 0) and the
 * round-trip (revert template, re-sync, original content restored).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(process.cwd(), 'scripts', 'sync-named-agent-workspaces.mjs');

interface FixtureLayout {
  templates: { path: string };
  workspaces: { path: string };
  pmDir: string;
  runnerDir: string;
}

function makeFixture(): FixtureLayout {
  const root = mkdtempSync(join(tmpdir(), 'sync-named-agents-'));
  const templates = join(root, 'templates');
  const workspaces = join(root, 'workspaces');

  // Templates
  mkdirSync(join(templates, 'pm'), { recursive: true });
  mkdirSync(join(templates, 'runner-host'), { recursive: true });
  mkdirSync(join(templates, '_shared'), { recursive: true });
  writeFileSync(join(templates, 'pm', 'SOUL.md'), 'PM SOUL v2\n');
  writeFileSync(join(templates, 'pm', 'AGENTS.md'), 'PM AGENTS v2\n');
  writeFileSync(join(templates, 'pm', 'IDENTITY.md'), 'PM IDENTITY v2\n');
  writeFileSync(join(templates, 'runner-host', 'SOUL.md'), 'RUNNER SOUL v2\n');
  writeFileSync(join(templates, 'runner-host', 'AGENTS.md'), 'RUNNER AGENTS v2\n');
  writeFileSync(join(templates, 'runner-host', 'IDENTITY.md'), 'RUNNER IDENTITY v2\n');
  writeFileSync(join(templates, '_shared', 'messaging-protocol.md'), 'MSG PROTOCOL v2\n');
  writeFileSync(join(templates, '_shared', 'shared-rules.md'), 'SHARED RULES v2\n');

  // Workspaces — start with stale content
  const pmDir = join(workspaces, 'mc-pm-default-dev');
  mkdirSync(pmDir, { recursive: true });
  writeFileSync(join(pmDir, 'SOUL.md'), 'PM SOUL v1 (stale)\n');
  writeFileSync(join(pmDir, 'AGENTS.md'), 'PM AGENTS v1 (stale)\n');
  writeFileSync(join(pmDir, 'IDENTITY.md'), 'PM IDENTITY v2\n'); // already in sync
  writeFileSync(join(pmDir, 'TOOLS.md'), 'OPERATOR-MANAGED\n');  // must NOT be touched

  const runnerDir = join(workspaces, 'mc-runner-dev');
  mkdirSync(runnerDir, { recursive: true });
  writeFileSync(join(runnerDir, 'SOUL.md'), 'RUNNER SOUL v1 (stale)\n');
  writeFileSync(join(runnerDir, 'AGENTS.md'), 'RUNNER AGENTS v2\n');
  writeFileSync(join(runnerDir, 'IDENTITY.md'), 'RUNNER IDENTITY v1 (stale)\n');
  writeFileSync(join(runnerDir, 'MESSAGING-PROTOCOL.md'), 'MSG PROTOCOL v1 (stale)\n');
  writeFileSync(join(runnerDir, 'SHARED-RULES.md'), 'SHARED RULES v2\n');

  // Untouchable: non-mc workspace dir, must be skipped silently
  const otherDir = join(workspaces, 'random-other-workspace');
  mkdirSync(otherDir, { recursive: true });
  writeFileSync(join(otherDir, 'SOUL.md'), 'NOT OURS\n');

  return {
    templates: { path: templates },
    workspaces: { path: workspaces },
    pmDir,
    runnerDir,
  };
}

function run(fix: FixtureLayout, opts: { dryRun?: boolean } = {}): { stdout: string; status: number } {
  try {
    const stdout = execFileSync(
      'node',
      [
        SCRIPT,
        `--root=${fix.workspaces.path}`,
        `--templates=${fix.templates.path}`,
        ...(opts.dryRun ? ['--dry-run'] : []),
      ],
      { encoding: 'utf8' },
    );
    return { stdout, status: 0 };
  } catch (err) {
    const e = err as { stdout?: string; status?: number };
    return { stdout: e.stdout ?? '', status: e.status ?? 1 };
  }
}

test('sync-named-agents: dry-run reports drift and exits 2', () => {
  const fix = makeFixture();
  try {
    const r = run(fix, { dryRun: true });
    assert.equal(r.status, 2, 'dry-run with drift exits 2');
    assert.match(r.stdout, /mc-pm-default-dev\/SOUL\.md: drift/);
    assert.match(r.stdout, /mc-pm-default-dev\/AGENTS\.md: drift/);
    assert.match(r.stdout, /mc-runner-dev\/SOUL\.md: drift/);
    assert.match(r.stdout, /mc-runner-dev\/MESSAGING-PROTOCOL\.md: drift/);
    // Untouched files
    assert.equal(readFileSync(join(fix.pmDir, 'SOUL.md'), 'utf8'), 'PM SOUL v1 (stale)\n');
  } finally {
    rmSync(fix.workspaces.path, { recursive: true, force: true });
    rmSync(fix.templates.path, { recursive: true, force: true });
  }
});

test('sync-named-agents: write mode replaces stale + leaves operator files alone', () => {
  const fix = makeFixture();
  try {
    const r = run(fix);
    assert.equal(r.status, 0);

    // Stale files updated to template content
    assert.equal(readFileSync(join(fix.pmDir, 'SOUL.md'), 'utf8'), 'PM SOUL v2\n');
    assert.equal(readFileSync(join(fix.pmDir, 'AGENTS.md'), 'utf8'), 'PM AGENTS v2\n');
    assert.equal(readFileSync(join(fix.runnerDir, 'SOUL.md'), 'utf8'), 'RUNNER SOUL v2\n');
    assert.equal(readFileSync(join(fix.runnerDir, 'IDENTITY.md'), 'utf8'), 'RUNNER IDENTITY v2\n');
    assert.equal(readFileSync(join(fix.runnerDir, 'MESSAGING-PROTOCOL.md'), 'utf8'), 'MSG PROTOCOL v2\n');

    // Operator-managed file untouched
    assert.equal(readFileSync(join(fix.pmDir, 'TOOLS.md'), 'utf8'), 'OPERATOR-MANAGED\n');

    // .bak files exist for what we changed
    const pmFiles = readdirSync(fix.pmDir);
    assert.ok(pmFiles.some((f) => f.startsWith('SOUL.md.bak.')), 'PM SOUL backup created');
    assert.ok(pmFiles.some((f) => f.startsWith('AGENTS.md.bak.')), 'PM AGENTS backup created');
    assert.ok(!pmFiles.some((f) => f.startsWith('IDENTITY.md.bak.')), 'in-sync file should not have backup');
    assert.ok(!pmFiles.some((f) => f.startsWith('TOOLS.md.bak.')), 'operator file should not have backup');
  } finally {
    rmSync(fix.workspaces.path, { recursive: true, force: true });
    rmSync(fix.templates.path, { recursive: true, force: true });
  }
});

test('sync-named-agents: idempotent — second dry-run exits 0', () => {
  const fix = makeFixture();
  try {
    run(fix); // apply
    const second = run(fix, { dryRun: true });
    assert.equal(second.status, 0, 'second --dry-run on synced tree must exit 0');
    assert.match(second.stdout, /summary:.*0 drift/);
  } finally {
    rmSync(fix.workspaces.path, { recursive: true, force: true });
    rmSync(fix.templates.path, { recursive: true, force: true });
  }
});

test('sync-named-agents: roundtrip — revert template, re-sync, marker absent', () => {
  const fix = makeFixture();
  try {
    // Apply once
    run(fix);

    // Inject a marker into the template
    const soulPath = join(fix.templates.path, 'pm', 'SOUL.md');
    writeFileSync(soulPath, 'PM SOUL v3 + marker\n');
    run(fix);
    assert.equal(readFileSync(join(fix.pmDir, 'SOUL.md'), 'utf8'), 'PM SOUL v3 + marker\n');

    // Revert template, re-sync
    writeFileSync(soulPath, 'PM SOUL v2\n');
    run(fix);
    assert.equal(readFileSync(join(fix.pmDir, 'SOUL.md'), 'utf8'), 'PM SOUL v2\n');
  } finally {
    rmSync(fix.workspaces.path, { recursive: true, force: true });
    rmSync(fix.templates.path, { recursive: true, force: true });
  }
});

test('sync-named-agents: skips non-mc workspace dirs', () => {
  const fix = makeFixture();
  try {
    const before = readFileSync(join(fix.workspaces.path, 'random-other-workspace', 'SOUL.md'), 'utf8');
    run(fix);
    const after = readFileSync(join(fix.workspaces.path, 'random-other-workspace', 'SOUL.md'), 'utf8');
    assert.equal(after, before, 'non-mc workspaces must not be touched');
  } finally {
    rmSync(fix.workspaces.path, { recursive: true, force: true });
    rmSync(fix.templates.path, { recursive: true, force: true });
  }
});
