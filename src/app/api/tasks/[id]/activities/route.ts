/**
 * Task Activities API
 * Endpoints for logging and retrieving task activities
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { CreateActivitySchema } from '@/lib/validation';
import { logDebugEvent } from '@/lib/debug-log';
import { AuthzError } from '@/lib/authz/agent-task';
import { authzErrorResponse } from '@/lib/authz/http';
import { logActivity } from '@/lib/services/task-activities';
import type { TaskActivity } from '@/lib/types';

export const dynamic = 'force-dynamic';

/**
 * GET /api/tasks/[id]/activities
 * Retrieve all activities for a task
 */
export async function GET(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const taskId = params.id;
    const db = getDb();

    // Get activities with agent info
    const activities = db.prepare(`
      SELECT 
        a.*,
        ag.id as agent_id,
        ag.name as agent_name,
        ag.avatar_emoji as agent_avatar_emoji
      FROM task_activities a
      LEFT JOIN agents ag ON a.agent_id = ag.id
      WHERE a.task_id = ?
      ORDER BY a.created_at DESC
    `).all(taskId) as any[];

    // Transform to include agent object
    const result: TaskActivity[] = activities.map(row => ({
      id: row.id,
      task_id: row.task_id,
      agent_id: row.agent_id,
      activity_type: row.activity_type,
      message: row.message,
      metadata: row.metadata,
      created_at: row.created_at,
      agent: row.agent_id ? {
        id: row.agent_id,
        name: row.agent_name,
        avatar_emoji: row.agent_avatar_emoji,
        role: '',
        status: 'working' as const,
        is_master: false,
        workspace_id: 'default',
        source: 'local' as const,
        description: '',
        created_at: '',
        updated_at: '',
      } : undefined,
    }));

    return NextResponse.json(result);
  } catch (error) {
    console.error('Error fetching activities:', error);
    return NextResponse.json(
      { error: 'Failed to fetch activities' },
      { status: 500 }
    );
  }
}

/**
 * Log an activity for a task.
 *
 * Agents call this to report progress, completed steps, and file creations so
 * the activity feed and stall detector see forward motion.
 *
 * @openapi
 * @tag Agent Callbacks
 * @auth bearer
 * @pathParams TaskIdParam
 * @body CreateActivitySchema
 */
export async function POST(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const taskId = params.id;
    const body = await request.json();
    
    // Validate input with Zod
    const validation = CreateActivitySchema.safeParse(body);
    if (!validation.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: validation.error.issues },
        { status: 400 }
      );
    }

    const { activity_type, message, agent_id, metadata } = validation.data;

    let result;
    try {
      result = logActivity({
        taskId,
        actingAgentId: agent_id ?? null,
        activityType: activity_type,
        message,
        metadata: metadata ? JSON.stringify(metadata) : undefined,
      });
    } catch (err) {
      if (err instanceof AuthzError) return authzErrorResponse(err);
      throw err;
    }

    logDebugEvent({
      type: 'agent.activity_post',
      direction: 'inbound',
      taskId,
      agentId: agent_id ?? null,
      requestBody: body,
      metadata: { activity_type },
    });

    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    console.error('Error creating activity:', error);
    return NextResponse.json(
      { error: 'Failed to create activity' },
      { status: 500 }
    );
  }
}
