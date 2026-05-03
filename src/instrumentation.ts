/**
 * Next.js instrumentation hook — runs once per server process, at boot,
 * before any request is handled.
 *
 * We use it to force DB initialization (and therefore migrations) eagerly,
 * so a fresh container that hasn't received traffic yet still ends up on
 * the latest schema. Without this, migrations only fire on the first API
 * call that touches the DB — which means "docker compose up" can appear
 * healthy while the schema is still out-of-date.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  const { getDb } = await import('@/lib/db');
  try {
    getDb();
  } catch (err) {
    console.error('[Instrumentation] Eager DB init failed:', err);
    throw err;
  }

  // Register the pm_pending_notes drain worker. The drain is cheap when
  // the queue is empty and it's the only path that recovers
  // propose_from_notes requests captured while the gateway was offline.
  try {
    const { registerDrainTriggers } = await import('@/lib/agents/pm-pending-drain');
    registerDrainTriggers();
  } catch (err) {
    console.warn('[Instrumentation] pm-pending-drain registration failed:', (err as Error).message);
  }

  // Register the rolling DB backup schedule. Boot tick after 30s grace,
  // then every MC_BACKUP_INTERVAL_HOURS hours (default 24). Retains the
  // newest MC_BACKUP_RETAIN files (default 14) and prunes the rest.
  // Same lib that backs the admin UI + the yarn db:backup CLI — one
  // backup system, one filename convention, one directory.
  try {
    const { registerBackupSchedule } = await import('@/lib/backup');
    registerBackupSchedule(() => getDb());
  } catch (err) {
    console.warn('[Instrumentation] backup registration failed:', (err as Error).message);
  }

  // Register the recurring_jobs scheduler — wakes every 60s, picks
  // jobs whose next_run_at has elapsed, dispatches each via
  // dispatchScope. See specs/scope-keyed-sessions.md §4.
  try {
    const { ensureRecurringSchedulerStarted } = await import(
      '@/lib/agents/recurring-scheduler'
    );
    ensureRecurringSchedulerStarted();
  } catch (err) {
    console.warn(
      '[Instrumentation] recurring-jobs scheduler registration failed:',
      (err as Error).message,
    );
  }
}
