/**
 * PM-scoped MCP endpoint.
 *
 * Mounts core + read + pm groups. Designed to be the only MCP server
 * a workspace's PM agent needs — saves ~14K tokens per dispatch versus
 * the full 47-tool default route.
 *
 * Worker tools (register_deliverable, update_task_status, spawn_subtask,
 * etc.) and CRUD tools (create_initiative, update_initiative, etc.)
 * are NOT mounted here — the PM uses propose_changes to mutate the
 * roadmap, not direct write tools.
 *
 * See `specs/mcp-surface-review.md` for the route split rationale.
 */

import { NextRequest } from 'next/server';
import { createMcpRouteHandler } from '../_handler';

export const dynamic = 'force-dynamic';

const handle = createMcpRouteHandler(['core', 'read', 'pm']);

export async function POST(request: NextRequest): Promise<Response> {
  return handle(request);
}

export async function GET(request: NextRequest): Promise<Response> {
  return handle(request);
}
