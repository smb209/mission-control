/**
 * Database Schema for Mission Control
 * 
 * This defines the current desired schema state.
 * For existing databases, migrations handle schema updates.
 * 
 * IMPORTANT: When adding new tables or columns:
 * 1. Add them here for new databases
 * 2. Create a migration in migrations.ts for existing databases
 */

export const schema = `
-- Workspaces table
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT,
  icon TEXT DEFAULT '📁',
  -- Per-workspace project/deliverables root. NULL means "use the
  -- env-derived default" (see resolveWorkspacePath()). Stored as a raw
  -- string with optional ~ that the server expands at access time.
  workspace_path TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Agents table
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  description TEXT,
  avatar_emoji TEXT DEFAULT '🤖',
  status TEXT DEFAULT 'standby' CHECK (status IN ('standby', 'working', 'offline')),
  is_master INTEGER DEFAULT 0,
  workspace_id TEXT DEFAULT 'default' REFERENCES workspaces(id) ON DELETE CASCADE,
  soul_md TEXT,
  user_md TEXT,
  agents_md TEXT,
  model TEXT,
  source TEXT DEFAULT 'local',
  gateway_agent_id TEXT,
  session_key_prefix TEXT,
  is_active INTEGER DEFAULT 1,
  total_cost_usd REAL DEFAULT 0,
  total_tokens_used INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Tasks table (Mission Queue)
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT DEFAULT 'inbox' CHECK (status IN ('pending_dispatch', 'planning', 'inbox', 'draft', 'assigned', 'in_progress', 'convoy_active', 'testing', 'review', 'verification', 'done', 'cancelled', 'needs_user_input')),
  priority TEXT DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  assigned_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  created_by_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  workspace_id TEXT DEFAULT 'default' REFERENCES workspaces(id) ON DELETE CASCADE,
  business_id TEXT DEFAULT 'default',
  due_date TEXT,
  workflow_template_id TEXT REFERENCES workflow_templates(id) ON DELETE SET NULL,
  planning_session_key TEXT,
  planning_messages TEXT,
  planning_complete INTEGER DEFAULT 0,
  planning_spec TEXT,
  planning_agents TEXT,
  planning_dispatch_error TEXT,
  status_reason TEXT,
  images TEXT,
  convoy_id TEXT,
  is_subtask INTEGER DEFAULT 0,
  product_id TEXT REFERENCES products(id) ON DELETE SET NULL,
  idea_id TEXT REFERENCES ideas(id) ON DELETE SET NULL,
  estimated_cost_usd REAL,
  actual_cost_usd REAL DEFAULT 0,
  repo_url TEXT,
  repo_branch TEXT,
  pr_url TEXT,
  pr_status TEXT CHECK (pr_status IN ('pending', 'open', 'merged', 'closed')),
  workspace_path TEXT,
  workspace_strategy TEXT,
  workspace_port INTEGER,
  workspace_base_commit TEXT,
  merge_status TEXT,
  merge_pr_url TEXT,
  is_archived INTEGER DEFAULT 0,
  archived_at TEXT,
  include_knowledge INTEGER DEFAULT 0,
  initiative_id TEXT REFERENCES initiatives(id) ON DELETE SET NULL,
  status_check_md TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Workspace port allocations for parallel build isolation
CREATE TABLE IF NOT EXISTS workspace_ports (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  port INTEGER NOT NULL UNIQUE,
  product_id TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  released_at TEXT
);

-- Workspace merge history
CREATE TABLE IF NOT EXISTS workspace_merges (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  workspace_path TEXT NOT NULL,
  strategy TEXT NOT NULL,
  base_commit TEXT,
  merge_commit TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  conflict_files TEXT,
  merge_log TEXT,
  merged_by TEXT,
  created_at TEXT NOT NULL,
  merged_at TEXT
);

-- Planning questions table
CREATE TABLE IF NOT EXISTS planning_questions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  question TEXT NOT NULL,
  question_type TEXT DEFAULT 'multiple_choice' CHECK (question_type IN ('multiple_choice', 'text', 'yes_no')),
  options TEXT,
  answer TEXT,
  answered_at TEXT,
  sort_order INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Planning specs table (locked specifications)
CREATE TABLE IF NOT EXISTS planning_specs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,
  spec_markdown TEXT NOT NULL,
  locked_at TEXT NOT NULL,
  locked_by TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Conversations table (agent-to-agent or task-related)
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  title TEXT,
  type TEXT DEFAULT 'direct' CHECK (type IN ('direct', 'group', 'task')),
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Conversation participants
CREATE TABLE IF NOT EXISTS conversation_participants (
  conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
  agent_id TEXT REFERENCES agents(id) ON DELETE CASCADE,
  joined_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (conversation_id, agent_id)
);

-- Messages table
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
  sender_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  content TEXT NOT NULL,
  message_type TEXT DEFAULT 'text' CHECK (message_type IN ('text', 'system', 'task_update', 'file')),
  metadata TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Events table (for live feed)
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  message TEXT NOT NULL,
  metadata TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Businesses/Workspaces table (legacy - kept for compatibility)
CREATE TABLE IF NOT EXISTS businesses (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- OpenClaw session mapping
CREATE TABLE IF NOT EXISTS openclaw_sessions (
  id TEXT PRIMARY KEY,
  agent_id TEXT REFERENCES agents(id) ON DELETE CASCADE,
  openclaw_session_id TEXT NOT NULL,
  channel TEXT,
  status TEXT DEFAULT 'active',
  session_type TEXT DEFAULT 'persistent',
  task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  ended_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Workflow templates (per-workspace workflow definitions)
CREATE TABLE IF NOT EXISTS workflow_templates (
  id TEXT PRIMARY KEY,
  workspace_id TEXT DEFAULT 'default' REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  stages TEXT NOT NULL,
  fail_targets TEXT,
  is_default INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Task role assignments (role -> agent mapping per task)
CREATE TABLE IF NOT EXISTS task_roles (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(task_id, role)
);

-- Knowledge entries (learner knowledge base)
CREATE TABLE IF NOT EXISTS knowledge_entries (
  id TEXT PRIMARY KEY,
  workspace_id TEXT DEFAULT 'default' REFERENCES workspaces(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  tags TEXT,
  confidence REAL DEFAULT 0.5,
  created_by_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Task activities table (for real-time activity log)
CREATE TABLE IF NOT EXISTS task_activities (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  activity_type TEXT NOT NULL,
  message TEXT NOT NULL,
  metadata TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Task deliverables table (files, URLs, artifacts)
-- role='input' rows are operator-attached at create time (uploads or
-- references to prior deliverables). role='output' rows are agent-produced.
-- Evidence gates and spec reconciliation only consider outputs.
CREATE TABLE IF NOT EXISTS task_deliverables (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  deliverable_type TEXT NOT NULL,
  title TEXT NOT NULL,
  path TEXT,
  description TEXT,
  storage_scheme TEXT DEFAULT 'host',
  size_bytes INTEGER,
  role TEXT NOT NULL DEFAULT 'output' CHECK (role IN ('input','output')),
  source_deliverable_id TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Convoys: parallel task groups.
-- parent_task_id is NOT unique: a task may have multiple convoys over time
-- (e.g. an agent coordinator appends further delegation rounds). Readers
-- use getActiveConvoyForTask() to pick the latest status='active' row.
CREATE TABLE IF NOT EXISTS convoys (
  id TEXT PRIMARY KEY,
  parent_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'paused', 'completing', 'done', 'failed')),
  decomposition_strategy TEXT DEFAULT 'manual' CHECK (decomposition_strategy IN ('manual', 'ai', 'planning', 'agent')),
  decomposition_spec TEXT,
  total_subtasks INTEGER DEFAULT 0,
  completed_subtasks INTEGER DEFAULT 0,
  failed_subtasks INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Convoy subtasks: individual work items within a convoy.
-- SLO columns (expected_* / checkin_*) are populated for agent-spawned
-- delegations; operator-created subtasks leave them NULL and fall back to
-- the global stall threshold.
CREATE TABLE IF NOT EXISTS convoy_subtasks (
  id TEXT PRIMARY KEY,
  convoy_id TEXT NOT NULL REFERENCES convoys(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,
  sort_order INTEGER DEFAULT 0,
  depends_on TEXT,
  suggested_role TEXT,
  slice TEXT,
  expected_deliverables TEXT,
  acceptance_criteria TEXT,
  expected_duration_minutes INTEGER,
  checkin_interval_minutes INTEGER DEFAULT 15,
  dispatched_at TEXT,
  due_at TEXT,
  deliverables_registered_count INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Agent health snapshots
CREATE TABLE IF NOT EXISTS agent_health (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  health_state TEXT DEFAULT 'idle' CHECK (health_state IN ('idle', 'working', 'stalled', 'stuck', 'zombie', 'offline')),
  last_activity_at TEXT,
  last_checkpoint_at TEXT,
  progress_score REAL DEFAULT 0,
  consecutive_stall_checks INTEGER DEFAULT 0,
  metadata TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Work checkpoints: periodic snapshots of agent work state
CREATE TABLE IF NOT EXISTS work_checkpoints (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  checkpoint_type TEXT DEFAULT 'auto' CHECK (checkpoint_type IN ('auto', 'manual', 'crash_recovery')),
  state_summary TEXT NOT NULL,
  files_snapshot TEXT,
  context_data TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Agent mailbox: inter-agent communication. Optionally scoped to a convoy
-- or a task. Both scope columns may be NULL for ad-hoc mail (e.g. roll-call,
-- help-requests to the master orchestrator).
CREATE TABLE IF NOT EXISTS agent_mailbox (
  id TEXT PRIMARY KEY,
  convoy_id TEXT REFERENCES convoys(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  from_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  to_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  subject TEXT,
  body TEXT NOT NULL,
  read_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_agent_mailbox_to ON agent_mailbox(to_agent_id, read_at);
CREATE INDEX IF NOT EXISTS idx_agent_mailbox_convoy ON agent_mailbox(convoy_id) WHERE convoy_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_agent_mailbox_task ON agent_mailbox(task_id) WHERE task_id IS NOT NULL;

-- Roll-call sessions: a master orchestrator asks each active agent to
-- check in; we track delivery and reply independently so the UI can
-- surface two distinct failure modes (couldn't deliver vs. agent silent).
CREATE TABLE IF NOT EXISTS rollcall_sessions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  initiator_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('direct', 'coordinator')),
  timeout_seconds INTEGER NOT NULL DEFAULT 30,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS rollcall_entries (
  id TEXT PRIMARY KEY,
  rollcall_id TEXT NOT NULL REFERENCES rollcall_sessions(id) ON DELETE CASCADE,
  target_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  delivery_status TEXT NOT NULL DEFAULT 'pending' CHECK (delivery_status IN ('pending', 'sent', 'failed', 'skipped')),
  delivery_error TEXT,
  delivered_at TEXT,
  reply_mail_id TEXT REFERENCES agent_mailbox(id) ON DELETE SET NULL,
  reply_body TEXT,
  replied_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_rollcall_entries_session ON rollcall_entries(rollcall_id);
CREATE INDEX IF NOT EXISTS idx_rollcall_entries_target ON rollcall_entries(target_agent_id, replied_at);

-- Products table (Product Autopilot)
CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  repo_url TEXT,
  live_url TEXT,
  product_program TEXT,
  icon TEXT DEFAULT '🚀',
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'paused', 'archived')),
  settings TEXT,
  build_mode TEXT DEFAULT 'plan_first' CHECK (build_mode IN ('auto_build', 'plan_first')),
  default_branch TEXT DEFAULT 'main',
  cost_cap_per_task REAL,
  cost_cap_monthly REAL,
  health_weight_config TEXT,
  batch_review_threshold INTEGER DEFAULT 10,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Research cycles: AI research runs per product
CREATE TABLE IF NOT EXISTS research_cycles (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  status TEXT DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed', 'cancelled', 'interrupted')),
  report TEXT,
  ideas_generated INTEGER DEFAULT 0,
  cost_usd REAL DEFAULT 0,
  tokens_used INTEGER DEFAULT 0,
  agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  current_phase TEXT DEFAULT 'init',
  phase_data TEXT,
  session_key TEXT,
  last_heartbeat TEXT,
  retry_count INTEGER DEFAULT 0,
  started_at TEXT DEFAULT (datetime('now')),
  completed_at TEXT,
  error_message TEXT
);

-- Ideation cycles: AI ideation runs per product
CREATE TABLE IF NOT EXISTS ideation_cycles (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  research_cycle_id TEXT REFERENCES research_cycles(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed', 'interrupted')),
  current_phase TEXT DEFAULT 'init',
  phase_data TEXT,
  session_key TEXT,
  last_heartbeat TEXT,
  retry_count INTEGER DEFAULT 0,
  ideas_generated INTEGER DEFAULT 0,
  error_message TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT
);

-- Autopilot activity log: real-time activity tracking
CREATE TABLE IF NOT EXISTS autopilot_activity_log (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  cycle_id TEXT NOT NULL,
  cycle_type TEXT NOT NULL CHECK(cycle_type IN ('research', 'ideation')),
  event_type TEXT NOT NULL,
  message TEXT NOT NULL,
  detail TEXT,
  cost_usd REAL,
  tokens_used INTEGER,
  created_at TEXT NOT NULL
);

-- Ideas: product improvement ideas from research or manual entry
CREATE TABLE IF NOT EXISTS ideas (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  cycle_id TEXT REFERENCES research_cycles(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN (
    'feature', 'improvement', 'ux', 'performance', 'integration',
    'infrastructure', 'content', 'growth', 'monetization', 'operations', 'security'
  )),
  research_backing TEXT,
  impact_score REAL,
  feasibility_score REAL,
  complexity TEXT CHECK (complexity IN ('S', 'M', 'L', 'XL')),
  estimated_effort_hours REAL,
  competitive_analysis TEXT,
  target_user_segment TEXT,
  revenue_potential TEXT,
  technical_approach TEXT,
  risks TEXT,
  tags TEXT,
  source TEXT DEFAULT 'research' CHECK (source IN ('research', 'manual', 'resurfaced', 'feedback')),
  source_research TEXT,
  status TEXT DEFAULT 'pending' CHECK (status IN (
    'pending', 'approved', 'rejected', 'maybe', 'building', 'built', 'shipped'
  )),
  swiped_at TEXT,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  user_notes TEXT,
  resurfaced_from TEXT REFERENCES ideas(id) ON DELETE SET NULL,
  resurfaced_reason TEXT,
  similarity_flag TEXT,
  auto_suppressed INTEGER DEFAULT 0,
  suppress_reason TEXT,
  variant_id TEXT REFERENCES product_program_variants(id) ON DELETE SET NULL,
  initiative_id TEXT REFERENCES initiatives(id) ON DELETE SET NULL,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Idea embeddings: text embeddings for similarity detection
CREATE TABLE IF NOT EXISTS idea_embeddings (
  id TEXT PRIMARY KEY,
  idea_id TEXT NOT NULL UNIQUE REFERENCES ideas(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  embedding TEXT NOT NULL,
  text_hash TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Idea suppressions: audit log of auto-suppressed duplicate ideas
CREATE TABLE IF NOT EXISTS idea_suppressions (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  suppressed_title TEXT NOT NULL,
  suppressed_description TEXT NOT NULL,
  similar_to_idea_id TEXT NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
  similarity_score REAL NOT NULL,
  reason TEXT NOT NULL,
  ideation_cycle_id TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Swipe history: user decisions on ideas
CREATE TABLE IF NOT EXISTS swipe_history (
  id TEXT PRIMARY KEY,
  idea_id TEXT NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('approve', 'reject', 'maybe', 'fire')),
  category TEXT NOT NULL,
  tags TEXT,
  impact_score REAL,
  feasibility_score REAL,
  complexity TEXT,
  user_notes TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Preference models: learned user preferences per product
CREATE TABLE IF NOT EXISTS preference_models (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  model_type TEXT DEFAULT 'simple' CHECK (model_type IN ('simple', 'advanced')),
  category_weights TEXT,
  tag_weights TEXT,
  complexity_weights TEXT,
  patterns TEXT,
  learned_preferences_md TEXT,
  total_swipes INTEGER DEFAULT 0,
  approval_rate REAL DEFAULT 0,
  last_updated TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now'))
);

-- Maybe pool: ideas deferred for re-evaluation
CREATE TABLE IF NOT EXISTS maybe_pool (
  id TEXT PRIMARY KEY,
  idea_id TEXT NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  last_evaluated_at TEXT,
  next_evaluate_at TEXT,
  evaluation_count INTEGER DEFAULT 0,
  evaluation_notes TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Product feedback: external feedback linked to products
CREATE TABLE IF NOT EXISTS product_feedback (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  content TEXT NOT NULL,
  customer_id TEXT,
  category TEXT,
  sentiment TEXT CHECK (sentiment IN ('positive', 'negative', 'neutral', 'mixed')),
  processed INTEGER DEFAULT 0,
  idea_id TEXT REFERENCES ideas(id) ON DELETE SET NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Cost events: granular cost tracking per operation
CREATE TABLE IF NOT EXISTS cost_events (
  id TEXT PRIMARY KEY,
  product_id TEXT REFERENCES products(id) ON DELETE SET NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  cycle_id TEXT REFERENCES research_cycles(id) ON DELETE SET NULL,
  agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'agent_dispatch', 'research_cycle', 'ideation_cycle', 'build_task',
    'content_generation', 'seo_analysis', 'web_search', 'external_api'
  )),
  provider TEXT,
  model TEXT,
  tokens_input INTEGER DEFAULT 0,
  tokens_output INTEGER DEFAULT 0,
  cost_usd REAL DEFAULT 0,
  metadata TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Cost caps: spending limits per workspace/product
CREATE TABLE IF NOT EXISTS cost_caps (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  product_id TEXT REFERENCES products(id) ON DELETE SET NULL,
  cap_type TEXT NOT NULL CHECK (cap_type IN ('per_cycle', 'per_task', 'daily', 'monthly', 'per_product_monthly')),
  limit_usd REAL NOT NULL,
  current_spend_usd REAL DEFAULT 0,
  period_start TEXT,
  period_end TEXT,
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'paused', 'exceeded')),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Product schedules: recurring automation schedules
CREATE TABLE IF NOT EXISTS product_schedules (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  schedule_type TEXT NOT NULL CHECK (schedule_type IN (
    'research', 'ideation', 'maybe_reevaluation', 'seo_audit',
    'content_refresh', 'analytics_report', 'social_batch', 'growth_experiment',
    'roadmap_drift_scan'
  )),
  cron_expression TEXT NOT NULL,
  timezone TEXT DEFAULT 'America/Denver',
  enabled INTEGER DEFAULT 1,
  last_run_at TEXT,
  next_run_at TEXT,
  config TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Operations log: audit trail for automated operations
CREATE TABLE IF NOT EXISTS operations_log (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  operation_type TEXT NOT NULL CHECK (operation_type IN (
    'seo_audit', 'content_publish', 'content_refresh', 'social_post',
    'keyword_research', 'analytics_report', 'growth_experiment',
    'feedback_processing', 'preference_update'
  )),
  status TEXT DEFAULT 'completed' CHECK (status IN ('running', 'completed', 'failed')),
  summary TEXT,
  details TEXT,
  cost_usd REAL DEFAULT 0,
  agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Content inventory: managed content pieces per product
CREATE TABLE IF NOT EXISTS content_inventory (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  content_type TEXT NOT NULL CHECK (content_type IN (
    'blog_post', 'documentation', 'tutorial', 'landing_page', 'changelog',
    'newsletter', 'faq', 'social_post', 'guide', 'case_study'
  )),
  title TEXT NOT NULL,
  url TEXT,
  status TEXT DEFAULT 'draft' CHECK (status IN ('draft', 'review', 'published', 'archived')),
  target_keywords TEXT,
  performance TEXT,
  last_refreshed_at TEXT,
  idea_id TEXT REFERENCES ideas(id) ON DELETE SET NULL,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Social queue: scheduled social media posts
CREATE TABLE IF NOT EXISTS social_queue (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('twitter', 'linkedin', 'facebook', 'instagram', 'reddit', 'other')),
  content TEXT NOT NULL,
  media_url TEXT,
  suggested_post_time TEXT,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'posted', 'failed')),
  posted_at TEXT,
  performance TEXT,
  idea_id TEXT REFERENCES ideas(id) ON DELETE SET NULL,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- SEO keywords: tracked keywords per product
CREATE TABLE IF NOT EXISTS seo_keywords (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  keyword TEXT NOT NULL,
  current_position REAL,
  previous_position REAL,
  impressions INTEGER DEFAULT 0,
  clicks INTEGER DEFAULT 0,
  ctr REAL DEFAULT 0,
  target_position REAL,
  status TEXT DEFAULT 'tracking' CHECK (status IN ('tracking', 'optimizing', 'achieved', 'abandoned')),
  content_ids TEXT,
  last_checked_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Task notes: operator ↔ agent chat messages
CREATE TABLE IF NOT EXISTS task_notes (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('note', 'direct')),
  role TEXT DEFAULT 'user',
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'read')),
  delivered_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Agent chat messages: operator ↔ agent chat scoped to a specific agent
-- (no task). Used by the Agent Details modal's Chat tab.
CREATE TABLE IF NOT EXISTS agent_chat_messages (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered')),
  session_key TEXT,
  metadata TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Product health scores: cached composite scores + daily snapshots
CREATE TABLE IF NOT EXISTS product_health_scores (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  overall_score REAL NOT NULL DEFAULT 0,
  research_freshness_score REAL DEFAULT 0,
  pipeline_depth_score REAL DEFAULT 0,
  swipe_velocity_score REAL DEFAULT 0,
  build_success_score REAL DEFAULT 0,
  cost_efficiency_score REAL DEFAULT 0,
  component_data TEXT,
  snapshot_date TEXT,
  calculated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- User task read tracking (for unread message badges)
CREATE TABLE IF NOT EXISTS user_task_reads (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL DEFAULT 'operator',
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  last_read_at TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(user_id, task_id)
);

-- Product Program variants for A/B testing
CREATE TABLE IF NOT EXISTS product_program_variants (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  content TEXT NOT NULL,
  is_control INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Product A/B tests
CREATE TABLE IF NOT EXISTS product_ab_tests (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  variant_a_id TEXT NOT NULL REFERENCES product_program_variants(id) ON DELETE CASCADE,
  variant_b_id TEXT NOT NULL REFERENCES product_program_variants(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'concluded', 'cancelled')),
  split_mode TEXT NOT NULL DEFAULT 'concurrent' CHECK (split_mode IN ('concurrent', 'alternating')),
  min_swipes INTEGER NOT NULL DEFAULT 50,
  last_variant_used TEXT,
  winner_variant_id TEXT REFERENCES product_program_variants(id) ON DELETE SET NULL,
  created_at TEXT DEFAULT (datetime('now')),
  concluded_at TEXT
);

-- Product skills: reusable agent playbooks
CREATE TABLE IF NOT EXISTS product_skills (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  skill_type TEXT NOT NULL CHECK (skill_type IN ('build', 'deploy', 'test', 'fix', 'config', 'pattern')),
  title TEXT NOT NULL,
  trigger_keywords TEXT,
  prerequisites TEXT,
  steps TEXT NOT NULL,
  verification TEXT,
  confidence REAL DEFAULT 0.5,
  times_used INTEGER DEFAULT 0,
  times_succeeded INTEGER DEFAULT 0,
  last_used_at TEXT,
  created_by_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  created_by_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  supersedes_skill_id TEXT REFERENCES product_skills(id) ON DELETE SET NULL,
  status TEXT DEFAULT 'draft' CHECK (status IN ('active', 'deprecated', 'draft')),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Skill usage reports from agents
CREATE TABLE IF NOT EXISTS skill_reports (
  id TEXT PRIMARY KEY,
  skill_id TEXT NOT NULL REFERENCES product_skills(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  used INTEGER NOT NULL DEFAULT 1,
  succeeded INTEGER NOT NULL DEFAULT 0,
  deviation TEXT,
  suggested_update TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Debug console: opt-in capture of MC↔agent traffic (dispatch payloads).
-- Gated by debug_config.collection_enabled; operator toggles from /debug UI.
CREATE TABLE IF NOT EXISTS debug_events (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  event_type TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('outbound', 'inbound', 'internal')),
  task_id TEXT,
  agent_id TEXT,
  session_key TEXT,
  duration_ms INTEGER,
  request_body TEXT,
  response_body TEXT,
  error TEXT,
  metadata TEXT
);

CREATE TABLE IF NOT EXISTS debug_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  collection_enabled INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Roadmap planning layer (see specs/roadmap-and-pm-spec.md §5).
-- Initiatives form a tree (parent_initiative_id). Almost every column is
-- nullable so a backlog item can be a one-line title with no other detail.
CREATE TABLE IF NOT EXISTS initiatives (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  product_id TEXT REFERENCES products(id) ON DELETE SET NULL,
  parent_initiative_id TEXT REFERENCES initiatives(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (kind IN ('theme','milestone','epic','story')),
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'planned'
    CHECK (status IN ('planned','in_progress','at_risk','blocked','done','cancelled')),
  owner_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  estimated_effort_hours REAL,
  complexity TEXT CHECK (complexity IN ('S','M','L','XL')),
  target_start TEXT,
  target_end TEXT,
  derived_start TEXT,
  derived_end TEXT,
  committed_end TEXT,
  status_check_md TEXT,
  sort_order INTEGER DEFAULT 0,
  source_idea_id TEXT REFERENCES ideas(id) ON DELETE SET NULL,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Cross-initiative dependency edges (DAG, many-to-many).
CREATE TABLE IF NOT EXISTS initiative_dependencies (
  id TEXT PRIMARY KEY,
  initiative_id TEXT NOT NULL REFERENCES initiatives(id) ON DELETE CASCADE,
  depends_on_initiative_id TEXT NOT NULL REFERENCES initiatives(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'finish_to_start'
    CHECK (kind IN ('finish_to_start','start_to_start','blocking','informational')),
  note TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(initiative_id, depends_on_initiative_id)
);

-- Audit log of every initiative-tree move.
CREATE TABLE IF NOT EXISTS initiative_parent_history (
  id TEXT PRIMARY KEY,
  initiative_id TEXT NOT NULL REFERENCES initiatives(id) ON DELETE CASCADE,
  from_parent_id TEXT REFERENCES initiatives(id) ON DELETE SET NULL,
  to_parent_id TEXT REFERENCES initiatives(id) ON DELETE SET NULL,
  moved_by_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Audit log of every task re-parent. First row per task has from = NULL.
CREATE TABLE IF NOT EXISTS task_initiative_history (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  from_initiative_id TEXT REFERENCES initiatives(id) ON DELETE SET NULL,
  to_initiative_id TEXT REFERENCES initiatives(id) ON DELETE SET NULL,
  moved_by_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Owner availability windows (PM impact-analysis input).
CREATE TABLE IF NOT EXISTS owner_availability (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  unavailable_start TEXT NOT NULL,
  unavailable_end TEXT NOT NULL,
  reason TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- PM proposal artifacts (Phase 5 will populate these).
CREATE TABLE IF NOT EXISTS pm_proposals (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  trigger_text TEXT NOT NULL,
  trigger_kind TEXT NOT NULL DEFAULT 'manual'
    CHECK (trigger_kind IN ('manual','scheduled_drift_scan','disruption_event','status_check_investigation','plan_initiative','decompose_initiative')),
  impact_md TEXT NOT NULL,
  proposed_changes TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','accepted','rejected','superseded')),
  applied_at TEXT,
  applied_by_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  parent_proposal_id TEXT REFERENCES pm_proposals(id) ON DELETE SET NULL,
  created_at TEXT DEFAULT (datetime('now')),
  target_initiative_id TEXT REFERENCES initiatives(id) ON DELETE CASCADE,
  plan_suggestions TEXT
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_assigned ON tasks(assigned_agent_id);
CREATE INDEX IF NOT EXISTS idx_tasks_workspace ON tasks(workspace_id);
CREATE INDEX IF NOT EXISTS idx_tasks_archived ON tasks(is_archived, status);
CREATE INDEX IF NOT EXISTS idx_agents_workspace ON agents(workspace_id);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);
CREATE INDEX IF NOT EXISTS idx_activities_task ON task_activities(task_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_deliverables_task ON task_deliverables(task_id);
CREATE INDEX IF NOT EXISTS idx_openclaw_sessions_task ON openclaw_sessions(task_id);
CREATE INDEX IF NOT EXISTS idx_planning_questions_task ON planning_questions(task_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_workflow_templates_workspace ON workflow_templates(workspace_id);
CREATE INDEX IF NOT EXISTS idx_task_roles_task ON task_roles(task_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_entries_workspace ON knowledge_entries(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_knowledge_entries_task ON knowledge_entries(task_id);
CREATE INDEX IF NOT EXISTS idx_convoys_parent ON convoys(parent_task_id);
CREATE INDEX IF NOT EXISTS idx_convoys_status ON convoys(status);
CREATE INDEX IF NOT EXISTS idx_convoy_subtasks_convoy ON convoy_subtasks(convoy_id);
CREATE INDEX IF NOT EXISTS idx_convoy_subtasks_task ON convoy_subtasks(task_id);
CREATE INDEX IF NOT EXISTS idx_agent_health_agent ON agent_health(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_health_state ON agent_health(health_state);
CREATE INDEX IF NOT EXISTS idx_work_checkpoints_task ON work_checkpoints(task_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_mailbox_to ON agent_mailbox(to_agent_id, read_at);
CREATE INDEX IF NOT EXISTS idx_agent_mailbox_convoy ON agent_mailbox(convoy_id);
CREATE INDEX IF NOT EXISTS idx_products_workspace ON products(workspace_id);
CREATE INDEX IF NOT EXISTS idx_research_cycles_product ON research_cycles(product_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_ideas_product ON ideas(product_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ideas_status ON ideas(status);
CREATE INDEX IF NOT EXISTS idx_ideas_product_pending ON ideas(product_id, status) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_swipe_history_product ON swipe_history(product_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_swipe_history_category ON swipe_history(product_id, category);
CREATE INDEX IF NOT EXISTS idx_maybe_pool_next ON maybe_pool(product_id, next_evaluate_at);
CREATE INDEX IF NOT EXISTS idx_cost_events_product ON cost_events(product_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cost_events_workspace ON cost_events(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cost_events_task ON cost_events(task_id);
CREATE INDEX IF NOT EXISTS idx_cost_caps_workspace ON cost_caps(workspace_id);
CREATE INDEX IF NOT EXISTS idx_product_schedules_product ON product_schedules(product_id);
CREATE INDEX IF NOT EXISTS idx_operations_log_product ON operations_log(product_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_content_inventory_product ON content_inventory(product_id);
CREATE INDEX IF NOT EXISTS idx_social_queue_product ON social_queue(product_id, status);
CREATE INDEX IF NOT EXISTS idx_seo_keywords_product ON seo_keywords(product_id);
CREATE INDEX IF NOT EXISTS idx_product_feedback_product ON product_feedback(product_id, processed);
CREATE INDEX IF NOT EXISTS idx_task_notes_task ON task_notes(task_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_task_notes_pending ON task_notes(task_id, status) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_agent_chat_messages_agent_created ON agent_chat_messages(agent_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ppv_product ON product_program_variants(product_id);
CREATE INDEX IF NOT EXISTS idx_ab_tests_product ON product_ab_tests(product_id, status);
CREATE INDEX IF NOT EXISTS idx_ideas_variant ON ideas(variant_id);
CREATE INDEX IF NOT EXISTS idx_ideation_cycles_product ON ideation_cycles(product_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_autopilot_activity_product ON autopilot_activity_log(product_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_autopilot_activity_cycle ON autopilot_activity_log(cycle_id, created_at);
CREATE INDEX IF NOT EXISTS idx_workspace_ports_active ON workspace_ports(status, port);
CREATE INDEX IF NOT EXISTS idx_workspace_merges_task ON workspace_merges(task_id);
CREATE INDEX IF NOT EXISTS idx_health_scores_product ON product_health_scores(product_id, calculated_at DESC);
CREATE INDEX IF NOT EXISTS idx_health_scores_snapshot ON product_health_scores(product_id, snapshot_date);
CREATE INDEX IF NOT EXISTS idx_idea_embeddings_product ON idea_embeddings(product_id);
CREATE INDEX IF NOT EXISTS idx_idea_embeddings_idea ON idea_embeddings(idea_id);
CREATE INDEX IF NOT EXISTS idx_idea_suppressions_product ON idea_suppressions(product_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_task_reads_user_task ON user_task_reads(user_id, task_id);
CREATE INDEX IF NOT EXISTS idx_product_skills_product ON product_skills(product_id, skill_type, status);
CREATE INDEX IF NOT EXISTS idx_product_skills_confidence ON product_skills(confidence DESC);
CREATE INDEX IF NOT EXISTS idx_skill_reports_skill ON skill_reports(skill_id);
CREATE INDEX IF NOT EXISTS idx_debug_events_created ON debug_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_debug_events_task ON debug_events(task_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_debug_events_agent ON debug_events(agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_initiatives_workspace ON initiatives(workspace_id);
CREATE INDEX IF NOT EXISTS idx_initiatives_parent ON initiatives(parent_initiative_id);
CREATE INDEX IF NOT EXISTS idx_initiatives_product ON initiatives(product_id);
CREATE INDEX IF NOT EXISTS idx_initiatives_status ON initiatives(status);
CREATE INDEX IF NOT EXISTS idx_initiatives_target_window ON initiatives(target_start, target_end);
CREATE INDEX IF NOT EXISTS idx_initiative_deps_from ON initiative_dependencies(initiative_id);
CREATE INDEX IF NOT EXISTS idx_initiative_deps_to ON initiative_dependencies(depends_on_initiative_id);
CREATE INDEX IF NOT EXISTS idx_task_initiative_history_task ON task_initiative_history(task_id, created_at);
CREATE INDEX IF NOT EXISTS idx_initiative_parent_history ON initiative_parent_history(initiative_id, created_at);
CREATE INDEX IF NOT EXISTS idx_owner_availability_agent ON owner_availability(agent_id, unavailable_start);
CREATE INDEX IF NOT EXISTS idx_tasks_initiative ON tasks(initiative_id);
CREATE INDEX IF NOT EXISTS idx_tasks_draft ON tasks(status, initiative_id) WHERE status='draft';
CREATE INDEX IF NOT EXISTS idx_pm_proposals_status ON pm_proposals(status, created_at DESC);
`;
