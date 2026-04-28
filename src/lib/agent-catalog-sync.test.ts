import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { selectGatewayAgents } from './agent-catalog-sync';

const AGENTS = [
  { id: 'main', name: 'main' },
  { id: 'mc-builder', name: 'Builder' },
  { id: 'mc-coordinator', name: 'Coordinator' },
  { id: 'mc-builder-dev', name: 'Builder' },
  { id: 'mc-coordinator-dev', name: 'Coordinator' },
  { id: 'mc-project-manager', name: 'Project Manager' },
  { id: 'mc-project-manager-dev', name: 'Project Manager' },
];

describe('selectGatewayAgents (env-driven filter)', () => {
  it('default config includes everything', () => {
    const { included, excludedGatewayIds } = selectGatewayAgents(AGENTS, {});
    assert.equal(included.length, AGENTS.length);
    assert.equal(excludedGatewayIds.size, 0);
  });

  it('exclude=*-dev keeps prod roster, drops dev roster', () => {
    const { included, excludedGatewayIds } = selectGatewayAgents(AGENTS, {
      exclude: '*-dev',
    });
    assert.deepEqual(
      included.map((a) => a.id).sort(),
      ['main', 'mc-builder', 'mc-coordinator', 'mc-project-manager'].sort(),
    );
    assert.deepEqual(
      [...excludedGatewayIds].sort(),
      ['mc-builder-dev', 'mc-coordinator-dev', 'mc-project-manager-dev'].sort(),
    );
  });

  it('include=*-dev keeps dev roster only', () => {
    const { included, excludedGatewayIds } = selectGatewayAgents(AGENTS, {
      include: '*-dev',
    });
    assert.deepEqual(
      included.map((a) => a.id).sort(),
      ['mc-builder-dev', 'mc-coordinator-dev', 'mc-project-manager-dev'].sort(),
    );
    assert.equal(excludedGatewayIds.size, 4);
    // Each non-matching id should land in excluded.
    for (const id of ['main', 'mc-builder', 'mc-coordinator', 'mc-project-manager']) {
      assert.ok(excludedGatewayIds.has(id), `${id} should be excluded`);
    }
  });

  it('exclude takes precedence over include for the same id', () => {
    // Operator sets a wide include and then an explicit exclude — the
    // exclude wins.
    const { included, excludedGatewayIds } = selectGatewayAgents(AGENTS, {
      include: 'mc-*',
      exclude: 'mc-coordinator,mc-coordinator-dev',
    });
    const ids = included.map((a) => a.id);
    assert.ok(!ids.includes('mc-coordinator'));
    assert.ok(!ids.includes('mc-coordinator-dev'));
    assert.ok(ids.includes('mc-builder'));
    assert.ok(excludedGatewayIds.has('mc-coordinator'));
    assert.ok(excludedGatewayIds.has('mc-coordinator-dev'));
    // Wide include matched, exclude knocked these out, and 'main'
    // never matched the include in the first place — still excluded.
    assert.ok(excludedGatewayIds.has('main'));
  });

  it('explicit comma-separated list works without globs', () => {
    const { included } = selectGatewayAgents(AGENTS, {
      include: 'main,mc-builder,mc-project-manager',
    });
    assert.deepEqual(
      included.map((a) => a.id).sort(),
      ['main', 'mc-builder', 'mc-project-manager'].sort(),
    );
  });

  it('whitespace and empty tokens are tolerated', () => {
    const { included } = selectGatewayAgents(AGENTS, {
      include: ' main , , mc-builder ',
    });
    assert.deepEqual(
      included.map((a) => a.id).sort(),
      ['main', 'mc-builder'].sort(),
    );
  });

  it('agents missing both id and name are skipped', () => {
    const noisy = [...AGENTS, { name: undefined }] as Parameters<typeof selectGatewayAgents>[0];
    const { included, excludedGatewayIds } = selectGatewayAgents(noisy, {});
    assert.equal(included.length, AGENTS.length);
    assert.equal(excludedGatewayIds.size, 0);
  });

  it('empty include string is treated as no filter (matches all)', () => {
    const { included } = selectGatewayAgents(AGENTS, { include: '' });
    assert.equal(included.length, AGENTS.length);
  });
});
