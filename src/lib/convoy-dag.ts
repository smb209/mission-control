/**
 * Shared convoy-DAG validator.
 *
 * Pulled out of `src/lib/mcp/groups/work.ts` (plan_convoy) so the
 * PM-driven apply pass for `create_convoy_under_initiative` diffs can
 * reuse the same Kahn topological sort + peer resolution. One place to
 * fix validation rules; two entry points (coordinator's plan_convoy MCP
 * tool + operator's proposal-accept).
 *
 * See docs/reference/pm-convoy-mandate.md "Apply pass" for the contract.
 */

import { queryOne, queryAll } from '@/lib/db';

// ─── Public types ──────────────────────────────────────────────────

/**
 * The minimal slice shape the validator needs. Both call sites pass
 * richer objects (with `slice`, `message`, `expected_deliverables`,
 * etc.); the validator only looks at `id`, the addressing axes, and
 * `depends_on`. Keeping the input type narrow lets each caller forward
 * its own slice array without an extra mapping pass.
 */
export interface ConvoyDagSliceInput {
  id: string;
  role?: string;
  peer_agent_id?: string;
  peer_gateway_id?: string;
  depends_on?: string[];
}

export interface DelegationPeerRow {
  id: string;
  name: string;
  role: string | null;
  gateway_agent_id: string | null;
}

export interface ResolvedPeer {
  peer: DelegationPeerRow;
  resolvedVia: 'role' | 'peer_agent_id' | 'peer_gateway_id';
}

export interface PeerResolutionError {
  slice_id: string;
  code: string;
  message: string;
}

export type ConvoyDagValidationResult =
  | {
      ok: true;
      /** Topological order of slice symbolic ids. */
      topo: string[];
      /** Resolved peer per symbolic id. */
      resolved: Map<string, ResolvedPeer>;
    }
  | {
      ok: false;
      /** Single error code identifying the first structural failure. */
      code:
        | 'duplicate_slice_id'
        | 'unknown_dep'
        | 'self_dependency'
        | 'cycle_detected'
        | 'peer_resolution_failed';
      message: string;
      /** Structured detail for the failure. */
      details: Record<string, unknown>;
    };

// ─── Peer resolution ───────────────────────────────────────────────

type ResolvePeerOk = {
  ok: true;
  peer: DelegationPeerRow;
  resolvedVia: 'role' | 'peer_agent_id' | 'peer_gateway_id';
};
type ResolvePeerErr = {
  ok: false;
  code: string;
  message: string;
  addressing: Record<string, string>;
};

/**
 * Resolve one slice's peer addressing (exactly one of role /
 * peer_agent_id / peer_gateway_id) against the workspace roster.
 *
 * Lifted verbatim from `resolveDelegationPeer` in
 * `src/lib/mcp/groups/work.ts` (PR #344-era code path). Identical
 * semantics — including the mc-runner / mc-runner-dev cross-workspace
 * carve-out and the role-active filter.
 */
export function resolveDelegationPeer(
  axes: { role?: string; peer_agent_id?: string; peer_gateway_id?: string },
  parentWs: string,
): ResolvePeerOk | ResolvePeerErr {
  const provided = [axes.role, axes.peer_agent_id, axes.peer_gateway_id]
    .filter((v): v is string => typeof v === 'string' && v.length > 0);
  if (provided.length === 0) {
    return {
      ok: false,
      code: 'peer_addressing_missing',
      message: 'Specify exactly one of role / peer_agent_id / peer_gateway_id.',
      addressing: {},
    };
  }
  if (provided.length > 1) {
    return {
      ok: false,
      code: 'peer_addressing_conflict',
      message: 'role / peer_agent_id / peer_gateway_id are mutually exclusive.',
      addressing: {},
    };
  }
  if (axes.role) {
    const peer = queryOne<DelegationPeerRow>(
      `SELECT id, name, role, gateway_agent_id FROM agents
        WHERE role = ?
          AND COALESCE(workspace_id, 'default') = ?
          AND COALESCE(status, 'standby') != 'offline'
          AND COALESCE(is_active, 1) = 1
        ORDER BY updated_at DESC LIMIT 1`,
      [axes.role, parentWs],
    );
    if (!peer) {
      // Help the operator (and the PM agent reading the error) recover:
      // list the roles that DO exist in this workspace so the next refine
      // can pick a valid one instead of inventing more synonyms.
      const available = queryAll<{ role: string }>(
        `SELECT DISTINCT role FROM agents
          WHERE COALESCE(workspace_id, 'default') = ?
            AND COALESCE(status, 'standby') != 'offline'
            AND COALESCE(is_active, 1) = 1
          ORDER BY role`,
        [parentWs],
      ).map((r) => r.role);
      const hint =
        available.length > 0
          ? ` Available roles in this workspace: ${available.join(', ')}.`
          : '';
      return {
        ok: false,
        code: 'peer_not_found',
        message: `No active agent with role "${axes.role}" in workspace ${parentWs}.${hint}`,
        addressing: { role: axes.role },
      };
    }
    return { ok: true, peer, resolvedVia: 'role' };
  }
  if (axes.peer_agent_id) {
    const peer = queryOne<DelegationPeerRow & { workspace_id: string | null }>(
      `SELECT id, name, role, gateway_agent_id, workspace_id FROM agents WHERE id = ? LIMIT 1`,
      [axes.peer_agent_id],
    );
    if (!peer) {
      return {
        ok: false,
        code: 'peer_not_found',
        message: `No agent with id "${axes.peer_agent_id}".`,
        addressing: { peer_agent_id: axes.peer_agent_id },
      };
    }
    const isOrgRunner =
      peer.gateway_agent_id === 'mc-runner' || peer.gateway_agent_id === 'mc-runner-dev';
    const peerWs = peer.workspace_id ?? 'default';
    if (peerWs !== parentWs && !isOrgRunner) {
      return {
        ok: false,
        code: 'peer_not_in_workspace',
        message: `Peer "${peer.name}" is in workspace ${peerWs}, not ${parentWs}.`,
        addressing: { peer_agent_id: axes.peer_agent_id },
      };
    }
    return {
      ok: true,
      peer: {
        id: peer.id,
        name: peer.name,
        role: peer.role,
        gateway_agent_id: peer.gateway_agent_id,
      },
      resolvedVia: 'peer_agent_id',
    };
  }
  const gwId = axes.peer_gateway_id as string;
  const isOrgRunner = gwId === 'mc-runner' || gwId === 'mc-runner-dev';
  const peer = isOrgRunner
    ? queryOne<DelegationPeerRow>(
        `SELECT id, name, role, gateway_agent_id FROM agents WHERE gateway_agent_id = ? LIMIT 1`,
        [gwId],
      )
    : queryOne<DelegationPeerRow>(
        `SELECT id, name, role, gateway_agent_id FROM agents WHERE gateway_agent_id = ? AND COALESCE(workspace_id, 'default') = ? LIMIT 1`,
        [gwId, parentWs],
      );
  if (!peer) {
    return {
      ok: false,
      code: 'peer_not_found',
      message: `No agent with gateway_agent_id "${gwId}" in workspace ${parentWs}.`,
      addressing: { peer_gateway_id: gwId },
    };
  }
  return { ok: true, peer, resolvedVia: 'peer_gateway_id' };
}

