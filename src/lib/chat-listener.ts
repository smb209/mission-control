/**
 * Chat Listener — captures agent responses to user chat messages.
 *
 * Strategy: tracks which sessionKeys have pending user chat messages.
 * When a state=final chat_event arrives on a tracked session, stores
 * it as the agent's reply and clears the tracking.
 *
 * Two scopes are supported:
 *   - task-scoped:  replies write to task_notes (existing TaskChatTab flow)
 *   - agent-scoped: replies write to agent_chat_messages (AgentChatTab flow,
 *                   for chats that don't belong to any task)
 */
import { getOpenClawClient } from '@/lib/openclaw/client';
import { run } from '@/lib/db';
import { v4 as uuidv4 } from 'uuid';
import { createNote } from '@/lib/task-notes';
import { broadcast } from '@/lib/events';

const GLOBAL_LISTENER_KEY = '__chat_listener_attached__';

type PendingEntry =
  | { kind: 'task'; taskId: string; sentAt: number }
  | { kind: 'agent'; agentId: string; sentAt: number };

// Sessions awaiting a reply: sessionKey → PendingEntry
const PENDING_KEY = '__chat_pending_replies__';
if (!(PENDING_KEY in globalThis)) {
  (globalThis as Record<string, unknown>)[PENDING_KEY] = new Map<string, PendingEntry>();
}
const pendingReplies = (globalThis as unknown as Record<string, Map<string, PendingEntry>>)[PENDING_KEY];

interface ChatEventPayload {
  runId?: string;
  sessionKey?: string;
  seq?: number;
  state?: string;
  message?: string | { role?: string; content?: unknown };
}

/**
 * Mark a task-scoped session as expecting a reply from the agent.
 * Called by /api/tasks/[id]/chat after sending a message.
 */
export function expectReply(sessionKey: string, taskId: string): void {
  pendingReplies.set(sessionKey, { kind: 'task', taskId, sentAt: Date.now() });
  setTimeout(() => {
    const entry = pendingReplies.get(sessionKey);
    if (entry && Date.now() - entry.sentAt >= 300000) {
      pendingReplies.delete(sessionKey);
    }
  }, 300000);
}

/**
 * Mark an agent-scoped session as expecting a reply. Called by
 * /api/agents/[id]/chat after sending a message.
 */
export function expectAgentReply(sessionKey: string, agentId: string): void {
  pendingReplies.set(sessionKey, { kind: 'agent', agentId, sentAt: Date.now() });
  setTimeout(() => {
    const entry = pendingReplies.get(sessionKey);
    if (entry && Date.now() - entry.sentAt >= 300000) {
      pendingReplies.delete(sessionKey);
    }
  }, 300000);
}

function extractContent(message: ChatEventPayload['message']): string {
  if (typeof message === 'string') return message;
  if (!message || typeof message !== 'object') return '';
  if (typeof message.content === 'string') return message.content;
  if (Array.isArray(message.content)) {
    return (message.content as Array<{ type?: string; text?: string }>)
      .filter(c => c.type === 'text' && c.text)
      .map(c => c.text!)
      .join('\n');
  }
  return '';
}

export function attachChatListener(): void {
  if ((globalThis as Record<string, unknown>)[GLOBAL_LISTENER_KEY]) return;
  (globalThis as Record<string, unknown>)[GLOBAL_LISTENER_KEY] = true;

  const client = getOpenClawClient();

  client.on('chat_event', (payload: ChatEventPayload) => {
    if (!payload.sessionKey) return;

    // Only process final (complete) messages
    if (payload.state !== 'final') return;

    const pending = pendingReplies.get(payload.sessionKey);
    if (!pending) return;

    const content = extractContent(payload.message);
    if (!content.trim()) return;

    // Skip dispatch-template content that leaks through
    if (content.includes('NEW TASK ASSIGNED') || content.includes('OUTPUT DIRECTORY:') ||
        content.includes('TASK_COMPLETE:') || content.includes('TEST_PASS:') ||
        content.includes('VERIFY_PASS:')) return;

    pendingReplies.delete(payload.sessionKey);

    try {
      if (pending.kind === 'task') {
        console.log(`[ChatListener] Agent replied for task ${pending.taskId}: ${content.slice(0, 100)}...`);
        const note = createNote(pending.taskId, content.trim(), 'direct', 'assistant');
        broadcast({ type: 'note_delivered', payload: { taskId: pending.taskId, noteId: note.id } });
      } else {
        console.log(`[ChatListener] Agent replied for agent ${pending.agentId}: ${content.slice(0, 100)}...`);
        const id = uuidv4();
        run(
          `INSERT INTO agent_chat_messages (id, agent_id, role, content, status, session_key)
           VALUES (?, ?, 'assistant', ?, 'delivered', ?)`,
          [id, pending.agentId, content.trim(), payload.sessionKey]
        );
        broadcast({ type: 'agent_chat_message', payload: { agentId: pending.agentId, messageId: id } });
      }
    } catch (err) {
      console.error('[ChatListener] Failed to store agent response:', err);
    }
  });

  console.log('[ChatListener] Attached to OpenClaw client');
}
