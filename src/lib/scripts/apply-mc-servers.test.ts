/**
 * Tests for scripts/apply-mc-servers.mjs.
 *
 * Spawns the script against a tmpfile fixture and asserts on the
 * resulting JSON shape + exit codes. Validates idempotence by running
 * twice.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(process.cwd(), 'scripts', 'apply-mc-servers.mjs');

function makeFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'apply-mc-servers-'));
  const path = join(dir, 'openclaw.json');
  return { dir, path };
}

const baseConfig = () => ({
  mcp: {
    servers: {
      'sc-mission-control': {
        command: 'node',
        args: ['/path/to/launcher.mjs'],
        env: { MC_URL: 'http://localhost:4001/api/mcp', MC_API_TOKEN: 'STABLE_TOKEN' },
      },
      'sc-mission-control-dev': {
        command: 'node',
        args: ['/path/to/launcher.mjs'],
        env: { MC_URL: 'http://localhost:4010/api/mcp', MC_API_TOKEN: 'DEV_TOKEN' },
      },
    },
  },
  agents: {
    list: [
      {
        id: 'mc-runner',
        name: 'MC Runner',
        tools: { alsoAllow: ['sc-mission-control__*', 'browser'], deny: ['image_generate'] },
      },
      {
        id: 'mc-runner-dev',
        name: 'MC Runner Dev',
        tools: { alsoAllow: ['sc-mission-control-dev__*', 'browser'], deny: ['image_generate'] },
      },
      {
        id: 'mc-pm-default',
        name: 'MC PM',
        tools: { alsoAllow: ['sc-mission-control__*', 'browser'], deny: ['image_generate'] },
      },
      {
        id: 'mc-pm-default-dev',
        name: 'MC PM Dev',
        tools: { alsoAllow: ['sc-mission-control-dev__*', 'browser'], deny: ['image_generate'] },
      },
      {
        // unrelated agent — must not be touched.
        id: 'random-agent',
        name: 'Random',
        tools: { alsoAllow: ['browser'] },
      },
    ],
  },
});

function run(configPath: string, opts: { dryRun?: boolean } = {}): { stdout: string; status: number } {
  try {
    const stdout = execFileSync(
      'node',
      [SCRIPT, `--config=${configPath}`, ...(opts.dryRun ? ['--dry-run'] : [])],
      { encoding: 'utf8' },
    );
    return { stdout, status: 0 };
  } catch (err) {
    const e = err as { stdout?: string; status?: number };
    return { stdout: e.stdout ?? '', status: e.status ?? 1 };
  }
}

test('apply-mc-servers: dry-run on fresh config reports drift and exits 2', () => {
  const { dir, path } = makeFixture();
  try {
    writeFileSync(path, JSON.stringify(baseConfig(), null, 2));
    const r = run(path, { dryRun: true });
    assert.equal(r.status, 2, 'dry-run on drift exits 2');
    assert.match(r.stdout, /add mcp.servers.sc-mission-control-pm /);
    assert.match(r.stdout, /add mcp.servers.sc-mission-control-pm-dev /);
    assert.match(r.stdout, /add mcp.servers.sc-mission-control-crud /);
    assert.match(r.stdout, /add mcp.servers.sc-mission-control-crud-dev /);
    assert.match(r.stdout, /pm-rewrite mc-pm-default(?!-dev)/);
    assert.match(r.stdout, /pm-rewrite mc-pm-default-dev/);
    assert.match(r.stdout, /runner-deny mc-runner(?!-dev)/);
    assert.match(r.stdout, /runner-deny mc-runner-dev/);

    // Confirm fixture wasn't mutated.
    const after = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(after.mcp.servers['sc-mission-control-pm'], undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('apply-mc-servers: write mode rewrites PM and adds scoped servers', () => {
  const { dir, path } = makeFixture();
  try {
    writeFileSync(path, JSON.stringify(baseConfig(), null, 2));
    const r = run(path);
    assert.equal(r.status, 0);

    const after = JSON.parse(readFileSync(path, 'utf8'));

    // Servers added with derived URLs.
    assert.equal(after.mcp.servers['sc-mission-control-pm'].env.MC_URL, 'http://localhost:4001/api/mcp/pm');
    assert.equal(after.mcp.servers['sc-mission-control-pm-dev'].env.MC_URL, 'http://localhost:4010/api/mcp/pm');
    assert.equal(after.mcp.servers['sc-mission-control-crud'].env.MC_URL, 'http://localhost:4001/api/mcp/crud');
    assert.equal(after.mcp.servers['sc-mission-control-crud-dev'].env.MC_URL, 'http://localhost:4010/api/mcp/crud');

    // PM stable: alsoAllow rewritten, deny extended.
    const pmStable = after.agents.list.find((a: { id: string }) => a.id === 'mc-pm-default');
    assert.deepEqual(pmStable.tools.alsoAllow, ['sc-mission-control-pm__*', 'browser']);
    // Deny includes: same-env full + same-env crud + cross-env (full+pm+crud).
    assert.ok(pmStable.tools.deny.includes('sc-mission-control__*'));
    assert.ok(pmStable.tools.deny.includes('sc-mission-control-crud__*'));
    assert.ok(pmStable.tools.deny.includes('sc-mission-control-dev__*'));
    assert.ok(pmStable.tools.deny.includes('sc-mission-control-pm-dev__*'));
    assert.ok(pmStable.tools.deny.includes('sc-mission-control-crud-dev__*'));
    assert.ok(pmStable.tools.deny.includes('image_generate'), 'pre-existing deny preserved');

    // PM dev: equivalent rewrites for dev env.
    const pmDev = after.agents.list.find((a: { id: string }) => a.id === 'mc-pm-default-dev');
    assert.deepEqual(pmDev.tools.alsoAllow, ['sc-mission-control-pm-dev__*', 'browser']);
    assert.ok(pmDev.tools.deny.includes('sc-mission-control-dev__*'));
    assert.ok(pmDev.tools.deny.includes('sc-mission-control__*'));

    // Runners: alsoAllow unchanged; deny extended.
    const runnerStable = after.agents.list.find((a: { id: string }) => a.id === 'mc-runner');
    assert.deepEqual(runnerStable.tools.alsoAllow, ['sc-mission-control__*', 'browser'], 'runner alsoAllow unchanged');
    assert.ok(runnerStable.tools.deny.includes('sc-mission-control-pm__*'));
    assert.ok(runnerStable.tools.deny.includes('sc-mission-control-crud__*'));
    assert.ok(runnerStable.tools.deny.includes('sc-mission-control-dev__*'));
    // Static deny list — bare tool names from openclaw's catalog.
    assert.ok(runnerStable.tools.deny.includes('memory_search'), 'runner must deny memory_search');
    assert.ok(runnerStable.tools.deny.includes('memory_get'), 'runner must deny memory_get');
    assert.ok(runnerStable.tools.deny.includes('x_search'), 'runner must deny x_search');

    // Unrelated agent untouched.
    const random = after.agents.list.find((a: { id: string }) => a.id === 'random-agent');
    assert.deepEqual(random.tools, { alsoAllow: ['browser'] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('apply-mc-servers: idempotent — second run is a no-op (dry-run exits 0)', () => {
  const { dir, path } = makeFixture();
  try {
    writeFileSync(path, JSON.stringify(baseConfig(), null, 2));
    run(path); // first apply
    const second = run(path, { dryRun: true });
    assert.equal(second.status, 0, 'second --dry-run on synced config must exit 0');
    assert.match(second.stdout, /agents: in sync \(no changes\)/);
    assert.match(second.stdout, /already configured/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('apply-mc-servers: missing default server throws', () => {
  const { dir, path } = makeFixture();
  try {
    const cfg = baseConfig();
    delete (cfg.mcp.servers as Record<string, unknown>)['sc-mission-control'];
    writeFileSync(path, JSON.stringify(cfg, null, 2));
    const r = run(path);
    assert.notEqual(r.status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
