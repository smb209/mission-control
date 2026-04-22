/**
 * GET /api/debug/mcp/status
 *
 * Aggregates everything the /debug/mcp dashboard shows at the top of the
 * page: whether the endpoint is enabled, how many tools the server
 * registers, count summaries, per-tool latency / error stats, and
 * per-agent call counts. The live feed is driven by the existing
 * `/api/debug/events?event_type=mcp.tool_call` endpoint; this one is for
 * everything that's not a row-per-call.
 *
 * All aggregate queries run against the `debug_events` table, filtered to
 * rows with `event_type='mcp.tool_call'`. No separate materialized view.
 */

import { NextResponse } from 'next/server';
import { queryAll, queryOne } from '@/lib/db';
import { buildServer } from '@/lib/mcp/server';

export const dynamic = 'force-dynamic';

interface ToolStatRow {
  tool_name: string;
  calls: number;
  errors: number;
  avg_ms: number | null;
  p95_ms: number | null;
  last_at: string | null;
}

interface AgentStatRow {
  agent_id: string | null;
  agent_name: string | null;
  calls: number;
  errors: number;
  last_at: string | null;
}

export async function GET() {
  const enabled =
    process.env.MC_MCP_ENABLED === '1' || process.env.MC_MCP_ENABLED === 'true';

  // Tool count comes straight from the server factory. Matches what the
  // /debug/mcp header shows alongside the enabled flag; lets operators
  // sanity-check that the server actually has the expected surface
  // without issuing a real tools/list.
  let toolsCount = 0;
  let toolNames: string[] = [];
  try {
    const server = buildServer();
    // `McpServer` keeps its registered tools in a private map; the public
    // surface exposes them via an internal `_registeredTools`. We access
    // it defensively so an SDK upgrade that renames the field degrades
    // gracefully (we just show 0 tools and the dashboard keeps working).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const registered = (server as any)._registeredTools as Record<string, unknown> | undefined;
    if (registered) {
      toolNames = Object.keys(registered);
      toolsCount = toolNames.length;
    }
  } catch (err) {
    console.warn('[mcp/status] buildServer introspection failed:', (err as Error).message);
  }

  // Count summaries — three time windows. All from `debug_events`.
  const totalRow = queryOne<{ cnt: number }>(
    `SELECT COUNT(*) as cnt FROM debug_events WHERE event_type = 'mcp.tool_call'`,
  );
  const hourRow = queryOne<{ cnt: number }>(
    `SELECT COUNT(*) as cnt FROM debug_events
       WHERE event_type = 'mcp.tool_call'
         AND created_at >= datetime('now', '-1 hour')`,
  );
  const dayRow = queryOne<{ cnt: number }>(
    `SELECT COUNT(*) as cnt FROM debug_events
       WHERE event_type = 'mcp.tool_call'
         AND created_at >= datetime('now', '-1 day')`,
  );
  const errorsHourRow = queryOne<{ cnt: number }>(
    `SELECT COUNT(*) as cnt FROM debug_events
       WHERE event_type = 'mcp.tool_call'
         AND created_at >= datetime('now', '-1 hour')
         AND error IS NOT NULL`,
  );

  // Per-tool stats. We stored tool_name in metadata JSON; SQLite's json_extract
  // is available (enabled in schema.ts migration 031). Percentile via a
  // window function would require sqlite ≥ 3.25 and a correlated subquery;
  // simpler to compute p95 client-side from raw durations if we need it.
  // For now, avg + max is enough — p95 left as a TODO once we have real data.
  const perTool = queryAll<ToolStatRow>(
    `SELECT
       json_extract(metadata, '$.tool_name') as tool_name,
       COUNT(*) as calls,
       SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END) as errors,
       ROUND(AVG(duration_ms)) as avg_ms,
       MAX(duration_ms) as p95_ms,
       MAX(created_at) as last_at
     FROM debug_events
     WHERE event_type = 'mcp.tool_call'
       AND created_at >= datetime('now', '-1 day')
     GROUP BY tool_name
     ORDER BY calls DESC`,
  );

  // Per-agent stats. JOIN on agents for names so the dashboard can show
  // "Writer" instead of a bare uuid. Some tool calls might not have
  // agent_id (e.g. unauthenticated probes during rollout); those collapse
  // into a null-named row.
  const perAgent = queryAll<AgentStatRow>(
    `SELECT
       d.agent_id,
       a.name as agent_name,
       COUNT(*) as calls,
       SUM(CASE WHEN d.error IS NOT NULL THEN 1 ELSE 0 END) as errors,
       MAX(d.created_at) as last_at
     FROM debug_events d
     LEFT JOIN agents a ON a.id = d.agent_id
     WHERE d.event_type = 'mcp.tool_call'
       AND d.created_at >= datetime('now', '-1 day')
     GROUP BY d.agent_id
     ORDER BY calls DESC`,
  );

  return NextResponse.json({
    enabled,
    tools: {
      count: toolsCount,
      names: toolNames,
    },
    counts: {
      total: totalRow?.cnt ?? 0,
      last_hour: hourRow?.cnt ?? 0,
      last_day: dayRow?.cnt ?? 0,
      errors_last_hour: errorsHourRow?.cnt ?? 0,
    },
    per_tool: perTool,
    per_agent: perAgent,
  });
}
