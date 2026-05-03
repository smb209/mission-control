/**
 * GET /api/agent-notes
 *
 * Read-side for the agent notes spine. Mirrors the MCP `read_notes` tool
 * filter shape so UI consumers can fetch initial state, then keep
 * themselves up to date via SSE `agent_note_*` events.
 *
 * See specs/scope-keyed-sessions.md §3 for context. POST is intentionally
 * not exposed — agents create notes via MCP `take_note`, not via HTTP.
 */

import { NextRequest, NextResponse } from 'next/server';
import { queryAll } from '@/lib/db';
import {
  listNotes,
  parseAttachedFiles,
  parseConsumedStages,
  type AgentNote,
  type NoteImportance,
  type NoteKind,
} from '@/lib/db/agent-notes';

const VALID_KINDS: ReadonlyArray<NoteKind> = [
  'discovery',
  'blocker',
  'uncertainty',
  'decision',
  'observation',
  'question',
  'breadcrumb',
];

function notePayload(note: AgentNote): Record<string, unknown> {
  return {
    id: note.id,
    workspace_id: note.workspace_id,
    agent_id: note.agent_id,
    task_id: note.task_id,
    initiative_id: note.initiative_id,
    scope_key: note.scope_key,
    role: note.role,
    run_group_id: note.run_group_id,
    kind: note.kind,
    audience: note.audience,
    body: note.body,
    attached_files: parseAttachedFiles(note),
    importance: note.importance,
    consumed_by_stages: parseConsumedStages(note),
    archived_at: note.archived_at,
    created_at: note.created_at,
  };
}

function parseImportance(raw: string | null): NoteImportance | undefined {
  if (raw === null) return undefined;
  const n = Number(raw);
  if (n === 0 || n === 1 || n === 2) return n;
  return undefined;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const { searchParams } = new URL(req.url);

  const workspaceId = searchParams.get('workspace_id') ?? undefined;
  const taskId = searchParams.get('task_id') ?? undefined;
  const initiativeId = searchParams.get('initiative_id') ?? undefined;
  const audience = searchParams.get('audience') ?? undefined;
  const scopeKey = searchParams.get('scope_key') ?? undefined;
  const runGroupId = searchParams.get('run_group_id') ?? undefined;
  const includeArchived = searchParams.get('include_archived') === 'true';
  const orderRaw = searchParams.get('order');
  const order = orderRaw === 'desc' ? 'desc' : orderRaw === 'asc' ? 'asc' : undefined;
  const minImportance = parseImportance(searchParams.get('min_importance'));
  const limitRaw = searchParams.get('limit');
  const limit = limitRaw ? Math.min(Math.max(parseInt(limitRaw, 10) || 50, 1), 200) : undefined;

  const kindsRaw = searchParams.getAll('kind');
  const kinds = kindsRaw.length > 0
    ? kindsRaw.filter((k): k is NoteKind => VALID_KINDS.includes(k as NoteKind))
    : undefined;

  if (!workspaceId && !taskId && !initiativeId) {
    return NextResponse.json(
      { error: 'must filter by workspace_id, task_id, or initiative_id' },
      { status: 400 },
    );
  }

  const includeChildTasks = searchParams.get('include_child_tasks') === 'true';

  // Initiative rollup: union of (notes for this initiative) +
  // (notes for tasks under this initiative). The hook's initiative
  // detail panel uses this so an operator viewing an initiative sees
  // activity across all child tasks.
  let notes: AgentNote[];
  if (initiativeId && includeChildTasks) {
    const directNotes = listNotes({
      workspace_id: workspaceId,
      initiative_id: initiativeId,
      audience,
      scope_key: scopeKey,
      run_group_id: runGroupId,
      kinds,
      include_archived: includeArchived,
      min_importance: minImportance,
      limit,
      order,
    });
    const childTaskIds = queryAll<{ id: string }>(
      `SELECT id FROM tasks WHERE initiative_id = ?`,
      [initiativeId],
    ).map((r) => r.id);
    const taskNotes: AgentNote[] = [];
    for (const tid of childTaskIds) {
      const partial = listNotes({
        workspace_id: workspaceId,
        task_id: tid,
        audience,
        scope_key: scopeKey,
        run_group_id: runGroupId,
        kinds,
        include_archived: includeArchived,
        min_importance: minImportance,
        limit: 50,
        order,
      });
      taskNotes.push(...partial);
    }
    // Dedupe + cap to limit, importance DESC then created_at order.
    const merged = [...directNotes, ...taskNotes];
    const seen = new Set<string>();
    const dedup = merged.filter((n) => {
      if (seen.has(n.id)) return false;
      seen.add(n.id);
      return true;
    });
    dedup.sort((a, b) => {
      if (a.importance !== b.importance) return b.importance - a.importance;
      const dir = order === 'desc' ? -1 : 1;
      return a.created_at.localeCompare(b.created_at) * dir;
    });
    notes = dedup.slice(0, limit ?? 50);
  } else {
    notes = listNotes({
      workspace_id: workspaceId,
      task_id: taskId,
      initiative_id: initiativeId,
      audience,
      scope_key: scopeKey,
      run_group_id: runGroupId,
      kinds,
      include_archived: includeArchived,
      min_importance: minImportance,
      limit,
      order,
    });
  }

  return NextResponse.json({
    count: notes.length,
    notes: notes.map(notePayload),
  });
}
