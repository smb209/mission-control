/**
 * Workspace conventions templates.
 *
 * Operator-pickable starter markdown for the conventions textarea. Each
 * template is a `.md` file in this directory with simple `--- key: value
 * ---` frontmatter. The body uses `{{...}}` variables that get resolved
 * at preview / dispatch time (see resolve-variables.ts).
 *
 * Templates are read at request time — no bundling step. Adding a new
 * template means dropping a `.md` file in this directory; nothing else
 * to wire.
 *
 * See specs/workspace-conventions-structured.md §4.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface WorkspaceTemplate {
  slug: string;
  title: string;
  description: string;
  intended_for: string;
  body: string;
}

const TEMPLATES_DIR = path.join(process.cwd(), 'src/lib/workspace-templates');

/**
 * Tiny frontmatter parser. We don't need a full YAML engine — every
 * template uses a stable subset (string-only top-level keys). Matches:
 *
 *     ---
 *     title: Code project
 *     description: Some text with: colons inside is fine
 *     ---
 *     <body>
 *
 * The body picks up everything after the closing fence. Leading newline
 * trimmed.
 */
function parseFrontmatter(raw: string): { fm: Record<string, string>; body: string } {
  const fm: Record<string, string> = {};
  if (!raw.startsWith('---')) {
    return { fm, body: raw };
  }
  // Find the closing fence on its own line.
  const lines = raw.split('\n');
  if (lines[0]?.trim() !== '---') return { fm, body: raw };
  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      endIdx = i;
      break;
    }
  }
  if (endIdx === -1) {
    // No closing fence; treat as no frontmatter to avoid swallowing the body.
    return { fm, body: raw };
  }
  for (let i = 1; i < endIdx; i++) {
    const line = lines[i];
    const m = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/);
    if (!m) continue;
    fm[m[1]] = m[2].trim();
  }
  // Trim a single leading newline after the closing fence so templates
  // can have a blank line after frontmatter without the body leading
  // with whitespace.
  let bodyStart = endIdx + 1;
  if (lines[bodyStart] === '') bodyStart += 1;
  return { fm, body: lines.slice(bodyStart).join('\n') };
}

/**
 * Read every `.md` file in the templates dir and parse frontmatter.
 * Files lacking required keys (title, description) are skipped with a
 * warning — never crash the request.
 */
export async function listTemplates(): Promise<WorkspaceTemplate[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(TEMPLATES_DIR);
  } catch (err) {
    console.error('[workspace-templates] cannot read templates dir', err);
    return [];
  }
  const out: WorkspaceTemplate[] = [];
  for (const fname of entries) {
    if (!fname.endsWith('.md')) continue;
    const slug = fname.replace(/\.md$/, '');
    const full = path.join(TEMPLATES_DIR, fname);
    let raw: string;
    try {
      raw = await fs.readFile(full, 'utf8');
    } catch (err) {
      console.warn(`[workspace-templates] failed to read ${fname}`, err);
      continue;
    }
    const { fm, body } = parseFrontmatter(raw);
    if (!fm.title || !fm.description) {
      console.warn(`[workspace-templates] ${fname} is missing title/description in frontmatter`);
      continue;
    }
    out.push({
      slug,
      title: fm.title,
      description: fm.description,
      intended_for: fm.intended_for ?? '',
      body: body.replace(/^\n+/, ''),
    });
  }
  // Stable ordering: blank first, then alphabetical by title for the rest.
  out.sort((a, b) => {
    if (a.slug === 'blank') return -1;
    if (b.slug === 'blank') return 1;
    return a.title.localeCompare(b.title);
  });
  return out;
}

export async function getTemplate(slug: string): Promise<WorkspaceTemplate | null> {
  const all = await listTemplates();
  return all.find((t) => t.slug === slug) ?? null;
}
