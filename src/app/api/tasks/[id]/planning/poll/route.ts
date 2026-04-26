import { NextRequest, NextResponse } from 'next/server';
import { queryOne, run } from '@/lib/db';
import { getOpenClawClient } from '@/lib/openclaw/client';
import { sendChatToSession } from '@/lib/openclaw/send-chat';
import { broadcast } from '@/lib/events';
import { getMessagesFromOpenClaw } from '@/lib/planning-utils';
import { parsePlanningEnvelope, type PlanningEnvelope } from '@/lib/planning-envelope';
import { persistPlannerPlan } from '@/lib/planning-persist';
import { buildReformatPrompt } from '@/lib/planner-prompt';
import { Task } from '@/lib/types';

export const dynamic = 'force-dynamic';

/**
 * Apply a single planner envelope to the task row. This is the state-machine
 * dispatcher — it keeps the business rules for "what does this phase do with
 * this envelope" in one place and lets the HTTP handler stay thin.
 */
function applyEnvelope(taskId: string, envelope: PlanningEnvelope): void {
  switch (envelope.kind) {
    case 'clarify_question': {
      run(
        `UPDATE tasks
         SET planning_phase = 'clarify',
             planning_understanding = ?,
             planning_unknowns = ?,
             updated_at = datetime('now')
         WHERE id = ?`,
        [
          envelope.understanding || null,
          envelope.unknowns.length ? JSON.stringify(envelope.unknowns) : null,
          taskId,
        ]
      );
      return;
    }
    case 'clarify_done': {
      run(
        `UPDATE tasks
         SET planning_phase = 'clarify',
             planning_understanding = ?,
             planning_unknowns = ?,
             updated_at = datetime('now')
         WHERE id = ?`,
        [
          envelope.understanding || null,
          envelope.unknowns.length ? JSON.stringify(envelope.unknowns) : null,
          taskId,
        ]
      );
      return;
    }
    case 'research_done': {
      const payload = {
        summary: envelope.summary,
        updated_unknowns: envelope.updated_unknowns,
        done_at: new Date().toISOString(),
      };
      run(
        `UPDATE tasks
         SET planning_research = ?,
             planning_unknowns = ?,
             updated_at = datetime('now')
         WHERE id = ?`,
        [
          JSON.stringify(payload),
          envelope.updated_unknowns.length ? JSON.stringify(envelope.updated_unknowns) : null,
          taskId,
        ]
      );
      return;
    }
    case 'plan': {
      // Store spec+agents and move to the confirm phase. Persist WITHOUT
      // dispatching — the user must explicitly click Lock & Dispatch.
      persistPlannerPlan(taskId, envelope);
      return;
    }
  }
}

