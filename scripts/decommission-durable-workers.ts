/**
 * Phase F decommissioner.
 *
 * Nulls `gateway_agent_id` on every `agents` row except:
 *   - The runner agents (mc-runner, mc-runner-dev)
 *   - PM placeholders (is_pm=1)
 *
 * Idempotent. Reports what changed. Does NOT delete rows — those are
 * still referenced by tasks.assigned_agent_id, task_activities,
 * convoy_subtasks, etc. Nulling the gateway link is enough: dispatch
 * routes through the runner, the per-role agent record stays as the
 * operator-visible "assigned" agent for the task.
 *
 * Run with:
 *   yarn tsx scripts/decommission-durable-workers.ts [--dry-run]
 *
 * Use --dry-run first to see what would change.
 */

import { closeDb, getDb, queryAll, run } from '../src/lib/db';

interface AgentRow {
  id: string;
  name: string;
  workspace_id: string | null;
  gateway_agent_id: string | null;
  is_pm: number | null;
}

const RUNNER_GATEWAY_IDS = new Set(['mc-runner', 'mc-runner-dev']);

function listDecommissionable(): AgentRow[] {
  return queryAll<AgentRow>(
    `SELECT id, name, workspace_id, gateway_agent_id, is_pm
       FROM agents
      WHERE gateway_agent_id IS NOT NULL
        AND COALESCE(is_pm, 0) = 0
        AND gateway_agent_id NOT IN ('mc-runner', 'mc-runner-dev')`,
  );
}

function applyNull(rows: AgentRow[]): number {
  let changed = 0;
  for (const r of rows) {
    run(
      `UPDATE agents
          SET gateway_agent_id = NULL,
              source = 'local',
              updated_at = datetime('now')
        WHERE id = ?`,
      [r.id],
    );
    changed++;
  }
  return changed;
}

function summarize(rows: AgentRow[]): void {
  if (rows.length === 0) {
    process.stderr.write('No durable workers to decommission — DB is already clean.\n');
    return;
  }
  process.stderr.write(`Found ${rows.length} agent rows to decommission:\n\n`);
  const grouped = new Map<string, number>();
  for (const r of rows) {
    grouped.set(r.gateway_agent_id ?? '(null)', (grouped.get(r.gateway_agent_id ?? '(null)') ?? 0) + 1);
  }
  for (const [gid, n] of grouped) {
    process.stderr.write(`  ${gid.padEnd(28)} ×${n}\n`);
  }
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  // Touch the DB once up-front so migrations run if this is a fresh DB.
  getDb();

  const rows = listDecommissionable();
  summarize(rows);

  if (dryRun) {
    process.stderr.write('\n(--dry-run set — not modifying any rows)\n');
    closeDb();
    return;
  }
  const changed = applyNull(rows);
  process.stderr.write(`\nUpdated ${changed} rows. gateway_agent_id is now NULL on every non-runner non-PM agent.\n`);
  process.stderr.write('The runner agent is the sole gateway-bearing record. PM placeholders unchanged.\n');
  closeDb();
}

main().catch((err) => {
  console.error('[decommission-durable-workers] fatal:', err);
  process.exit(1);
});

// Mark RUNNER_GATEWAY_IDS as referenced for tooling clarity.
void RUNNER_GATEWAY_IDS;
