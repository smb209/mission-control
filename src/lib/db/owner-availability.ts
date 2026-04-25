/**
 * Owner availability DB helpers (Phase 4 of the roadmap planning layer).
 *
 * The `owner_availability` table was introduced in Phase 1 but had no API
 * surface or helpers. The derivation engine (§7.2) consumes these rows to
 * push initiative `derived_end` later by the overlap of any owner-out-of-
 * office windows. Phase 5 will add a PM-driven path for these rows; for
 * now they are operator-managed.
 *
 * Rows represent UNAVAILABLE windows (the agent is out / heads-down on
 * something else). An empty list means the owner is fully available, which
 * is the default the derivation falls back to.
 */

import { v4 as uuidv4 } from 'uuid';
import { queryAll, queryOne, run } from '@/lib/db';

export interface OwnerAvailability {
  id: string;
  agent_id: string;
  unavailable_start: string;
  unavailable_end: string;
  reason: string | null;
  created_at: string;
}

export interface CreateOwnerAvailabilityInput {
  agent_id: string;
  unavailable_start: string;
  unavailable_end: string;
  reason?: string | null;
}

export interface ListOwnerAvailabilityFilters {
  /** Restrict to a single agent. */
  agent_id?: string;
  /**
   * Overlap query: include rows whose [unavailable_start, unavailable_end]
   * window intersects [between_start, between_end]. Either bound may be
   * omitted to treat that side as unbounded.
   */
  between_start?: string | null;
  between_end?: string | null;
  /** Restrict to agents in a particular workspace. */
  workspace_id?: string;
}

export function createOwnerAvailability(input: CreateOwnerAvailabilityInput): OwnerAvailability {
  if (!input.agent_id) throw new Error('agent_id is required');
  if (!input.unavailable_start || !input.unavailable_end) {
    throw new Error('unavailable_start and unavailable_end are required');
  }
  if (input.unavailable_end < input.unavailable_start) {
    throw new Error('unavailable_end must be >= unavailable_start');
  }

  // Confirm the agent exists. SQLite's FK is informational without a
  // PRAGMA cycle, but giving a clear error here is friendlier than the
  // raw FK error the next mutation would produce.
  const agent = queryOne<{ id: string }>('SELECT id FROM agents WHERE id = ?', [input.agent_id]);
  if (!agent) throw new Error(`Agent not found: ${input.agent_id}`);

  const id = uuidv4();
  const now = new Date().toISOString();
  run(
    `INSERT INTO owner_availability (id, agent_id, unavailable_start, unavailable_end, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, input.agent_id, input.unavailable_start, input.unavailable_end, input.reason ?? null, now],
  );
  return queryOne<OwnerAvailability>('SELECT * FROM owner_availability WHERE id = ?', [id])!;
}

export function listOwnerAvailability(filters: ListOwnerAvailabilityFilters = {}): OwnerAvailability[] {
  const where: string[] = [];
  const params: unknown[] = [];

  if (filters.workspace_id) {
    // Join to agents on workspace.
    where.push('oa.agent_id IN (SELECT id FROM agents WHERE workspace_id = ?)');
    params.push(filters.workspace_id);
  }
  if (filters.agent_id) {
    where.push('oa.agent_id = ?');
    params.push(filters.agent_id);
  }
  // Overlap predicate: NOT (window ends before query starts OR window starts after query ends).
  if (filters.between_start) {
    where.push('oa.unavailable_end >= ?');
    params.push(filters.between_start);
  }
  if (filters.between_end) {
    where.push('oa.unavailable_start <= ?');
    params.push(filters.between_end);
  }

  const sql =
    `SELECT oa.* FROM owner_availability oa ` +
    (where.length ? `WHERE ${where.join(' AND ')} ` : '') +
    `ORDER BY oa.unavailable_start, oa.created_at`;
  return queryAll<OwnerAvailability>(sql, params);
}

export function getOwnerAvailability(id: string): OwnerAvailability | undefined {
  return queryOne<OwnerAvailability>('SELECT * FROM owner_availability WHERE id = ?', [id]);
}

export function deleteOwnerAvailability(id: string): void {
  const existing = queryOne<{ id: string }>('SELECT id FROM owner_availability WHERE id = ?', [id]);
  if (!existing) throw new Error(`Owner availability not found: ${id}`);
  run('DELETE FROM owner_availability WHERE id = ?', [id]);
}
