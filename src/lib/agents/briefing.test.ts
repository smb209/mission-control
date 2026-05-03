/**
 * buildBriefing — pure function tests against fixture templates.
 *
 * Coverage:
 *  - Identity preamble appears first.
 *  - Role section pulled from agent-templates/<role>/SOUL.md|AGENTS.md|IDENTITY.md.
 *  - agent_role_overrides row trumps templates when present.
 *  - Notetaker addendum appended with run_group_id + scope_key injected.
 *  - Trigger body appears after the role + addendum sections.
 *  - is_resume hint included only when flag is true.
 *  - briefingByteLength agrees with buildBriefing output length.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { run } from '@/lib/db';
import {
  __setTemplatesDirForTests,
  buildBriefing,
  briefingByteLength,
} from './briefing';

function freshWorkspace(): string {
  const id = `ws-br-${uuidv4().slice(0, 8)}`;
  run(
    `INSERT OR IGNORE INTO workspaces (id, name, slug, created_at) VALUES (?, ?, ?, datetime('now'))`,
    [id, id, id],
  );
  return id;
}

function makeFixtureTemplates(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), 'mc-briefing-'));
  // Builder role.
  mkdirSync(path.join(dir, 'builder'), { recursive: true });
  writeFileSync(path.join(dir, 'builder', 'SOUL.md'), '# Builder soul\n\nYou are a builder.');
  writeFileSync(path.join(dir, 'builder', 'AGENTS.md'), '# Builder agents.md');
  writeFileSync(path.join(dir, 'builder', 'IDENTITY.md'), '# Builder identity');
  // Shared addendum.
  mkdirSync(path.join(dir, '_shared'), { recursive: true });
  writeFileSync(path.join(dir, '_shared', 'notetaker.md'), '# Notetaker\n\nTake notes.');
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test('buildBriefing: identity preamble appears first', () => {
  const fx = makeFixtureTemplates();
  __setTemplatesDirForTests(fx.dir);
  const ws = freshWorkspace();
  try {
    const out = buildBriefing({
      workspace_id: ws,
      role: 'builder',
      scope_key: 'agent:mc-runner-dev:ws-x:task-y:builder:1',
      agent_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      gateway_agent_id: 'mc-runner-dev',
      run_group_id: 'rg-1',
      trigger_body: 'Do the thing.',
    });
    assert.match(out, /^Your agent_id is: aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/);
    assert.match(out, /Your gateway_agent_id is: mc-runner-dev/);
    assert.match(out, /# Role: builder/);
    assert.match(out, /Builder soul/);
    assert.match(out, /Notetaker/);
    assert.match(out, /run_group_id: "rg-1"/);
    assert.match(out, /scope_key: "agent:mc-runner-dev:ws-x:task-y:builder:1"/);
    assert.match(out, /Do the thing\./);
  } finally {
    __setTemplatesDirForTests(null);
    fx.cleanup();
  }
});

test('buildBriefing: workspace override trumps template SOUL', () => {
  const fx = makeFixtureTemplates();
  __setTemplatesDirForTests(fx.dir);
  const ws = freshWorkspace();
  try {
    run(
      `INSERT INTO agent_role_overrides (workspace_id, role, soul_md)
       VALUES (?, 'builder', ?)`,
      [ws, '# Override soul\n\nWorkspace-specific guidance.'],
    );
    const out = buildBriefing({
      workspace_id: ws,
      role: 'builder',
      scope_key: 'sk',
      agent_id: 'agent-x',
      gateway_agent_id: 'mc-runner-dev',
      run_group_id: 'rg-2',
      trigger_body: 'body',
    });
    assert.match(out, /Override soul/);
    assert.doesNotMatch(out, /Builder soul/);
    // AGENTS.md/IDENTITY.md not overridden — still come from templates.
    assert.match(out, /Builder agents\.md/);
    assert.match(out, /Builder identity/);
  } finally {
    __setTemplatesDirForTests(null);
    fx.cleanup();
  }
});

test('buildBriefing: missing template files yield empty role section gracefully', () => {
  const empty = mkdtempSync(path.join(tmpdir(), 'mc-briefing-empty-'));
  __setTemplatesDirForTests(empty);
  const ws = freshWorkspace();
  try {
    const out = buildBriefing({
      workspace_id: ws,
      role: 'tester',
      scope_key: 'sk',
      agent_id: 'aid',
      gateway_agent_id: 'mc-runner-dev',
      run_group_id: 'rg',
      trigger_body: 'TRIGGER BODY HERE',
    });
    assert.match(out, /Your agent_id is: aid/);
    // No role section means no '# Role: tester' header (the helper
    // skips empty sections); but trigger body still appears.
    assert.match(out, /TRIGGER BODY HERE/);
  } finally {
    __setTemplatesDirForTests(null);
    rmSync(empty, { recursive: true, force: true });
  }
});

test('buildBriefing: is_resume adds resume hint', () => {
  const fx = makeFixtureTemplates();
  __setTemplatesDirForTests(fx.dir);
  const ws = freshWorkspace();
  try {
    const out = buildBriefing({
      workspace_id: ws,
      role: 'builder',
      scope_key: 'sk',
      agent_id: 'aid',
      gateway_agent_id: 'mc-runner-dev',
      run_group_id: 'rg',
      trigger_body: 'body',
      is_resume: true,
    });
    assert.match(out, /prior trajectory under the same scope key/);

    const fresh = buildBriefing({
      workspace_id: ws,
      role: 'builder',
      scope_key: 'sk',
      agent_id: 'aid',
      gateway_agent_id: 'mc-runner-dev',
      run_group_id: 'rg',
      trigger_body: 'body',
      is_resume: false,
    });
    assert.doesNotMatch(fresh, /prior trajectory/);
  } finally {
    __setTemplatesDirForTests(null);
    fx.cleanup();
  }
});

test('buildBriefing: role + addendum + trigger order is identity → role → addendum → trigger', () => {
  const fx = makeFixtureTemplates();
  __setTemplatesDirForTests(fx.dir);
  const ws = freshWorkspace();
  try {
    const out = buildBriefing({
      workspace_id: ws,
      role: 'builder',
      scope_key: 'sk',
      agent_id: 'aid',
      gateway_agent_id: 'mc-runner-dev',
      run_group_id: 'rg',
      trigger_body: 'TRIGGER_MARKER',
    });
    const idx = (s: string) => out.indexOf(s);
    const idIdx = idx('Your agent_id is:');
    const roleIdx = idx('# Role: builder');
    const addendumIdx = idx('# Notetaker');
    const trigIdx = idx('TRIGGER_MARKER');
    assert.ok(idIdx >= 0 && roleIdx > idIdx && addendumIdx > roleIdx && trigIdx > addendumIdx,
      `order broken: id=${idIdx} role=${roleIdx} addendum=${addendumIdx} trigger=${trigIdx}`);
  } finally {
    __setTemplatesDirForTests(null);
    fx.cleanup();
  }
});

test('briefingByteLength matches buildBriefing UTF-8 length', () => {
  const fx = makeFixtureTemplates();
  __setTemplatesDirForTests(fx.dir);
  const ws = freshWorkspace();
  try {
    const input = {
      workspace_id: ws,
      role: 'builder' as const,
      scope_key: 'sk',
      agent_id: 'aid',
      gateway_agent_id: 'mc-runner-dev',
      run_group_id: 'rg',
      trigger_body: 'body — with non-ascii 你好',
    };
    const text = buildBriefing(input);
    assert.equal(briefingByteLength(input), Buffer.byteLength(text, 'utf8'));
  } finally {
    __setTemplatesDirForTests(null);
    fx.cleanup();
  }
});
