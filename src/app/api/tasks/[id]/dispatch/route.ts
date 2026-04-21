import { NextRequest, NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { queryOne, queryAll, run } from '@/lib/db';
import { getOpenClawClient } from '@/lib/openclaw/client';
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
import { getPendingNotesForDispatch } from '@/lib/task-notes';
import { createTaskWorkspace, determineIsolationStrategy } from '@/lib/workspace-isolation';
import { parsePlanningSpec } from '@/lib/planning-spec';
import type { Task, Agent, Product, OpenClawSession, WorkflowStage, TaskImage } from '@/lib/types';

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

    // Get or create OpenClaw session for this agent + task combination
    let session = queryOne<OpenClawSession>(
      'SELECT * FROM openclaw_sessions WHERE agent_id = ? AND task_id = ? AND status = ?',
      [agent.id, id, 'active']
    );

    const now = new Date().toISOString();

    if (!session) {
      // Create session record
      const sessionId = uuidv4();
      const openclawSessionId = `mission-control-${agent.name.toLowerCase().replace(/\s+/g, '-')}-${id}`;

      run(
        `INSERT INTO openclaw_sessions (id, agent_id, openclaw_session_id, task_id, channel, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [sessionId, agent.id, openclawSessionId, id, 'mission-control', 'active', now, now]
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
    const deliverablesDir = getTaskDeliverableDir(
      { id: task.id, title: task.title, created_at: task.created_at },
      'host'
    );

    // Create isolated workspace if parallel builds are possible
    // Only for builder dispatches (assigned/in_progress), not tester/reviewer
    let workspaceIsolated = false;
    let workspaceBranchName: string | undefined;
    let workspacePort: number | undefined;
    const isolationStrategy = determineIsolationStrategy(task as Task);
    const isBuilderDispatch = task.status === 'assigned' || task.status === 'in_progress' || task.status === 'inbox';
    if (isolationStrategy && isBuilderDispatch) {
      try {
        const workspace = await createTaskWorkspace(task as Task);
        taskProjectDir = workspace.path;
        workspaceIsolated = true;
        workspaceBranchName = workspace.branch;
        workspacePort = workspace.port;
        console.log(`[Dispatch] Created ${workspace.strategy} workspace for task ${task.id}: ${workspace.path}`);
      } catch (err) {
        console.warn(`[Dispatch] Workspace isolation failed, using default path:`, (err as Error).message);
      }
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

    // Inject relevant knowledge from the learner knowledge base
    let knowledgeSection = '';
    try {
      const knowledge = getRelevantKnowledge(task.workspace_id, task.title);
      knowledgeSection = formatKnowledgeForDispatch(knowledge);
    } catch {
      // Knowledge injection is best-effort
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

    // Every /api/tasks/* and /api/agents/* callback requires the MC bearer
    // token when MC_API_TOKEN is set. Gateway agents read their token from
    // MC-CONTEXT.json (see src/lib/openclaw/worker-context.ts) rather than
    // having it embedded inline in the dispatch message — that keeps the
    // secret out of chat archives / replay logs and gives agents a durable
    // on-disk recovery path if the dispatch message scrolls out of context.
    // Non-gateway ad-hoc agents fall back to the old embedded-token form
    // since they have no workspace directory to read from.
    const mcAuthToken = process.env.MC_API_TOKEN || '';
    const gatewayIdForContext = (agent as { gateway_agent_id?: string | null }).gateway_agent_id || '';
    const mcContextPath = gatewayIdForContext
      ? `~/.openclaw/workspaces/${gatewayIdForContext}/MC-CONTEXT.json`
      : null;
    const authHeaderLine = mcContextPath
      ? `  -H "Authorization: Bearer $(jq -r .mc_token ${mcContextPath})" \\\n`
      : mcAuthToken
        ? `  -H "Authorization: Bearer ${mcAuthToken}" \\\n`
        : '';

    // Banner appended near the top of the dispatch message so agents always
    // see (a) where their call-home credentials live and (b) the hard rule
    // that MC's database is off-limits. Only shown for gateway agents (the
    // only ones with workspaces on disk to read from).
    const callHomeSection = mcContextPath
      ? `\n---
**🔒 CALL-HOME CONTEXT** — your MC identity + bearer token live on disk at:
  \`${mcContextPath}\`

Every \`curl\` below pulls the token via \`jq\` substitution. The file also holds \`mc_url\`, \`my_agent_id\`, and a \`peer_agent_ids\` map. Read it with \`cat\` if you need any of those values — do not embed them from the dispatch message (they rotate).

**⚠️ Never read \`~/docker/mission-control/data/mission-control.db\` or any other MC-internal file.** Mission Control's state is ONLY reachable via the HTTP endpoints below. Agents that query the DB directly get stale data and bypass every evidence gate. If you need a value you can't find, mail the Coordinator via the mailbox endpoint.
`
      : '';

    let completionInstructions: string;
    if (isCoordinator) {
      // This prompt is the response to a specific failure mode observed on
      // task cc3d40e1 (2026-04-20): the Coordinator posted one umbrella
      // "Delegated parallel research+write+review to 3 agents" activity
      // *without* ever invoking the sessions_send tool. Gateway logs showed
      // zero outbound peer messages. The Coordinator then went idle waiting
      // for callbacks that could never happen.
      //
      // Defense in depth below:
      //   (a) Ordering: sessions_send BEFORE the activity, not after.
      //   (b) One activity per sessions_send call, each tagged with a parseable
      //       marker that includes the tool_call_id the gateway returned.
      //   (c) Explicit ban on umbrella "I delegated to N agents" claims.
      //   (d) Server-side audit (see auditCoordinatorDelegations in
      //       src/lib/coordinator-audit.ts) flags tasks where claimed
      //       delegations > 0 but zero peer callbacks arrived.
      completionInstructions = `**YOUR ROLE: COORDINATOR** — Delegate to the persistent agents above via the gateway. Mission Control cannot see tool invocations on the gateway side, so YOU are responsible for emitting structured proof of each delegation after it fires.

**DELEGATION PROTOCOL — strict ordering:**

For each peer agent you want to delegate work to:

1. **Invoke \`sessions_send\` FIRST.** Do NOT announce the delegation before the tool call returns. Capture the tool-call result id the gateway returns.
   - \`sessionKey\`: construct a FRESH per-task session key as \`agent:<peer_gateway_id>:task-${task.id}\` — substitute the peer's gateway id from the list above (e.g. \`agent:mc-researcher:task-${task.id}\`). The gateway creates the session implicitly on first send.
   - **Do NOT target the peer's \`:main\` session.** Shared \`:main\` sessions carry context from prior tasks, collide when multiple tasks run in parallel, and appear to get aborted more aggressively by the gateway's run lifecycle (see the task cc3d40e1 post-mortem: every peer delegation landed on \`:main\` and was aborted before responding). Per-task session keys give each delegation an isolated lane.
   - \`message\`: include the task id (\`${task.id}\`), the specific slice of work, any context, and prefix it with "You are the <role> for this task".
   - \`timeoutSeconds\`: \`0\` for fire-and-forget parallel work.

2. **IMMEDIATELY AFTER the tool call returns successfully, POST ONE activity** logging that specific delegation. Each activity message MUST start with the \`[DELEGATION]\` marker in the exact format below. Mission Control audits these — messages that don't match the format are treated as unverified:

\`\`\`bash
curl -sS -X POST "${missionControlUrl}/api/tasks/${task.id}/activities" \\
  -H "Content-Type: application/json" \\
${authHeaderLine}  -d '{"activity_type":"updated","message":"[DELEGATION] target=\\"<agent name>\\" gateway_id=\\"<gateway_agent_id>\\" tool_call_id=\\"<id returned by sessions_send>\\" slice=\\"<one-line summary of what you asked them to do>\\""}'
\`\`\`

**ONE activity per sessions_send call.** Do NOT bundle multiple delegations into a single activity. Do NOT post an umbrella "Delegated work to 3 agents" activity — it will be rejected by the audit and the stall detector will flag the task as suspected hallucinated delegation.

**DO NOT use \`sessions_spawn\`.** Spawned subagents inherit a stripped context and won't know their role.

**If \`sessions_send\` is rejected** with an allow-list error (*"Session send visibility is restricted"*), the OpenClaw allow-list on this coordinator needs \`tools.sessions.visibility: "all"\`. Surface the blocker immediately — do not post a \`[DELEGATION]\` activity since no delegation actually happened:

\`\`\`bash
curl -sS -X POST "${missionControlUrl}/api/tasks/${task.id}/fail" \\
  -H "Content-Type: application/json" \\
${authHeaderLine}  -d '{"reason":"sessions_send blocked by allow-list: <error text>"}'
\`\`\`

**AGGREGATION & COMPLETION** (after every peer has reported back):

\`\`\`bash
# Register the aggregated deliverable. Save it to the DELIVERABLES DIR below.
curl -sS -X POST "${missionControlUrl}/api/tasks/${task.id}/deliverables" \\
  -H "Content-Type: application/json" \\
${authHeaderLine}  -d '{"deliverable_type":"file","title":"<title>","path":"${deliverablesDir}/<filename>"}'

# Transition the task.
curl -sS -X PATCH "${missionControlUrl}/api/tasks/${task.id}" \\
  -H "Content-Type: application/json" \\
${authHeaderLine}  -d '{"status":"${nextStatus}"}'
\`\`\`

When complete, reply with:
\`TASK_COMPLETE: [one line per delegated agent with tool_call_id + outcome]\``;
    } else if (isBuilder) {
      // Build the builder's completion block. When a structured spec exists,
      // require one deliverable POST per spec id (the evidence gate enforces
      // this server-side) and instruct an explicit self-check before the
      // status transition. When no spec exists, fall back to the legacy
      // single-deliverable flow so ad-hoc tasks still work.
      const hasStructuredSpec = Boolean(normalizedSpec && normalizedSpec.deliverables.length > 0);

      if (hasStructuredSpec && normalizedSpec) {
        const exampleId = normalizedSpec.deliverables[0].id;
        const examplePath = normalizedSpec.deliverables[0].path_pattern || `${deliverablesDir}/<filename>`;
        const fileIds = normalizedSpec.deliverables.filter(d => d.kind === 'file').map(d => d.id);
        const allIds = normalizedSpec.deliverables.map(d => d.id);
        const fileCheckHint = fileIds.length > 0
          ? `For each \`kind: "file"\` deliverable above (${fileIds.map(id => `\`${id}\``).join(', ')}), \`ls -la\` the \`path_pattern\` under ${deliverablesDir}. If any file is missing, FIX IT before transitioning — the evidence gate will reject the status PATCH otherwise.`
          : 'No file-kind deliverables — verify behavior deliverables by manually reproducing each acceptance statement.';

        completionInstructions = `**✅ DEFINITION OF DONE** — you cannot transition this task until EVERY entry in the checklist above is registered.

**Step 1 — produce every deliverable in the checklist.** Do not ship a skeleton referencing files that don't exist. If the checklist lists \`styles.css\` and \`app.js\` as separate entries, they must each exist as separate files under the deliverables dir with real content.

**Step 2 — self-check before transitioning:**
${fileCheckHint}

If your output includes an HTML entry point, grep it for every \`href=\`/\`src=\` reference and confirm each target file actually exists. A page that references a missing \`app.js\` is not shippable.

**Step 3 — register one deliverable per spec id** (the Authorization header is required on every call):

\`\`\`bash
# Repeat this POST for each deliverables[] entry in the checklist, using the matching spec_deliverable_id.
curl -sS -X POST "${missionControlUrl}/api/tasks/${task.id}/deliverables" \\
  -H "Content-Type: application/json" \\
${authHeaderLine}  -d '{"deliverable_type":"file","title":"<human name>","path":"${examplePath}","spec_deliverable_id":"${exampleId}"}'
\`\`\`

Expected spec_deliverable_id values: ${allIds.map(id => `\`${id}\``).join(', ')}

