/**
 * HTTP glue for the agent-task authorization helper.
 *
 * Keeps the try/catch + NextResponse-mapping boilerplate out of each route
 * handler. The enforce-if-provided pattern is deliberate: operator calls
 * (UI moves on the kanban board) go through the same routes but don't
 * carry an agent_id, and they're already trusted via the same-origin
 * bypass in src/proxy.ts. Only agent-initiated calls carry an agent_id,
 * and those are the ones we authorize here.
 */

import { NextResponse } from 'next/server';
import {
  AuthzError,
  AuthzAction,
  assertAgentActive,
  assertAgentCanActOnTask,
} from './agent-task';

function authzErrorResponse(err: AuthzError): NextResponse {
  return NextResponse.json(
    {
      error: err.message,
      code: err.code,
    },
    { status: 403 },
  );
}

/**
 * If `agentId` is provided, enforce task authorization and return a 403
 * NextResponse on failure. Returns null on success (route continues).
 *
 * Operator flows (no agent_id in body) return null without checking — they
 * are trusted via the same-origin bypass in src/proxy.ts.
 */
export function authorizeAgentForTask(
  agentId: string | null | undefined,
  taskId: string,
  action: AuthzAction,
): NextResponse | null {
  if (!agentId) return null;
  try {
    assertAgentCanActOnTask(agentId, taskId, action);
    return null;
  } catch (err) {
    if (err instanceof AuthzError) return authzErrorResponse(err);
    throw err;
  }
}

/**
 * If `agentId` is provided, enforce that the agent exists and is active,
 * but do not check task binding. Used for mail where the sender isn't tied
 * to a specific task (roll-call replies, broadcasts).
 */
export function authorizeAgentActive(
  agentId: string | null | undefined,
): NextResponse | null {
  if (!agentId) return null;
  try {
    assertAgentActive(agentId);
    return null;
  } catch (err) {
    if (err instanceof AuthzError) return authzErrorResponse(err);
    throw err;
  }
}
