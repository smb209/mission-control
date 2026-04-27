/**
 * Pure-string helpers for the `<!--pm-plan-suggestions {json} -->`
 * sidecar embedded in plan_initiative impact_md. Lives in its own
 * module so client components can import it without dragging in the
 * server-only DB layer that the apply helper depends on.
 */

export interface PlanInitiativeSuggestionsBlob {
  refined_description?: string | null;
  complexity?: 'S' | 'M' | 'L' | 'XL' | null;
  target_start?: string | null;
  target_end?: string | null;
  status_check_md?: string | null;
  owner_agent_id?: string | null;
  dependencies?: Array<{
    depends_on_initiative_id: string;
    kind?: 'finish_to_start' | 'start_to_start' | 'blocking' | 'informational';
    note?: string | null;
  }>;
}

/**
 * Single regex that matches both the canonical `<!--pm-plan-suggestions
 * {json} -->` sidecar AND stylized variants the PM agent sometimes
 * emits (em-dash `—` instead of `--`, en-dash `–`). Markdown renderers
 * only strip the canonical form, so the stylized variants leak through
 * as visible JSON in the chat — both for parsing AND for rendering, we
 * want to recognize them all.
 */
const SIDECAR_PATTERN_GLOBAL =
  /<!(?:--|—|–)\s*pm-plan-suggestions\s+([\s\S]*?)\s*(?:--|—|–)>/g;

/**
 * Extract a JSON object string from arbitrary text. Uses a greedy match
 * from the first `{` to the last `}` — safe for PM-generated markdown
 * which doesn't contain bare `}` outside JSON blocks.
 */
function extractLeadingJsonObject(text: string): string | null {
  if (!text.trimStart().startsWith('{')) return null;
  const m = text.match(/(\{[\s\S]*\})/);
  return m ? m[1] : null;
}

/**
 * Pull the suggestions blob out of an impact_md string. Returns null
 * when no sidecar matches or the JSON is malformed.
 *
 * Handles two malformed variants the PM agent produces:
 *
 *   Pattern A (inline garbage):
 *     <!--pm-plan-suggestions {JSON}'><!--pm-plan-suggestions end-->
 *     The regex captures `{JSON}'>...end`; we strip the trailing garbage
 *     by extracting just the leading `{...}` object.
 *
 *   Pattern B (empty tag, JSON outside):
 *     <!--pm-plan-suggestions-->
 *     { "refined_description": "...", ... }
 *     The comment closes immediately; the JSON sits on the next line(s)
 *     outside any comment. The canonical regex never matches because
 *     `\s+` requires content inside the tag.
 */
export function parseSuggestionsFromImpactMd(
  md: string,
): PlanInitiativeSuggestionsBlob | null {
  // Pattern A: JSON inside the comment (canonical + stylized dash variants).
  const m = md.match(/<!(?:--|—|–)\s*pm-plan-suggestions\s+([\s\S]*?)\s*(?:--|—|–)>/);
  if (m) {
    const raw = m[1].trim();
    try {
      return JSON.parse(raw) as PlanInitiativeSuggestionsBlob;
    } catch {
      const extracted = extractLeadingJsonObject(raw);
      if (extracted) {
        try {
          return JSON.parse(extracted) as PlanInitiativeSuggestionsBlob;
        } catch { /* fall through */ }
      }
    }
  }

  // Pattern B: empty `<!--pm-plan-suggestions-->` tag, JSON follows outside.
  const emptyTagIdx = md.indexOf('<!--pm-plan-suggestions-->');
  if (emptyTagIdx !== -1) {
    const afterTag = md.slice(emptyTagIdx + '<!--pm-plan-suggestions-->'.length).trimStart();
    const extracted = extractLeadingJsonObject(afterTag);
    if (extracted) {
      try {
        return JSON.parse(extracted) as PlanInitiativeSuggestionsBlob;
      } catch { /* fall through */ }
    }
  }

  return null;
}

/**
 * Remove every pm-plan-suggestions sidecar from a markdown string for
 * display purposes. Handles canonical, stylized, and empty-tag variants.
 * Trims leftover blank lines so the output reads clean.
 */
export function stripSuggestionsSidecar(md: string): string {
  // Strip Pattern A: JSON inside the comment.
  let result = md.replace(SIDECAR_PATTERN_GLOBAL, '');
  // Strip Pattern B: empty tag + JSON block immediately following.
  result = result.replace(/<!--pm-plan-suggestions-->\s*\{[\s\S]*?\}(?=\s*\n\n|\s*$|\s*\n[^{])/g, '');
  // Fallback: bare empty tag with no JSON (already stripped if JSON matched above).
  result = result.replace(/<!--pm-plan-suggestions-->/g, '');
  return result.replace(/\n{3,}/g, '\n\n').trim();
}
