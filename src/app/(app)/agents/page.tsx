'use client';

/**
 * Dedicated Agents page — tabular roster.
 *
 * The card-grid version was a clear win over the legacy sidebar but still
 * hid most agent details behind the edit modal. This pass switches to a
 * compact sortable table that surfaces the high-frequency knobs (avatar,
 * role, model) inline so the operator can sweep across the whole team
 * without opening the modal for each one.
 *
 * Inline-editable columns commit on change/blur via PATCH /api/agents/[id]
 * with optimistic update + rollback. The full settings (description,
 * SOUL.md / USER.md / AGENTS.md, session_key_prefix, master flag, etc.)
 * still live in AgentModal — clicking the agent's name opens it.
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  Loader2,
  Megaphone,
  RotateCcw,
  Plus,
  Search,
  Power,
  Pencil,
  Zap,
  ZapOff,
  Users,
  ChevronUp,
  ChevronDown,
  ChevronsUpDown,
} from 'lucide-react';
import { useMissionControl } from '@/lib/store';
import { useCurrentWorkspaceId } from '@/components/shell/workspace-context';
import type { Agent, AgentStatus, AgentHealthState, OpenClawSession } from '@/lib/types';
import { AgentModal } from '@/components/AgentModal';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { DiscoverAgentsModal } from '@/components/DiscoverAgentsModal';
import { HealthIndicator } from '@/components/HealthIndicator';
import { AgentPingIndicator } from '@/components/AgentPingIndicator';
import { RollCallResultsPanel, type RollCallResultView } from '@/components/AgentsSidebar';
import { showAlertDialog } from '@/lib/show-alert';

type FilterTab = 'all' | 'working' | 'standby';

// Sortable columns. The action column is intentionally not sortable.
type SortKey = 'name' | 'role' | 'model' | 'status' | 'gateway';
interface SortState { key: SortKey; dir: 'asc' | 'desc' }

const EMOJI_OPTIONS = ['🤖', '🦞', '💻', '🔍', '✍️', '🎨', '📊', '🧠', '⚡', '🚀', '🎯', '🔧'];

export default function AgentsPage() {
  const { agents, setAgents, agentOpenClawSessions, setAgentOpenClawSession, updateAgent, agentPings, setAgentPings } =
    useMissionControl();
  const workspaceId = useCurrentWorkspaceId();

  // Hydrate the agents store directly. Other plan pages (workspace,
  // initiatives, pm) hydrate via their own fetches; /agents previously
  // relied on a sibling page having populated the shared store first, so
  // a direct visit / hard reload showed an empty roster.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/agents?workspace_id=${encodeURIComponent(workspaceId)}`);
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as Agent[];
        if (!cancelled) setAgents(data);
      } catch {
        /* leave roster empty — UI shows the empty-state */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceId, setAgents]);

  const [filter, setFilter] = useState<FilterTab>('all');
  const [sort, setSort] = useState<SortState>({ key: 'name', dir: 'asc' });
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editingAgent, setEditingAgent] = useState<Agent | null>(null);
  const [showDiscoverModal, setShowDiscoverModal] = useState(false);
  const [connectingAgentId, setConnectingAgentId] = useState<string | null>(null);
  const [activeSubAgents, setActiveSubAgents] = useState(0);
  const [agentHealth, setAgentHealth] = useState<Record<string, AgentHealthState>>({});
  const [togglingAgentId, setTogglingAgentId] = useState<string | null>(null);
  const [resettingAgentId, setResettingAgentId] = useState<string | null>(null);
  const [rollCallBusy, setRollCallBusy] = useState(false);
  const [rollCallResult, setRollCallResult] = useState<RollCallResultView | null>(null);
  const [resetSessionsBusy, setResetSessionsBusy] = useState(false);
  // Replaces native window.confirm() — see §1.7 finding in PREVIEW_TEST_FINDINGS.
  // The native dialog blocks automation tooling and breaks the test-flow walk.
  const [pendingConfirm, setPendingConfirm] = useState<null | {
    title: string;
    body: React.ReactNode;
    confirmLabel: string;
    destructive?: boolean;
    onConfirm: () => void;
  }>(null);
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [defaultModel, setDefaultModel] = useState<string>('');
  const [emojiPickerFor, setEmojiPickerFor] = useState<string | null>(null);

  // ─── data hydration ─────────────────────────────────────────────────

  const loadOpenClawSessions = useCallback(async () => {
    for (const agent of agents) {
      try {
        const res = await fetch(`/api/agents/${agent.id}/openclaw`);
        if (res.ok) {
          const data = await res.json();
          if (data.linked && data.session) {
            setAgentOpenClawSession(agent.id, data.session as OpenClawSession);
          }
        }
      } catch (error) {
        console.error(`Failed to load OpenClaw session for ${agent.name}:`, error);
      }
    }
  }, [agents, setAgentOpenClawSession]);

  useEffect(() => {
    if (agents.length > 0) loadOpenClawSessions();
  }, [loadOpenClawSessions, agents.length]);

  useEffect(() => {
    const tick = async () => {
      try {
        const res = await fetch('/api/openclaw/sessions?session_type=subagent&status=active');
        if (res.ok) {
          const sessions = await res.json();
          setActiveSubAgents(sessions.length);
        }
      } catch {}
    };
    tick();
    const id = setInterval(tick, 30_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const tick = async () => {
      try {
        const res = await fetch('/api/agents/health');
        if (res.ok) {
          const data = await res.json();
          const healthMap: Record<string, AgentHealthState> = {};
          for (const h of data) healthMap[h.agent_id] = h.health_state;
          setAgentHealth(healthMap);
        }
      } catch {}
    };
    tick();
    const id = setInterval(tick, 30_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/agents/activity');
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as Record<string, { sentAt?: string; receivedAt?: string }>;
        setAgentPings(data);
      } catch {}
    })();
    return () => {
      cancelled = true;
    };
  }, [setAgentPings]);

  // Models list for the inline dropdown — fetched once on mount, same as
  // AgentModal does. The "(Default)" suffix is shown in the option label so
  // the operator can tell which entry will be picked when model is left blank.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/openclaw/models');
        if (!res.ok || cancelled) return;
        const data = await res.json();
        setAvailableModels(data.availableModels || []);
        setDefaultModel(data.defaultModel || '');
      } catch {}
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Roll-call status polling while the panel is open.
  useEffect(() => {
    if (!rollCallResult?.rollcall_id) return;
    const rid = rollCallResult.rollcall_id;
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch(`/api/agents/rollcall/${rid}`);
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;
        setRollCallResult(prev =>
          prev && prev.rollcall_id === rid
            ? { ...prev, entries: data.entries, seconds_remaining: data.summary.seconds_remaining }
            : prev,
        );
      } catch {}
    };
    tick();
    const interval = setInterval(tick, 2_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [rollCallResult?.rollcall_id]);

  // ─── header actions ─────────────────────────────────────────────────

  const runRollCall = async () => {
    setRollCallBusy(true);
    setRollCallResult(null);
    try {
      const res = await fetch('/api/agents/rollcall', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace_id: workspaceId, mode: 'direct', timeout_seconds: 30 }),
      });
      const data = await res.json();
      if (!res.ok) {
        setRollCallResult({
          rollcall_id: '',
          mode: 'direct',
          seconds_remaining: 0,
          entries: [],
          error: data.error,
          reason: data.reason,
        });
        return;
      }
      setRollCallResult({
        rollcall_id: data.rollcall_id,
        mode: data.rollcall.mode,
        seconds_remaining: 30,
        entries: data.entries,
      });
    } catch (err) {
      setRollCallResult({
        rollcall_id: '',
        mode: 'direct',
        seconds_remaining: 0,
        entries: [],
        error: (err as Error).message,
      });
    } finally {
      setRollCallBusy(false);
    }
  };

  const resetAllSessions = () => {
    setPendingConfirm({
      title: 'Reset ALL agent sessions?',
      body: (
        <ol className="list-decimal pl-5 space-y-1">
          <li>Aborts in-flight Product Autopilot research/ideation cycles.</li>
          <li>Wipes Mission Control session tracking.</li>
          <li>
            Sends <code className="text-xs px-1 rounded bg-mc-bg-secondary">/reset</code> to every active gateway-synced agent.
          </li>
          <li className="text-mc-text-secondary">
            Use after editing persona files or when sessionKey routing has drifted.
          </li>
        </ol>
      ),
      confirmLabel: 'Reset all',
      destructive: true,
      onConfirm: () => { void doResetAllSessions(); },
    });
  };

  const doResetAllSessions = async () => {
    setResetSessionsBusy(true);
    try {
      const res = await fetch('/api/openclaw/sessions', { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) {
        showAlertDialog(data.error || 'Failed to reset sessions');
        return;
      }
      for (const agent of agents) setAgentOpenClawSession(agent.id, null);
      const resets: Array<{ name: string; ok: boolean; error?: string }> = data.agents_reset || [];
      const ok = resets.filter(r => r.ok).map(r => r.name);
      const failed = resets.filter(r => !r.ok);
      const aborted: Array<{ cycle_id: string; cycle_type: string }> = data.aborted_cycles || [];
      const lines: string[] = [`Cleared ${data.deleted} MC session record(s).`];
      if (aborted.length) lines.push(`Aborted ${aborted.length} in-flight autopilot cycle(s).`);
      if (ok.length) lines.push(`Sent /reset to: ${ok.join(', ')}`);
      if (failed.length) {
        lines.push(`Failed to /reset: ${failed.map(f => `${f.name} (${f.error || 'unknown'})`).join('; ')}`);
        lines.push("Fall back: run `/reset` in those agents' OpenClaw chats directly.");
      }
      if (data.gateway_error) lines.push(`Gateway unreachable: ${data.gateway_error}`);
      showAlertDialog(lines.join('\n').length > 80 ? lines.join('\n') : '', lines.join('\n'));
    } catch (err) {
      showAlertDialog('Reset failed', `Failed to reset sessions: ${(err as Error).message}`);
    } finally {
      setResetSessionsBusy(false);
    }
  };

  // ─── per-agent actions ──────────────────────────────────────────────

  // Generic optimistic-update PATCH used by the inline avatar / role /
  // model edits. Centralising it keeps each cell-level handler small and
  // ensures the rollback path is uniform.
  const patchAgent = useCallback(
    async (agent: Agent, patch: Partial<Agent>): Promise<boolean> => {
      const optimistic: Agent = { ...agent, ...patch };
      updateAgent(optimistic);
      try {
        const res = await fetch(`/api/agents/${agent.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch),
        });
        if (!res.ok) {
          updateAgent(agent);
          const err = await res.json().catch(() => ({}));
          showAlertDialog(err.error || 'Failed to update agent');
          return false;
        }
        const fresh = (await res.json()) as Agent;
        updateAgent(fresh);
        return true;
      } catch (err) {
        updateAgent(agent);
        showAlertDialog('Update failed', `Failed to update agent: ${(err as Error).message}`);
        return false;
      }
    },
    [updateAgent],
  );

  const toggleAgentActive = async (agent: Agent) => {
    const nextActive = !(Number(agent.is_active ?? 1) === 1);
    setTogglingAgentId(agent.id);
    await patchAgent(agent, { is_active: nextActive ? 1 : 0 });
    setTogglingAgentId(null);
  };

  const resetAgentSession = (agent: Agent) => {
    if (!agent.gateway_agent_id) {
      showAlertDialog('No gateway ID', 'This agent has no gateway_agent_id; nothing to reset on the gateway side.');
      return;
    }
    setPendingConfirm({
      title: `Reset ${agent.name}'s session?`,
      body: <p>The agent will re-init persona files on its next message.</p>,
      confirmLabel: 'Reset',
      destructive: true,
      onConfirm: () => { void doResetAgentSession(agent); },
    });
  };

  const doResetAgentSession = async (agent: Agent) => {
    setResettingAgentId(agent.id);
    try {
      const res = await fetch(`/api/agents/${agent.id}/reset`, { method: 'POST' });
      const body = await res.json().catch(() => ({}));
      if (res.ok && body.sent) {
        showAlertDialog(`Reset sent — gateway re-init in flight (cleared ${body.deleted ?? 0} session row(s)).`);
      } else if (res.ok && !body.sent) {
        showAlertDialog(
          `Gateway didn't ack`,
          `MC-side cleared (${body.deleted ?? 0} row(s)) but gateway didn't ack: ${body.error ?? body.gateway_error ?? 'send failed'}.`,
        );
      } else {
        showAlertDialog(body.error || `Reset failed (${res.status})`);
      }
    } catch (err) {
      showAlertDialog((err as Error).message || 'Reset failed');
    } finally {
      setResettingAgentId(null);
    }
  };

  const handleConnectToOpenClaw = async (agent: Agent) => {
    setConnectingAgentId(agent.id);
    try {
      const existingSession = agentOpenClawSessions[agent.id];
      if (existingSession) {
        const res = await fetch(`/api/agents/${agent.id}/openclaw`, { method: 'DELETE' });
        if (res.ok) setAgentOpenClawSession(agent.id, null);
      } else {
        const res = await fetch(`/api/agents/${agent.id}/openclaw`, { method: 'POST' });
        if (res.ok) {
          const data = await res.json();
          setAgentOpenClawSession(agent.id, data.session as OpenClawSession);
        } else {
          const error = await res.json();
          showAlertDialog(`Failed to connect: ${error.error || 'Unknown error'}`);
        }
      }
    } catch (error) {
      console.error('OpenClaw connection error:', error);
    } finally {
      setConnectingAgentId(null);
    }
  };

  // ─── derived ────────────────────────────────────────────────────────

  const filteredAgents = useMemo(() => {
    const matching = agents.filter(a => filter === 'all' || a.status === filter);
    const byKey = (a: Agent): string => {
      switch (sort.key) {
        case 'name': return a.name.toLowerCase();
        case 'role': return (a.role || '').toLowerCase();
        case 'model': return (a.model || '').toLowerCase();
        case 'status': return a.status;
        case 'gateway': return (a.gateway_agent_id || '').toLowerCase();
      }
    };
    const sorted = [...matching].sort((a, b) => {
      const av = byKey(a);
      const bv = byKey(b);
      if (av < bv) return sort.dir === 'asc' ? -1 : 1;
      if (av > bv) return sort.dir === 'asc' ? 1 : -1;
      return 0;
    });
    return sorted;
  }, [agents, filter, sort]);

  const counts = useMemo(
    () => ({
      all: agents.length,
      working: agents.filter(a => a.status === 'working').length,
      standby: agents.filter(a => a.status === 'standby').length,
    }),
    [agents],
  );

  const toggleSort = (key: SortKey) =>
    setSort(prev => ({
      key,
      dir: prev.key === key && prev.dir === 'asc' ? 'desc' : 'asc',
    }));

  return (
    <div className="min-h-full bg-mc-bg p-6">
      <div className="max-w-[1600px] mx-auto">
        {/* Header */}
        <header className="mb-5 flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-3">
            <Users className="w-6 h-6 text-mc-accent" />
            <div>
              <h1 className="text-2xl font-bold text-mc-text">Agents</h1>
              <p className="text-sm text-mc-text-secondary">
                Workspace roster, OpenClaw connectivity, and session controls.
              </p>
            </div>
            <span className="ml-2 px-2 py-0.5 rounded bg-mc-bg-secondary border border-mc-border text-xs text-mc-text-secondary">
              {agents.length} total
            </span>
            {activeSubAgents > 0 && (
              <span className="px-2 py-0.5 rounded bg-green-500/10 border border-green-500/30 text-xs text-green-400">
                ● {activeSubAgents} sub-agent{activeSubAgents === 1 ? '' : 's'} active
              </span>
            )}
          </div>

          <div className="ml-auto flex flex-wrap items-center gap-2">
            <HeaderButton
              icon={rollCallBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Megaphone className="w-4 h-4" />}
              onClick={runRollCall}
              disabled={rollCallBusy}
              tone="purple"
            >
              {rollCallBusy ? 'Calling…' : 'Roll Call'}
            </HeaderButton>
            <HeaderButton
              icon={resetSessionsBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <RotateCcw className="w-4 h-4" />}
              onClick={resetAllSessions}
              disabled={resetSessionsBusy}
              tone="amber"
            >
              {resetSessionsBusy ? 'Resetting…' : 'Reset all sessions'}
            </HeaderButton>
            <HeaderButton
              icon={<Search className="w-4 h-4" />}
              onClick={() => setShowDiscoverModal(true)}
              tone="blue"
            >
              Import from Gateway
            </HeaderButton>
            <HeaderButton
              icon={<Plus className="w-4 h-4" />}
              onClick={() => setShowCreateModal(true)}
              tone="accent"
            >
              Add Agent
            </HeaderButton>
          </div>
        </header>

        {/* Filter tabs */}
        <div className="mb-4 flex items-center gap-2">
          {(['all', 'working', 'standby'] as FilterTab[]).map(tab => (
            <button
              key={tab}
              onClick={() => setFilter(tab)}
              className={`px-3 py-1.5 rounded text-xs uppercase tracking-wide transition-colors ${
                filter === tab
                  ? 'bg-mc-accent text-mc-bg font-medium'
                  : 'bg-mc-bg-secondary border border-mc-border text-mc-text-secondary hover:text-mc-text'
              }`}
            >
              {tab} <span className="opacity-70">({counts[tab]})</span>
            </button>
          ))}
        </div>

        {/* Roll-call results */}
        {rollCallResult && (
          <div className="mb-4 rounded-lg border border-mc-border bg-mc-bg-secondary overflow-hidden">
            <RollCallResultsPanel result={rollCallResult} onClose={() => setRollCallResult(null)} />
          </div>
        )}

        {/* Table */}
        {filteredAgents.length === 0 ? (
          <div className="p-10 rounded-lg border border-dashed border-mc-border bg-mc-bg-secondary text-center text-mc-text-secondary">
            No agents match this filter.
          </div>
        ) : (
          <div className="rounded-lg border border-mc-border bg-mc-bg-secondary overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-mc-bg/50 border-b border-mc-border">
                  <tr className="text-left text-xs uppercase tracking-wide text-mc-text-secondary">
                    <Th width="w-12" />
                    <Th onSort={() => toggleSort('name')} sortDir={sort.key === 'name' ? sort.dir : null}>Name</Th>
                    <Th onSort={() => toggleSort('role')} sortDir={sort.key === 'role' ? sort.dir : null}>Role</Th>
                    <Th onSort={() => toggleSort('model')} sortDir={sort.key === 'model' ? sort.dir : null}>Model</Th>
                    <Th onSort={() => toggleSort('gateway')} sortDir={sort.key === 'gateway' ? sort.dir : null}>Gateway</Th>
                    <Th onSort={() => toggleSort('status')} sortDir={sort.key === 'status' ? sort.dir : null}>Status</Th>
                    <Th>Activity</Th>
                    <Th>Health</Th>
                    <Th>Actions</Th>
                  </tr>
                </thead>
                <tbody>
                  {filteredAgents.map(agent => (
                    <AgentRow
                      key={agent.id}
                      agent={agent}
                      openclawSession={agentOpenClawSessions[agent.id]}
                      ping={agentPings[agent.id]}
                      health={agentHealth[agent.id]}
                      isConnecting={connectingAgentId === agent.id}
                      isToggling={togglingAgentId === agent.id}
                      isResetting={resettingAgentId === agent.id}
                      availableModels={availableModels}
                      defaultModel={defaultModel}
                      emojiPickerOpen={emojiPickerFor === agent.id}
                      onOpenEmojiPicker={open => setEmojiPickerFor(open ? agent.id : null)}
                      onPatchField={patch => patchAgent(agent, patch)}
                      onEdit={() => setEditingAgent(agent)}
                      onTogglePower={() => toggleAgentActive(agent)}
                      onResetSession={() => resetAgentSession(agent)}
                      onToggleOpenClaw={() => handleConnectToOpenClaw(agent)}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {showCreateModal && <AgentModal onClose={() => setShowCreateModal(false)} workspaceId={workspaceId} />}
      {editingAgent && (
        <AgentModal agent={editingAgent} onClose={() => setEditingAgent(null)} workspaceId={workspaceId} />
      )}
      {showDiscoverModal && (
        <DiscoverAgentsModal onClose={() => setShowDiscoverModal(false)} workspaceId={workspaceId} />
      )}
      <ConfirmDialog
        open={pendingConfirm !== null}
        title={pendingConfirm?.title ?? ''}
        body={pendingConfirm?.body ?? null}
        confirmLabel={pendingConfirm?.confirmLabel ?? 'Confirm'}
        destructive={pendingConfirm?.destructive}
        onConfirm={() => {
          const action = pendingConfirm?.onConfirm;
          setPendingConfirm(null);
          action?.();
        }}
        onCancel={() => setPendingConfirm(null)}
      />
    </div>
  );
}

// ─── building blocks ──────────────────────────────────────────────────

function HeaderButton({
  icon,
  onClick,
  disabled,
  children,
  tone,
}: {
  icon: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
  tone: 'purple' | 'amber' | 'blue' | 'accent';
}) {
  const palettes = {
    purple: 'border-purple-500/30 text-purple-300 hover:bg-purple-500/10',
    amber: 'border-amber-500/30 text-amber-300 hover:bg-amber-500/10',
    blue: 'border-blue-500/30 text-blue-300 hover:bg-blue-500/10',
    accent: 'border-mc-accent/40 text-mc-accent hover:bg-mc-accent/10',
  } as const;
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border text-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${palettes[tone]}`}
    >
      {icon}
      {children}
    </button>
  );
}

function Th({
  children,
  onSort,
  sortDir,
  width,
}: {
  children?: React.ReactNode;
  onSort?: () => void;
  sortDir?: 'asc' | 'desc' | null;
  width?: string;
}) {
  if (!onSort) {
    return <th className={`px-3 py-2 font-medium ${width ?? ''}`}>{children}</th>;
  }
  return (
    <th className={`px-3 py-2 font-medium ${width ?? ''}`}>
      <button
        type="button"
        onClick={onSort}
        className="inline-flex items-center gap-1 hover:text-mc-text"
      >
        {children}
        {sortDir === 'asc' ? (
          <ChevronUp className="w-3 h-3" />
        ) : sortDir === 'desc' ? (
          <ChevronDown className="w-3 h-3" />
        ) : (
          <ChevronsUpDown className="w-3 h-3 opacity-40" />
        )}
      </button>
    </th>
  );
}

interface AgentRowProps {
  agent: Agent;
  openclawSession: OpenClawSession | null | undefined;
  ping: { sentAt?: string; receivedAt?: string } | undefined;
  health: AgentHealthState | undefined;
  isConnecting: boolean;
  isToggling: boolean;
  isResetting: boolean;
  availableModels: string[];
  defaultModel: string;
  emojiPickerOpen: boolean;
  onOpenEmojiPicker: (open: boolean) => void;
  onPatchField: (patch: Partial<Agent>) => Promise<boolean>;
  onEdit: () => void;
  onTogglePower: () => void;
  onResetSession: () => void;
  onToggleOpenClaw: () => void;
}

function AgentRow({
  agent,
  openclawSession,
  ping,
  health,
  isConnecting,
  isToggling,
  isResetting,
  availableModels,
  defaultModel,
  emojiPickerOpen,
  onOpenEmojiPicker,
  onPatchField,
  onEdit,
  onTogglePower,
  onResetSession,
  onToggleOpenClaw,
}: AgentRowProps) {
  const isActive = Number(agent.is_active ?? 1) === 1;
  const isGatewaySynced = agent.source === 'gateway';

  return (
    <tr
      className={`border-b border-mc-border last:border-0 ${
        isActive ? 'hover:bg-mc-bg/30' : 'opacity-60 hover:bg-mc-bg/20'
      }`}
    >
      {/* Avatar with emoji picker */}
      <td className="px-3 py-2">
        <EmojiCell
          emoji={agent.avatar_emoji}
          openclawConnected={!!openclawSession}
          isMaster={!!agent.is_master}
          open={emojiPickerOpen}
          onOpen={onOpenEmojiPicker}
          onPick={emoji => {
            onOpenEmojiPicker(false);
            if (emoji !== agent.avatar_emoji) onPatchField({ avatar_emoji: emoji });
          }}
        />
      </td>

      {/* Name (clicks open the full edit modal) */}
      <td className="px-3 py-2">
        <button
          type="button"
          onClick={onEdit}
          className="text-left group"
          title="Open full editor"
        >
          <div className="flex items-center gap-1.5">
            <span className="font-medium text-mc-text group-hover:text-mc-accent">{agent.name}</span>
            {!isActive && (
              <span className="text-[10px] px-1 py-0 bg-amber-500/20 text-amber-400 rounded uppercase tracking-wider">
                paused
              </span>
            )}
          </div>
          {agent.description && (
            <div className="text-xs text-mc-text-secondary line-clamp-1 max-w-[24ch]" title={agent.description}>
              {agent.description}
            </div>
          )}
        </button>
      </td>

      {/* Role — inline editable text. Free-text in the DB so we don't
          constrain to a select. Commits on blur or Enter. */}
      <td className="px-3 py-2">
        <InlineTextField
          value={agent.role}
          disabled={isGatewaySynced}
          disabledTitle="Role is synced from the gateway"
          onCommit={next => {
            if (next.trim() && next !== agent.role) onPatchField({ role: next.trim() });
          }}
          className="w-32"
        />
      </td>

      {/* Model — inline dropdown */}
      <td className="px-3 py-2">
        <select
          value={agent.model || ''}
          onChange={e => onPatchField({ model: e.target.value })}
          className="bg-mc-bg border border-mc-border rounded px-2 py-1 text-xs text-mc-text focus:outline-none focus:border-mc-accent w-44"
        >
          <option value="">— default{defaultModel ? ` (${defaultModel})` : ''} —</option>
          {availableModels.map(m => (
            <option key={m} value={m}>
              {m}
              {defaultModel === m ? ' (default)' : ''}
            </option>
          ))}
        </select>
      </td>

      {/* Gateway badge */}
      <td className="px-3 py-2">
        {agent.gateway_agent_id ? (
          <span
            className="inline-flex items-center gap-1 text-xs font-mono text-mc-text-secondary"
            title="gateway_agent_id"
          >
            <span className="text-[10px] px-1 py-0 bg-blue-500/20 text-blue-400 rounded">GW</span>
            <span className="truncate max-w-[20ch]">{agent.gateway_agent_id}</span>
          </span>
        ) : (
          <span className="text-xs text-mc-text-secondary/60">local</span>
        )}
      </td>

      {/* Status pill */}
      <td className="px-3 py-2">
        <span className={`text-[10px] px-2 py-0.5 rounded uppercase tracking-wide ${getStatusBadge(agent.status)}`}>
          {agent.status}
        </span>
      </td>

      {/* Activity ping */}
      <td className="px-3 py-2">
        <AgentPingIndicator sentAt={ping?.sentAt} receivedAt={ping?.receivedAt} />
      </td>

      {/* Health */}
      <td className="px-3 py-2">
        {health && health !== 'idle' ? (
          <HealthIndicator state={health} size="sm" />
        ) : (
          <span className="text-xs text-mc-text-secondary/40">—</span>
        )}
      </td>

      {/* Actions */}
      <td className="px-3 py-2">
        <div className="flex items-center gap-1">
          <IconButton
            icon={<Power className={`w-3.5 h-3.5 ${isActive ? '' : 'text-amber-400'}`} />}
            onClick={onTogglePower}
            disabled={isToggling}
            title={isActive ? 'Pause (excludes from routing + roll-call)' : 'Activate'}
          />
          {agent.gateway_agent_id && (
            <IconButton
              icon={
                isResetting ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <RotateCcw className="w-3.5 h-3.5" />
                )
              }
              onClick={onResetSession}
              disabled={isResetting}
              title="Reset session — clears MC rows + sends /reset to the gateway"
            />
          )}
          <IconButton icon={<Pencil className="w-3.5 h-3.5" />} onClick={onEdit} title="Edit (full settings)" />
          {!!agent.is_master && (
            <button
              onClick={onToggleOpenClaw}
              disabled={isConnecting}
              title={openclawSession ? 'OpenClaw connected' : 'Connect to OpenClaw'}
              className={`inline-flex items-center gap-1 px-2 py-1.5 rounded text-[10px] border transition-colors ${
                openclawSession
                  ? 'bg-green-500/15 border-green-500/30 text-green-400 hover:bg-green-500/25'
                  : 'border-mc-border text-mc-text-secondary hover:text-mc-text hover:border-mc-accent/40'
              }`}
            >
              {isConnecting ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : openclawSession ? (
                <Zap className="w-3 h-3" />
              ) : (
                <ZapOff className="w-3 h-3" />
              )}
              <span className="hidden xl:inline">{openclawSession ? 'OpenClaw' : 'Connect'}</span>
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}

function IconButton({
  icon,
  onClick,
  disabled,
  title,
}: {
  icon: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="p-1.5 rounded border border-mc-border text-mc-text-secondary hover:text-mc-text hover:border-mc-accent/40 disabled:opacity-50 disabled:cursor-not-allowed"
    >
      {icon}
    </button>
  );
}

/**
 * Avatar cell with click-to-pick emoji popover. The popover anchors to the
 * cell's position; closes on outside click or Escape. Master ★ + OpenClaw
 * connected dot are decorations on top of the avatar.
 */
function EmojiCell({
  emoji,
  openclawConnected,
  isMaster,
  open,
  onOpen,
  onPick,
}: {
  emoji: string;
  openclawConnected: boolean;
  isMaster: boolean;
  open: boolean;
  onOpen: (open: boolean) => void;
  onPick: (emoji: string) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) onOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onOpen]);

  return (
    <div ref={wrapRef} className="relative inline-block">
      <button
        type="button"
        onClick={() => onOpen(!open)}
        className="text-2xl relative hover:scale-105 transition-transform"
        title="Change avatar"
      >
        <span>{emoji}</span>
        {openclawConnected && (
          <span className="absolute -bottom-1 -right-1 w-2.5 h-2.5 bg-green-500 rounded-full border-2 border-mc-bg-secondary" />
        )}
        {isMaster && <span className="absolute -top-1 -right-1 text-[10px] text-mc-accent-yellow">★</span>}
      </button>
      {open && (
        <div className="absolute left-0 top-full mt-1 z-30 p-2 rounded-lg border border-mc-border bg-mc-bg shadow-lg flex flex-wrap gap-1 w-44">
          {EMOJI_OPTIONS.map(opt => (
            <button
              key={opt}
              type="button"
              onClick={() => onPick(opt)}
              className={`w-8 h-8 text-xl rounded hover:bg-mc-bg-tertiary ${
                opt === emoji ? 'bg-mc-accent/15 ring-1 ring-mc-accent' : ''
              }`}
              title={opt}
            >
              {opt}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Inline editable text field. Commits on blur or Enter; reverts on Escape.
 * Used for the role column where the DB column is free-text but we don't
 * want a full-blown form for what is usually a one-word change.
 */
function InlineTextField({
  value,
  disabled,
  disabledTitle,
  onCommit,
  className,
}: {
  value: string;
  disabled?: boolean;
  disabledTitle?: string;
  onCommit: (next: string) => void;
  className?: string;
}) {
  const [draft, setDraft] = useState(value);
  // Re-sync when the upstream value changes (e.g., another tab updated it).
  useEffect(() => {
    setDraft(value);
  }, [value]);
  return (
    <input
      type="text"
      value={draft}
      onChange={e => setDraft(e.target.value)}
      onBlur={() => {
        if (draft !== value) onCommit(draft);
      }}
      onKeyDown={e => {
        if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur();
        if (e.key === 'Escape') {
          setDraft(value);
          (e.currentTarget as HTMLInputElement).blur();
        }
      }}
      disabled={disabled}
      title={disabled ? disabledTitle : undefined}
      className={`bg-mc-bg border border-mc-border rounded px-2 py-1 text-xs text-mc-text focus:outline-none focus:border-mc-accent disabled:opacity-50 disabled:cursor-not-allowed ${className ?? ''}`}
    />
  );
}

function getStatusBadge(status: AgentStatus): string {
  const styles: Record<string, string> = {
    standby: 'status-standby',
    working: 'status-working',
    offline: 'status-offline',
  };
  return styles[status] || styles.standby;
}