// ─── DAG validator ─────────────────────────────────────────────────

/**
 * Validate a convoy slice DAG. Returns either a successful result with
 * the topological order + resolved peers, or a single structured error.
 *
 * Steps (atomic — first failure short-circuits):
 *   1. Duplicate slice ids.
 *   2. Unknown / self-referencing depends_on.
 *   3. Kahn's topological sort; surfaces cycles.
 *   4. Peer resolution for every slice (aggregates all peer errors so
 *      the caller can show one combined diagnostic instead of N retries).
 *
 * Caller decides what to do with the result — `plan_convoy` writes
 * `convoy_subtasks` directly; the proposal-accept pass writes through
 * `spawnDelegationSubtask`. Neither path mutates the DB inside the
 * validator.
 */
export function validateConvoyDag(
  slices: ConvoyDagSliceInput[],
  parentWs: string,
): ConvoyDagValidationResult {
  // ── 1. duplicate ids ─────────────────────────────────────────────
  const ids = new Set<string>();
  for (const s of slices) {
    if (ids.has(s.id)) {
      return {
        ok: false,
        code: 'duplicate_slice_id',
        message: `Duplicate slice id "${s.id}".`,
        details: { id: s.id },
      };
    }
    ids.add(s.id);
  }

  // ── 2. unknown / self deps ───────────────────────────────────────
  for (const s of slices) {
    for (const dep of s.depends_on ?? []) {
      if (!ids.has(dep)) {
        return {
          ok: false,
          code: 'unknown_dep',
          message: `Slice "${s.id}" depends on unknown id "${dep}".`,
          details: { slice_id: s.id, dep },
        };
      }
      if (dep === s.id) {
        return {
          ok: false,
          code: 'self_dependency',
          message: `Slice "${s.id}" depends on itself.`,
          details: { slice_id: s.id },
        };
      }
    }
  }

  // ── 3. Kahn topo sort ────────────────────────────────────────────
  const inDegree = new Map<string, number>();
  const outEdges = new Map<string, string[]>();
  for (const s of slices) {
    inDegree.set(s.id, (s.depends_on ?? []).length);
    for (const dep of s.depends_on ?? []) {
      const arr = outEdges.get(dep) ?? [];
      arr.push(s.id);
      outEdges.set(dep, arr);
    }
  }
  const ready: string[] = [];
  for (const [id, deg] of inDegree) if (deg === 0) ready.push(id);
  const topo: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    topo.push(id);
    for (const next of outEdges.get(id) ?? []) {
      const d = (inDegree.get(next) ?? 0) - 1;
      inDegree.set(next, d);
      if (d === 0) ready.push(next);
    }
  }
  if (topo.length !== slices.length) {
    const stuck = slices.filter((s) => !topo.includes(s.id)).map((s) => s.id);
    return {
      ok: false,
      code: 'cycle_detected',
      message: `Cycle detected: slices ${stuck.join(', ')} form a dependency loop.`,
      details: { stuck },
    };
  }

  // ── 4. peer resolution (aggregate all failures) ──────────────────
  const resolved = new Map<string, ResolvedPeer>();
  const peerErrors: PeerResolutionError[] = [];
  for (const s of slices) {
    const r = resolveDelegationPeer(
      { role: s.role, peer_agent_id: s.peer_agent_id, peer_gateway_id: s.peer_gateway_id },
      parentWs,
    );
    if (!r.ok) {
      peerErrors.push({ slice_id: s.id, code: r.code, message: r.message });
    } else {
      resolved.set(s.id, { peer: r.peer, resolvedVia: r.resolvedVia });
    }
  }
  if (peerErrors.length > 0) {
    return {
      ok: false,
      code: 'peer_resolution_failed',
      message: `Could not resolve ${peerErrors.length} peer(s):\n${peerErrors
        .map((e) => `- ${e.slice_id}: ${e.message}`)
        .join('\n')}`,
      details: { failures: peerErrors },
    };
  }

  return { ok: true, topo, resolved };
}
