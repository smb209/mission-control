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
}
