/**
 * GET /api/admin/environment
 *
 * Read-only snapshot of the resolved server environment for the
 * settings page's diagnostic block. Mission Control's gateway URL,
 * deliverables paths, and feature flags are all set via env vars and
 * can't be tweaked at runtime — the operator can at least see what
 * the running server thinks they are.
 *
 * Sensitive values (gateway tokens, MC API token, webhook secret) are
 * NOT returned; only their presence is reported.
 */

import { NextResponse } from 'next/server';
import { getDefaultWorkspaceRoot } from '@/lib/config';

export const dynamic = 'force-dynamic';

export async function GET() {
  const env = process.env;
  return NextResponse.json({
    mission_control_url: env.MISSION_CONTROL_URL ?? null,
    openclaw_gateway_url: env.OPENCLAW_GATEWAY_URL ?? null,
    deliverables_host_path: env.MC_DELIVERABLES_HOST_PATH ?? null,
    deliverables_container_path: env.MC_DELIVERABLES_CONTAINER_PATH ?? null,
    projects_path_env: env.PROJECTS_PATH ?? null,
    workspace_base_path_env: env.WORKSPACE_BASE_PATH ?? null,
    resolved_default_workspace_root: getDefaultWorkspaceRoot(),
    litellm_url: env.LITELLM_URL ?? null,
    allow_dynamic_agents: env.ALLOW_DYNAMIC_AGENTS === 'true',
    planning_timeout_ms: env.PLANNING_TIMEOUT_MS ?? null,
    secrets_present: {
      openclaw_gateway_token: !!env.OPENCLAW_GATEWAY_TOKEN,
      mc_api_token: !!env.MC_API_TOKEN,
      webhook_secret: !!env.WEBHOOK_SECRET,
      litellm_api_key: !!env.LITELLM_API_KEY,
    },
  });
}
