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
 * Pull the suggestions blob out of an impact_md string. Returns null
 * when no sidecar matches or the JSON is malformed.
 *
 * Handles a malformed variant the PM agent sometimes produces:
 *   <!--pm-plan-suggestions {JSON}'><!--pm-plan-suggestions end-->
 * In that case the regex captures `{JSON}'>...end` — we fall back to
 * extracting the leading balanced JSON object (`{...}`) from the capture.
 */
export function parseSuggestionsFromImpactMd(
  md: string,
): PlanInitiativeSuggestionsBlob | null {
  // Use a single-shot non-global copy of the pattern (regex.exec on a
  // shared global keeps state in `lastIndex`).
  const m = md.match(/<!(?:--|—|–)\s*pm-plan-suggestions\s+([\s\S]*?)\s*(?:--|—|–)>/);
  if (!m) return null;
  const raw = m[1].trim();
  try {
    return JSON.parse(raw) as PlanInitiativeSuggestionsBlob;
  } catch {
    // Malformed sidecar — try to extract just the leading JSON object.
    // `\{[\s\S]*\}` is greedy so it backtracks to the LAST `}`, which is
    // the closing brace of the JSON rather than any garbage that follows.
    const objMatch = raw.match(/^(\{[\s\S]*\})/);
    if (objMatch) {
      try {
        return JSON.parse(objMatch[1]) as PlanInitiativeSuggestionsBlob;
      } catch { /* fall through */ }
    }
    return null;
  }
}

/**
 * Remove every pm-plan-suggestions sidecar from a markdown string for
 * display purposes. Handles canonical and stylized variants. Trims any
 * leftover blank lines so the output reads clean.
 */
export function stripSuggestionsSidecar(md: string): string {
  return md.replace(SIDECAR_PATTERN_GLOBAL, '').replace(/\n{3,}/g, '\n\n').trim();
}