**Step 4 — log a completion activity:**

\`\`\`bash
curl -sS -X POST "${missionControlUrl}/api/tasks/${task.id}/activities" \\
  -H "Content-Type: application/json" \\
${authHeaderLine}  -d '{"activity_type":"completed","message":"<what you built — one line>"}'
\`\`\`

**Step 5 — transition status.** If this returns HTTP 400 with "missing: <ids>", you're missing deliverables. Produce them and retry — do NOT try to force the transition.

\`\`\`bash
curl -sS -X PATCH "${missionControlUrl}/api/tasks/${task.id}" \\
  -H "Content-Type: application/json" \\
${authHeaderLine}  -d '{"status":"${nextStatus}"}'
\`\`\`

When complete, reply with:
\`TASK_COMPLETE: [brief summary — which deliverables you registered]\``;
      } else {
        // Legacy / unplanned task path — evidence gate only enforces the
        // baseline bar (1 deliverable + 1 activity).
        completionInstructions = `**IMPORTANT:** After completing work, you MUST make these three calls in order — all require the Authorization header:

\`\`\`bash
# 1. Register deliverable
# Save the file to the **DELIVERABLES DIR** below so it becomes web-downloadable.
curl -sS -X POST "${missionControlUrl}/api/tasks/${task.id}/deliverables" \\
  -H "Content-Type: application/json" \\
${authHeaderLine}  -d '{"deliverable_type":"file","title":"<file name>","path":"${deliverablesDir}/<filename>"}'

# 2. Log activity (must have both a deliverable AND an activity before step 3 will pass the evidence gate)
curl -sS -X POST "${missionControlUrl}/api/tasks/${task.id}/activities" \\
  -H "Content-Type: application/json" \\
${authHeaderLine}  -d '{"activity_type":"completed","message":"<what you built in one line>"}'

# 3. Transition status
curl -sS -X PATCH "${missionControlUrl}/api/tasks/${task.id}" \\
  -H "Content-Type: application/json" \\
${authHeaderLine}  -d '{"status":"${nextStatus}"}'
\`\`\`

When complete, reply with:
\`TASK_COMPLETE: [brief summary of what you did]\``;
      }
    } else if (isTester) {
      // Testers get the success_criteria list as a pass/fail checklist — this
      // is the difference between "I glanced at the deliverable" and "I
      // actually verified each assertion".
      const hasCriteria = Boolean(normalizedSpec && normalizedSpec.success_criteria.length > 0);
      const criteriaGuidance = hasCriteria && normalizedSpec
        ? `\n**Your job: verify each success criterion in the checklist above.** For each one:
1. Run the \`how_to_test\` step.
2. Record the result (pass or fail) with the criterion's id.

Do NOT pass the stage unless every criterion passes. "Looks good to me" is not verification.

**When you pass all criteria:**
\`\`\`bash
curl -sS -X POST "${missionControlUrl}/api/tasks/${task.id}/activities" \\
  -H "Content-Type: application/json" \\
${authHeaderLine}  -d '{"activity_type":"completed","message":"All ${normalizedSpec.success_criteria.length} success criteria passed: [<sc-1> ok; <sc-2> ok; ...]"}'

curl -sS -X PATCH "${missionControlUrl}/api/tasks/${task.id}" \\
  -H "Content-Type: application/json" \\
${authHeaderLine}  -d '{"status":"${nextStatus}"}'
\`\`\`

**When any criterion fails** — name the failing ids explicitly so the builder knows what to fix:
\`\`\`bash
curl -sS -X POST "${missionControlUrl}/api/tasks/${task.id}/fail" \\
  -H "Content-Type: application/json" \\
${authHeaderLine}  -d '{"reason":"Failed criteria: <sc-id1>: <what you observed>; <sc-id2>: <what you observed>. Builder must address each named criterion."}'
\`\`\``
        : `\n**No structured success criteria on this task.** Review the deliverables against the spec/description and use your judgment.

**If tests pass:**
\`\`\`bash
curl -sS -X POST "${missionControlUrl}/api/tasks/${task.id}/activities" \\
  -H "Content-Type: application/json" \\
${authHeaderLine}  -d '{"activity_type":"completed","message":"Tests passed: <summary>"}'

curl -sS -X PATCH "${missionControlUrl}/api/tasks/${task.id}" \\
  -H "Content-Type: application/json" \\
${authHeaderLine}  -d '{"status":"${nextStatus}"}'
\`\`\`

**If tests fail:**
\`\`\`bash
curl -sS -X POST "${missionControlUrl}/api/tasks/${task.id}/fail" \\
  -H "Content-Type: application/json" \\
${authHeaderLine}  -d '{"reason":"<detailed description of what failed and what needs fixing>"}'
\`\`\``;

      completionInstructions = `**YOUR ROLE: TESTER** — Verify deliverables against the success criteria above.
${criteriaGuidance}

Reply with: \`TEST_PASS: [summary]\` or \`TEST_FAIL: [what failed, by criterion id]\``;
    } else if (isVerifier) {
      const hasCriteria = Boolean(normalizedSpec && normalizedSpec.success_criteria.length > 0);
      const criteriaReminder = hasCriteria
        ? `\n\nEvery success criterion in the checklist above must pass. "Looks good" is not verification — confirm each assertion using its \`how_to_test\` step, then list the ids you confirmed in your activity message.`
        : '';

      completionInstructions = `**YOUR ROLE: VERIFIER** — Verify that all work meets quality standards.${criteriaReminder}

Review deliverables, test results, and task requirements.

**If verification PASSES** — all calls require the Authorization header:

\`\`\`bash
curl -sS -X POST "${missionControlUrl}/api/tasks/${task.id}/activities" \\
  -H "Content-Type: application/json" \\
${authHeaderLine}  -d '{"activity_type":"completed","message":"Verification passed: <summary; criteria verified: [<ids>]>"}'

curl -sS -X PATCH "${missionControlUrl}/api/tasks/${task.id}" \\
  -H "Content-Type: application/json" \\
${authHeaderLine}  -d '{"status":"${nextStatus}"}'
\`\`\`

**If verification FAILS** — name the specific criterion ids that failed:

\`\`\`bash
curl -sS -X POST "${missionControlUrl}/api/tasks/${task.id}/fail" \\
  -H "Content-Type: application/json" \\
${authHeaderLine}  -d '{"reason":"Failed criteria: <sc-id1>: <what you observed>; <sc-id2>: ...</what you observed>"}'
\`\`\`

Reply with: \`VERIFY_PASS: [summary]\` or \`VERIFY_FAIL: [what failed, by criterion id]\``;
    } else {
      // Fallback for unknown roles
      completionInstructions = `**IMPORTANT:** After completing work, update status — the call requires the Authorization header:

\`\`\`bash
curl -sS -X PATCH "${missionControlUrl}/api/tasks/${task.id}" \\
  -H "Content-Type: application/json" \\
${authHeaderLine}  -d '{"status":"${nextStatus}"}'
\`\`\``;
    }

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

    const taskMessage = `${priorityEmoji} **${headline}**

**Title:** ${task.title}
${task.description ? `**Description:** ${task.description}\n` : ''}
**Priority:** ${task.priority.toUpperCase()}
${task.due_date ? `**Due:** ${task.due_date}\n` : ''}
**Task ID:** ${task.id}
${callHomeSection}${deliverablesLead}${criteriaLead}${planningSpecSection}${agentInstructionsSection}${skillsSection}${knowledgeSection}${imagesSection}${buildCheckpointContext(task.id) || ''}${formatMailForDispatch(agent.id) || ''}${repoSection}${delegationRosterSection}
${isBuilder ? (workspaceIsolated
  ? `**\u{1F512} ISOLATED WORKSPACE:** ${taskProjectDir}\n- **Port:** ${workspacePort || 'default'} (use this for dev server, NOT the default)\n${workspaceBranchName ? `- **Branch:** ${workspaceBranchName}\n` : ''}- **IMPORTANT:** Do NOT modify files outside this workspace directory. Other agents may be working on the same project in parallel. All your work must stay within: ${taskProjectDir}\n**DELIVERABLES DIR (separate):** ${deliverablesDir}\nCreate ${deliverablesDir} and save final deliverables there so they become web-downloadable from Mission Control.\n`
  : `**OUTPUT DIRECTORY:** ${taskProjectDir}\n**DELIVERABLES DIR:** ${deliverablesDir}\nCreate ${deliverablesDir} and save final deliverables there so they become web-downloadable from Mission Control.\n`)
: isCoordinator ? `**DELIVERABLES DIR:** ${deliverablesDir}\nAggregated deliverables registered via the deliverables endpoint should be written to this directory so they become web-downloadable.\n` : `**OUTPUT DIRECTORY:** ${taskProjectDir}\n**DELIVERABLES DIR:** ${deliverablesDir}\nFinal deliverables should be saved to ${deliverablesDir} so they become web-downloadable.\n`}
${completionInstructions}

If you need help or clarification, ask the orchestrator.`;

    // Inject any pending operator notes (queued via /btw chat)
    const { formatted: pendingNotes } = getPendingNotesForDispatch(id);
    const finalMessage = pendingNotes ? taskMessage + pendingNotes : taskMessage;

    // Send message to agent's session using chat.send
    try {
      // Use sessionKey for routing to the agent's session.
      // Prefix defaults (via resolveAgentSessionKeyPrefix) are:
      //   1. Explicit `agent.session_key_prefix` if set
      //   2. `agent:<gateway_agent_id>:` for gateway-synced agents
      //   3. `agent:<name-slug>:` as last resort
      // The old hard-coded `agent:main:` catchall silently misrouted
      // every MC→agent chat.send to the gateway's "main" agent.
      const { resolveAgentSessionKeyPrefix } = await import('@/lib/openclaw/session-key');
      const prefix = resolveAgentSessionKeyPrefix(agent);
      const sessionKey = `${prefix}${session.openclaw_session_id}`;
      const idempotencyKey = `dispatch-${task.id}-${Date.now()}`;
      const chatSendStart = Date.now();
      let chatSendResponse: unknown;
      let chatSendError: string | null = null;
      try {
        chatSendResponse = await client.call('chat.send', {
          sessionKey,
          message: finalMessage,
          idempotencyKey,
        });
      } catch (err) {
        chatSendError = (err as Error).message;
        throw err; // preserve existing error-path behavior below
      } finally {
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
          responseBody: chatSendResponse,
          error: chatSendError,
          metadata: {
            agent_name: agent.name,
            agent_role: (agent as { role?: string }).role ?? null,
            message_length: finalMessage.length,
            task_status: task.status,
          },
        });
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
