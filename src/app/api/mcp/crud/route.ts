/**
 * CRUD-scoped MCP endpoint.
 *
 * Mounts core + read + crud groups. Parked endpoint — not mounted on
 * any agent by default. Available for future direct-edit agents (e.g.
 * an operator-driven schedule manipulator) that need to bypass the
 * PM's proposal flow and mutate initiatives/tasks directly.
 *
 * Operators wire this up by editing `~/.openclaw/openclaw.json` to
 * register the server and grant the appropriate per-agent allowlist.
 *
 * See `docs/archive/mcp-surface-review.md` for rationale.
 */

import { NextRequest } from 'next/server';
import { createMcpRouteHandler } from '../_handler';

export const dynamic = 'force-dynamic';

const handle = createMcpRouteHandler(['core', 'read', 'crud']);

export async function POST(request: NextRequest): Promise<Response> {
  return handle(request);
}

export async function GET(request: NextRequest): Promise<Response> {
  return handle(request);
}
