/**
 * Agent mailbox service.
 *
 * Wraps the low-level `sendMail` (in src/lib/mailbox.ts) with:
 *   - Sender authorization (agent exists + active)
 *   - Task-scope authorization when `taskId` is set — cross-task probing
 *     via mail is a real vector an agent could otherwise use to pressure
 *     peers outside its assignment.
 *   - Recipient existence check (clean 404 vs FK blowup).
 *   - Roll-call reply matching (so the UI's live status flips).
 *
 * HTTP route and (PR 3) MCP `send_mail` tool both call this.
 *
 * Throws `AuthzError` on authz failure. Returns an `ok: false` result when
 * the recipient is missing so the caller maps to 404 without guessing.
 */

import { queryOne } from '@/lib/db';
import { sendMail, type SendMailResult } from '@/lib/mailbox';
import { recordRollCallReplyIfMatch } from '@/lib/rollcall';
import {
  assertAgentActive,
  assertAgentCanActOnTask,
} from '@/lib/authz/agent-task';
import type { Agent, AgentMailMessage } from '@/lib/types';

export interface SendAgentMailInput {
  fromAgentId: string;
  toAgentId: string;
  body: string;
  subject?: string;
  convoyId?: string | null;
  taskId?: string | null;
  push?: boolean;
}

export type SendAgentMailResult =
  | {
      ok: true;
      message: AgentMailMessage;
      push?: SendMailResult['delivery'];
      rollcallMatched: boolean;
      rollcallId?: string;
    }
  | {
      ok: false;
      code: 'recipient_not_found';
      error: string;
    };

export async function sendAgentMail(
  input: SendAgentMailInput,
): Promise<SendAgentMailResult> {
  const { fromAgentId, toAgentId, body, subject, convoyId, taskId, push } = input;

  assertAgentActive(fromAgentId);
  if (taskId) {
    assertAgentCanActOnTask(fromAgentId, taskId, 'activity');
  }

  const recipient = queryOne<Agent>('SELECT id FROM agents WHERE id = ?', [toAgentId]);
  if (!recipient) {
    return {
      ok: false,
      code: 'recipient_not_found',
      error: `Recipient agent ${toAgentId} not found`,
    };
  }

  const result = await sendMail({
    convoyId: convoyId ?? null,
    taskId: taskId ?? null,
    fromAgentId,
    toAgentId,
    subject,
    body,
    push: Boolean(push),
  });

  const rollcall = recordRollCallReplyIfMatch({
    mailId: result.message.id,
    fromAgentId,
    toAgentId,
    subject,
    body,
  });

  return {
    ok: true,
    message: result.message,
    push: result.delivery,
    rollcallMatched: rollcall.matched,
    rollcallId: rollcall.rollcallId,
  };
}
