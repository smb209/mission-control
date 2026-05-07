/**
 * Verify the host→container translation we lean on for the
 * `local_repo_init` git-init runner. The translator itself lives in
 * src/lib/deliverables/storage.ts; this suite locks the contract in
 * relative to the workspace-conventions use case so a future change
 * to the deliverables module won't silently break the dockerized
 * git-init flow.
 *
 * See specs/workspace-conventions-structured.md §5 + the route
 * implementation in src/app/api/workspaces/[id]/route.ts.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { hostPathToContainerPath } from '@/lib/deliverables/storage';

function withEnv<T>(
  patch: Record<string, string | undefined>,
  fn: () => T,
): T {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(patch)) prev[k] = process.env[k];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('host→container: no-op when host root equals container root', () => {
  withEnv(
    {
      MC_DELIVERABLES_HOST_PATH: '/Users/op/projects',
      MC_DELIVERABLES_CONTAINER_PATH: '/Users/op/projects',
    },
    () => {
      assert.equal(
        hostPathToContainerPath('/Users/op/projects/foo'),
        '/Users/op/projects/foo',
      );
    },
  );
});

test('host→container: dockerized — host path under bind root translates', () => {
  withEnv(
    {
      MC_DELIVERABLES_HOST_PATH: '/Users/op/projects',
      MC_DELIVERABLES_CONTAINER_PATH: '/app/data/projects',
    },
    () => {
      assert.equal(
        hostPathToContainerPath('/Users/op/projects/foo'),
        '/app/data/projects/foo',
      );
      // Direct match on the root is also handled.
      assert.equal(
        hostPathToContainerPath('/Users/op/projects'),
        '/app/data/projects',
      );
    },
  );
});

test('host→container: path outside the bind root passes through', () => {
  // The translator returns the input as-is when it can't translate.
  // The git-init runner relies on existsSync() to then catch the miss
  // and surface a clear error — see ensureLocalRepo.
  withEnv(
    {
      MC_DELIVERABLES_HOST_PATH: '/Users/op/projects',
      MC_DELIVERABLES_CONTAINER_PATH: '/app/data/projects',
    },
    () => {
      assert.equal(
        hostPathToContainerPath('/somewhere/else/foo'),
        '/somewhere/else/foo',
      );
    },
  );
});
