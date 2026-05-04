import { NextResponse } from 'next/server';
import { AGENT_TEAM_PRESETS, listAgentTemplates } from '@/lib/agent-templates';

export const dynamic = 'force-dynamic';

// GET /api/agent-templates
// Lists role templates (read from the in-repo agent-templates/ tree)
// and curated team presets. Used by the +Add Agent chooser UX so the
// operator can stand up a workspace's roster without typing
// SOUL/AGENTS/IDENTITY by hand.
export async function GET() {
  try {
    const templates = await listAgentTemplates();
    return NextResponse.json({
      templates: templates.map(t => ({
        role: t.role,
        display_name: t.display_name,
        emoji: t.emoji,
        blurb: t.blurb,
      })),
      presets: AGENT_TEAM_PRESETS,
    });
  } catch (error) {
    console.error('Failed to list agent templates:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to list templates' },
      { status: 500 },
    );
  }
}
