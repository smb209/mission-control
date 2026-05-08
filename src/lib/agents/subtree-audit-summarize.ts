/**
 * Standalone helper: render a parsed `audit_proposal` body as ~3-5
 * lines of prose, suitable for use as a parent-layer briefing summary
 * (childFindings) or as an L3 synthesizer briefing item.
 *
 * Lives in its own file to avoid a cycle between `audit-prompt.ts`
 * (which renders proposal summaries in the synthesizer briefing) and
 * `subtree-audit.ts` (which renders proposal summaries for parent-layer
 * childFindings and also imports `audit-prompt`).
 *
 * Re-exported from `subtree-audit.ts` so existing callers keep working.
 */

import type { AuditProposalBody } from '@/lib/agents/audit-proposals/schemas';

export function summarizeProposalForBriefing(body: AuditProposalBody): string {
  const lines: string[] = [];
  lines.push(
    `Proposed action: **${body.proposed_action}** (confidence: ${body.confidence}).`,
  );
  if (body.proposed_action === 'mark_done') {
    lines.push(`Completion note: ${body.proposed_changes.note}`);
  } else if (body.proposed_action === 'cancel') {
    lines.push(`Cancel reason: ${body.proposed_changes.reason}`);
  } else if (body.proposed_action === 'modify_scope') {
    const parts: string[] = [];
    if (body.proposed_changes.title) parts.push(`title→"${body.proposed_changes.title}"`);
    if (body.proposed_changes.description) parts.push('description updated');
    lines.push(`Scope change: ${parts.join(', ')}`);
  } else if (body.proposed_action === 'modify_dates') {
    const parts: string[] = [];
    if (body.proposed_changes.target_start)
      parts.push(`target_start→${body.proposed_changes.target_start}`);
    if (body.proposed_changes.target_end)
      parts.push(`target_end→${body.proposed_changes.target_end}`);
    lines.push(`Date change: ${parts.join(', ')}`);
  }
  // Rationale — keep first ~240 chars.
  const r = body.rationale.trim();
  lines.push(`Rationale: ${r.length > 240 ? r.slice(0, 240) + '…' : r}`);
  if (body.would_confirm_by && body.would_confirm_by.trim()) {
    lines.push(`Would confirm by: ${body.would_confirm_by.trim()}`);
  }
  const evCount = body.repo_evidence.length;
  lines.push(`Evidence: ${evCount} ref${evCount === 1 ? '' : 's'}.`);
  return lines.join('\n');
}
