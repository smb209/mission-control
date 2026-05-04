import { NextRequest, NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { queryOne, run, transaction } from '@/lib/db';
import { loadAgentTemplate, AGENT_TEAM_PRESETS } from '@/lib/agent-templates';
import type { Agent } from '@/lib/types';

export const dynamic = 'force-dynamic';

interface FromTemplateBody {
  workspace_id: string;
  /** Inline list of {role, as_pm?} OR a preset id. Exactly one must be set. */
  roles?: Array<{ role: string; as_pm?: boolean; name?: string }>;
  preset_id?: string;
}

// POST /api/agents/from-template
// Bulk-create agents from `agent-templates/<role>/` content. Used by
// the +Add Agent chooser; one transaction so a partial failure
// (e.g. a missing template) rolls everything back.
//
// Idempotency note: this is a fresh-create path. Re-submitting the
// same body will create duplicates — the chooser UI is responsible
// for not double-clicking.
export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as FromTemplateBody;
    const workspaceId = body.workspace_id || 'default';
    if (!body.roles?.length && !body.preset_id) {
      return NextResponse.json({ error: 'roles or preset_id is required' }, { status: 400 });
    }

    const rolesToCreate = body.preset_id
      ? AGENT_TEAM_PRESETS.find(p => p.id === body.preset_id)?.roles
      : body.roles;
    if (!rolesToCreate || rolesToCreate.length === 0) {
      return NextResponse.json({ error: 'No roles to create' }, { status: 400 });
    }

    // Pre-load all templates before opening the transaction so a
    // missing template fails the whole call cleanly. Templates are
    // filesystem reads (async); the transaction body is sync.
    const loaded: Array<{
      role: string;
      as_pm: boolean;
      name?: string;
      tmpl: NonNullable<Awaited<ReturnType<typeof loadAgentTemplate>>>;
    }> = [];
    for (const r of rolesToCreate) {
      const tmpl = await loadAgentTemplate(r.role);
      if (!tmpl) {
        return NextResponse.json(
          { error: `No template found for role "${r.role}"` },
          { status: 400 },
        );
      }
      loaded.push({
        role: r.role,
        as_pm: !!r.as_pm,
        name: 'name' in r ? (r as { name?: string }).name : undefined,
        tmpl,
      });
    }

    // Reject if any preset/role flags is_pm but the workspace already
    // has a PM. Operator can rename / re-flag the existing PM via the
    // agent page if they actually want to swap.
    if (loaded.some(l => l.as_pm)) {
      const existingPm = queryOne<{ id: string; name: string }>(
        `SELECT id, name FROM agents WHERE workspace_id = ? AND is_pm = 1 LIMIT 1`,
        [workspaceId],
      );
      if (existingPm) {
        // Demote the as_pm flag — keep agents created, but don't
        // collide with the workspace's existing PM. (Preset still
        // creates the persona; operator promotes manually later.)
        for (const l of loaded) l.as_pm = false;
      }
    }

    const created: Agent[] = [];
    transaction(() => {
      const now = new Date().toISOString();
      for (const l of loaded) {
        const id = uuidv4();
        const name = l.name?.trim() || l.tmpl.display_name;
        const isPmInt = l.as_pm ? 1 : 0;
        run(
          `INSERT INTO agents (id, name, role, description, avatar_emoji, is_master, is_pm, workspace_id, soul_md, user_md, agents_md, model, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            id,
            name,
            // Lowercase 'pm' for the resolver's legacy fallback;
            // other roles pass through verbatim.
            l.role === 'pm' ? 'pm' : l.role,
            l.tmpl.blurb || null,
            l.tmpl.emoji,
            l.role === 'pm' || l.as_pm ? 1 : 0,
            isPmInt,
            workspaceId,
            l.tmpl.soul_md || null,
            null,
            l.tmpl.agents_md || null,
            null,
            now,
            now,
          ],
        );
        // One-PM-per-workspace: clear is_pm on any prior PM in this
        // workspace when promoting a new one.
        if (isPmInt) {
          run(
            `UPDATE agents SET is_pm = 0 WHERE workspace_id = ? AND id != ?`,
            [workspaceId, id],
          );
        }
        const row = queryOne<Agent>('SELECT * FROM agents WHERE id = ?', [id]);
        if (row) created.push(row);
      }
    });

    return NextResponse.json({ created }, { status: 201 });
  } catch (error) {
    console.error('Failed to create agents from template:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to create agents' },
      { status: 500 },
    );
  }
}
