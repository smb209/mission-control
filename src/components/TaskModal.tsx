'use client';

import { useRef, useState, useCallback } from 'react';
import { X, Save, Trash2, Activity, Package, Bot, ClipboardList, Plus, Users, ImageIcon, Truck, Radio, MessageSquare, ExternalLink, HardDrive, Archive, ArchiveRestore, Paperclip, Upload, Link as LinkIcon, FileText, BookOpen, Send } from 'lucide-react';
import { useMissionControl } from '@/lib/store';
import { triggerAutoDispatch, shouldTriggerAutoDispatch } from '@/lib/auto-dispatch';
import { ActivityLog } from './ActivityLog';
import { DeliverablesList } from './DeliverablesList';
import { SessionsList } from './SessionsList';
import { PlanningTab } from './PlanningTab';
import { TeamTab } from './TeamTab';
import { AgentModal } from './AgentModal';
import { TaskImages } from './TaskImages';
import { ConvoyTab } from './ConvoyTab';
import { AgentLiveTab } from './AgentLiveTab';
import { TaskChatTab } from './TaskChatTab';
import { WorkspaceTab } from './WorkspaceTab';
import { DeliverablePicker, type PickerDeliverable } from './DeliverablePicker';
import { TaskInitiativePanel } from './TaskInitiativePanel';
import type { Task, TaskPriority, TaskStatus } from '@/lib/types';

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024; // 100 MB — server enforces the same cap

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

type TabType = 'overview' | 'planning' | 'convoy' | 'team' | 'activity' | 'deliverables' | 'images' | 'sessions' | 'workspace' | 'agent-live' | 'chat';

interface TaskModalProps {
  task?: Task;
  onClose: () => void;
  workspaceId?: string;
}

