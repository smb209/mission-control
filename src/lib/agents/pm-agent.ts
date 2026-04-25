/**
 * PM agent definition + soul_md loader.
 *
 * Phase 5 of the roadmap & PM-agent feature (specs/roadmap-and-pm-spec.md).
 * The PM is a planning-layer agent: one per workspace, role='pm', seeded
 * via migration. It reacts to operator-dropped disruptions and produces
 * `pm_proposals` rows. It never writes to the execution board.
 *
 * The system prompt is kept in `pm-soul.md` so it's readable and editable
 * without touching code. We read it at module init and bake it into the
 * exported constant — migrations call `getPmSoulMd()` synchronously and
 * the file lives next to this module.
 */

import fs from 'node:fs';
import path from 'node:path';

let _cache: string | null = null;

/**
 * Returns the PM agent's system prompt (soul_md) loaded from
 * `pm-soul.md`. Cached after first read. If the file is missing
 * (shouldn't happen in production — it's part of the source tree), we fall
 * back to a stub so seeds still succeed and the operator can fix it later.
 */
export function getPmSoulMd(): string {
  if (_cache) return _cache;
  try {
    // __dirname-equivalent for both bundled and unbundled callers. In
    // dev/test the file resolves alongside this TS file; under
    // `next build` the assets are co-located via the standalone bundler.
    const filePath = path.join(__dirname, 'pm-soul.md');
    _cache = fs.readFileSync(filePath, 'utf8');
  } catch {
    _cache = PM_SOUL_FALLBACK;
  }
  return _cache!;
}

/**
 * Hardcoded fallback — keeps seeds working even when the .md file isn't
 * reachable from the bundle path (e.g. some Next.js packaging modes). This
 * is intentionally a short summary rather than the full prompt; if the
 * file ever becomes unreadable in production we want the operator to
 * notice.
 */
const PM_SOUL_FALLBACK = `# PM Agent (fallback prompt)

You are the workspace PM. Read the roadmap snapshot, analyze the
operator's disruption, and call \`propose_changes\` with an impact
summary plus a structured diff. Never edit the execution board directly.
This is a stub fallback prompt; restore src/lib/agents/pm-soul.md to use
the full version.`;

export const PM_AGENT_NAME = 'PM';
export const PM_AGENT_AVATAR = '📋';
export const PM_AGENT_ROLE = 'pm';
export const PM_AGENT_DESCRIPTION =
  'Workspace project manager — maintains the roadmap, analyzes disruptions, proposes structured changes the operator approves.';
