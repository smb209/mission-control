/**
 * Real-agent E2E smoke for the scope-keyed-sessions stack.
 *
 * Imports dispatchPm directly so we sidestep Next.js dev module-instance
 * splits — every import path resolves through one Node process, the
 * openclaw client singleton is consistent across the whole flow.
 *
 * Steps:
 *   1. Load the FOIA workspace + PM agent (assumes db:reset + seed +
 *      promote already ran).
 *   2. Connect the openclaw client.
 *   3. dispatchPm with a canonical "Sarah out X to Y" disruption.
 *   4. Await the completion promise (real-agent round-trip via
 *      spark-lb/agent).
 *   5. Print the synth placeholder + final agent proposal IDs +
 *      dispatch_state evolution.
 *   6. Exit non-zero if dispatch_state ended in 'synth_only'
 *      (indicates the agent didn't supersede).
 */

import { getOpenClawClient } from '../src/lib/openclaw/client';
import { dispatchPm } from '../src/lib/agents/pm-dispatch';
import { getPmAgent } from '../src/lib/agents/pm-resolver';
import { sendChatAndAwaitReply } from '../src/lib/openclaw/send-chat';
import { closeDb, getDb, queryOne } from '../src/lib/db';

interface WorkspaceRow {
  id: string;
  slug: string;
}

async function main(): Promise<void> {
  // Touch the DB so migrations are applied.
  getDb();

  const workspace = queryOne<WorkspaceRow>(
    `SELECT id, slug FROM workspaces WHERE slug = 'foia' LIMIT 1`,
  );
  if (!workspace) {
    console.error('FOIA workspace not found. Run yarn tsx scripts/seed-foia-fixture.ts first.');
    process.exit(1);
  }
  const pm = getPmAgent(workspace.id);
  if (!pm || !pm.gateway_agent_id) {
    console.error(
      `FOIA PM not promoted to gateway. Set gateway_agent_id and session_key_prefix on the PM agent first.`,
    );
    process.exit(1);
  }
  console.log(`Workspace: ${workspace.id} (${workspace.slug})`);
  console.log(`PM agent: ${pm.id} → gateway=${pm.gateway_agent_id}`);

  console.log('\nConnecting openclaw client...');
  const client = getOpenClawClient();
  await client.connect();
  console.log(`Connected: ${client.isConnected()}`);
  if (!client.isConnected()) {
    console.error('openclaw client not connected after connect(); aborting.');
    process.exit(1);
  }

  // Wait for any catalog sync to settle.
  await new Promise((res) => setTimeout(res, 1000));

  // Diagnostic: sanity-check the raw chat.send path before dispatchPm.
  console.log('\n[diagnostic] direct sendChatAndAwaitReply with a no-op message...');
  const probe = await sendChatAndAwaitReply({
    agent: pm,
    message: '[probe] hello — please reply OK to confirm session is live',
    idempotencyKey: 'e2e-probe',
    sessionSuffix: 'dispatch-main',
    timeoutMs: 30_000,
  });
  console.log(`  sent: ${probe.sent}`);
  console.log(`  sessionKey: ${probe.sessionKey}`);
  if (!probe.sent) {
    console.log(`  reason: ${(probe as { reason?: string }).reason}`);
    if ((probe as { error?: Error }).error) {
      console.log(`  error: ${(probe as { error?: Error }).error?.message}`);
    }
  } else {
    console.log(`  timedOut: ${(probe as { timedOut?: boolean }).timedOut}`);
    console.log(`  collected events: ${(probe as { reply?: unknown[] }).reply?.length ?? 0}`);
  }

  const trigger_text = 'E2E smoke: Sarah out 2026-05-24 to 2026-05-29';
  console.log(`\nDispatching: "${trigger_text}"`);
  const t0 = Date.now();
  const result = dispatchPm({
    workspace_id: workspace.id,
    trigger_text,
    trigger_kind: 'manual',
  });
  console.log(
    `Synth placeholder: ${result.proposal.id} (state=${result.proposal.dispatch_state}, awaiting_agent=${result.awaiting_agent})`,
  );
  console.log('Awaiting real-agent completion (up to ~120s)...');

  const settled = await result.completion;
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\nCompleted in ${elapsed}s`);
  console.log(`  used_named_agent:        ${settled.used_named_agent}`);
  console.log(`  used_synthesize_fallback: ${settled.used_synthesize_fallback}`);
  console.log(`  final.id:                ${settled.final.id}`);
  console.log(`  final.dispatch_state:    ${settled.final.dispatch_state}`);
  console.log(`  final.status:            ${settled.final.status}`);
  console.log(`  final.impact_md.length:  ${settled.final.impact_md.length} chars`);
  console.log(
    `  final.changes:           ${settled.final.proposed_changes.length} diff(s)`,
  );

  if (settled.final.dispatch_state === 'synth_only') {
    console.error('\nFAIL: dispatch ended in synth_only — agent did not supersede.');
    process.exit(2);
  }
  console.log('\nPASS: agent superseded the synth placeholder via real-agent round-trip.');
  closeDb();
}

main().catch((err) => {
  console.error('e2e-foia-disruption fatal:', err);
  process.exit(1);
});