export function TaskModal({ task, onClose, workspaceId }: TaskModalProps) {
  const { agents, addTask, updateTask, updateTaskStatus, addEvent } = useMissionControl();
  const [isPromoting, setIsPromoting] = useState(false);
  const [promoteError, setPromoteError] = useState<string | null>(null);

  const handlePromote = async () => {
    if (!task) return;
    setIsPromoting(true);
    setPromoteError(null);
    try {
      const res = await fetch(`/api/tasks/${task.id}/promote`, { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Promote failed (${res.status})`);
      }
      updateTaskStatus(task.id, 'inbox');
      addEvent({
        id: task.id + '-promote-' + Date.now(),
        type: 'task_status_changed',
        task_id: task.id,
        message: `Promoted draft to queue: ${task.title}`,
        created_at: new Date().toISOString(),
      });
      onClose();
    } catch (e) {
      setPromoteError(e instanceof Error ? e.message : 'Promote failed');
    } finally {
      setIsPromoting(false);
    }
  };

  // Set status='in_progress' (which the existing auto-dispatch path detects)
  // and trigger the gateway dispatch. Used both by "Start work" on a queued
  // task and by "Promote and start" on a draft (after promotion).
  const startWork = async (
    targetTask: Task,
    options: { agentId?: string | null; agentName?: string } = {},
  ): Promise<void> => {
    const agentId = options.agentId ?? targetTask.assigned_agent_id ?? null;
    const agentName =
      options.agentName ?? agents.find(a => a.id === agentId)?.name ?? 'Unknown Agent';
    const patchRes = await fetch(`/api/tasks/${targetTask.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'in_progress' }),
    });
    if (!patchRes.ok) {
      const body = await patchRes.json().catch(() => ({}));
      throw new Error(body.error || `Status update failed (${patchRes.status})`);
    }
    updateTaskStatus(targetTask.id, 'in_progress');
    if (agentId) {
      const result = await triggerAutoDispatch({
        taskId: targetTask.id,
        taskTitle: targetTask.title,
        agentId,
        agentName,
        workspaceId: targetTask.workspace_id,
      });
      if (!result.success) {
        throw new Error(result.error || 'Dispatch failed');
      }
    }
    addEvent({
      id: targetTask.id + '-start-' + Date.now(),
      type: 'task_status_changed',
      task_id: targetTask.id,
      message: `Started: ${targetTask.title}`,
      created_at: new Date().toISOString(),
    });
  };

  const handleStartWork = async () => {
    if (!task) return;
    setIsPromoting(true);
    setPromoteError(null);
    try {
      await startWork(task);
      onClose();
    } catch (e) {
      setPromoteError(e instanceof Error ? e.message : 'Start failed');
    } finally {
      setIsPromoting(false);
    }
  };

  const handlePromoteAndStart = async () => {
    if (!task) return;
    setIsPromoting(true);
    setPromoteError(null);
    try {
      const promoteRes = await fetch(`/api/tasks/${task.id}/promote`, { method: 'POST' });
      if (!promoteRes.ok) {
        const body = await promoteRes.json().catch(() => ({}));
        throw new Error(body.error || `Promote failed (${promoteRes.status})`);
      }
      updateTaskStatus(task.id, 'inbox');
      // The promote endpoint doesn't change assigned_agent_id, so we can use
      // the task's existing assignment (set when the workflow template
      // auto-assigned at draft-creation time) to drive the dispatch.
      await startWork({ ...task, status: 'inbox' });
      onClose();
    } catch (e) {
      setPromoteError(e instanceof Error ? e.message : 'Promote-and-start failed');
    } finally {
      setIsPromoting(false);
    }
  };
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showAgentModal, setShowAgentModal] = useState(false);
  const [usePlanningMode, setUsePlanningMode] = useState(false);
  // Auto-switch to relevant tab based on task status
  const [activeTab, setActiveTab] = useState<TabType>(
    task?.status === 'planning' ? 'planning' : task?.status === 'convoy_active' ? 'convoy' : 'overview'
  );

  // Stable callback for when spec is locked - use window.location.reload() to refresh data
  const handleSpecLocked = useCallback(() => {
    window.location.reload();
  }, []);

  const [form, setForm] = useState({
    title: task?.title || '',
    description: task?.description || '',
    priority: task?.priority || 'normal' as TaskPriority,
    status: task?.status || 'inbox' as TaskStatus,
    assigned_agent_id: task?.assigned_agent_id || '',
    due_date: task?.due_date || '',
    include_knowledge: Boolean(task?.include_knowledge),
  });

  const resolveStatus = (): TaskStatus => {
    // Planning mode overrides everything
    if (!task && usePlanningMode) return 'planning';
    // Auto-determine based on agent assignment
    const hasAgent = !!form.assigned_agent_id;
    if (!task) {
      // New task: agent → assigned, no agent → inbox
      return hasAgent ? 'assigned' : 'inbox';
    }
    // Existing task: if in inbox and agent just assigned, promote to assigned
    if (task.status === 'inbox' && hasAgent) return 'assigned';
    return form.status;
  };

  const [saveError, setSaveError] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [isArchiving, setIsArchiving] = useState(false);

  // Attachments staged on the overview tab for a new task. For edit mode we
  // commit them to the existing task immediately via the "Add" buttons
  // instead of staging, so retries after a partial save work transparently.
  const [pendingUploads, setPendingUploads] = useState<File[]>([]);
  const [pendingRefs, setPendingRefs] = useState<PickerDeliverable[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [showPicker, setShowPicker] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Bumping this forces DeliverablesList to refetch after edit-mode uploads.
  const [deliverablesRefresh, setDeliverablesRefresh] = useState(0);
  const effectiveWorkspaceId = workspaceId || task?.workspace_id || 'default';

  const stageFiles = (files: FileList | File[]) => {
    const list = Array.from(files);
    const tooLarge = list.filter((f) => f.size > MAX_UPLOAD_BYTES);
    const ok = list.filter((f) => f.size <= MAX_UPLOAD_BYTES);
    if (tooLarge.length > 0) {
      setAttachmentError(
        `${tooLarge.length} file(s) exceed the 100 MB limit: ${tooLarge.map((f) => f.name).join(', ')}`,
      );
    } else {
      setAttachmentError(null);
    }
    if (ok.length > 0) {
      setPendingUploads((prev) => [...prev, ...ok]);
    }
  };

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) stageFiles(e.target.files);
    // Reset so selecting the same file again re-fires onChange.
    e.target.value = '';
  };

  const uploadFilesToTask = async (tid: string, files: File[]): Promise<string[]> => {
    if (files.length === 0) return [];
    const fd = new FormData();
    for (const f of files) fd.append('files', f, f.name);
    const res = await fetch(`/api/tasks/${tid}/attachments`, { method: 'POST', body: fd });
    const data = await res.json().catch(() => ({ failed: [{ filename: '(batch)', error: 'Upload failed' }] }));
    const failures = (data.failed || []) as Array<{ filename: string; error: string }>;
    return failures.map((f) => `${f.filename}: ${f.error}`);
  };

  const linkReferencesToTask = async (tid: string, refs: PickerDeliverable[]): Promise<string[]> => {
    if (refs.length === 0) return [];
    const results = await Promise.allSettled(
      refs.map((r) =>
        fetch(`/api/tasks/${tid}/deliverables`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ kind: 'reference', source_deliverable_id: r.id }),
        }).then(async (res) => {
          if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.error || `Failed to link "${r.title}"`);
          }
        }),
      ),
    );
    return results
      .map((r, i) => (r.status === 'rejected' ? `${refs[i].title}: ${r.reason?.message ?? 'link failed'}` : null))
      .filter((v): v is string => v !== null);
  };

  // Edit-mode: commit attachment changes immediately so "retry after a
  // failed create" is just reopening the task and clicking Add.
  const handleEditModeAddFiles = async (files: FileList | File[]) => {
    if (!task) return;
    const list = Array.from(files);
    const tooLarge = list.filter((f) => f.size > MAX_UPLOAD_BYTES);
    const ok = list.filter((f) => f.size <= MAX_UPLOAD_BYTES);
    if (tooLarge.length > 0) {
      setAttachmentError(
        `${tooLarge.length} file(s) exceed the 100 MB limit: ${tooLarge.map((f) => f.name).join(', ')}`,
      );
    } else {
      setAttachmentError(null);
    }
    if (ok.length === 0) return;
    const failures = await uploadFilesToTask(task.id, ok);
    if (failures.length > 0) {
      setAttachmentError(failures.join('; '));
    }
    setDeliverablesRefresh((n) => n + 1);
  };

  const handleEditModeAddReference = async (ref: PickerDeliverable) => {
    if (!task) return;
    const failures = await linkReferencesToTask(task.id, [ref]);
    if (failures.length > 0) {
      setAttachmentError(failures.join('; '));
    } else {
      setAttachmentError(null);
    }
    setDeliverablesRefresh((n) => n + 1);
  };

  const handleSubmit = async (e: React.FormEvent, keepOpen = false) => {
    e.preventDefault();
    setIsSubmitting(true);
    setSaveError(null);

    try {
      const url = task ? `/api/tasks/${task.id}` : '/api/tasks';
      const method = task ? 'PATCH' : 'POST';
      const resolvedStatus = resolveStatus();

      const payload = {
        ...form,
        status: resolvedStatus,
        assigned_agent_id: form.assigned_agent_id || null,
        due_date: form.due_date || null,
        workspace_id: workspaceId || task?.workspace_id || 'default',
      };

      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({ error: 'Unknown error' }));
        setSaveError(errData.error || `Save failed (${res.status})`);
        return;
      }

      const savedTask = await res.json();

      if (task) {
        // Editing existing task
        updateTask(savedTask);

        // Note: dispatch for existing tasks is handled server-side by the PATCH route.
        // Only trigger client-side dispatch for drag-to-in_progress (legacy flow).
        if (shouldTriggerAutoDispatch(task.status, savedTask.status, savedTask.assigned_agent_id)) {
          triggerAutoDispatch({
            taskId: savedTask.id,
            taskTitle: savedTask.title,
            agentId: savedTask.assigned_agent_id,
            agentName: savedTask.assigned_agent?.name || 'Unknown Agent',
            workspaceId: savedTask.workspace_id
          }).catch((err) => console.error('Auto-dispatch failed:', err));
        }

        onClose();
        return;
      }

      // Creating new task
      addTask(savedTask);
      addEvent({
        id: savedTask.id + '-created',
        type: 'task_created',
        task_id: savedTask.id,
        message: `New task: ${savedTask.title}`,
        created_at: new Date().toISOString(),
      });

      // Fan out staged attachments. Run sequentially-but-parallel-internally:
      // upload batch + refs batch fire concurrently, and we wait for both to
      // finish before dispatching so the agent's first prompt sees them.
      const attachFailures: string[] = [];
      if (pendingUploads.length > 0 || pendingRefs.length > 0) {
        const [uploadErrs, refErrs] = await Promise.all([
          uploadFilesToTask(savedTask.id, pendingUploads),
          linkReferencesToTask(savedTask.id, pendingRefs),
        ]);
        attachFailures.push(...uploadErrs, ...refErrs);
      }
      if (attachFailures.length > 0) {
        // Task is saved; surface the partial-failure list without closing so
        // the user can retry via the edit view. Keep dispatch on ice.
        setSaveError(`Task created, but some attachments failed: ${attachFailures.join('; ')}`);
        return;
      }

      if (usePlanningMode) {
        // Start planning session (fire-and-forget), then close modal.
        // User reopens the task from the board to see the planning tab.
        fetch(`/api/tasks/${savedTask.id}/planning`, { method: 'POST' })
          .catch((error) => console.error('Failed to start planning:', error));
        onClose();
        return;
      }

      // Auto-dispatch if agent assigned (fire-and-forget)
      if (savedTask.assigned_agent_id && savedTask.status === 'assigned') {
        triggerAutoDispatch({
          taskId: savedTask.id,
          taskTitle: savedTask.title,
          agentId: savedTask.assigned_agent_id,
          agentName: savedTask.assigned_agent?.name || 'Unknown Agent',
          workspaceId: savedTask.workspace_id
        }).catch((err) => console.error('Auto-dispatch failed:', err));
      }

      if (keepOpen) {
        // "Save & New": clear form, stay open
        setForm({
          title: '',
          description: '',
          priority: 'normal' as TaskPriority,
          status: 'inbox' as TaskStatus,
          assigned_agent_id: '',
          due_date: '',
          include_knowledge: false,
        });
        setUsePlanningMode(false);
        setPendingUploads([]);
        setPendingRefs([]);
        setAttachmentError(null);
      } else {
        onClose();
      }
    } catch (error) {
      console.error('Failed to save task:', error);
      setSaveError(error instanceof Error ? error.message : 'Network error — please try again');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleArchiveToggle = async () => {
    if (!task) return;
    const shouldArchive = !task.is_archived;
    setIsArchiving(true);
    try {
      const res = await fetch(`/api/tasks/${task.id}/archive`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ archived: shouldArchive }),
      });
      if (res.ok) {
        const updated = await res.json();
        useMissionControl.setState((state) => ({
          tasks: state.tasks.map((t) => (t.id === updated.id ? { ...t, ...updated } : t)),
        }));
        onClose();
      }
    } catch (error) {
      console.error('Failed to toggle archive:', error);
    } finally {
      setIsArchiving(false);
    }
  };

  const handleDelete = async () => {
    if (!task || !confirm(`Delete "${task.title}"?`)) return;

    setIsDeleting(true);
    setDeleteError(null);
    try {
      const res = await fetch(`/api/tasks/${task.id}`, { method: 'DELETE' });
      if (res.ok) {
        useMissionControl.setState((state) => ({
          tasks: state.tasks.filter((t) => t.id !== task.id),
        }));
        onClose();
      } else {
        const errData = await res.json().catch(() => ({ error: 'Unknown error' }));
        setDeleteError(errData.error || `Delete failed (${res.status})`);
      }
    } catch (error) {
      console.error('Failed to delete task:', error);
      setDeleteError(error instanceof Error ? error.message : 'Network error — please try again');
    } finally {
      setIsDeleting(false);
    }
  };

  const priorities: TaskPriority[] = ['low', 'normal', 'high', 'urgent'];

  const tabs = [
    { id: 'overview' as TabType, label: 'Overview', icon: null },
    { id: 'planning' as TabType, label: 'Planning', icon: <ClipboardList className="w-4 h-4" /> },
    { id: 'convoy' as TabType, label: 'Convoy', icon: <Truck className="w-4 h-4" /> },
    { id: 'team' as TabType, label: 'Team', icon: <Users className="w-4 h-4" /> },
    { id: 'activity' as TabType, label: 'Activity', icon: <Activity className="w-4 h-4" /> },
    { id: 'deliverables' as TabType, label: 'Deliverables', icon: <Package className="w-4 h-4" /> },
    { id: 'images' as TabType, label: 'Images', icon: <ImageIcon className="w-4 h-4" /> },
    { id: 'sessions' as TabType, label: 'Sessions', icon: <Bot className="w-4 h-4" /> },
    // Workspace tab — shown when task has workspace isolation
    ...(task?.workspace_path ? [{ id: 'workspace' as TabType, label: 'Workspace', icon: <HardDrive className="w-4 h-4" /> }] : []),
    // Chat is always available — messages dispatch the agent if needed
    { id: 'chat' as TabType, label: 'Chat', icon: <MessageSquare className="w-4 h-4" /> },
    // Agent Live only shown when agent is active
    ...(task && ['in_progress', 'convoy_active', 'testing', 'verification'].includes(task.status)
      ? [
          { id: 'agent-live' as TabType, label: 'Agent Live', icon: <Radio className="w-4 h-4" /> },
        ]
      : []),
  ];

  return (
    <div className="fixed inset-0 bg-black/50 flex items-end sm:items-center justify-center z-50 p-3 sm:p-4">
      <div className="bg-mc-bg-secondary border border-mc-border rounded-t-xl sm:rounded-lg w-full max-w-5xl max-h-[92vh] sm:max-h-[92vh] h-[92vh] flex flex-col pb-[env(safe-area-inset-bottom)] sm:pb-0">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-mc-border shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            {task && (
              <span
                className={`px-2 py-0.5 rounded text-[10px] uppercase tracking-wide border shrink-0 ${
                  task.status === 'draft'
                    ? 'bg-amber-500/15 text-amber-300 border-amber-500/40'
                    : 'bg-mc-bg-tertiary text-mc-text-secondary border-mc-border'
                }`}
              >
                {task.status}
              </span>
            )}
            <h2 className="text-lg font-semibold truncate">
              {task ? task.title : 'Create New Task'}
            </h2>
          </div>
          <button
            onClick={onClose}
            className="p-1 hover:bg-mc-bg-tertiary rounded-sm shrink-0"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Tabs - only show for existing tasks */}
        {task && (
          <div className="flex border-b border-mc-border shrink-0 overflow-x-auto">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex items-center gap-2 px-4 min-h-11 py-2 text-sm font-medium transition-colors whitespace-nowrap ${
                  activeTab === tab.id
                    ? 'text-mc-accent border-b-2 border-mc-accent'
                    : 'text-mc-text-secondary hover:text-mc-text'
                }`}
              >
                {tab.icon}
                {tab.label}
              </button>
            ))}
          </div>
        )}

        {/* Content Area */}
        <div className="flex-1 overflow-y-auto p-4">
          {/* Overview Tab */}
          {activeTab === 'overview' && (
            <form onSubmit={handleSubmit} className="space-y-4">
          {/* Title */}
          <div>
            <label className="block text-sm font-medium mb-1">Title</label>
            <input
              type="text"
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              required
              className="w-full min-h-11 bg-mc-bg border border-mc-border rounded-sm px-3 py-2 text-sm focus:outline-hidden focus:border-mc-accent"
              placeholder="What needs to be done?"
            />
          </div>

          {/* Description — defaults to a roomier height so longer
              briefs don't feel cramped, and resize-y so the operator
              can grow it further. Full inline-edit on the rest of the
              fields is a separate pass; here we only fix the most
              common gripe (description squeezed into 3 rows). */}
          <div>
            <label className="block text-sm font-medium mb-1">Description</label>
            <textarea
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              rows={8}
              className="w-full bg-mc-bg border border-mc-border rounded-sm px-3 py-2 text-sm focus:outline-hidden focus:border-mc-accent resize-y"
              placeholder="Add details..."
            />
          </div>

          {/* Planning Mode Toggle - only for new tasks */}
          {!task && (
            <div className="p-3 bg-mc-bg rounded-lg border border-mc-border">
              <label className="flex items-start gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={usePlanningMode}
                  onChange={(e) => setUsePlanningMode(e.target.checked)}
                  className="w-4 h-4 mt-0.5 rounded-sm border-mc-border"
                />
                <div>
                  <span className="font-medium text-sm flex items-center gap-2">
                    <ClipboardList className="w-4 h-4 text-mc-accent" />
                    Enable Planning Mode
                  </span>
                  <p className="text-xs text-mc-text-secondary mt-1">
                    Best for complex projects that need detailed requirements.
                    You&apos;ll answer a few questions to define scope, goals, and constraints
                    before work begins. Skip this for quick, straightforward tasks.
                  </p>
                </div>
              </label>
            </div>
          )}

          {/* Inject prior lessons (workspace knowledge) - opt-in */}
          <div className="p-3 bg-mc-bg rounded-lg border border-mc-border">
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={form.include_knowledge}
                onChange={(e) => setForm({ ...form, include_knowledge: e.target.checked })}
                className="w-4 h-4 mt-0.5 rounded-sm border-mc-border"
              />
              <div>
                <span className="font-medium text-sm flex items-center gap-2">
                  <BookOpen className="w-4 h-4 text-mc-accent" />
                  Include workspace lessons in dispatch
                </span>
                <p className="text-xs text-mc-text-secondary mt-1">
                  Off by default. When enabled, the assigned agent receives the
                  workspace&apos;s recent learner-captured lessons as context.
                  Leave off for unrelated work — agents can still pull a
                  targeted lesson on demand via <code>request_knowledge</code>.
                </p>
              </div>
            </label>
          </div>

          {/* Assigned Agent */}
          <div>
            <label className="block text-sm font-medium mb-1">Assign to</label>
            <select
              value={form.assigned_agent_id}
              onChange={(e) => {
                if (e.target.value === '__add_new__') {
                  setShowAgentModal(true);
                } else {
                  setForm({ ...form, assigned_agent_id: e.target.value });
                }
              }}
              className="w-full min-h-11 bg-mc-bg border border-mc-border rounded-sm px-3 py-2 text-sm focus:outline-hidden focus:border-mc-accent"
            >
              <option value="">Unassigned</option>
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.avatar_emoji} {agent.name} - {agent.role}
                </option>
              ))}
              <option value="__add_new__" className="text-mc-accent">
                ➕ Add new agent...
              </option>
            </select>
          </div>

          <div className="grid grid-cols-2 gap-4">
            {/* Priority */}
            <div>
              <label className="block text-sm font-medium mb-1">Priority</label>
              <select
                value={form.priority}
                onChange={(e) => setForm({ ...form, priority: e.target.value as TaskPriority })}
                className="w-full min-h-11 bg-mc-bg border border-mc-border rounded-sm px-3 py-2 text-sm focus:outline-hidden focus:border-mc-accent"
              >
                {priorities.map((p) => (
                  <option key={p} value={p}>
                    {p.toUpperCase()}
                  </option>
                ))}
              </select>
            </div>

            {/* Due Date */}
            <div>
              <label className="block text-sm font-medium mb-1">Due Date</label>
              <input
                type="datetime-local"
                value={form.due_date}
                onChange={(e) => setForm({ ...form, due_date: e.target.value })}
                className="w-full min-h-11 bg-mc-bg border border-mc-border rounded-sm px-3 py-2 text-sm focus:outline-hidden focus:border-mc-accent"
              />
            </div>
          </div>

          {/* Attachments */}
          <div>
            <label className="block text-sm font-medium mb-1 flex items-center gap-1.5">
              <Paperclip className="w-4 h-4" />
              Attachments
            </label>
            <p className="text-xs text-mc-text-secondary mb-2">
              {task
                ? 'Add files or reference prior deliverables. Changes save immediately.'
                : 'Add files or reference prior deliverables to give the agent context. These save after you create the task.'}
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-sm border border-mc-border hover:border-mc-accent hover:bg-mc-bg-tertiary"
              >
                <Upload className="w-3.5 h-3.5" />
                Upload files
              </button>
              <button
                type="button"
                onClick={() => setShowPicker(true)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-sm border border-mc-border hover:border-mc-accent hover:bg-mc-bg-tertiary"
              >
                <LinkIcon className="w-3.5 h-3.5" />
                Reference prior deliverable
              </button>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={(e) => {
                  if (task) {
                    if (e.target.files) handleEditModeAddFiles(e.target.files);
                    e.target.value = '';
                  } else {
                    handleFileInputChange(e);
                  }
                }}
              />
            </div>

            {/* Staged list — create mode only */}
            {!task && (pendingUploads.length > 0 || pendingRefs.length > 0) && (
              <ul className="mt-3 space-y-1.5">
                {pendingUploads.map((f, i) => (
                  <li
                    key={`u-${i}-${f.name}`}
                    className="flex items-center gap-2 p-2 bg-mc-bg rounded-sm border border-mc-border text-xs"
                  >
                    <Upload className="w-3.5 h-3.5 text-mc-accent shrink-0" />
                    <span className="flex-1 truncate">{f.name}</span>
                    <span className="text-mc-text-secondary shrink-0">{formatBytes(f.size)}</span>
                    <button
                      type="button"
                      onClick={() => setPendingUploads((prev) => prev.filter((_, idx) => idx !== i))}
                      className="p-0.5 hover:bg-mc-bg-tertiary rounded-sm text-mc-text-secondary hover:text-mc-text"
                      title="Remove"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </li>
                ))}
                {pendingRefs.map((r, i) => (
                  <li
                    key={`r-${r.id}`}
                    className="flex items-center gap-2 p-2 bg-mc-bg rounded-sm border border-mc-border text-xs"
                  >
                    <FileText className="w-3.5 h-3.5 text-mc-accent shrink-0" />
                    <span className="flex-1 truncate">
                      {r.title} <span className="text-mc-text-secondary">from {r.task_title}</span>
                    </span>
                    <button
                      type="button"
                      onClick={() => setPendingRefs((prev) => prev.filter((_, idx) => idx !== i))}
                      className="p-0.5 hover:bg-mc-bg-tertiary rounded-sm text-mc-text-secondary hover:text-mc-text"
                      title="Remove"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {attachmentError && (
              <div className="mt-2 p-2 bg-red-500/10 border border-red-500/30 rounded-sm">
                <span className="text-xs text-red-400">{attachmentError}</span>
              </div>
            )}
          </div>

          {/* Initiative + provenance — only meaningful for existing tasks */}
          {task && (
            <TaskInitiativePanel
              taskId={task.id}
              taskStatus={task.status}
              workspaceId={task.workspace_id || workspaceId || 'default'}
              initiativeId={task.initiative_id ?? null}
              onChanged={handleSpecLocked}
            />
          )}

          {/* Pull Request section */}
          {task?.pr_url && (
            <div className="p-3 bg-mc-bg rounded-lg border border-mc-border">
              <h4 className="text-sm font-medium text-mc-text mb-2 flex items-center gap-2">
                <ExternalLink className="w-4 h-4" />
                Pull Request
              </h4>
              <div className="flex items-center gap-3">
                <a
                  href={task.pr_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-mc-accent hover:underline break-all"
                >
                  {task.pr_url}
                </a>
                {task.pr_status && (
                  <span className={`shrink-0 text-xs px-2 py-1 rounded font-medium ${
                    task.pr_status === 'open' ? 'bg-blue-500/20 text-blue-400' :
                    task.pr_status === 'merged' ? 'bg-green-500/20 text-green-400' :
                    task.pr_status === 'closed' ? 'bg-red-500/20 text-red-400' :
                    'bg-gray-500/20 text-gray-400'
                  }`}>
                    {task.pr_status}
                  </span>
                )}
              </div>
            </div>
          )}

          {saveError && (
            <div className="p-3 bg-red-500/10 border border-red-500/30 rounded-md">
              <span className="text-sm text-red-400">{saveError}</span>
            </div>
          )}
            </form>
          )}

          {/* Planning Tab */}
          {activeTab === 'planning' && task && (
            <PlanningTab
              taskId={task.id}
              onSpecLocked={handleSpecLocked}
            />
          )}

          {/* Convoy Tab */}
          {activeTab === 'convoy' && task && (
            <ConvoyTab taskId={task.id} taskTitle={task.title} taskStatus={task.status} />
          )}

          {/* Team Tab */}
          {activeTab === 'team' && task && (
            <TeamTab taskId={task.id} workspaceId={workspaceId || task.workspace_id || 'default'} />
          )}

          {/* Activity Tab */}
          {activeTab === 'activity' && task && (
            <ActivityLog taskId={task.id} />
          )}

          {/* Deliverables Tab */}
          {activeTab === 'deliverables' && task && (
            <DeliverablesList taskId={task.id} refreshKey={deliverablesRefresh} />
          )}

          {/* Images Tab */}
          {activeTab === 'images' && task && (
            <TaskImages taskId={task.id} />
          )}

          {/* Sessions Tab */}
          {activeTab === 'sessions' && task && (
            <SessionsList taskId={task.id} />
          )}

          {/* Agent Live Tab */}
          {activeTab === 'agent-live' && task && (
            <AgentLiveTab taskId={task.id} />
          )}

          {/* Chat Tab */}
          {/* Workspace Tab */}
          {activeTab === 'workspace' && task && (
            <WorkspaceTab taskId={task.id} taskStatus={task.status} />
          )}

          {activeTab === 'chat' && task && (
            <TaskChatTab taskId={task.id} />
          )}
        </div>

        {/* Footer - only show on overview tab */}
        {activeTab === 'overview' && (
          <div className="flex items-center justify-between p-4 border-t border-mc-border shrink-0">
            <div className="flex items-center gap-2">
              {task && (
                <>
                  <button
                    type="button"
                    onClick={handleArchiveToggle}
                    disabled={isArchiving}
                    className="min-h-11 flex items-center gap-2 px-3 py-2 text-mc-text-secondary hover:text-mc-text hover:bg-mc-bg-tertiary rounded-sm text-sm disabled:opacity-50"
                    title={task.is_archived ? 'Restore from archive' : 'Archive (preserves deliverables)'}
                  >
                    {task.is_archived ? <ArchiveRestore className="w-4 h-4" /> : <Archive className="w-4 h-4" />}
                    {isArchiving ? '...' : task.is_archived ? 'Unarchive' : 'Archive'}
                  </button>
                  <button
                    type="button"
                    onClick={handleDelete}
                    disabled={isDeleting}
                    className="min-h-11 flex items-center gap-2 px-3 py-2 text-mc-accent-red hover:bg-mc-accent-red/10 rounded-sm text-sm disabled:opacity-50"
                    title="Permanently delete this task and its deliverables"
                  >
                    <Trash2 className="w-4 h-4" />
                    {isDeleting ? 'Deleting...' : 'Delete'}
                  </button>
                  {deleteError && (
                    <span className="text-xs text-red-400 max-w-48 truncate" title={deleteError}>
                      {deleteError}
                    </span>
                  )}
                </>
              )}
            </div>
            <div className="flex items-center gap-2">
              {(task?.status === 'draft' || task?.status === 'inbox' || task?.status === 'assigned') && (
                <>
                  {promoteError && (
                    <span className="text-xs text-red-400 max-w-48 truncate" title={promoteError}>
                      {promoteError}
                    </span>
                  )}
                  {task.status === 'draft' && (
                    <button
                      type="button"
                      onClick={handlePromote}
                      disabled={isPromoting}
                      title="Promote draft to the queue (status → inbox); doesn't start work"
                      className="min-h-11 flex items-center gap-2 px-3 py-2 rounded-sm text-sm border border-amber-500/40 text-amber-300 hover:bg-amber-500/10 disabled:opacity-50"
                    >
                      <Send className="w-4 h-4" />
                      {isPromoting ? 'Working…' : 'Promote to queue'}
                    </button>
                  )}
                  {task.status === 'draft' && task.assigned_agent_id && (
                    <button
                      type="button"
                      onClick={handlePromoteAndStart}
                      disabled={isPromoting}
                      title="Promote draft and immediately dispatch to the assigned agent"
                      className="min-h-11 flex items-center gap-2 px-3 py-2 rounded-sm text-sm bg-mc-accent text-mc-bg hover:bg-mc-accent/90 disabled:opacity-50"
                    >
                      <Send className="w-4 h-4" />
                      {isPromoting ? 'Working…' : 'Promote and start'}
                    </button>
                  )}
                  {(task.status === 'inbox' || task.status === 'assigned') && task.assigned_agent_id && (
                    <button
                      type="button"
                      onClick={handleStartWork}
                      disabled={isPromoting}
                      title="Dispatch to the assigned agent and move to In Progress"
                      className="min-h-11 flex items-center gap-2 px-3 py-2 rounded-sm text-sm bg-mc-accent text-mc-bg hover:bg-mc-accent/90 disabled:opacity-50"
                    >
                      <Send className="w-4 h-4" />
                      {isPromoting ? 'Starting…' : 'Start work'}
                    </button>
                  )}
                </>
              )}
              <button
                type="button"
                onClick={onClose}
                className="min-h-11 px-4 py-2 text-sm text-mc-text-secondary hover:text-mc-text"
              >
                Cancel
              </button>
              {!task && (
                <button
                  onClick={(e) => handleSubmit(e, true)}
                  disabled={isSubmitting}
                  className="min-h-11 flex items-center gap-2 px-4 py-2 border border-mc-accent text-mc-accent rounded-sm text-sm font-medium hover:bg-mc-accent/10 disabled:opacity-50"
                >
                  <Plus className="w-4 h-4" />
                  {isSubmitting ? 'Saving...' : 'Save & New'}
                </button>
              )}
              <button
                onClick={handleSubmit}
                disabled={isSubmitting}
                className="min-h-11 flex items-center gap-2 px-4 py-2 bg-mc-accent text-mc-bg rounded-sm text-sm font-medium hover:bg-mc-accent/90 disabled:opacity-50"
              >
                <Save className="w-4 h-4" />
                {isSubmitting ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Nested Agent Modal for inline agent creation */}
      {showAgentModal && (
        <AgentModal
          workspaceId={workspaceId}
          onClose={() => setShowAgentModal(false)}
          onAgentCreated={(agentId) => {
            // Auto-select the newly created agent
            setForm({ ...form, assigned_agent_id: agentId });
            setShowAgentModal(false);
          }}
        />
      )}

      {showPicker && (
        <DeliverablePicker
          workspaceId={effectiveWorkspaceId}
          excludeTaskId={task?.id}
          onClose={() => setShowPicker(false)}
          onPick={(d) => {
            setShowPicker(false);
            if (task) {
              handleEditModeAddReference(d);
            } else if (!pendingRefs.some((r) => r.id === d.id)) {
              setPendingRefs((prev) => [...prev, d]);
            }
          }}
        />
      )}
    </div>
  );
}
