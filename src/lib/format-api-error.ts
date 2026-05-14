/**
 * Format an API error response that may include structured `hints`
 * (validation detail) alongside the top-level `error` string.
 *
 * Background: `PmProposalValidationError` carries a summary message
 * (e.g. "Invalid proposed_changes: 1 error(s)") plus a `hints: string[]`
 * with the actual per-diff failures (e.g. "[pm-convoy-mandate]
 * Decompose-flow proposals MUST use create_convoy_under_initiative, not
 * create_task_under_initiative."). API routes surface both as
 * `{ error, hints }` — but several call sites only render `error`, which
 * shows the operator a useless summary with no actionable detail.
 *
 * Pass the parsed response body and a fallback string (typically the
 * HTTP status); this returns a single human-readable message safe for
 * `setErr(...)` or `throw new Error(...)`.
 */
export function formatApiError(
  body: unknown,
  fallback: string,
): string {
  if (!body || typeof body !== 'object') return fallback;
  const b = body as { error?: unknown; hints?: unknown };
  const summary = typeof b.error === 'string' && b.error.length > 0 ? b.error : fallback;
  if (Array.isArray(b.hints) && b.hints.length > 0) {
    const lines = b.hints
      .filter((h): h is string => typeof h === 'string' && h.length > 0)
      .map((h) => `  • ${h}`)
      .join('\n');
    if (lines) return `${summary}\n${lines}`;
  }
  return summary;
}
