import { z } from 'zod';

// Agent IDs may be standard UUIDs (locally generated) or 32-char hex strings
// (from OpenClaw gateway). Accept both formats.
const agentId = z.string().regex(
  /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32})$/i,
  'Must be a valid UUID or hex identifier'
);

// Task status and priority enums from types
const TaskStatus = z.enum([
  'draft',
  'pending_dispatch',
  'planning',
  'inbox',
  'assigned',
  'in_progress',
  'convoy_active',
  'testing',
  'review',
  'verification',
  'done',
  'cancelled'
]);

const TaskPriority = z.enum(['low', 'normal', 'high', 'urgent']);

const ActivityType = z.enum([
  'spawned',
  'updated',
  'completed',
  'file_created',
  'status_changed'
]);

const DeliverableType = z.enum(['file', 'url', 'artifact']);

// Task validation schemas
export const CreateTaskSchema = z.object({
  title: z.string().min(1, 'Title is required').max(500, 'Title must be 500 characters or less'),
  description: z.string().max(10000, 'Description must be 10000 characters or less').optional(),
  status: TaskStatus.optional(),
  priority: TaskPriority.optional(),
  assigned_agent_id: agentId.optional().nullable(),
  created_by_agent_id: agentId.optional().nullable(),
  business_id: z.string().optional(),
  workspace_id: z.string().optional(),
  due_date: z.string().optional().nullable(),
  include_knowledge: z.boolean().optional(),
});

export const UpdateTaskSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  description: z.string().max(10000).optional(),
  status: TaskStatus.optional(),
  priority: TaskPriority.optional(),
  assigned_agent_id: agentId.optional().nullable(),
  workflow_template_id: z.string().optional().nullable(),
  due_date: z.string().optional().nullable(),
  updated_by_agent_id: agentId.optional(),
  status_reason: z.string().max(2000).optional(),
  board_override: z.boolean().optional(),
  override_reason: z.string().max(2000).optional(),
  pr_url: z.string().url().optional().nullable(),
  pr_status: z.enum(['pending', 'open', 'merged', 'closed']).optional(),
  include_knowledge: z.boolean().optional(),
});

// Admin release-stall schema — escape hatch for deadlocked tasks that
// cannot clear the evidence gate. Deliberately restricted to the two
// terminal statuses so operators can't use it to bypass normal workflow.
export const ReleaseStallSchema = z.object({
  reason: z.string().min(1, 'reason is required').max(500),
  terminal_state: z.enum(['cancelled', 'done']).optional(),
  released_by: z.string().max(200).optional(),
});

// Admin release-cycle schema — equivalent for autopilot cycles stuck in
// status='running'. Only one terminal state (`interrupted`) because
// research_cycles / ideation_cycles have no notion of "completed but
// cancelled by operator"; the CHECK constraint already enforces
// running|completed|failed|interrupted|cancelled (research) and
// running|completed|failed|interrupted (ideation), and `interrupted` is
// the shared vocabulary used by recovery.ts.
export const ReleaseCycleSchema = z.object({
  reason: z.string().min(1, 'reason is required').max(500),
  released_by: z.string().max(200).optional(),
});

// Shared path-param schemas for OpenAPI doc generation
export const TaskIdParam = z.object({
  id: z.string().describe('Task UUID'),
});

export const AgentIdParam = z.object({
  id: z.string().describe('Agent UUID or 32-char hex gateway ID'),
});

// Activity validation schema
export const CreateActivitySchema = z.object({
  activity_type: ActivityType,
  message: z.string().min(1, 'Message is required').max(5000, 'Message must be 5000 characters or less'),
  agent_id: agentId.optional(),
  metadata: z.string().optional(),
});

const DeliverableRole = z.enum(['input', 'output']);

// Deliverable validation schema — pre-existing shape used by agents to
// register an output they produced (or, with role='input', an operator-
// attached input from the create-task flow).
export const CreateDeliverableSchema = z.object({
  deliverable_type: DeliverableType,
  title: z.string().min(1, 'Title is required'),
  path: z.string().optional(),
  description: z.string().optional(),
  /** The agent posting this deliverable. When present, the agent-task
   *  authorization check (src/lib/authz/agent-task.ts) enforces the agent
   *  is actually on this task. Optional for backward compatibility with
   *  operator flows; MCP-dispatched agents always provide it. */
  agent_id: agentId.optional(),
  /** When fulfilling a planning-spec deliverable, name which one. The
   *  evidence gate reconciles this against planning_spec.deliverables[].id
   *  before allowing a transition into testing/review/verification/done. */
  spec_deliverable_id: z.string().max(200).optional(),
  /** Operator uploads / references use 'input'. Defaults to 'output' so
   *  agent-side POSTs don't need to change. */
  role: DeliverableRole.optional(),
});

