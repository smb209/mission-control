/**
 * Role-soul loader for stage-bound roles (builder / tester / reviewer).
 *
 * Unlike the PM soul (workspace-scoped, baked into the agent row at seed
 * time), role souls are stage definitions that any agent can play. They
 * are surfaced at dispatch time as part of the task message so the role
 * rules are always paired with the work the agent is being asked to do.
 *
 * The .md files live next to this module (`builder-soul.md`,
 * `tester-soul.md`, `reviewer-soul.md`). Read once and cached.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { RoleName } from '@/lib/gates/config';

const cache = new Map<RoleName, string>();

/** Returns the soul markdown for a role, or null if the file is missing. */
export function getRoleSoul(role: RoleName): string | null {
  const cached = cache.get(role);
  if (cached !== undefined) return cached;

  const candidates = [
    path.join(__dirname, `${role}-soul.md`),
    path.join(process.cwd(), 'src', 'lib', 'agents', `${role}-soul.md`),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      const md = fs.readFileSync(p, 'utf8');
      cache.set(role, md);
      return md;
    }
  }
  cache.set(role, '');
  return null;
}

/**
 * Format the role soul as a dispatch-ready section. Returns empty string
 * when the file is missing so the dispatch path can concatenate
 * unconditionally.
 */
export function formatRoleSoulSection(role: RoleName): string {
  const md = getRoleSoul(role);
  if (!md) return '';
  return `\n---\n**📜 ROLE: ${role.toUpperCase()} — read these rules before acting.**\n\n${md.trim()}\n`;
}
