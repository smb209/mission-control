import { NextRequest, NextResponse } from 'next/server';
import { getDb, queryAll, queryOne, run } from '@/lib/db';
import { getOpenClawClient } from '@/lib/openclaw/client';
import { broadcast } from '@/lib/events';
import { extractJSON } from '@/lib/planning-utils';
import { getAgentRoster, formatRosterForPrompt } from '@/lib/agent-resolver';
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

    // Find the latest question (last assistant message with question structure)
    const lastAssistantMessage = [...messages].reverse().find((m: { role: string }) => m.role === 'assistant');
    let currentQuestion = null;

    if (lastAssistantMessage) {
      // Use extractJSON to handle code blocks and surrounding text
      const parsed = extractJSON(lastAssistantMessage.content);
      if (parsed && 'question' in parsed) {
        currentQuestion = parsed;
      }
    }

    return NextResponse.json({
      taskId,
      sessionKey: task.planning_session_key,
      messages,
      currentQuestion,
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
    // the dispatch. When the planner emits its final `agents` list at status
    // "complete", it may now return `agent_id` per agent to reuse one of these
    // existing rows — see the polling handler for reuse/verify logic.
    const roster = getAgentRoster(task.workspace_id);
    const rosterBlock = formatRosterForPrompt(roster);

    // Build the initial planning prompt. Two things matter here: the
    // question-asking loop (which fires now) and the final completion
    // shape the planner MUST emit once it's done asking. We spell the
    // completion schema out up front because agents anchor on structure
    // when shown it once — asking for a binary-testable spec only at the
    // "answer" stage was producing narrative summaries that downstream
    // builders then interpreted in the cheapest way possible.
    const planningPrompt = `PLANNING REQUEST

Task Title: ${task.title}
Task Description: ${task.description || 'No description provided'}

AVAILABLE AGENTS (workspace roster):
${rosterBlock}

When you later emit the final plan (status: "complete") with an "agents" array, prefer assigning roles to the agents listed above by including their "agent_id" in each entry. Only propose a new agent (agent_id: null) when no listed agent is a suitable fit — and include a "rationale" explaining the specific capability gap.

You are starting a planning session for this task. Read PLANNING.md for your protocol.

**Your job has two phases:**

PHASE 1 — ask multiple-choice questions until you understand what the user needs.
PHASE 2 — emit a final spec with STRUCTURED, TESTABLE deliverables and success criteria (see schema below) so downstream builders and testers can objectively tell whether work is done.

**Completion schema** (for when you're ready to emit status: "complete"):
\`\`\`json
{
  "status": "complete",
  "spec": {
    "title": "...",
    "summary": "...",
    "deliverables": [
      {
        "id": "short-machine-id",              // stable id builders use when registering fulfillment
        "title": "Human-readable name",
        "kind": "file" | "behavior" | "artifact",
        "path_pattern": "src/foo.js",          // required when kind=file; relative to the deliverables dir
        "acceptance": "Binary, testable assertion — e.g. 'exports logShot(data) which persists to IndexedDB db=espresso-shots'"
      }
    ],
    "success_criteria": [
      {
        "id": "sc-1",
        "assertion": "Binary: passes or fails, no ambiguity",
        "how_to_test": "Specific command, manual step, or assertion the tester runs"
      }
    ],
    "constraints": {}
  },
  "agents": [ /* as described above */ ],
  "execution_plan": {}
}
\`\`\`

**Rules for the spec (these are the difference between a working deliverable and a broken mockup):**
- EVERY major artifact needed to ship the task must be its own entry in \`deliverables\` — not bundled under a vague "module" entry. If the task needs an HTML page + CSS + JS + service worker, that is four deliverables, not one.
- For \`kind: "file"\`, \`path_pattern\` MUST name the file. No "some JS file" — name it.
- For \`kind: "behavior"\`, \`acceptance\` MUST be verifiable (e.g. "page loads from cache with network disabled", not "works offline").
- \`success_criteria\` are for the Tester: each one should be something pass/fail-able. If you can't describe how to test it, it doesn't belong here.

PHASE 1 starts now. Generate your FIRST question to understand what the user needs. Remember:
- Questions must be multiple choice
- Include an "Other" option
- Be specific to THIS task, not generic

Respond with ONLY valid JSON in this format:
{
  "question": "Your question here?",
  "options": [
    {"id": "A", "label": "First option"},
    {"id": "B", "label": "Second option"},
    {"id": "C", "label": "Third option"},
    {"id": "other", "label": "Other"}
  ]
}`;

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
      SET planning_session_key = ?, planning_messages = ?, status = 'planning'
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

    // Clear planning-related fields
    run(`
      UPDATE tasks
      SET planning_session_key = NULL,
          planning_messages = NULL,
          planning_complete = 0,
          planning_spec = NULL,
          planning_agents = NULL,
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
