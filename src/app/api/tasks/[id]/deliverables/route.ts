/**
 * Task Deliverables API
 * Endpoints for managing task deliverables (files, URLs, artifacts)
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { CreateDeliverableSchema, ReferenceDeliverableSchema } from '@/lib/validation';
import { logDebugEvent } from '@/lib/debug-log';
import { AuthzError } from '@/lib/authz/agent-task';
import { authzErrorResponse } from '@/lib/authz/http';
import { registerDeliverable } from '@/lib/services/task-deliverables';

import type { TaskDeliverable } from '@/lib/types';

export const dynamic = 'force-dynamic';
/**
 * GET /api/tasks/[id]/deliverables
 * Retrieve all deliverables for a task
 */
export async function GET(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const taskId = params.id;
    const db = getDb();

    const deliverables = db.prepare(`
      SELECT *
      FROM task_deliverables
      WHERE task_id = ?
      ORDER BY created_at DESC
    `).all(taskId) as TaskDeliverable[];

    return NextResponse.json(deliverables);
  } catch (error) {
    console.error('Error fetching deliverables:', error);
    return NextResponse.json(
      { error: 'Failed to fetch deliverables' },
      { status: 500 }
    );
  }
}

/**
 * Register a deliverable (file, URL, or artifact) produced by a task.
 *
 * Agents call this after writing outputs so the UI can show download links
 * and the evidence gate recognizes the stage as having produced work.
 *
 * @openapi
 * @tag Agent Callbacks
 * @auth bearer
 * @pathParams TaskIdParam
 * @body CreateDeliverableSchema
 */
export async function POST(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const taskId = params.id;
    const body = await request.json();

    // Reference variant: operator linking a prior deliverable as an input on
    // this task. Disambiguated by `kind: 'reference'`; the service-layer call
    // always sets role='input' and records source_deliverable_id.
    if (body && body.kind === 'reference') {
      const refValidation = ReferenceDeliverableSchema.safeParse(body);
      if (!refValidation.success) {
        return NextResponse.json(
          { error: 'Validation failed', details: refValidation.error.issues },
          { status: 400 }
        );
      }
      const sourceId = refValidation.data.source_deliverable_id;
      const source = getDb()
        .prepare(`SELECT * FROM task_deliverables WHERE id = ?`)
        .get(sourceId) as TaskDeliverable | undefined;
      if (!source) {
        return NextResponse.json({ error: 'Source deliverable not found' }, { status: 404 });
      }

      let refResult;
      try {
        refResult = registerDeliverable({
          taskId,
          actingAgentId: null,
          deliverableType: source.deliverable_type,
          title: source.title,
          path: source.path,
          description: source.description,
          role: 'input',
          sourceDeliverableId: source.id,
        });
      } catch (err) {
        if (err instanceof AuthzError) return authzErrorResponse(err);
        throw err;
      }

      logDebugEvent({
        type: 'agent.deliverable_post',
        direction: 'inbound',
        taskId,
        requestBody: body,
        metadata: { kind: 'reference', source_deliverable_id: sourceId },
      });

      return NextResponse.json(refResult.deliverable, { status: 201 });
    }

    // Validate input with Zod
    const validation = CreateDeliverableSchema.safeParse(body);
    if (!validation.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: validation.error.issues },
        { status: 400 }
      );
    }

    const { deliverable_type, title, path, description, spec_deliverable_id, agent_id, role } = validation.data;

    // Reject the reserved ssh:// prefix — the column is widened for future
    // remote storage, but nothing reads it yet. HTTP-only pre-validation;
    // kept out of the service since MCP tools can impose their own input
    // constraints at schema time.
    if (path && path.startsWith('ssh://')) {
      return NextResponse.json(
        { error: 'Remote (ssh://) deliverable storage is not yet supported' },
        { status: 501 }
      );
    }

    let result;
    try {
      result = registerDeliverable({
        taskId,
        actingAgentId: agent_id ?? null,
        deliverableType: deliverable_type,
        title,
        path,
        description,
        specDeliverableId: spec_deliverable_id,
        role,
      });
    } catch (err) {
      if (err instanceof AuthzError) return authzErrorResponse(err);
      throw err;
    }

    logDebugEvent({
      type: 'agent.deliverable_post',
      direction: 'inbound',
      taskId,
      requestBody: body,
      metadata: { deliverable_type, title, file_exists: result.fileExists },
    });

    // Return with warning if file doesn't exist
    if (deliverable_type === 'file' && !result.fileExists) {
      return NextResponse.json(
        {
          ...result.deliverable,
          warning: `File does not exist at path: ${result.normalizedPath}. Please create the file.`
        },
        { status: 201 }
      );
    }

    return NextResponse.json(result.deliverable, { status: 201 });
  } catch (error) {
    console.error('Error creating deliverable:', error);
    return NextResponse.json(
      { error: 'Failed to create deliverable' },
      { status: 500 }
    );
  }
}
