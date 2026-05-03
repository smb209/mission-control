import { NextRequest, NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { queryOne, queryAll, run } from '@/lib/db';
import { getOpenClawClient } from '@/lib/openclaw/client';
import { sendChatToAgent } from '@/lib/openclaw/send-chat';
import { broadcast } from '@/lib/events';
import { getProjectsPath, getMissionControlUrl } from '@/lib/config';
import { getTaskDeliverableDir } from '@/lib/deliverables/storage';
import { getRelevantKnowledge, formatKnowledgeForDispatch } from '@/lib/learner';
import { getTaskWorkflow } from '@/lib/workflow-engine';
import { syncGatewayAgentsToCatalog } from '@/lib/agent-catalog-sync';
import { pickDynamicAgent } from '@/lib/task-governance';
import { buildCheckpointContext, saveCheckpoint, getLatestCheckpoint } from '@/lib/checkpoint';
import { clearStallFlag } from '@/lib/stall-detection';
import { logDebugEvent } from '@/lib/debug-log';
import { formatMailForDispatch } from '@/lib/mailbox';
import { formatPendingRollcallsForDispatch } from '@/lib/rollcall';
import { getPendingNotesForDispatch } from '@/lib/task-notes';
import { createTaskWorkspace, resolveDispatchWorkspace } from '@/lib/workspace-isolation';
import { parsePlanningSpec } from '@/lib/planning-spec';
import {
  getPrescribedCommandsForRole,
  formatPrescribedCommandsSection,
  type RoleName,
} from '@/lib/gates/config';
import { formatRoleSoulSection } from '@/lib/agents/role-souls';
import { dispatchScope } from '@/lib/agents/dispatch-scope';
import {
  computeWorkerScopeSuffix,
  getRunnerAgent,
  isScopeKeyedDispatchEnabled,
  nextWorkerAttempt,
} from '@/lib/agents/runner';
import type { BriefingRole } from '@/lib/agents/briefing';
import { execSync } from 'child_process';
import { existsSync } from 'fs';
import type { Task, Agent, Product, OpenClawSession, WorkflowStage, TaskImage } from '@/lib/types';

/**
 * Map a per-role gateway agent (`mc-builder-dev`, etc.) onto the
 * scope-keyed-dispatch role label. Falls back to inspecting the
 * agent's `role` column when the gateway id doesn't match a known
 * role pattern.
 */
function resolveBriefingRole(agent: Agent): BriefingRole | null {
  const gw = (agent as Agent & { gateway_agent_id?: string | null }).gateway_agent_id ?? '';
  const baseId = gw.replace(/^mc-/, '').replace(/-dev$/, '');
  if (
    baseId === 'builder' ||
    baseId === 'tester' ||
    baseId === 'reviewer' ||
    baseId === 'researcher' ||
    baseId === 'writer' ||
    baseId === 'learner' ||
    baseId === 'coordinator'
  ) {
    return baseId;
  }
  if (baseId === 'project-manager') return 'pm';
  const role = (agent as Agent & { role?: string | null }).role ?? '';
  switch (role) {
    case 'builder':
    case 'tester':
    case 'reviewer':
    case 'researcher':
    case 'writer':
    case 'learner':
    case 'coordinator':
    case 'pm':
      return role;
    default:
      return null;
  }
}

export const dynamic = 'force-dynamic';
interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/tasks/[id]/dispatch
 * 
 * Dispatches a task to its assigned agent's OpenClaw session.
 * Creates session if needed, sends task details to agent.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;

    // Keep canonical agent catalog synced before every dispatch (best-effort)
    await syncGatewayAgentsToCatalog({ reason: 'dispatch' }).catch(err => {
      console.warn('[Dispatch] agent catalog sync failed:', err);
    });

    // Get task with agent info
    const task = queryOne<Task & { assigned_agent_name?: string; workspace_id: string }>(
      `SELECT t.*, a.name as assigned_agent_name, a.is_master
       FROM tasks t
       LEFT JOIN agents a ON t.assigned_agent_id = a.id
       WHERE t.id = ?`,
      [id]
    );

    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    let assignedAgentId = task.assigned_agent_id;
    if (!assignedAgentId) {
      const statusRoleMap: Record<string, string> = {
        assigned: 'builder',
        in_progress: 'builder',
        testing: 'tester',
        review: 'reviewer',
        verification: 'reviewer',
      };
      const dynamicAgent = pickDynamicAgent(id, statusRoleMap[task.status] || 'builder');
      if (dynamicAgent) {
        assignedAgentId = dynamicAgent.id;
        run('UPDATE tasks SET assigned_agent_id = ?, updated_at = datetime(\'now\') WHERE id = ?', [assignedAgentId, id]);
      }
    }

    if (!assignedAgentId) {
      return NextResponse.json(
        { error: 'Task has no routable agent' },
        { status: 400 }
      );
    }

    // Get agent details
    const agent = queryOne<Agent>(
      'SELECT * FROM agents WHERE id = ?',
      [assignedAgentId]
    );

    if (!agent) {
      return NextResponse.json({ error: 'Assigned agent not found' }, { status: 404 });
    }

    // Check if dispatching to the master agent while there are other orchestrators available
    if (agent.is_master) {
      // Check for other master agents in the same workspace (excluding this one)
      const otherOrchestrators = queryAll<{
        id: string;
        name: string;
        role: string;
      }>(
        `SELECT id, name, role
         FROM agents
         WHERE is_master = 1
         AND id != ?
         AND workspace_id = ?
         AND status != 'offline'`,
        [agent.id, task.workspace_id]
      );

      if (otherOrchestrators.length > 0) {
        return NextResponse.json({
          success: false,
          warning: 'Other orchestrators available',
          message: `There ${otherOrchestrators.length === 1 ? 'is' : 'are'} ${otherOrchestrators.length} other orchestrator${otherOrchestrators.length === 1 ? '' : 's'} available in this workspace: ${otherOrchestrators.map(o => o.name).join(', ')}. Consider assigning this task to them instead.`,
          otherOrchestrators,
        }, { status: 409 }); // 409 Conflict - indicating there's an alternative
      }
    }

    // Connect to OpenClaw Gateway
    const client = getOpenClawClient();
    if (!client.isConnected()) {
      try {
        await client.connect();
      } catch (err) {
        console.error('Failed to connect to OpenClaw Gateway:', err);
        client.forceReconnect();
        return NextResponse.json(
          { error: 'Failed to connect to OpenClaw Gateway' },
          { status: 503 }
        );
      }
    }

    // Resolve the workflow stage that owns this dispatch. Sessions are
    // keyed on (agent_id, task_id, stage) so the same agent landing in
    // two stages (e.g. via fallback routing) gets two distinct gateway
    // conversations rather than appending to a shared context. NULL =
    // no workflow stage (planner / coordinator / legacy paths) — the
    // lookup matches NULL-stage sessions for those callers.
    const dispatchWorkflow = getTaskWorkflow(id);
    const dispatchStage: string | null = dispatchWorkflow
      ? (dispatchWorkflow.stages.find(s => s.status === task.status)?.id ?? null)
      : null;

    // Get or create OpenClaw session for this agent + task + stage. The
    // NULL-aware predicate means a missing stage parameter only matches
    // a row that was also written with NULL stage — so workflow
    // dispatches and non-workflow dispatches don't cross-pollinate.
    let session = queryOne<OpenClawSession>(
      `SELECT * FROM openclaw_sessions
         WHERE agent_id = ? AND task_id = ? AND status = 'active'
           AND ((stage IS NULL AND ? IS NULL) OR stage = ?)`,
      [agent.id, id, dispatchStage, dispatchStage]
    );

    const now = new Date().toISOString();

    if (!session) {
      // Create session record. The session id encodes the stage so the
      // gateway-side conversation is observably distinct in debug logs
      // even before we look at the row.
      const sessionId = uuidv4();
      const stageSlug = dispatchStage ? `-${dispatchStage}` : '';
      const openclawSessionId = `mission-control-${agent.name.toLowerCase().replace(/\s+/g, '-')}-${id}${stageSlug}`;

      run(
        `INSERT INTO openclaw_sessions (id, agent_id, openclaw_session_id, task_id, stage, channel, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [sessionId, agent.id, openclawSessionId, id, dispatchStage, 'mission-control', 'active', now, now]
      );

      session = queryOne<OpenClawSession>(
        'SELECT * FROM openclaw_sessions WHERE id = ?',
        [sessionId]
      );

      // Log session creation
      run(
        `INSERT INTO events (id, type, agent_id, message, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        [uuidv4(), 'agent_status_changed', agent.id, `${agent.name} session created`, now]
      );

      logDebugEvent({
        type: 'session.create',
        direction: 'internal',
        taskId: id,
        agentId: agent.id,
        sessionKey: openclawSessionId,
        metadata: {
          agent_name: agent.name,
          reason: 'no_active_session_found',
        },
      });
    }

    if (!session) {
      return NextResponse.json(
        { error: 'Failed to create agent session' },
        { status: 500 }
      );
    }

    // Cost cap warning check
    let costCapWarning: string | undefined;
    if (task.product_id) {
      const product = queryOne<Product>('SELECT * FROM products WHERE id = ?', [task.product_id]);
      if (product?.cost_cap_monthly) {
        const monthStart = new Date();
        monthStart.setDate(1);
        monthStart.setHours(0, 0, 0, 0);
        const monthlySpend = queryOne<{ total: number }>(
          `SELECT COALESCE(SUM(cost_usd), 0) as total FROM cost_events
           WHERE product_id = ? AND created_at >= ?`,
          [task.product_id, monthStart.toISOString()]
        );
        if (monthlySpend && monthlySpend.total >= product.cost_cap_monthly) {
          costCapWarning = `Monthly cost cap reached: $${monthlySpend.total.toFixed(2)}/$${product.cost_cap_monthly.toFixed(2)}`;
          console.warn(`[Dispatch] ${costCapWarning} for product ${product.name}`);
        }
      }
    }

    // Build task message for agent
    const priorityEmoji = {
      low: '🔵',
      normal: '⚪',
      high: '🟡',
      urgent: '🔴'
    }[task.priority] || '⚪';

    // Get project path for working files — with workspace isolation if needed
    const projectsPath = getProjectsPath();
    const projectDir = task.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    let taskProjectDir = `${projectsPath}/${projectDir}`;
    const missionControlUrl = getMissionControlUrl();

    // Deliverables directory: MC-managed location the agent writes FINAL
    // deliverables into so they become web-downloadable. Separate from
    // taskProjectDir, which may be an isolated worktree the agent codes in.
    //
    // Slice 7 of the autonomous-flow tightening: pick the perspective from
    // `agent.runtime_kind`. A host-runtime agent gets `/Users/...`; a
    // container-runtime agent gets `/app/...`. The AlertDialog Tester wrote
    // a `/app/workspace/...` screenshot from a host runtime and got ENOENT
    // because the dispatch always passed 'host' regardless of where the
    // agent actually ran.
    const agentRuntime: 'host' | 'container' =
      (agent as Agent & { runtime_kind?: string }).runtime_kind === 'container'
        ? 'container'
        : 'host';
    const deliverablesDir = getTaskDeliverableDir(
      { id: task.id, title: task.title, created_at: task.created_at },
      agentRuntime,
    );

    // Create isolated workspace if parallel builds are possible.
    //
    // Slice 3 of the autonomous-flow tightening tightens this:
    //   1. Builder: hard-fail dispatch when the product is repo-backed
    //      (`determineIsolationStrategy` returned a strategy) but workspace
    //      creation throws. The previous behavior — warn-and-continue with
    //      the shared `${projectsPath}/${slug}` directory — is what put the
    //      AlertDialog Builder on `main` (see PR #117 spec post-mortem).
    //   2. Tester / Reviewer: read back the workspace the Builder created
    //      (persisted on `task.workspace_path` by createTaskWorkspace) so
    //      downstream stages exercise the SAME tree the build happened in,
    //      rather than the shared default path.
    //   3. Non-repo-backed products (no isolation strategy) keep the shared
    //      dir — the strict mode only triggers when isolation was supposed
    //      to be available.
    let workspaceIsolated = false;
    let workspaceBranchName: string | undefined;
    let workspacePort: number | undefined;
    const isBuilderDispatch = task.status === 'assigned' || task.status === 'in_progress' || task.status === 'inbox';
    const isTesterOrReviewerDispatch = task.status === 'testing' || task.status === 'review' || task.status === 'verification';
    const dispatchRole = isBuilderDispatch
      ? 'builder'
      : isTesterOrReviewerDispatch
        ? 'tester_or_reviewer'
        : 'other';

    const wsResolution = await resolveDispatchWorkspace(
      task as Task & { workspace_path?: string | null; workspace_port?: number | null },
      dispatchRole,
      { existsSync, createTaskWorkspace },
    );
    if (!wsResolution.ok) {
      console.error(
        `[Dispatch] ${wsResolution.code} for task ${task.id}: ${wsResolution.detail}`,
      );
      return NextResponse.json(
        { error: wsResolution.code, detail: wsResolution.detail },
        { status: wsResolution.http_status },
      );
    }
    taskProjectDir = wsResolution.path;
    workspaceIsolated = wsResolution.isolated;
    workspaceBranchName = wsResolution.branch;
    workspacePort = wsResolution.port;
    if (workspaceIsolated) {
      console.log(
        `[Dispatch] ${dispatchRole} ${wsResolution.reused ? 'reusing' : 'created'} workspace for ${task.id}: ${taskProjectDir}`,
      );
    }

    // Parse planning_spec and planning_agents if present (stored as JSON text on the task row)
    const rawTask = task as Task & { assigned_agent_name?: string; workspace_id: string; planning_spec?: string; planning_agents?: string };
    let planningSpecSection = '';
    let deliverablesChecklistSection = '';
    let successCriteriaChecklistSection = '';
    let agentInstructionsSection = '';

    // Normalize the planner's output so dispatch can build structured
    // checklists for the builder (deliverables) and tester (criteria),
    // regardless of whether the planner emitted the old string[] shape or
    // the new structured one.
    const normalizedSpec = parsePlanningSpec(rawTask.planning_spec);

    if (rawTask.planning_spec) {
      try {
        const spec = JSON.parse(rawTask.planning_spec);
        // follow_ups are persisted alongside the spec for operator triage but
        // must NOT bleed into the builder's brief — they describe work that
        // is intentionally out of scope for THIS task.
        if (spec && typeof spec === 'object' && !Array.isArray(spec)) {
          delete (spec as Record<string, unknown>).follow_ups;
        }
        // planning_spec may be an object with spec_markdown, or a raw string
        const specText = typeof spec === 'string' ? spec : (spec.spec_markdown || JSON.stringify(spec, null, 2));
        planningSpecSection = `\n---\n**📋 PLANNING SPECIFICATION:**\n${specText}\n`;
      } catch {
        // If not valid JSON, treat as plain text
        planningSpecSection = `\n---\n**📋 PLANNING SPECIFICATION:**\n${rawTask.planning_spec}\n`;
      }
    }

    if (normalizedSpec && normalizedSpec.deliverables.length > 0) {
      const lines = normalizedSpec.deliverables.map(d => {
        const pathPart = d.path_pattern ? ` → \`${d.path_pattern}\`` : '';
        return `- [ ] **\`${d.id}\`** (${d.kind})${pathPart}\n      - Title: ${d.title}\n      - Acceptance: ${d.acceptance}`;
      }).join('\n');
      deliverablesChecklistSection = `\n---\n**✅ DELIVERABLES CHECKLIST — every entry must be produced and registered by id:**\n${lines}\n`;
    }

    if (normalizedSpec && normalizedSpec.success_criteria.length > 0) {
      const lines = normalizedSpec.success_criteria.map(c =>
        `- [ ] **\`${c.id}\`**: ${c.assertion}\n      - How to test: ${c.how_to_test}`
      ).join('\n');
      successCriteriaChecklistSection = `\n---\n**🎯 SUCCESS CRITERIA — each must be verified as pass/fail:**\n${lines}\n`;
    }

    if (rawTask.planning_agents) {
      try {
        const agents = JSON.parse(rawTask.planning_agents);
        if (Array.isArray(agents)) {
          // Find instructions for this specific agent, or include all if none match
          const myInstructions = agents.find(
            (a: { agent_id?: string; name?: string; instructions?: string }) =>
              a.agent_id === agent.id || a.name === agent.name
          );
          if (myInstructions?.instructions) {
            agentInstructionsSection = `\n**🎯 YOUR INSTRUCTIONS:**\n${myInstructions.instructions}\n`;
          } else {
            // Include all agent instructions for context
            const allInstructions = agents
              .filter((a: { instructions?: string }) => a.instructions)
              .map((a: { name?: string; role?: string; instructions?: string }) =>
                `- **${a.name || a.role || 'Agent'}:** ${a.instructions}`
              )
              .join('\n');
            if (allInstructions) {
              agentInstructionsSection = `\n**🎯 AGENT INSTRUCTIONS:**\n${allInstructions}\n`;
            }
          }
        }
      } catch {
        // Ignore malformed planning_agents JSON
      }
    }

    // Inject relevant knowledge from the learner knowledge base — opt-in
    // per task (see tasks.include_knowledge, migration 041). The legacy
    // auto-injection had no relevance filter and pulled unrelated lessons
    // into every dispatch; agents that need a lesson can pull a targeted
    // one via the `request_knowledge` MCP tool instead.
    let knowledgeSection = '';
    if ((task as Task & { include_knowledge?: number }).include_knowledge) {
      try {
        const knowledge = getRelevantKnowledge(task.workspace_id, task.title);
        knowledgeSection = formatKnowledgeForDispatch(knowledge);
      } catch {
        // Knowledge injection is best-effort
      }
    }

    // Inject matched product skills (proven procedures from previous tasks)
    let skillsSection = '';
    if (task.product_id) {
      try {
        const { getMatchedSkills, formatSkillsForDispatch } = await import('@/lib/skills');
        const skills = getMatchedSkills(task.product_id, task.title, task.description || '', agent.name);
        skillsSection = formatSkillsForDispatch(skills);
      } catch {
        // Skills injection is best-effort
      }
    }

    // Determine role-specific instructions based on workflow template
    const workflow = getTaskWorkflow(id);
    let currentStage: WorkflowStage | undefined;
    let nextStage: WorkflowStage | undefined;
    if (workflow) {
      let stageIndex = workflow.stages.findIndex(s => s.status === task.status);
      // 'assigned' isn't a workflow stage — resolve to the 'build' stage (in_progress)
      if (stageIndex < 0 && (task.status === 'assigned' || task.status === 'inbox')) {
        stageIndex = workflow.stages.findIndex(s => s.role === 'builder');
      }
      if (stageIndex >= 0) {
        currentStage = workflow.stages[stageIndex];
        nextStage = workflow.stages[stageIndex + 1];
      }
    }

    // Role detection. Coordinator/orchestrator must be checked *before*
    // the builder fallback — `isBuilder` is true whenever `currentStage` is
    // unresolved, which was bucketing coordinator dispatches as "go build
    // something" and triggering the legacy sessions_spawn path.
    const isCoordinator =
      (agent as Agent & { role?: string }).role === 'coordinator' ||
      (agent as Agent & { role?: string }).role === 'orchestrator' ||
      Boolean(agent.is_master);
    const isBuilder = !isCoordinator && (!currentStage || currentStage.role === 'builder' || task.status === 'assigned');
    const isTester = !isCoordinator && currentStage?.role === 'tester';
    const isVerifier = !isCoordinator && (currentStage?.role === 'verifier' || currentStage?.role === 'reviewer');
    const nextStatus = nextStage?.status || 'review';
    const failEndpoint = `POST ${missionControlUrl}/api/tasks/${task.id}/fail`;

    // Prescribed verification commands (slice 2 of the autonomous-flow
    // tightening). The role's gate set comes from `.mc/gates.json` in the
    // workspace, falling back to package.json auto-discovery. Tester /
    // reviewer get the changed-files list interpolated into ${CHANGED_FILES}
    // placeholders; for builder we leave the placeholder literal because
    // there's no committed diff yet — they'll resolve it at evidence-
    // submission time against their current diff.
    let prescribedCommandsSection = '';
    let roleSoulSection = '';
    const role: RoleName | null = isBuilder
      ? 'builder'
      : isTester
        ? 'tester'
        : isVerifier
          ? 'reviewer'
          : null;
    if (role) {
      roleSoulSection = formatRoleSoulSection(role);
    }
    if (role && taskProjectDir) {
      let changedFiles: string[] = [];
      if ((isTester || isVerifier) && workspaceBranchName) {
        try {
          const baseBranch = (task as Task & { repo_branch?: string }).repo_branch || 'main';
          const out = execSync(
            `git diff --name-only ${baseBranch}...HEAD`,
            { cwd: taskProjectDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
          );
          changedFiles = out.split('\n').map((s) => s.trim()).filter(Boolean);
        } catch {
          // best-effort; gate config still emits commands without the placeholder filled
        }
      }
      try {
        const prescribed = getPrescribedCommandsForRole(taskProjectDir, role, { changedFiles });
        prescribedCommandsSection = formatPrescribedCommandsSection(prescribed, {
          agentId: agent.id,
          taskId: task.id,
        });
      } catch (err) {
        console.warn('[Dispatch] prescribed-command resolution failed:', (err as Error).message);
      }
    }

    // For coordinator dispatches, enumerate the persistent gateway-synced
    // agents so the coordinator can delegate via `sessions_send` rather than
    // spawning ephemeral subagents (which inherit a stripped context — no
    // SOUL.md / IDENTITY.md — and are therefore "confused" about their
    // role). We only list agents with a gateway_agent_id so local/test
    // agents don't leak into the coordinator's dispatch surface.
    let delegationRosterSection = '';
    if (isCoordinator) {
      const siblings = queryAll<{ id: string; name: string; role: string; gateway_agent_id: string }>(
        `SELECT id, name, role, gateway_agent_id
           FROM agents
          WHERE gateway_agent_id IS NOT NULL
            AND id != ?
            AND COALESCE(status, 'standby') != 'offline'
            AND COALESCE(is_active, 1) = 1
          ORDER BY role ASC, name ASC`,
        [agent.id]
      );
      if (siblings.length > 0) {
        const rosterLines = siblings
          .map(s => `- **${s.name}** (role: \`${s.role}\`, gateway id: \`${s.gateway_agent_id}\`)`)
          .join('\n');
        delegationRosterSection = `\n---
**👥 AVAILABLE PERSISTENT AGENTS — delegate here, do NOT spawn new ones:**
${rosterLines}

Each of these is a long-lived agent with its own pinned identity
(\`SOUL.md\`, \`AGENTS.md\`, \`USER.md\`). Route work to them so they keep
their persona, memory, and channel bindings.
`;
      }
    }

    // Call-home context for every gateway agent. Agents call MC via the
    // sc-mission-control MCP tools (one tool per route). The dispatch
    // message embeds the agent_id + task_id literally so agents can paste
    // them directly into tool-call argument objects without rereading
    // MC-CONTEXT.json. MC_MCP_ENABLED stays as a kill switch at the
    // /api/mcp endpoint — turning it off makes every tool call 503 and
    // the agent surfaces that to the operator.
    const gatewayIdForContext = (agent as { gateway_agent_id?: string | null }).gateway_agent_id || '';
    const mcContextPath = gatewayIdForContext
      ? `~/.openclaw/workspaces/${gatewayIdForContext}/MC-CONTEXT.json`
      : null;

    const callHomeSection = `\n---
**🔒 CALL-HOME: use the \`sc-mission-control\` MCP tools**

Every MC interaction goes through the \`sc-mission-control\` tool server. Preferred calls by action:

| When you want to... | Call tool |
|---|---|
| Learn your own \`agent_id\` + peers | \`whoami({ agent_id: … })\` |
| Register a deliverable | \`register_deliverable(...)\` |
| Log a progress / completion note | \`log_activity(...)\` |
| Move the task to the next stage | \`update_task_status(...)\` |
| Fail a stage (tester/reviewer) | \`fail_task(...)\` |
| Save a checkpoint | \`save_checkpoint(...)\` |
| Mail a peer | \`send_mail(...)\` (use \`list_peers\` to find ids) |
| Delegate a slice (coordinator) | \`delegate(...)\` — auto-logs the audit activity |

Every state-changing tool takes \`agent_id\` as the first argument. **Your \`agent_id\` is:** \`${agent.id}\`  \\
${gatewayIdForContext ? `Your \`gateway_id\` is: \`${gatewayIdForContext}\`  \\\n` : ''}Task id: \`${task.id}\`

${mcContextPath ? `Read \`${mcContextPath}\` (MC-CONTEXT.json) if you need to re-derive your \`agent_id\` — \`my_agent_id\` is the only field that file now carries.\n\n` : ''}**⚠️ Never read \`~/docker/mission-control/data/*.db\` or any other MC-internal file.** MC state is reachable only via these tools.

If a tool returns \`MCP endpoint is disabled\` (HTTP 503), the operator has the kill-switch \`MC_MCP_ENABLED=0\`. Surface the failure and wait — do not try to reconstruct curls.
`;

    // Capture non-null ids once — TS's flow analysis narrows `agent` and
    // `task` above but doesn't carry that narrowing into the closure below.
    const agentId = agent.id;
    const taskIdForMcp = task.id;
    // Build MCP-oriented completion instructions for pilot agents. These
    // preserve the role-specific *domain* guidance (checklists, pass/fail
    // criteria) but swap curl for tool calls. When MCP tools fail, the
    // agent can fall through to the existing curl scaffolding below —
    // that's the "defence in depth" during pilot.
    function buildCompletionInstructions(): string {
      const deliverableExampleIds =
        normalizedSpec && normalizedSpec.deliverables.length > 0
          ? normalizedSpec.deliverables.map((d) => `\`${d.id}\``).join(', ')
          : '(no structured spec — one deliverable call is enough)';

      if (isCoordinator) {
        return `**YOUR ROLE: COORDINATOR** — Delegate to peers using the \`spawn_subtask\` MCP tool. Every delegation must declare deliverables, acceptance criteria, duration, and cadence — no declarations, no spawn.

**First decide the shape of the flow.** The task workflow defaults to a single builder step — you are responsible for shaping anything richer. For each task, ask:
- Does a single builder slice cover this end-to-end, or does it split cleanly across roles (research → write, build → test, draft → review)?
- Does the output need an independent quality gate before it can be trusted (testing, review, fact-check, sign-off)?
- Is any slice high-risk or hard to undo, such that a second pair of eyes is worth the latency?

If the answer to all three is "no", spawn one builder subtask and accept it when delivered. If any is "yes", spawn the additional slices explicitly — typically a tester or reviewer subtask gated on the builder's deliverable. Skip ceremony when it isn't earned; add gates when the work needs them.

**Per peer, call once:**
\`\`\`
spawn_subtask({
  agent_id: "${agentId}",
  task_id: "${taskIdForMcp}",
  peer_gateway_id: "<mc-researcher | mc-writer | …>",
  slice: "<one-line summary of what this peer owns>",
  message: "You are the <role> for this task.\\n\\n<context + why this slice exists>",
  expected_deliverables: [ { title: "<name>", kind: "file" | "note" | "report" } ],
  acceptance_criteria: [ "<criterion 1>", "<criterion 2>" ],
  expected_duration_minutes: 30,
  checkin_interval_minutes: 15
})
\`\`\`

\`spawn_subtask\` creates a tracked convoy subtask with the SLO you declare, dispatches the peer through the normal pipeline, and returns a \`subtask_id\`. The peer sees your contract inline in its briefing.

**While peers are working, check on them:**
\`\`\`
list_my_subtasks({ agent_id: "${agentId}", task_id: "${taskIdForMcp}" })
\`\`\`
Each row has a \`state_derived\` (dispatched / in_progress / drifting / overdue / delivered / blocked / timed_out / accepted / rejected / cancelled).

**When a peer delivers** (state_derived = "delivered"):
\`\`\`
accept_subtask({ agent_id: "${agentId}", subtask_id: "<id>" })
# or if the work doesn't meet acceptance criteria:
reject_subtask({ agent_id: "${agentId}", subtask_id: "<id>", reason: "<specific>", new_acceptance_criteria: [ ... ] })
\`\`\`

**If a peer is stuck and the slice was wrong,** cancel and re-spawn with a better brief:
\`\`\`
cancel_subtask({ agent_id: "${agentId}", subtask_id: "<id>", reason: "<why>" })
spawn_subtask({ ... })   # fresh slice
\`\`\`

**When all subtasks are accepted:**
\`\`\`
register_deliverable({ agent_id: "${agentId}", task_id: "${taskIdForMcp}", deliverable_type: "file", title: "<title>", path: "${deliverablesDir}/<filename>" })
update_task_status({ agent_id: "${agentId}", task_id: "${taskIdForMcp}", status: "${nextStatus}" })
\`\`\`

Reply with \`TASK_COMPLETE: [one line per delegated subtask]\`.`;
      }

      if (isBuilder) {
        const hasStructuredSpec = Boolean(
          normalizedSpec && normalizedSpec.deliverables.length > 0,
        );
        const deliverablesStep = hasStructuredSpec
          ? `**Step 1 — produce every deliverable in the checklist.** For each spec id (${deliverableExampleIds}), call \`register_deliverable\` with its \`spec_deliverable_id\`:

\`\`\`
register_deliverable({ agent_id: "${agentId}", task_id: "${taskIdForMcp}", deliverable_type: "file", title: "<title>", path: "<path>", spec_deliverable_id: "<id>" })
\`\`\``
          : `**Step 1 — produce and register the deliverable(s).**

\`\`\`
register_deliverable({ agent_id: "${agentId}", task_id: "${taskIdForMcp}", deliverable_type: "file", title: "<title>", path: "${deliverablesDir}/<filename>" })
\`\`\``;

        return `**✅ DEFINITION OF DONE** — every deliverable registered, completion logged, status moved.

${deliverablesStep}

**Step 2 — log completion:**
\`\`\`
log_activity({ agent_id: "${agentId}", task_id: "${taskIdForMcp}", activity_type: "completed", message: "<what you built, one line>" })
\`\`\`

**Step 3 — transition the task:**
\`\`\`
update_task_status({ agent_id: "${agentId}", task_id: "${taskIdForMcp}", status: "${nextStatus}" })
\`\`\`

If \`update_task_status\` returns \`evidence_gate\` with \`missing_deliverable_ids\`, you didn't register enough — produce the missing ones and retry. Do NOT try to force the transition.

Reply with \`TASK_COMPLETE: [deliverables registered]\`.`;
      }

      if (isTester) {
        const hasCriteria = Boolean(
          normalizedSpec && normalizedSpec.success_criteria.length > 0,
        );
        return `**YOUR ROLE: TESTER** — Verify each success criterion.${
          hasCriteria
            ? `\n\n${normalizedSpec!.success_criteria.length} criteria to check. For each, run its \`how_to_test\` and record pass/fail.`
            : `\n\nNo structured criteria — review against the spec using your judgment.`
        }

**On PASS (all criteria):**
\`\`\`
log_activity({ agent_id: "${agentId}", task_id: "${taskIdForMcp}", activity_type: "completed", message: "All criteria passed: [<sc-1> ok; <sc-2> ok; …]" })
update_task_status({ agent_id: "${agentId}", task_id: "${taskIdForMcp}", status: "${nextStatus}" })
\`\`\`

**On FAIL (any criterion):**
\`\`\`
fail_task({ agent_id: "${agentId}", task_id: "${taskIdForMcp}", reason: "Failed criteria: <sc-id1>: <what you observed>; …" })
\`\`\`

Reply with \`TEST_PASS: [summary]\` or \`TEST_FAIL: [what failed by criterion id]\`.`;
      }

      if (isVerifier) {
        return `**YOUR ROLE: VERIFIER** — Verify the work meets quality standards.

**On PASS:**
\`\`\`
log_activity({ agent_id: "${agentId}", task_id: "${taskIdForMcp}", activity_type: "completed", message: "Verification passed: <summary; criteria verified: [<ids>]>" })
update_task_status({ agent_id: "${agentId}", task_id: "${taskIdForMcp}", status: "${nextStatus}" })
\`\`\`

**On FAIL:**
\`\`\`
fail_task({ agent_id: "${agentId}", task_id: "${taskIdForMcp}", reason: "Failed criteria: <sc-id1>: <what you observed>; …" })
\`\`\`

Reply with \`VERIFY_PASS: [summary]\` or \`VERIFY_FAIL: [what failed by criterion id]\`.`;
      }

      // Fallback for unknown roles
      return `**When your work is done:**
\`\`\`
update_task_status({ agent_id: "${agentId}", task_id: "${taskIdForMcp}", status: "${nextStatus}" })
\`\`\``;
    }

    // Every gateway agent gets the same MCP-oriented completion
    // instructions. When MC_MCP_ENABLED is off, the /api/mcp endpoint
    // returns 503 and tool calls surface that to the agent — which is the
    // kill switch. The curl scaffolding that lived here previously (PRs
    // 1-5 built the dispatch message with role-specific curl templates
    // agents pasted into shells) has been removed now that every agent
    // has ≥1 week of clean mcp.tool_call traffic. See the PR 6 cutover
    // note in ~/.claude/plans/can-you-make-that-async-eich.md.
    const completionInstructions = buildCompletionInstructions();

        // Build image references section
    let imagesSection = '';
    if (task.images) {
      try {
        const images: TaskImage[] = JSON.parse(task.images);
        if (images.length > 0) {
          const imageList = images
            .map(img => `- ${img.original_name}: ${missionControlUrl}/api/task-images/${task.id}/${img.filename}`)
            .join('\n');
          imagesSection = `\n**Reference Images:**\n${imageList}\n`;
        }
      } catch {
        // Ignore malformed images JSON
      }
    }

    // Build repo/PR section for builder agents when task has a repo
    let repoSection = '';
    if ((task as Task & { repo_url?: string }).repo_url && isBuilder) {
      const repoUrl = (task as Task & { repo_url?: string }).repo_url!;
      const repoBranch = (task as Task & { repo_branch?: string }).repo_branch || 'main';
      const branchName = `autopilot/${task.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 50)}`;

      repoSection = `
---
**\u{1F517} REPOSITORY:**
- **Repo:** ${repoUrl}
- **Base branch:** ${repoBranch}
- **Feature branch:** ${branchName}

**GIT WORKFLOW:**
1. First, verify you have git access: run \`git ls-remote ${repoUrl}\`
   - If this fails, report the error immediately via:
     PATCH ${missionControlUrl}/api/tasks/${task.id}
     Body: {"status_reason": "Git auth not configured: [error message]"}
     Then STOP — do not proceed without repo access.
2. Clone the repo (or use existing local copy)
3. Create branch \`${branchName}\` from \`${repoBranch}\`
4. Implement the feature
5. Commit with clear messages (reference task: ${task.id})
6. Push branch and create a Pull Request

**PR REQUIREMENTS:**
- Title: "\u{1F916} Autopilot: ${task.title}"
- Body must include:
  - What was built and why
  - Research backing (from the idea)
  - Technical approach taken
  - Any risks or trade-offs
  - Task ID: ${task.id}
- Target branch: ${repoBranch}
- After creating PR, report the PR URL:
  PATCH ${missionControlUrl}/api/tasks/${task.id}
  Body: {"pr_url": "<github PR url>", "pr_status": "open"}
`;
    }

    const roleLabel = currentStage?.label || 'Task';
    const headline = isCoordinator
      ? `COORDINATOR DISPATCH — ${task.title}`
      : isBuilder
        ? 'NEW TASK ASSIGNED'
        : `${roleLabel.toUpperCase()} STAGE — ${task.title}`;

    // Put the structured checklists up front when they exist — the builder
    // needs the deliverables list before wading through the spec prose, and
    // the tester needs the criteria list up front. Old-shape tasks (no
    // structured spec) render only the existing planningSpecSection below.
    const deliverablesLead = isBuilder ? deliverablesChecklistSection : '';
    const criteriaLead = (isTester || isVerifier) ? successCriteriaChecklistSection : '';

    // Delegation Contract — shown to agent-spawned subtask peers so they
    // see their obligation inline (SLO, acceptance criteria, deliverables,
    // escape hatch). Operator-created convoy subtasks have NULL SLO
    // fields and skip this section.
    let delegationContractSection = '';
    if ((task as Task & { is_subtask?: number }).is_subtask) {
      const contract = queryOne<{
        id: string;
        slice: string | null;
        expected_deliverables: string | null;
        acceptance_criteria: string | null;
        expected_duration_minutes: number | null;
        checkin_interval_minutes: number | null;
        due_at: string | null;
        coordinator_name: string | null;
      }>(
        `SELECT cs.id, cs.slice, cs.expected_deliverables, cs.acceptance_criteria,
                cs.expected_duration_minutes, cs.checkin_interval_minutes, cs.due_at,
                ca.name as coordinator_name
           FROM convoy_subtasks cs
           JOIN convoys c ON c.id = cs.convoy_id
           JOIN tasks p ON p.id = c.parent_task_id
           LEFT JOIN agents ca ON ca.id = p.assigned_agent_id
          WHERE cs.task_id = ?`,
        [task.id],
      );
      if (contract && contract.expected_duration_minutes != null) {
        const parseJson = <T,>(s: string | null): T[] => { if (!s) return []; try { return JSON.parse(s) as T[]; } catch { return []; } };
        const delivs = parseJson<{ title: string; kind: string }>(contract.expected_deliverables);
        const criteria = parseJson<string>(contract.acceptance_criteria);
        delegationContractSection = `
---
**\u{1F91D} DELEGATION CONTRACT**

You were delegated this work by coordinator ${contract.coordinator_name ?? '(unknown)'}. The contract is:

- **Slice:** ${contract.slice ?? '(unset)'}
- **Expected deliverables** (register every one via \`register_deliverable\`):
${delivs.length > 0 ? delivs.map(d => `  - ${d.title} (${d.kind})`).join('\n') : '  - (none declared)'}
- **Acceptance criteria** (all must hold for accept_subtask):
${criteria.length > 0 ? criteria.map(c => `  - ${c}`).join('\n') : '  - (none declared)'}
- **Expected duration:** ${contract.expected_duration_minutes} minutes (due at ${contract.due_at ?? 'unset'})
- **Check-in cadence:** call \`log_activity\` at least every ${contract.checkin_interval_minutes ?? 15} minutes with a substantive note. Silence past 2\u00D7 cadence = drift alert to coordinator.
- **Your \`subtask_id\`:** \`${contract.id}\` — referenced automatically by register_deliverable and fail_task.

**If the slice is wrong:** do not sub-delegate, do not improvise. Call \`fail_task\` with \`reason: "redecompose: <specific ask>"\`, optionally mail the coordinator with suggestions, and stop. The coordinator will re-plan.
`;
      }
    }

    // Workspace conventions block — markdown the operator wrote on the
    // workspace settings page (workspaces.context_md), prepended to
    // every dispatch so the agent has rules-of-the-road grounding it
    // can't get from the task row alone (repo URLs, testing patterns,
    // git/PR rules, package manager, etc). v0 of org-scope memory
    // grounding (precursor to the memory-layer epic). Empty / null →
    // no block at all so we don't render an empty placeholder.
    let workspaceConventionsSection = '';
    try {
      const wsRow = queryOne<{ context_md: string | null }>(
        `SELECT context_md FROM workspaces WHERE id = ?`,
        [task.workspace_id],
      );
      const ctx = wsRow?.context_md;
      if (typeof ctx === 'string' && ctx.trim().length > 0) {
        workspaceConventionsSection =
          `## Workspace conventions\n\n${ctx.trim()}\n\n---\n\n`;
      }
    } catch (err) {
      console.warn('[Dispatch] workspace context lookup failed:', (err as Error).message);
    }

    const taskMessage = `${workspaceConventionsSection}${priorityEmoji} **${headline}**

**Title:** ${task.title}
${task.description ? `**Description:** ${task.description}\n` : ''}
**Priority:** ${task.priority.toUpperCase()}
${task.due_date ? `**Due:** ${task.due_date}\n` : ''}
**Task ID:** ${task.id}
${callHomeSection}${delegationContractSection}${roleSoulSection}${deliverablesLead}${criteriaLead}${planningSpecSection}${agentInstructionsSection}${skillsSection}${knowledgeSection}${imagesSection}${buildCheckpointContext(task.id) || ''}${formatMailForDispatch(agent.id) || ''}${formatPendingRollcallsForDispatch(agent.id)}${repoSection}${delegationRosterSection}${prescribedCommandsSection}
${isCoordinator
  ? `**DELIVERABLES DIR:** ${deliverablesDir}\nAggregated deliverables registered via the deliverables endpoint should be written to this directory so they become web-downloadable.\n`
  : workspaceIsolated
    ? `**\u{1F512} ISOLATED WORKSPACE:** ${taskProjectDir}\n- **Port:** ${workspacePort || 'default'} (use this for dev server, NOT the default)\n${workspaceBranchName ? `- **Branch:** ${workspaceBranchName}\n` : ''}- **IMPORTANT:** Do NOT modify files outside this workspace directory. ${isBuilder ? 'Other agents may be working on the same project in parallel.' : 'This is the same tree the Builder produced — exercise the change here, do NOT cd into the shared project root.'} All your work must stay within: ${taskProjectDir}\n**DELIVERABLES DIR (separate):** ${deliverablesDir}\nCreate ${deliverablesDir} and save final deliverables there so they become web-downloadable from Mission Control.\n`
    : `**OUTPUT DIRECTORY:** ${taskProjectDir}\n**DELIVERABLES DIR:** ${deliverablesDir}\n${isBuilder ? 'Create' : 'Final deliverables should be saved to'} ${deliverablesDir}${isBuilder ? ' and save final deliverables there so they become web-downloadable from Mission Control.' : ' so they become web-downloadable.'}\n`}
${completionInstructions}

If you need help or clarification, ask the orchestrator.`;

    // Inject any pending operator notes (queued via /btw chat)
    const { formatted: pendingNotes } = getPendingNotesForDispatch(id);
    const finalMessage = pendingNotes ? taskMessage + pendingNotes : taskMessage;

    // Send message to agent's session using chat.send.
    // sessionKey resolution lives in `buildAgentSessionKey` (called by
    // `sendChatToAgent`):
    //   1. Explicit `agent.session_key_prefix` if set
    //   2. `agent:<gateway_agent_id>:` for gateway-synced agents
    //   3. `agent:<name-slug>:` as last resort
    // The old hard-coded `agent:main:` catchall silently misrouted
    // every MC→agent chat.send to the gateway's "main" agent.
    try {
      const idempotencyKey = `dispatch-${task.id}-${Date.now()}`;
      const chatSendStart = Date.now();

      // Phase C scope-keyed dispatch path. Gated by
      // MC_USE_SCOPE_KEYED_DISPATCH=1. When enabled, the chat.send
      // routes through the org-wide mc-runner-dev agent with a
      // briefing composed by buildBriefing(). The legacy per-role
      // agent stays as the task's `assigned_agent_id` for the
      // operator UI (and remains the fallback when the runner is
      // missing).
      const useScopeKeyed = isScopeKeyedDispatchEnabled();
      const runner = useScopeKeyed ? getRunnerAgent() : null;
      const briefingRole = runner ? resolveBriefingRole(agent) : null;

      let sendResult: Awaited<ReturnType<typeof sendChatToAgent>>;

      if (useScopeKeyed && runner && briefingRole) {
        // Scope-keyed branch: the runner receives the briefing; the
        // briefing carries the role-soul + identity preamble carrying
        // the runner's UUID + a notetaker addendum + the legacy
        // task message as the trigger body. Workers retry-attempt
        // strategy is `fresh`: each retry mints a new attempt
        // segment so the trajectory starts clean.
        const attempt = nextWorkerAttempt(task.id, briefingRole);
        const sessionSuffix = computeWorkerScopeSuffix({
          workspace_id: task.workspace_id ?? '',
          task_id: task.id,
          role: briefingRole,
          attempt,
        });
        const dispatchResult = await dispatchScope({
          workspace_id: task.workspace_id ?? '',
          role: briefingRole,
          agent: runner,
          session_suffix: sessionSuffix,
          trigger_body: finalMessage,
          scope_type: 'task_role',
          task_id: task.id,
          attempt_strategy: 'fresh',
          idempotencyKey,
          dry_run: true,
        });
        // dispatchScope dry-runs the briefing assembly + mc_sessions
        // upsert; the actual chat.send still goes through
        // sendChatToAgent for the existing logging / error-path
        // behavior (logDebugEvent, sendResult shape, etc.).
        sendResult = await sendChatToAgent({
          agent: runner,
          message: dispatchResult.briefing,
          idempotencyKey,
          sessionSuffix,
        });
      } else {
        // Legacy path (default until MC_USE_SCOPE_KEYED_DISPATCH=1).
        sendResult = await sendChatToAgent({
          agent,
          message: finalMessage,
          idempotencyKey,
          sessionSuffix: session.openclaw_session_id,
        });
      }
      const sessionKey = sendResult.sessionKey;
      // Debug console capture. No-op unless collection is enabled. Stores
      // the full dispatch payload so operators can see exactly what the
      // agent was asked to do — including injected knowledge, checkpoint
      // context, and planning spec.
      logDebugEvent({
        type: 'chat.send',
        direction: 'outbound',
        taskId: task.id,
        agentId: agent.id,
        sessionKey,
        durationMs: Date.now() - chatSendStart,
        requestBody: { sessionKey, message: finalMessage, idempotencyKey },
        responseBody: sendResult.sent ? sendResult.response : undefined,
        error: sendResult.sent ? null : (sendResult.error?.message ?? sendResult.reason ?? 'send_failed'),
        metadata: {
          agent_name: agent.name,
          agent_role: (agent as { role?: string }).role ?? null,
          message_length: finalMessage.length,
          task_status: task.status,
        },
      });
      if (!sendResult.sent) {
        // Preserve existing error-path behavior — the outer catch
        // updates task status, force-reconnects the client, and
        // returns 503.
        throw sendResult.error ?? new Error(sendResult.reason ?? 'chat.send failed');
      }

      // Only move to in_progress for builder dispatch (task is in 'assigned' status)
      // For tester/reviewer/verifier, the task status is already correct
      if (task.status === 'assigned') {
        run(
          'UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?',
          ['in_progress', now, id]
        );
      }

      // Broadcast task update
      const updatedTask = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [id]);
      if (updatedTask) {
        broadcast({
          type: 'task_updated',
          payload: updatedTask,
        });
      }

      // Update agent status to working
      run(
        'UPDATE agents SET status = ?, updated_at = ? WHERE id = ?',
        ['working', now, agent.id]
      );

      // Log dispatch event to events table
      const eventId = uuidv4();
      run(
        `INSERT INTO events (id, type, agent_id, task_id, message, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [eventId, 'task_dispatched', agent.id, task.id, `Task "${task.title}" dispatched to ${agent.name}`, now]
      );

      // Log dispatch activity to task_activities table (for Activity tab)
      const activityId = crypto.randomUUID();
      run(
        `INSERT INTO task_activities (id, task_id, agent_id, activity_type, message, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [activityId, task.id, agent.id, 'status_changed', `Task dispatched to ${agent.name} - Agent is now working on this task`, now]
      );

      // A successful dispatch is the canonical "coordinator (or operator)
      // has acted" signal. Clear any stalled_* status_reason so the
      // scanner doesn't re-flag the task on its next pass.
      clearStallFlag(task.id);

      // Auto-checkpoint on dispatch. Throttled to 60s so rapid re-dispatch
      // during nudge/recovery doesn't write duplicate rows. Gives
      // checkpoint/restore a viable starting point even before the agent
      // writes any of its own checkpoints — previously the restore route
      // returned 404 for long-running tasks because nothing ever called
      // saveCheckpoint().
      try {
        const latestCheckpoint = getLatestCheckpoint(task.id);
        const recent = latestCheckpoint
          && (Date.now() - new Date(latestCheckpoint.created_at).getTime()) / 1000 < 60;
        if (!recent) {
          saveCheckpoint({
            taskId: task.id,
            agentId: agent.id,
            checkpointType: 'auto',
            stateSummary: `Dispatched to ${agent.name} (status=${task.status}, role=${currentStage?.role || 'unknown'})`,
            contextData: {
              stage: currentStage?.label,
              dispatch_message_length: finalMessage.length,
            },
          });
        }
      } catch (err) {
        console.warn('[Dispatch] saveCheckpoint failed:', err);
      }

      return NextResponse.json({
        success: true,
        task_id: task.id,
        agent_id: agent.id,
        session_id: session.openclaw_session_id,
        message: 'Task dispatched to agent',
        ...(costCapWarning ? { cost_cap_warning: costCapWarning } : {}),
      });
    } catch (err) {
      console.error('Failed to send message to agent:', err);
      // Force-reconnect so the next dispatch attempt gets a fresh WebSocket
      const client2 = getOpenClawClient();
      client2.forceReconnect();
      // Reset task to 'assigned' so dispatch can be retried
      run(
        `UPDATE tasks SET status = 'assigned', planning_dispatch_error = ?, updated_at = datetime('now') WHERE id = ? AND status != 'done'`,
        [`Dispatch delivery failed: ${(err as Error).message}`, id]
      );
      const failedTask = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [id]);
      if (failedTask) {
        broadcast({ type: 'task_updated', payload: failedTask });
      }
      return NextResponse.json(
        { error: `Failed to deliver task to agent: ${(err as Error).message}` },
        { status: 503 }
      );
    }
  } catch (error) {
    console.error('Failed to dispatch task:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
