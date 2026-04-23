/**
 * Server-side loopback fetch to POST /api/tasks/[id]/dispatch.
 *
 * Consolidates what used to be copy-pasted into planning-persist.ts,
 * force-complete/route.ts, agent-health.ts, and autopilot/swipe.ts — each
 * with its own timeout, its own error swallowing, and its own IPv6
 * landmine. Having one helper means one place to fix when the next
 * network quirk shows up and one place to look at when a dispatch
 * mysteriously fails.
 *
 * Known failure modes this guards against:
 * - Node undici resolves `localhost` to ::1 first; Next dev binds IPv4
 *   only on macOS by default → `fetch failed` with no status. Coerce
 *   localhost → 127.0.0.1 before calling.
 * - The dispatch route is heavy (OpenClaw session setup, knowledge
 *   fetch, workspace creation, mailbox flush, git ops). 30s is too
 *   tight in Docker; 120s is the current budget.
 * - AbortError/TimeoutError/ECONNREFUSED all bubble up as a bare
 *   "fetch failed" on undici unless you dig into `err.cause`. We
 *   unwrap it so the surfaced error is actionable.
 */

import { getMissionControlUrl } from './config';

/** Structured dispatch result. `error` is a human-readable string with the
 *  underlying cause appended when present (e.g. "fetch failed (AbortError:
 *  ...)"). `url` and `status` are included for log-site correlation. */
export interface InternalDispatchResult {
  success: boolean;
  status?: number;
  error?: string;
  url: string;
}

/**
 * Dispatch a task by POSTing to the internal /api/tasks/{id}/dispatch.
 *
 * @param taskId - task to dispatch
 * @param opts.caller - string tag included in log lines so you can tell
 *   which caller fired the dispatch (lock, health, force-complete, ...)
 * @param opts.timeoutMs - override default 120s timeout
 */
export async function internalDispatch(
  taskId: string,
  opts: { caller: string; timeoutMs?: number } = { caller: 'unknown' }
): Promise<InternalDispatchResult> {
  const caller = opts.caller || 'unknown';
  const timeoutMs = opts.timeoutMs ?? 120_000;

  // Coerce localhost → 127.0.0.1 to dodge IPv4/IPv6 binding mismatches.
  const rawUrl = getMissionControlUrl();
  const missionControlUrl = rawUrl.replace(
    /^(https?:\/\/)localhost(?=[:/]|$)/i,
    '$1127.0.0.1'
  );
  const url = `${missionControlUrl}/api/tasks/${taskId}/dispatch`;

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (process.env.MC_API_TOKEN) {
    headers['Authorization'] = `Bearer ${process.env.MC_API_TOKEN}`;
  }

  const startedAt = Date.now();
  console.log(`[InternalDispatch:${caller}] POST ${url} (rawUrl=${rawUrl}, timeout=${timeoutMs}ms)`);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const elapsed = Date.now() - startedAt;

    if (res.ok) {
      console.log(`[InternalDispatch:${caller}] OK in ${elapsed}ms (status=${res.status})`);
      return { success: true, status: res.status, url };
    }

    const body = await res.text().catch(() => '');
    const error = `Dispatch returned ${res.status}: ${body.slice(0, 400)}`;
    console.error(`[InternalDispatch:${caller}] FAIL after ${elapsed}ms — ${error}`);
    return { success: false, status: res.status, error, url };
  } catch (err) {
    const elapsed = Date.now() - startedAt;
    const e = err as Error & {
      cause?: { code?: string; errno?: string; syscall?: string; message?: string; name?: string };
      name?: string;
    };
    // Unwrap the undici "fetch failed" wrapper so callers see the real cause.
    const causeParts: string[] = [];
    if (e.name && e.name !== 'Error') causeParts.push(e.name);
    if (e.cause?.name) causeParts.push(e.cause.name);
    if (e.cause?.code) causeParts.push(e.cause.code);
    if (e.cause?.syscall) causeParts.push(`syscall=${e.cause.syscall}`);
    if (e.cause?.message) causeParts.push(e.cause.message);

    const detail = causeParts.length > 0 ? ` (${causeParts.join(' · ')})` : '';
    const error = `${e.message}${detail}`;
    console.error(
      `[InternalDispatch:${caller}] THREW after ${elapsed}ms — ${error}`,
      // Full stack/cause tree for deep debugging — visible in Docker logs.
      { url, name: e.name, cause: e.cause, stack: e.stack }
    );
    return { success: false, error, url };
  }
}
