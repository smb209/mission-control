import { queryAll, queryOne, run, transaction } from '@/lib/db';
import { getOpenClawClient } from '@/lib/openclaw/client';
import { logDebugEvent } from '@/lib/debug-log';
import { writeAllWorkerContexts } from '@/lib/openclaw/worker-context';

interface GatewayAgent {
  id?: string;
  name?: string;
  label?: string;
  // OpenClaw may return model as a string or as { primary: string, fallbacks: string[] }
  model?: string | { primary?: string; fallbacks?: string[]; [key: string]: unknown };
}

/** Normalise the gateway model field to a plain string for DB storage. */
function normaliseModel(
  model: GatewayAgent['model'],
): string | null {
  if (!model) return null;
  if (typeof model === 'string') return model;
  return model.primary ?? null;
}

const SYNC_INTERVAL_MS = Number(process.env.AGENT_CATALOG_SYNC_INTERVAL_MS || 60_000);
let lastSyncAt = 0;
let syncing: Promise<number> | null = null;

/**
 * Compile a comma-separated list of glob patterns into a single matcher.
 * Patterns support `*` only (matches any sequence). Whitespace and empty
 * tokens are ignored. Returns `null` when no patterns were configured —
 * caller treats null as "no filter".
 *
 * Used by the catalog sync to honor `MC_AGENT_SYNC_INCLUDE` /
 * `MC_AGENT_SYNC_EXCLUDE`. The dogfood layout sets one of:
 *   prod docker:  MC_AGENT_SYNC_EXCLUDE=*-dev
 *   dev launch:   MC_AGENT_SYNC_INCLUDE=*-dev
 * so each MC instance only mirrors its own roster from the gateway.
 */
function compileGlobList(env: string | undefined): ((id: string) => boolean) | null {
  if (!env) return null;
  const patterns = env
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (patterns.length === 0) return null;
  // Translate each glob to a regex anchored to the full id. `*` becomes
  // `.*`; everything else is escaped so dots / dashes etc. match literally.
  const regexes = patterns.map((p) => {
    const escaped = p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp(`^${escaped}$`);
  });
  return (id: string) => regexes.some((re) => re.test(id));
}

/**
 * Phase H: pick the runner gateway id this MC instance prefers, mirroring
 * `src/lib/agents/runner.ts:getRunnerAgent` selection logic. Dev MCs
 * use `mc-runner-dev`; prod uses `mc-runner`. The opposite is
 * auto-excluded from catalog sync so a dev DB never grows a prod
 * runner row (and vice versa).
 */
function preferredRunnerGatewayId(env: NodeJS.ProcessEnv = process.env): 'mc-runner' | 'mc-runner-dev' {
  const explicit = env.MC_RUNNER_GATEWAY_ID;
  if (explicit === 'mc-runner' || explicit === 'mc-runner-dev') return explicit;
  const isDev = env.NODE_ENV === 'development' || env.MC_ENV === 'dev';
  return isDev ? 'mc-runner-dev' : 'mc-runner';
}

/**
 * Decide which gateway agent ids should sync into the catalog. Returns
 * the included subset and the set of gateway ids that were filtered
 * out, so the caller can mark previously-synced excluded rows offline.
 *
 * Exported for tests; production callers use it through
 * `syncGatewayAgentsToCatalog`.
 */
export function selectGatewayAgents(
  gatewayAgents: GatewayAgent[],
  env: { include?: string; exclude?: string; processEnv?: NodeJS.ProcessEnv } = {
    include: process.env.MC_AGENT_SYNC_INCLUDE,
    exclude: process.env.MC_AGENT_SYNC_EXCLUDE,
    processEnv: process.env,
  },
): { included: GatewayAgent[]; excludedGatewayIds: Set<string> } {
  const includeMatch = compileGlobList(env.include);
  const excludeMatch = compileGlobList(env.exclude);
  const preferredRunner = preferredRunnerGatewayId(env.processEnv ?? process.env);
  const otherRunner = preferredRunner === 'mc-runner' ? 'mc-runner-dev' : 'mc-runner';

  const included: GatewayAgent[] = [];
  const excludedGatewayIds = new Set<string>();

  for (const ga of gatewayAgents) {
    const id = ga.id || ga.name;
    if (!id) continue;
    // Phase H: auto-exclude the non-preferred runner so a dev DB never
    // grows a `mc-runner` row (and vice versa for prod). Operator-set
    // INCLUDE/EXCLUDE still apply on top of this default.
    if (id === otherRunner) {
      excludedGatewayIds.add(id);
      continue;
    }
    // Include defaults to match-all when not configured. Exclude is then
    // applied on top — so an id can be in the include list and still be
    // dropped if exclude matches it.
    const isIncluded = includeMatch ? includeMatch(id) : true;
    const isExcluded = excludeMatch ? excludeMatch(id) : false;
    if (isIncluded && !isExcluded) {
      included.push(ga);
    } else {
      excludedGatewayIds.add(id);
    }
  }

  return { included, excludedGatewayIds };
}

