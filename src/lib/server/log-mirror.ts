/**
 * Tee process.stdout/stderr to a file so dev-server logs survive HMR
 * reloads, preview-tool buffer wraps, and clean restarts. Called once at
 * boot from `instrumentation.ts` after the nodejs-runtime guard, so the
 * `node:fs` / `node:path` imports here never reach the Edge-runtime
 * analyzer.
 *
 * Gating: explicit `MC_LOG_FILE` env var wins; otherwise dev defaults to
 * `/tmp/mc-dev.log`. Production stays opt-in to avoid filling disks.
 *
 * Pairs with the `api.error` channel in `debug_events` (structured
 * route errors in SQLite). This file captures everything else —
 * framework noise, route-handler `console.log`, third-party deps.
 */

// Wrap dynamic imports through a Function constructor so Next.js's
// Edge-runtime static analyzer doesn't flag `node:fs` / `node:path`.
// This file is only ever reached from instrumentation.ts after the
// `NEXT_RUNTIME === 'nodejs'` guard, so the disguise is safe.
const dynImport = new Function('m', 'return import(m)') as <T>(m: string) => Promise<T>;

interface GlobalWithFlag {
  __mcLogMirrorInstalled?: boolean;
}

export async function installLogMirror(): Promise<{ path: string; installed: boolean } | null> {
  const explicit = process.env.MC_LOG_FILE;
  const inDev = process.env.NODE_ENV !== 'production';
  const logPath = explicit && explicit.trim() !== ''
    ? explicit
    : inDev ? '/tmp/mc-dev.log' : null;
  if (!logPath) return null;

  const g = globalThis as GlobalWithFlag;
  if (g.__mcLogMirrorInstalled) return { path: logPath, installed: false };

  const fs = await dynImport<typeof import('node:fs')>('node:fs');
  const path = await dynImport<typeof import('node:path')>('node:path');
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const stream = fs.createWriteStream(logPath, { flags: 'a' });

  const tee =
    (orig: typeof process.stdout.write) =>
    ((
      chunk: Uint8Array | string,
      enc?: BufferEncoding | ((err?: Error | null) => void),
      cb?: (err?: Error | null) => void,
    ) => {
      try {
        stream.write(chunk as Uint8Array | string);
      } catch {
        /* never break the writer */
      }
      return orig(chunk as never, enc as never, cb as never);
    }) as typeof process.stdout.write;

  process.stdout.write = tee(process.stdout.write.bind(process.stdout));
  process.stderr.write = tee(process.stderr.write.bind(process.stderr));
  g.__mcLogMirrorInstalled = true;
  stream.write(`\n--- log mirror attached pid=${process.pid} at ${new Date().toISOString()} ---\n`);
  return { path: logPath, installed: true };
}