/** Alternate body shape for POST /api/tasks/:id/deliverables — links a prior
 *  deliverable from another task as an input on this task. The server looks up
 *  the source row, copies its type/title/path/description, and inserts a new
 *  row with role='input' and source_deliverable_id pointing at the source. */
export const ReferenceDeliverableSchema = z.object({
  kind: z.literal('reference'),
  source_deliverable_id: z.string().min(1, 'source_deliverable_id is required').max(100),
});

// Planning spec deliverables + success criteria (structured shape). Readers
// still accept the legacy array-of-strings shape for in-flight tasks — see
// parsePlanningSpec in src/lib/planning-spec.ts.
const SpecDeliverableKind = z.enum(['file', 'behavior', 'artifact']);

export const SpecDeliverableSchema = z.object({
  id: z.string().min(1).max(100),
  title: z.string().min(1).max(500),
  kind: SpecDeliverableKind,
  path_pattern: z.string().max(500).optional(),
  acceptance: z.string().min(1).max(2000),
});

export const SpecSuccessCriterionSchema = z.object({
  id: z.string().min(1).max(100),
  assertion: z.string().min(1).max(1000),
  how_to_test: z.string().min(1).max(1000),
});

// Fail-task validation schema — agents hit this to trigger a fail-loopback
// from testing/review/verification back to in_progress.
export const FailTaskSchema = z.object({
  reason: z.string().min(1, 'reason is required').max(5000),
  /** The agent reporting the failure. When present, the agent-task
   *  authorization check enforces the agent is the tester/reviewer for
   *  this task. Optional for backward compatibility. */
  agent_id: agentId.optional(),
});

// Checkpoint validation schema — agents save work-state snapshots so
// mission-control can resume or audit long-running tasks.
const CheckpointFileSnapshot = z.object({
  path: z.string().min(1),
  hash: z.string().min(1),
  size: z.number().int().min(0),
});

export const CheckpointSchema = z.object({
  agent_id: agentId,
  checkpoint_type: z.enum(['auto', 'manual', 'crash_recovery']).optional(),
  state_summary: z.string().min(1, 'state_summary is required').max(10000),
  files_snapshot: z.array(CheckpointFileSnapshot).optional(),
  context_data: z.record(z.string(), z.unknown()).optional(),
});

// Product Autopilot validation schemas

const IdeaCategory = z.enum([
  'feature', 'improvement', 'ux', 'performance', 'integration',
  'infrastructure', 'content', 'growth', 'monetization', 'operations', 'security'
]);

const IdeaComplexity = z.enum(['S', 'M', 'L', 'XL']);

const SwipeAction = z.enum(['approve', 'reject', 'maybe', 'fire']);

const CostCapType = z.enum(['per_cycle', 'per_task', 'daily', 'monthly', 'per_product_monthly']);

const CostEventType = z.enum([
  'agent_dispatch', 'research_cycle', 'ideation_cycle', 'build_task',
  'content_generation', 'seo_analysis', 'web_search', 'external_api'
]);

const ProductStatus = z.enum(['active', 'paused', 'archived']);

export const CreateProductSchema = z.object({
  name: z.string().min(1, 'Name is required').max(200),
  description: z.string().max(5000).optional(),
  repo_url: z.string().url().optional().or(z.literal('')),
  live_url: z.string().url().optional().or(z.literal('')),
  product_program: z.string().max(50000).optional(),
  icon: z.string().max(10).optional(),
  workspace_id: z.string().optional(),
  settings: z.string().optional(),
  build_mode: z.enum(['auto_build', 'plan_first']).optional(),
  default_branch: z.string().max(200).optional(),
});

