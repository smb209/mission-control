import { NextRequest, NextResponse } from 'next/server';
import { getDb, queryAll, queryOne, run } from '@/lib/db';
import { getOpenClawClient } from '@/lib/openclaw/client';
import { broadcast } from '@/lib/events';
import { parsePlanningEnvelope } from '@/lib/planning-envelope';
import { getAgentRoster, formatRosterForPrompt } from '@/lib/agent-resolver';
import { buildInitialPlannerPrompt } from '@/lib/planner-prompt';
// File system imports removed - using OpenClaw API instead

export const dynamic = 'force-dynamic';

// Last-resort fallback when no agent context is available. Normally the
// per-agent prefix resolver (resolveAgentSessionKeyPrefix) picks the
// gateway-id or name-slug based prefix for the specific target agent.
// The old `agent:main:` default silently routed every planning session
// to the gateway's "main" agent regardless of which agent was planning.
const FALLBACK_SESSION_KEY_PREFIX = 'agent:main:';

// GET /api/tasks/[id]/planning - Get planning state
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: taskId } = await params;

  try {
    // Get task
    const task = getDb().prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as {
      id: string;
      title: string;
      description: string;
      status: string;
      planning_session_key?: string;
      planning_messages?: string;
      planning_complete?: number;
      planning_spec?: string;
      planning_agents?: string;
    } | undefined;
    
    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    // Parse planning messages from JSON
    const messages = task.planning_messages ? JSON.parse(task.planning_messages) : [];

    // Classify the latest assistant message into a phased envelope. Legacy
    // single-phase flows still work — parsePlanningEnvelope handles the old
    // { question, options } and { status: 'complete', spec } shapes.
    const lastAssistantMessage = [...messages].reverse().find((m: { role: string }) => m.role === 'assistant');
    let currentQuestion: { question: string; options: Array<{ id: string; label: string }>; understanding?: string; unknowns?: string[] } | null = null;
    let clarifyDone: { understanding: string; unknowns: string[]; needs_research: boolean; research_rationale?: string } | null = null;

    if (lastAssistantMessage) {
      const { envelope } = parsePlanningEnvelope(lastAssistantMessage.content);
      if (envelope?.kind === 'clarify_question') {
        currentQuestion = {
          question: envelope.question,
          options: envelope.options,
          understanding: envelope.understanding,
          unknowns: envelope.unknowns,
        };
      } else if (envelope?.kind === 'clarify_done') {
        clarifyDone = {
          understanding: envelope.understanding,
          unknowns: envelope.unknowns,
          needs_research: envelope.needs_research,
          research_rationale: envelope.research_rationale,
        };
      }
    }

    type TaskRow = typeof task & {
      planning_phase?: string;
      planning_understanding?: string;
      planning_unknowns?: string;
      planning_research?: string;
    };
    const taskRow = task as TaskRow;

    return NextResponse.json({
      taskId,
      sessionKey: task.planning_session_key,
      messages,
      currentQuestion,
      clarifyDone,
      phase: taskRow.planning_phase ?? 'clarify',
      understanding: taskRow.planning_understanding ?? null,
      unknowns: taskRow.planning_unknowns ? JSON.parse(taskRow.planning_unknowns) : [],
      research: taskRow.planning_research ? JSON.parse(taskRow.planning_research) : null,
      isComplete: !!task.planning_complete,
      spec: task.planning_spec ? JSON.parse(task.planning_spec) : null,
      agents: task.planning_agents ? JSON.parse(task.planning_agents) : null,
      isStarted: messages.length > 0,
    });
  } catch (error) {
    console.error('Failed to get planning state:', error);
    return NextResponse.json({ error: 'Failed to get planning state' }, { status: 500 });
  }
}