function normalizeRole(name: string): string {
  const n = name.toLowerCase();
  // Order matters: more-specific patterns first. Without the research /
  // write / coord branches below, gateway-synced agents named "Researcher",
  // "Writer", or "Coordinator" all fell through to 'builder', which hid
  // them from pickDynamicAgent's role-based lookup and caused every
  // convoy sub-task to route to the single `role='builder'` agent.
  if (n.includes('learn')) return 'learner';
  if (n.includes('test')) return 'tester';
  if (n.includes('review') || n.includes('verif')) return 'reviewer';
  if (n.includes('fix')) return 'fixer';
  if (n.includes('senior')) return 'senior';
  if (n.includes('research')) return 'researcher';
  if (n.includes('writ')) return 'writer';
  if (n.includes('design')) return 'designer';
  if (n.includes('coord')) return 'coordinator';
  if (n.includes('plan') || n.includes('orch')) return 'orchestrator';
  return 'builder';
}

export async function syncGatewayAgentsToCatalog(options?: { force?: boolean; reason?: string }): Promise<number> {
  const force = Boolean(options?.force);
  const now = Date.now();
  if (!force && now - lastSyncAt < SYNC_INTERVAL_MS) {
    return 0;
  }

  if (syncing) return syncing;

  syncing = (async () => {
    const client = getOpenClawClient();
    if (!client.isConnected()) {
      await client.connect();
    }

    const listStart = Date.now();
    let gatewayAgents: GatewayAgent[] = [];
    let listError: string | null = null;
    try {
      gatewayAgents = (await client.listAgents()) as GatewayAgent[];
    } catch (err) {
      listError = (err as Error).message;
      throw err;
    } finally {
      logDebugEvent({
        type: 'gateway.list_agents',
        direction: 'outbound',
        durationMs: Date.now() - listStart,
        responseBody: { count: gatewayAgents.length, agents: gatewayAgents.map(a => ({ id: a.id, name: a.name })) },
        error: listError,
        metadata: { reason: options?.reason || 'automatic' },
      });
    }

    // Apply MC_AGENT_SYNC_INCLUDE / MC_AGENT_SYNC_EXCLUDE before any DB
    // writes. The gateway is single-source-of-truth for the workspace
    // roster; this filter is purely an MC-side mirror choice (one prod
    // and one dev MC instance can coexist against the same gateway by
    // mirroring disjoint subsets of agents).
    const { included, excludedGatewayIds } = selectGatewayAgents(gatewayAgents);

    // Track *whether* a gateway_id has any existing rows (to choose
     // INSERT vs UPDATE). Multiple rows per gateway_id are legal — the
     // clone-agents-on-create feature copies an agent into a new
     // workspace while preserving gateway_agent_id, since gateway agents
     // are an org-wide identity. Both rows must receive sync updates,
     // so the UPDATEs below match by gateway_agent_id rather than id.
    const existing = queryAll<{ id: string; gateway_agent_id: string | null }>(
      `SELECT id, gateway_agent_id FROM agents WHERE gateway_agent_id IS NOT NULL`
    );
    const existingGatewayIds = new Set<string>();
    for (const a of existing) {
      if (a.gateway_agent_id) existingGatewayIds.add(a.gateway_agent_id);
    }

    let changed = 0;
    let markedOffline = 0;
    const ts = new Date().toISOString();

    transaction(() => {
      for (const ga of included) {
        const gatewayId = ga.id || ga.name;
        if (!gatewayId) continue;

        const name = ga.name || ga.label || gatewayId;
        const role = normalizeRole(name);

        if (existingGatewayIds.has(gatewayId)) {
          // Update every existing row for this gateway_agent_id (one per
          // workspace that has an agent linked to it). Flip status off
          // 'offline' if a previous sync had marked it filtered-out and
          // the operator has now included it again.
          //
          // Phase H: runner rows are also re-asserted as is_pm=1 +
          // is_master=1 so a stale row that lost the flags (manual DB
          // edit, partial migration) self-heals on the next sync.
          const isRunner = gatewayId === 'mc-runner' || gatewayId === 'mc-runner-dev';
          if (isRunner) {
            run(
              `UPDATE agents
                  SET name = ?,
                      role = CASE WHEN role IS NULL OR role = 'builder' THEN ? ELSE role END,
                      model = COALESCE(?, model),
                      source = 'gateway',
                      status = CASE WHEN status = 'offline' THEN 'standby' ELSE status END,
                      is_pm = 1,
                      is_master = 1,
                      is_active = 1,
                      updated_at = ?
                WHERE gateway_agent_id = ?`,
              [name, role, normaliseModel(ga.model), ts, gatewayId]
            );
          } else {
            run(
              `UPDATE agents
                  SET name = ?,
                      role = CASE WHEN role IS NULL OR role = 'builder' THEN ? ELSE role END,
                      model = COALESCE(?, model),
                      source = 'gateway',
                      status = CASE WHEN status = 'offline' THEN 'standby' ELSE status END,
                      updated_at = ?
                WHERE gateway_agent_id = ?`,
              [name, role, normaliseModel(ga.model), ts, gatewayId]
            );
          }
          changed += 1;
        } else if (gatewayId === 'mc-runner' || gatewayId === 'mc-runner-dev') {
          // Phase F: only auto-create rows for the org-wide runner.
          // Per-role workers (mc-builder, mc-tester, etc.) are no
          // longer durable agents — work routes through the runner
          // with role-specific briefings.
          //
          // Phase H: the runner IS the PM. Insert with is_pm=1 +
          // is_master=1 so a fresh DB has a working PM the moment
          // catalog sync completes.
          run(
            `INSERT INTO agents (id, name, role, description, avatar_emoji, is_master, is_pm, is_active, workspace_id, model, source, gateway_agent_id, created_at, updated_at)
             VALUES (lower(hex(randomblob(16))), ?, 'pm', ?, '🎯', 1, 1, 1, 'default', ?, 'gateway', ?, ?, ?)`,
            [name, `Org-wide PM + scope-keyed-session host (${gatewayId})`, normaliseModel(ga.model), gatewayId, ts, ts]
          );
          changed += 1;
        } else {
          // Non-runner, non-existing gateway id: skip insert. The
          // gateway exposes per-role agents for backwards compat
          // with operators who haven't migrated, but Phase F+ MC
          // doesn't materialize them as DB rows.
        }
      }

      // Mark previously-synced rows whose gateway id is now filtered
      // out as `status='offline'`. Don't touch `is_active` — that's the
      // operator's intentional disable toggle and we don't want to
      // overwrite it. Don't delete the row either; FK references from
      // tasks / mailbox stay valid, and a future env-var relaxation
      // will flip status back to 'idle' automatically (above).
      for (const gatewayId of excludedGatewayIds) {
        if (!existingGatewayIds.has(gatewayId)) continue;
        // Phase H: when a runner is excluded (the non-preferred one
        // for this MC instance's env), also demote it from PM/master
        // and deactivate so hasWorkspacePm / getPmAgent don't pick
        // it up as the PM. Workers that were previously synced fall
        // back to the legacy status='offline' update.
        const isRunner = gatewayId === 'mc-runner' || gatewayId === 'mc-runner-dev';
        const result = isRunner
          ? run(
              `UPDATE agents
                  SET status = 'offline',
                      is_active = 0,
                      is_pm = 0,
                      is_master = 0,
                      updated_at = ?
                WHERE gateway_agent_id = ?
                  AND (status != 'offline' OR is_active = 1 OR is_pm = 1 OR is_master = 1)`,
              [ts, gatewayId]
            )
          : run(
              `UPDATE agents SET status = 'offline', updated_at = ? WHERE gateway_agent_id = ? AND status != 'offline'`,
              [ts, gatewayId]
            );
        if (result.changes > 0) markedOffline += result.changes;
      }

      run(
        `INSERT INTO events (id, type, message, metadata, created_at)
         VALUES (lower(hex(randomblob(16))), 'system', ?, ?, ?)`,
        [
          `Agent catalog sync completed (${options?.reason || 'automatic'})`,
          JSON.stringify({
            changed,
            marked_offline: markedOffline,
            included: included.length,
            excluded: excludedGatewayIds.size,
            reason: options?.reason || 'automatic',
          }),
          ts,
        ]
      );
    });

    // Refresh MC-CONTEXT.json for every gateway agent now that the catalog
    // is up to date. This is best-effort — a failed write shouldn't break
    // the sync (e.g. the bind mount is missing in local `next dev`).
    try {
      const results = writeAllWorkerContexts();
      const written = results.filter((r) => !r.error && !r.skipped).length;
      const skipped = results.filter((r) => r.skipped).length;
      const failed = results.filter((r) => r.error);
      if (failed.length > 0) {
        console.warn(
          `[AgentCatalog] MC-CONTEXT.json: wrote=${written} skipped=${skipped} failed=${failed.length}`,
          failed.map((f) => `${f.gateway_agent_id}: ${f.error}`).join('; ')
        );
      } else if (results.length > 0) {
        console.log(
          `[AgentCatalog] MC-CONTEXT.json refreshed for ${written} agent(s)${skipped ? `, skipped ${skipped}` : ''}`
        );
      }
    } catch (err) {
      console.warn('[AgentCatalog] MC-CONTEXT.json refresh failed:', (err as Error).message);
    }

    lastSyncAt = Date.now();
    return changed;
  })();

  try {
    return await syncing;
  } finally {
    syncing = null;
  }
}