// GET /api/tasks/[id]/planning/poll - Check for new messages from OpenClaw
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: taskId } = await params;

  try {
    const task = queryOne<{
      id: string;
      planning_session_key?: string;
      planning_messages?: string;
      planning_complete?: number;
      planning_dispatch_error?: string;
      planning_phase?: string;
      planning_understanding?: string;
      planning_unknowns?: string;
      planning_research?: string;
    }>('SELECT * FROM tasks WHERE id = ?', [taskId]);

    if (!task || !task.planning_session_key) {
      return NextResponse.json({ error: 'Planning session not found' }, { status: 404 });
    }

    if (task.planning_complete) {
      return NextResponse.json({ hasUpdates: false, isComplete: true });
    }

    // Return dispatch error if present (allows user to see/ retry failed dispatch)
    if (task.planning_dispatch_error) {
      return NextResponse.json({
        hasUpdates: true,
        dispatchError: task.planning_dispatch_error,
      });
    }

    const messages = task.planning_messages ? JSON.parse(task.planning_messages) : [];
    const initialAssistantCount = messages.filter((m: { role: string }) => m.role === 'assistant').length;

    const openclawMessages = await getMessagesFromOpenClaw(task.planning_session_key);

    if (openclawMessages.length > initialAssistantCount) {
      let currentQuestion:
        | {
            question: string;
            input_kind: 'options' | 'freetext';
            options: Array<{ id: string; label: string; allow_details?: boolean }>;
            placeholder?: string;
            understanding?: string;
            unknowns?: string[];
          }
        | null = null;
      let clarifyDone:
        | { understanding: string; unknowns: string[]; needs_research: boolean; research_rationale?: string }
        | null = null;
      let researchDone: { summary: string; updated_unknowns: string[] } | null = null;
      let planReady = false;
      let phaseAfter: string = task.planning_phase || 'clarify';

      const newMessages = openclawMessages.slice(initialAssistantCount);
      for (const msg of newMessages) {
        if (msg.role !== 'assistant') continue;
        const stored = { role: 'assistant' as const, content: msg.content, timestamp: Date.now() };
        messages.push(stored);

        const { envelope, reason } = parsePlanningEnvelope(msg.content);
        if (!envelope) {
          // Fall through to the reformat path below — we handle it once after
          // the loop so the auto-retry only fires on the LAST bad message.
          continue;
        }

        applyEnvelope(taskId, envelope);

        switch (envelope.kind) {
          case 'clarify_question':
            currentQuestion = {
              question: envelope.question,
              input_kind: envelope.input_kind,
              // Freetext questions carry no options — pass through as-is.
              // For options shape, backfill an Other fallback if the planner
              // forgot (keeps the user from getting stuck with no escape).
              options: envelope.input_kind === 'freetext'
                ? []
                : envelope.options.length
                ? envelope.options
                : [{ id: 'continue', label: 'Continue' }, { id: 'other', label: 'Other', allow_details: true }],
              placeholder: envelope.placeholder,
              understanding: envelope.understanding,
              unknowns: envelope.unknowns,
            };
            phaseAfter = 'clarify';
            break;
          case 'clarify_done':
            clarifyDone = {
              understanding: envelope.understanding,
              unknowns: envelope.unknowns,
              needs_research: envelope.needs_research,
              research_rationale: envelope.research_rationale,
            };
            phaseAfter = 'clarify';
            break;
          case 'research_done':
            researchDone = {
              summary: envelope.summary,
              updated_unknowns: envelope.updated_unknowns,
            };
            phaseAfter = 'research';
            break;
          case 'plan':
            planReady = true;
            phaseAfter = 'confirm';
            break;
        }
        // Log classification outcome for diagnostics
        console.log(
          `[Planning Poll] Task ${taskId} envelope kind=${envelope.kind}${reason ? ' reason=' + reason : ''}`
        );
      }

      // Persist the updated message log.
      run('UPDATE tasks SET planning_messages = ? WHERE id = ?', [JSON.stringify(messages), taskId]);

      // If we saw a new plan envelope, read back spec+agents (persistPlannerPlan
      // wrote them during applyEnvelope).
      let spec: unknown = null;
      let agents: unknown = null;
      if (planReady) {
        const fresh = queryOne<{ planning_spec?: string; planning_agents?: string }>(
          `SELECT planning_spec, planning_agents FROM tasks WHERE id = ?`,
          [taskId]
        );
        if (fresh?.planning_spec) spec = JSON.parse(fresh.planning_spec);
        if (fresh?.planning_agents) agents = JSON.parse(fresh.planning_agents);
      }

      // Broadcast task update so other UI surfaces reflect phase changes.
      const updatedTask = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [taskId]);
      if (updatedTask) {
        broadcast({ type: 'task_updated', payload: updatedTask });
      }

      return NextResponse.json({
        hasUpdates: true,
        complete: false,
        messages,
        phase: phaseAfter,
        currentQuestion,
        clarifyDone,
        researchDone,
        planReady,
        spec,
        agents,
      });
    }

    // FALLBACK: If the last stored assistant message was a plan/complete that
    // never got applied (race condition or a crash during applyEnvelope),
    // re-apply it now. Since plan envelopes no longer auto-dispatch, this is
    // safe to do repeatedly — persistPlannerPlan just overwrites spec/agents.
    const lastAssistantMsg = [...messages].reverse().find((m: { role: string }) => m.role === 'assistant');
    if (lastAssistantMsg) {
      const { envelope, reason } = parsePlanningEnvelope(lastAssistantMsg.content);
      if (envelope?.kind === 'plan' && task.planning_phase !== 'confirm' && task.planning_phase !== 'complete') {
        applyEnvelope(taskId, envelope);
        const fresh = queryOne<{ planning_spec?: string; planning_agents?: string }>(
          `SELECT planning_spec, planning_agents FROM tasks WHERE id = ?`,
          [taskId]
        );
        return NextResponse.json({
          hasUpdates: true,
          complete: false,
          messages,
          phase: 'confirm',
          planReady: true,
          spec: fresh?.planning_spec ? JSON.parse(fresh.planning_spec) : null,
          agents: fresh?.planning_agents ? JSON.parse(fresh.planning_agents) : null,
        });
      }

      if (!envelope) {
        // Auto-reprompt on unparseable last message, same single-retry rule
        // as before. We only retry if we haven't already reprompted this msg.
        const alreadyReprompted = (lastAssistantMsg as { reprompted?: boolean }).reprompted === true;

        if (!alreadyReprompted) {
          const sessionKey = task.planning_session_key;
          const client = getOpenClawClient();
          if (!client.isConnected()) {
            await client.connect();
          }
          const sendResult = await sendChatToSession({
            sessionKey,
            message: buildReformatPrompt(reason || 'Not a recognized planning envelope'),
            idempotencyKey: `planning-reprompt-${taskId}-${Date.now()}`,
          });
          if (!sendResult.sent) {
            const errMsg = sendResult.error?.message ?? sendResult.reason ?? 'unknown';
            console.error(`[Planning Poll] Failed to send reformat correction:`, errMsg);
            return NextResponse.json({
              hasUpdates: true,
              parseError: `Planner returned invalid JSON and the reformat request also failed: ${errMsg}`,
              rawContent: lastAssistantMsg.content.slice(0, 4000),
              messages,
            });
          }
          console.log(`[Planning Poll] Sent reformat correction to planner for task ${taskId}`);

          const taggedMessages = messages.map((m: { role: string; content: string; timestamp: number; reprompted?: boolean }) =>
            m === lastAssistantMsg ? { ...m, reprompted: true } : m
          );
          run('UPDATE tasks SET planning_messages = ? WHERE id = ?', [JSON.stringify(taggedMessages), taskId]);

          return NextResponse.json({
            hasUpdates: true,
            reprompted: true,
            messages: taggedMessages,
          });
        }

        return NextResponse.json({
          hasUpdates: true,
          parseError: 'The planning agent returned malformed JSON twice in a row. Cancel and restart planning, or edit the task and try again.',
          rawContent: lastAssistantMsg.content.slice(0, 4000),
          messages,
        });
      }
    }

    // Stale-planning heuristic (unchanged) — surface in UI after 10 min idle.
    const lastMsgTimestamp = messages.length > 0 ? messages[messages.length - 1].timestamp : null;
    const stalePlanningMs = 10 * 60 * 1000;
    const isStalePlanning = lastMsgTimestamp && Date.now() - lastMsgTimestamp > stalePlanningMs;

    return NextResponse.json({
      hasUpdates: false,
      phase: task.planning_phase || 'clarify',
      stalePlanning: isStalePlanning || undefined,
      staleSinceMs: isStalePlanning ? Date.now() - lastMsgTimestamp : undefined,
    });
  } catch (error) {
    console.error('Failed to poll for updates:', error);
    return NextResponse.json({ error: 'Failed to poll for updates' }, { status: 500 });
  }
}
