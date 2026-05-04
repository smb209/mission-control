/**
 * Read role personas from the in-repo `agent-templates/<role>/`
 * directory tree. Used by the +Add Agent chooser UX so the operator
 * can spawn a new agent pre-populated with SOUL/AGENTS/IDENTITY
 * markdown for a known role instead of starting blank.
 *
 * Filesystem layout per role: SOUL.md, AGENTS.md, IDENTITY.md.
 * `_shared/` and `runner-host/` are excluded — `_shared` is briefing
 * addenda, `runner-host` is the neutral gateway-agent template
 * (operators don't pick that as a persona; it's auto-managed).
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(process.cwd());
const TEMPLATES_DIR = path.join(REPO_ROOT, 'agent-templates');
const EXCLUDED = new Set(['_shared', 'runner-host']);

export interface AgentTemplate {
  role: string;
  /** Display name extracted from IDENTITY.md `**Name:**` line, falling
   *  back to a Title Case rendering of the role slug. */
  display_name: string;
  /** Single-emoji extracted from IDENTITY.md `**Emoji:**` line, falling
   *  back to a per-role default. */
  emoji: string;
  /** One-line blurb derived from IDENTITY.md `**Vibe:**` line, or the
   *  first non-meta sentence of SOUL.md. Used for grid card subtitle. */
  blurb: string;
  /** Full markdown bodies fed straight into `agents.{soul_md,agents_md}`
   *  on creation. IDENTITY.md content is folded into soul_md (the
   *  operator can split it later if they want; the briefing pipeline
   *  treats them as a single role section anyway). */
  soul_md: string;
  agents_md: string;
}

const ROLE_EMOJI_FALLBACK: Record<string, string> = {
  pm: '🧭',
  coordinator: '🧩',
  builder: '⚡',
  researcher: '🔍',
  tester: '🧪',
  reviewer: '🔎',
  writer: '✍️',
  learner: '🧠',
};

function extractField(md: string, label: string): string | null {
  // Matches `**Label:** value` (case-sensitive label, single emoji or short value on the line).
  const re = new RegExp(`\\*\\*${label}:\\*\\*\\s*(.+?)\\s*$`, 'm');
  const m = re.exec(md);
  return m ? m[1].trim() : null;
}

function firstSentence(md: string): string {
  // Skip frontmatter-ish header lines; grab the first prose sentence.
  for (const raw of md.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#')) continue;
    if (line.startsWith('**')) continue;
    if (line.startsWith('---')) continue;
    // Truncate at first sentence-ending punctuation.
    const m = /^([^.!?\n]+[.!?])/.exec(line);
    return (m ? m[1] : line).slice(0, 200);
  }
  return '';
}

async function readIfExists(p: string): Promise<string> {
  try {
    return await fs.readFile(p, 'utf8');
  } catch {
    return '';
  }
}

async function loadOne(role: string): Promise<AgentTemplate | null> {
  const dir = path.join(TEMPLATES_DIR, role);
  const stat = await fs.stat(dir).catch(() => null);
  if (!stat?.isDirectory()) return null;

  const [soul, agents, identity] = await Promise.all([
    readIfExists(path.join(dir, 'SOUL.md')),
    readIfExists(path.join(dir, 'AGENTS.md')),
    readIfExists(path.join(dir, 'IDENTITY.md')),
  ]);
  if (!soul && !agents && !identity) return null;

  const display_name =
    extractField(identity, 'Name') ?? role.charAt(0).toUpperCase() + role.slice(1);
  const emoji = extractField(identity, 'Emoji') ?? ROLE_EMOJI_FALLBACK[role] ?? '🤖';
  const blurb =
    extractField(identity, 'Vibe') ?? firstSentence(soul) ?? `${role} agent`;

  // Fold IDENTITY.md into the head of soul_md so the agent's persona
  // block (which renders soul/user/agents) carries identity context
  // without losing it.
  const soul_md = identity ? `${identity.trim()}\n\n---\n\n${soul.trim()}` : soul.trim();

  return {
    role,
    display_name,
    emoji,
    blurb: blurb.slice(0, 140),
    soul_md,
    agents_md: agents.trim(),
  };
}

export async function listAgentTemplates(): Promise<AgentTemplate[]> {
  const entries = await fs.readdir(TEMPLATES_DIR).catch(() => [] as string[]);
  const roles = entries.filter(e => !EXCLUDED.has(e) && !e.startsWith('.') && !e.endsWith('.md'));
  const loaded = await Promise.all(roles.map(loadOne));
  return loaded.filter((t): t is AgentTemplate => t !== null);
}

export async function loadAgentTemplate(role: string): Promise<AgentTemplate | null> {
  if (EXCLUDED.has(role)) return null;
  return loadOne(role);
}

/**
 * Curated team presets surfaced in the +Add Agent chooser. Operator
 * picks one and MC creates the listed roles in a single bulk call.
 * The PM in each preset is flagged as the workspace PM — the
 * one-PM-per-workspace invariant in `/api/agents` PATCH applies on
 * insert.
 */
export interface AgentTeamPreset {
  id: string;
  name: string;
  description: string;
  /** Roles to create, in order. The first role flagged `as_pm: true`
   *  becomes the workspace PM; others land as standby agents. */
  roles: Array<{ role: string; as_pm?: boolean }>;
}

export const AGENT_TEAM_PRESETS: AgentTeamPreset[] = [
  {
    id: 'pm-only',
    name: 'PM only',
    description: 'Just a project manager. Lightest setup — every workspace needs one.',
    roles: [{ role: 'pm', as_pm: true }],
  },
  {
    id: 'build-and-ship',
    name: 'Build & ship',
    description: 'PM + builder + tester + reviewer. The standard delivery loop.',
    roles: [
      { role: 'pm', as_pm: true },
      { role: 'builder' },
      { role: 'tester' },
      { role: 'reviewer' },
    ],
  },
  {
    id: 'research-and-write',
    name: 'Research & write',
    description: 'PM + researcher + writer. Discovery-heavy work that ends in a doc.',
    roles: [
      { role: 'pm', as_pm: true },
      { role: 'researcher' },
      { role: 'writer' },
    ],
  },
  {
    id: 'full-stack',
    name: 'Full team',
    description: 'PM + coordinator + builder + tester + reviewer + researcher + writer + learner.',
    roles: [
      { role: 'pm', as_pm: true },
      { role: 'coordinator' },
      { role: 'builder' },
      { role: 'tester' },
      { role: 'reviewer' },
      { role: 'researcher' },
      { role: 'writer' },
      { role: 'learner' },
    ],
  },
];