export function ensureCatalogSyncScheduled(): void {
  if (process.env.NODE_ENV === 'test') return;
  const g = globalThis as unknown as { __mcAgentCatalogTimer?: NodeJS.Timeout };
  if (g.__mcAgentCatalogTimer) return;
  g.__mcAgentCatalogTimer = setInterval(() => {
    syncGatewayAgentsToCatalog({ reason: 'scheduled' }).catch((err) => {
      console.error('[AgentCatalog] scheduled sync failed:', err);
    });
  }, SYNC_INTERVAL_MS);
  syncGatewayAgentsToCatalog({ reason: 'startup' }).catch((err) => {
    console.error('[AgentCatalog] startup sync failed:', err);
  });
}

export function getAgentByPreferredRoles(taskId: string, preferredRoles: string[]): { id: string; name: string } | null {
  // Workspace-scope the global-role fallback. Without this filter a
  // multi-workspace gateway clone (#133) can be selected for a task in
  // another workspace, which then trips authz:workspace_mismatch on
  // every MCP call. The byTaskRole path is already implicitly scoped
  // because task_roles rows are populated from workspace agents
  // (populateTaskRolesFromAgents).
  const taskWorkspace = queryOne<{ workspace_id: string | null }>(
    'SELECT workspace_id FROM tasks WHERE id = ?',
    [taskId],
  )?.workspace_id ?? 'default';
  // Filter out operator-disabled agents (is_active=0). COALESCE(is_active, 1)
  // guards rows created before the column existed.
  for (const role of preferredRoles) {
    const byTaskRole = queryOne<{ id: string; name: string }>(
      `SELECT a.id, a.name
       FROM task_roles tr
       JOIN agents a ON a.id = tr.agent_id
       WHERE tr.task_id = ? AND tr.role = ?
         AND a.status != 'offline'
         AND COALESCE(a.is_active, 1) = 1
       LIMIT 1`,
      [taskId, role]
    );
    if (byTaskRole) return byTaskRole;

    const byGlobalRole = queryOne<{ id: string; name: string }>(
      `SELECT id, name FROM agents
       WHERE role = ? AND status != 'offline' AND COALESCE(is_active, 1) = 1
         AND COALESCE(workspace_id, 'default') = ?
       ORDER BY updated_at DESC LIMIT 1`,
      [role, taskWorkspace]
    );
    if (byGlobalRole) return byGlobalRole;
  }
  return null;
}