export const UpdateProductSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(5000).optional(),
  repo_url: z.string().url().optional().nullable().or(z.literal('')),
  live_url: z.string().url().optional().nullable().or(z.literal('')),
  product_program: z.string().max(50000).optional(),
  icon: z.string().max(10).optional(),
  status: ProductStatus.optional(),
  settings: z.string().optional(),
  build_mode: z.enum(['auto_build', 'plan_first']).optional(),
  default_branch: z.string().max(200).optional(),
  cost_cap_per_task: z.number().min(0).optional().nullable(),
  cost_cap_monthly: z.number().min(0).optional().nullable(),
  batch_review_threshold: z.number().int().min(1).max(100).optional(),
});

export const SwipeActionSchema = z.object({
  idea_id: z.string().min(1, 'Idea ID is required'),
  action: SwipeAction,
  notes: z.string().max(2000).optional(),
});

export const CreateIdeaSchema = z.object({
  title: z.string().min(1, 'Title is required').max(500),
  description: z.string().min(1, 'Description is required').max(10000),
  category: IdeaCategory,
  complexity: IdeaComplexity.optional(),
  impact_score: z.number().min(1).max(10).optional(),
  feasibility_score: z.number().min(1).max(10).optional(),
  estimated_effort_hours: z.number().min(0).optional(),
  tags: z.array(z.string()).optional(),
  technical_approach: z.string().max(5000).optional(),
  risks: z.array(z.string()).optional(),
});

export const CreateCostCapSchema = z.object({
  workspace_id: z.string().optional(),
  product_id: z.string().optional().nullable(),
  cap_type: CostCapType,
  limit_usd: z.number().positive('Limit must be positive'),
  period_start: z.string().optional(),
  period_end: z.string().optional(),
});

export const UpdateCostCapSchema = z.object({
  limit_usd: z.number().positive().optional(),
  status: z.enum(['active', 'paused']).optional(),
  period_start: z.string().optional(),
  period_end: z.string().optional(),
});

export const CreateCostEventSchema = z.object({
  product_id: z.string().optional().nullable(),
  workspace_id: z.string().optional(),
  task_id: z.string().optional().nullable(),
  cycle_id: z.string().optional().nullable(),
  agent_id: z.string().optional().nullable(),
  event_type: CostEventType,
  provider: z.string().optional(),
  model: z.string().optional(),
  tokens_input: z.number().int().min(0).optional(),
  tokens_output: z.number().int().min(0).optional(),
  cost_usd: z.number().min(0),
  metadata: z.string().optional(),
});

export const CreateScheduleSchema = z.object({
  schedule_type: z.enum([
    'research', 'ideation', 'maybe_reevaluation', 'seo_audit',
    'content_refresh', 'analytics_report', 'social_batch', 'growth_experiment'
  ]),
  cron_expression: z.string().min(1, 'Cron expression is required'),
  timezone: z.string().optional(),
  enabled: z.boolean().optional(),
  config: z.string().optional(),
});

export const UpdateScheduleSchema = z.object({
  cron_expression: z.string().min(1).optional(),
  timezone: z.string().optional(),
  enabled: z.boolean().optional(),
  config: z.string().optional(),
});

// Type exports for use in routes
export type CreateTaskInput = z.infer<typeof CreateTaskSchema>;
export type UpdateTaskInput = z.infer<typeof UpdateTaskSchema>;
export type CreateActivityInput = z.infer<typeof CreateActivitySchema>;
export type CreateDeliverableInput = z.infer<typeof CreateDeliverableSchema>;
export type CreateProductInput = z.infer<typeof CreateProductSchema>;
export type UpdateProductInput = z.infer<typeof UpdateProductSchema>;
export type SwipeActionInput = z.infer<typeof SwipeActionSchema>;
export type CreateIdeaInput = z.infer<typeof CreateIdeaSchema>;
export type CreateCostCapInput = z.infer<typeof CreateCostCapSchema>;
export type UpdateCostCapInput = z.infer<typeof UpdateCostCapSchema>;
export type CreateCostEventInput = z.infer<typeof CreateCostEventSchema>;
export type CreateScheduleInput = z.infer<typeof CreateScheduleSchema>;
export type UpdateScheduleInput = z.infer<typeof UpdateScheduleSchema>;
export type FailTaskInput = z.infer<typeof FailTaskSchema>;
export type CheckpointInput = z.infer<typeof CheckpointSchema>;