// POST /api/tasks/[id]/planning - Start planning session
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: taskId } = await params;

  try {
    const body = await request.json().catch(() => ({}));
    const customSessionKeyPrefix = body.session_key_prefix;

    // Get task
    const task = getDb().prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as {
      id: string;
      title: string;
      description: string;
      status: string;
      workspace_id: string;
      planning_session_key?: string;
      planning_messages?: string;
    } | undefined;

    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    // Check if planning already started
    if (task.planning_session_key) {
      return NextResponse.json({ error: 'Planning already started', sessionKey: task.planning_session_key }, { status: 400 });
    }

    // Check if there are other orchestrators available before starting planning with the default master agent.
    // Fetch the full master agent so we can feed it to resolveAgentSessionKeyPrefix
    // instead of reading session_key_prefix directly — the resolver falls
    // back to the agent's own gateway namespace when no explicit prefix is set.
    const defaultMaster = queryOne<import('@/lib/types').Agent>(
      `SELECT * FROM agents WHERE is_master = 1 AND workspace_id = ? ORDER BY created_at ASC LIMIT 1`,
      [task.workspace_id]
    );

    // Get assigned agent (for session_key_prefix via the resolver).
    const taskWithAgent = getDb().prepare(`
      SELECT a.session_key_prefix, a.gateway_agent_id, a.name
      FROM tasks t
      LEFT JOIN agents a ON t.assigned_agent_id = a.id
      WHERE t.id = ?
    `).get(taskId) as { session_key_prefix?: string; gateway_agent_id?: string; name?: string } | undefined;

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
      [defaultMaster?.id ?? '', task.workspace_id]
    );

    if (otherOrchestrators.length > 0) {
      return NextResponse.json({
        error: 'Other orchestrators available',
        message: `There ${otherOrchestrators.length === 1 ? 'is' : 'are'} ${otherOrchestrators.length} other orchestrator${otherOrchestrators.length === 1 ? '' : 's'} available in this workspace: ${otherOrchestrators.map(o => o.name).join(', ')}. Please assign this task to them directly.`,
        otherOrchestrators,
      }, { status: 409 }); // 409 Conflict
    }

    // Create session key for this planning task.
    // Priority: custom prefix > assigned agent (via resolver) > master agent
    // (via resolver) > fallback. The resolver picks `agent:<gateway_id>:`
    // or `agent:<name>:` when the column is null, keeping messages in the
    // specific agent's namespace.
    const { resolveAgentSessionKeyPrefix } = await import('@/lib/openclaw/session-key');
    let basePrefix: string;
    if (customSessionKeyPrefix) {
      basePrefix = customSessionKeyPrefix.endsWith(':') ? customSessionKeyPrefix : customSessionKeyPrefix + ':';
    } else if (taskWithAgent?.name) {
      basePrefix = resolveAgentSessionKeyPrefix({
        session_key_prefix: taskWithAgent.session_key_prefix,
        gateway_agent_id: taskWithAgent.gateway_agent_id,
        name: taskWithAgent.name,
      } as import('@/lib/types').Agent);
    } else if (defaultMaster) {
      basePrefix = resolveAgentSessionKeyPrefix(defaultMaster);
    } else {
      basePrefix = FALLBACK_SESSION_KEY_PREFIX;
    }
    const planningPrefix = basePrefix + 'planning:';
    const sessionKey = `${planningPrefix}${taskId}`;

    // Fetch the gateway-linked agent roster and surface it to the planner.
    // Without this context the planner invents new agents every run, which is
    // the root of the ghost-agent duplication bug: the real gateway agents
    // sit idle while newly-created rows with no session_key_prefix receive
    // the dispatch. When the planner emits its final plan with an "agents"
    // array, it can now reuse one of these existing rows by agent_id — see
    // the polling handler for reuse/verify logic.
    const roster = getAgentRoster(task.workspace_id);
    const rosterBlock = formatRosterForPrompt(roster);

    // Validation-first phased prompt. The planner now walks clarify →
    // (optional) research → plan → confirm → complete rather than a single
    // Q&A loop ending in auto-dispatch. See src/lib/planner-prompt.ts for
    // the full protocol and src/lib/planning-envelope.ts for the envelope
    // schemas both sides agree on.
    const planningPrompt = buildInitialPlannerPrompt({
      taskTitle: task.title,
      taskDescription: task.description || '',
      rosterBlock,
    });

    // Connect to OpenClaw and send the planning request
    const client = getOpenClawClient();
    if (!client.isConnected()) {
      await client.connect();
    }

    // Send planning request to the planning session
    await client.call('chat.send', {
      sessionKey: sessionKey,
      message: planningPrompt,
      idempotencyKey: `planning-start-${taskId}-${Date.now()}`,
    });

    // Store the session key and initial message
    const messages = [{ role: 'user', content: planningPrompt, timestamp: Date.now() }];

    getDb().prepare(`
      UPDATE tasks
      SET planning_session_key = ?,
          planning_messages = ?,
          status = 'planning',
          planning_phase = 'clarify',
          planning_understanding = NULL,
          planning_unknowns = NULL,
          planning_research = NULL
      WHERE id = ?
    `).run(sessionKey, JSON.stringify(messages), taskId);

    // Return immediately - frontend will poll for updates
    // This eliminates the aggressive polling loop that was making 30+ OpenClaw API calls
    return NextResponse.json({
      success: true,
      sessionKey,
      messages,
      note: 'Planning started. Poll GET endpoint for updates.',
    });
  } catch (error) {
    console.error('Failed to start planning:', error);
    return NextResponse.json({ error: 'Failed to start planning: ' + (error as Error).message }, { status: 500 });
  }
}

// DELETE /api/tasks/[id]/planning - Cancel planning session
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: taskId } = await params;

  try {
    // Get task to check session key
    const task = queryOne<{
      id: string;
      planning_session_key?: string;
      status: string;
    }>(
      'SELECT * FROM tasks WHERE id = ?',
      [taskId]
    );

    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    // Clear planning-related fields (including the enhanced phase columns
    // from migration 036). Status returns to 'inbox' so the task can be
    // re-planned cleanly.
    run(`
      UPDATE tasks
      SET planning_session_key = NULL,
          planning_messages = NULL,
          planning_complete = 0,
          planning_spec = NULL,
          planning_agents = NULL,
          planning_phase = 'clarify',
          planning_understanding = NULL,
          planning_unknowns = NULL,
          planning_research = NULL,
          planner_agent_id = NULL,
          status = 'inbox',
          updated_at = datetime('now')
      WHERE id = ?
    `, [taskId]);

    // Broadcast task update
    const updatedTask = queryOne('SELECT * FROM tasks WHERE id = ?', [taskId]);
    if (updatedTask) {
      broadcast({
        type: 'task_updated',
        payload: updatedTask as any, // Cast to any to satisfy SSEEvent payload union type
      });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Failed to cancel planning:', error);
    return NextResponse.json({ error: 'Failed to cancel planning: ' + (error as Error).message }, { status: 500 });
  }
}
