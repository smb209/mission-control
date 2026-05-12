/**
 * Workspace conventions variable substitution.
 *
 * Postman-style `{{token}}` syntax replaces declared tokens with values
 * pulled from the workspace row. Used by:
 *   - <AgentPromptPreview> on the settings page
 *   - get_workspace_context MCP tool
 *   - dispatch route (src/app/api/tasks/[id]/dispatch/route.ts)
 *
 * Behavior:
 *   - Known token, value present → expanded.
 *   - Known token, value missing/empty → expanded to '' silently.
 *     (Settings preview separately decorates these as ⚠️ chips.)
 *   - Unknown token → left as the literal `{{whatever}}` so typos are
 *     visible at render time.
 *
 * See docs/reference/workspace-conventions-structured.md §3.
 */

/** Tokens the resolver knows about. Keep sorted; add new ones explicitly. */
export const KNOWN_VARIABLES = [
  'base_branch',
  'deliverables',
  'name',
  'repo_url',
  'working_dir',
] as const;

export type KnownVariable = (typeof KNOWN_VARIABLES)[number];

export interface VariableSource {
  /** Workspace display name (workspaces.name). */
  name: string;
  /** Resolved working tree path (workspaces.workspace_path or env default). */
  working_dir: string;
  /** Deliverables path. Falls back to working_dir when not set. */
  deliverables?: string | null;
  /** Repo URL. Optional — null/empty ⇒ '' substitution + preview warning. */
  repo_url?: string | null;
  /** Default base branch. Optional. */
  base_branch?: string | null;
}

const TOKEN_RE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

function lookup(varName: string, src: VariableSource): string | null {
  switch (varName) {
    case 'name':
      return src.name ?? '';
    case 'working_dir':
      return src.working_dir ?? '';
    case 'deliverables':
      // deliverables falls back to working_dir per spec §1.
      return (src.deliverables && src.deliverables.trim()) || src.working_dir || '';
    case 'repo_url':
      return src.repo_url ?? '';
    case 'base_branch':
      return src.base_branch ?? '';
    default:
      return null;
  }
}

/**
 * Resolve all `{{token}}` occurrences in `text`.
 *
 * `text` may be null/undefined → returns ''.
 *
 * Unknown tokens are preserved verbatim (a regex lookup miss returns
 * null, and we slot back the original match).
 */
export function resolveVariables(
  text: string | null | undefined,
  src: VariableSource,
): string {
  if (!text) return '';
  return text.replace(TOKEN_RE, (match, varName: string) => {
    const value = lookup(varName, src);
    if (value === null) return match;
    return value;
  });
}

export interface VariableUsage {
  variable: string;
  /** Whether the resolver knows this token. */
  known: boolean;
  /**
   * Whether the resolved value is empty (only meaningful when known).
   * The settings preview pane uses this to render `⚠️ {{x}} (empty)`
   * chips so operators can see what won't expand at dispatch time.
   */
  empty?: boolean;
}

/**
 * Inventory the `{{...}}` tokens in `text`. Used by the settings page
 * to render warning chips for unknown / empty variables alongside the
 * preview pane. Order matches first appearance; duplicates collapsed.
 */
export function inventoryVariables(
  text: string | null | undefined,
  src: VariableSource,
): VariableUsage[] {
  if (!text) return [];
  const out: VariableUsage[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(TOKEN_RE)) {
    const varName = m[1];
    if (seen.has(varName)) continue;
    seen.add(varName);
    const value = lookup(varName, src);
    if (value === null) {
      out.push({ variable: varName, known: false });
    } else {
      out.push({
        variable: varName,
        known: true,
        empty: value.trim().length === 0,
      });
    }
  }
  return out;
}
