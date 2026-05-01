'use client';

import { useState, useEffect } from 'react';
import { X, Save, Trash2, Lock, RotateCcw } from 'lucide-react';
import { useMissionControl } from '@/lib/store';
import type { Agent, AgentStatus } from '@/lib/types';
import { AgentActivityTab } from '@/components/AgentActivityTab';
import { AgentChatTab } from '@/components/AgentChatTab';

interface AgentModalProps {
  agent?: Agent;
  onClose: () => void;
  workspaceId?: string;
  onAgentCreated?: (agentId: string) => void;
}

const EMOJI_OPTIONS = ['🤖', '🦞', '💻', '🔍', '✍️', '🎨', '📊', '🧠', '⚡', '🚀', '🎯', '🔧'];

type TabId = 'info' | 'soul' | 'user' | 'agents' | 'activity' | 'chat';

export function AgentModal({ agent, onClose, workspaceId, onAgentCreated }: AgentModalProps) {
  const { addAgent, updateAgent, agents } = useMissionControl();
  const isGateway = agent?.source === 'gateway';
  const [activeTab, setActiveTab] = useState<TabId>('info');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [defaultModel, setDefaultModel] = useState<string>('');
  const [modelsLoading, setModelsLoading] = useState(true);
  const [isResetting, setIsResetting] = useState(false);
  // Inline feedback after a reset attempt — null clears the strip.
  const [resetMsg, setResetMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const [form, setForm] = useState({
    name: agent?.name || '',
    role: agent?.role || '',
    description: agent?.description || '',
    avatar_emoji: agent?.avatar_emoji || '🤖',
    status: agent?.status || 'standby' as AgentStatus,
    is_master: agent?.is_master || false,
    is_pm: !!agent?.is_pm,
    soul_md: agent?.soul_md || '',
    user_md: agent?.user_md || '',
    agents_md: agent?.agents_md || '',
    model: agent?.model || '',
    session_key_prefix: agent?.session_key_prefix || '',
  });

  // Fetch fresh agent data when modal opens (store data may be stale)
  useEffect(() => {
    if (!agent?.id) return;
    let cancelled = false;
    fetch(`/api/agents/${agent.id}`)
      .then(res => res.ok ? res.json() : null)
      .then(fresh => {
        if (cancelled || !fresh) return;
        setForm(prev => ({
          ...prev,
          soul_md: fresh.soul_md || '',
          user_md: fresh.user_md || '',
          agents_md: fresh.agents_md || '',
        }));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [agent?.id]);

  // Load available models from OpenClaw config
  useEffect(() => {
    const loadModels = async () => {
      try {
        const res = await fetch('/api/openclaw/models');
        if (res.ok) {
          const data = await res.json();
          setAvailableModels(data.availableModels || []);
          setDefaultModel(data.defaultModel || '');
          // If agent has no model set, use default
          if (!agent?.model && data.defaultModel) {
            setForm(prev => ({ ...prev, model: data.defaultModel }));
          }
        }
      } catch (error) {
        console.error('Failed to load models:', error);
      } finally {
        setModelsLoading(false);
      }
    };
    loadModels();
  }, [agent]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);

    try {
      const url = agent ? `/api/agents/${agent.id}` : '/api/agents';
      const method = agent ? 'PATCH' : 'POST';

      const trimmedPrefix = form.session_key_prefix?.trim();
      const normalizedPrefix = !trimmedPrefix ? '' : trimmedPrefix.endsWith(':') ? trimmedPrefix : trimmedPrefix + ':';

      // Gateway agents' name/description and SOUL/USER/AGENTS live upstream in
      // OpenClaw. Strip them from the PATCH body so MC never overwrites synced
      // values with a stale form snapshot.
      const payload: Record<string, unknown> = {
        ...form,
        session_key_prefix: normalizedPrefix || undefined,
        workspace_id: workspaceId || agent?.workspace_id || 'default',
      };
      if (isGateway) {
        delete payload.name;
        delete payload.description;
        delete payload.soul_md;
        delete payload.user_md;
        delete payload.agents_md;
      }

      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (res.ok) {
        const savedAgent = await res.json();
        if (agent) {
          updateAgent(savedAgent);
        } else {
          addAgent(savedAgent);
          // Notify parent if callback provided (e.g., for inline agent creation)
          if (onAgentCreated) {
            onAgentCreated(savedAgent.id);
          }
        }
        onClose();
      }
    } catch (error) {
      console.error('Failed to save agent:', error);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDelete = async () => {
    if (!agent || !confirm(`Delete ${agent.name}?`)) return;

    try {
      const res = await fetch(`/api/agents/${agent.id}`, { method: 'DELETE' });
      if (res.ok) {
        // Remove from store
        useMissionControl.setState((state) => ({
          agents: state.agents.filter((a) => a.id !== agent.id),
          selectedAgent: state.selectedAgent?.id === agent.id ? null : state.selectedAgent,
        }));
        onClose();
      }
    } catch (error) {
      console.error('Failed to delete agent:', error);
    }
  };

  // Reset just this agent's session — the per-agent equivalent of the
  // sidebar's "Reset all sessions". Hits POST /api/agents/[id]/reset which
  // clears MC-side session rows and sends `/reset` to the gateway.
  const handleReset = async () => {
    if (!agent) return;
    if (!confirm(`Reset ${agent.name}'s session? The agent will re-init its persona files on the next message.`)) {
      return;
    }
    setIsResetting(true);
    setResetMsg(null);
    try {
      const res = await fetch(`/api/agents/${agent.id}/reset`, { method: 'POST' });
      const body = await res.json().catch(() => ({}));
      if (res.ok && body.sent) {
        setResetMsg({
          kind: 'ok',
          text: `Reset sent — gateway re-init in flight (cleared ${body.deleted ?? 0} session row(s)).`,
        });
      } else if (res.ok && !body.sent) {
        // Phase 1 succeeded but gateway send didn't land (offline, no
        // session, etc.). Surface it so the operator knows MC-side is
        // clean but they may need to type `/reset` in the chat manually.
        setResetMsg({
          kind: 'err',
          text: `MC-side cleared (${body.deleted ?? 0} row(s)) but gateway didn't ack: ${body.error ?? body.gateway_error ?? 'send failed'}.`,
        });
      } else {
        setResetMsg({
          kind: 'err',
          text: body.error ?? `Reset failed (${res.status})`,
        });
      }
    } catch (e) {
      setResetMsg({
        kind: 'err',
        text: e instanceof Error ? e.message : 'Reset failed',
      });
    } finally {
      setIsResetting(false);
    }
  };

  const tabs: Array<{ id: TabId; label: string }> = [
    { id: 'info', label: 'Info' },
    ...(isGateway
      ? []
      : [
          { id: 'soul' as TabId, label: 'SOUL.md' },
          { id: 'user' as TabId, label: 'USER.md' },
          { id: 'agents' as TabId, label: 'AGENTS.md' },
        ]),
    ...(agent
      ? [
          { id: 'activity' as TabId, label: 'Activity' },
          { id: 'chat' as TabId, label: 'Chat' },
        ]
      : []),
  ];

  return (
    <div className="fixed inset-0 bg-black/50 flex items-end sm:items-center justify-center z-50 p-3 sm:p-4">
      <div className="bg-mc-bg-secondary border border-mc-border rounded-t-xl sm:rounded-lg w-full max-w-4xl max-h-[92vh] sm:max-h-[90vh] flex flex-col pb-[env(safe-area-inset-bottom)] sm:pb-0">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-mc-border">
          <h2 className="text-lg font-semibold">
            {agent ? `${agent.name} Details` : 'New Agent'}
          </h2>
          <button
            onClick={onClose}
            className="p-1 hover:bg-mc-bg-tertiary rounded-sm"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-mc-border overflow-x-auto">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`px-4 min-h-11 py-2 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
                activeTab === tab.id
                  ? 'border-mc-accent text-mc-accent'
                  : 'border-transparent text-mc-text-secondary hover:text-mc-text'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Content */}
        {activeTab === 'activity' && agent ? (
          <div className="flex-1 overflow-hidden flex flex-col">
            <AgentActivityTab agentId={agent.id} />
          </div>
        ) : activeTab === 'chat' && agent ? (
          <div className="flex-1 overflow-hidden flex flex-col">
            <AgentChatTab agent={agent} />
          </div>
        ) : (
        <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto p-4">
          {activeTab === 'info' && (
            <div className="space-y-4">
              {isGateway && (
                <div className="flex items-start gap-2 px-3 py-2 bg-mc-bg-tertiary/60 border border-mc-border rounded-sm text-xs text-mc-text-secondary">
                  <Lock className="w-3.5 h-3.5 mt-[1px] shrink-0" />
                  <span>
                    Synced from OpenClaw gateway
                    {agent?.gateway_agent_id && (
                      <> — <span className="font-mono">{agent.gateway_agent_id}</span></>
                    )}
                    . Name, description, and SOUL/USER/AGENTS are managed upstream.
                  </span>
                </div>
              )}
              {/* Avatar Selection */}
              <div>
                <label className="block text-sm font-medium mb-2">Avatar</label>
                <div className="flex flex-wrap gap-2">
                  {EMOJI_OPTIONS.map((emoji) => (
                    <button
                      key={emoji}
                      type="button"
                      onClick={() => setForm({ ...form, avatar_emoji: emoji })}
                      className={`text-2xl p-2 rounded hover:bg-mc-bg-tertiary ${
                        form.avatar_emoji === emoji
                          ? 'bg-mc-accent/20 ring-2 ring-mc-accent'
                          : ''
                      }`}
                    >
                      {emoji}
                    </button>
                  ))}
                </div>
              </div>

              {/* Name */}
              <div>
                <label className="block text-sm font-medium mb-1">Name</label>
                <input
                  type="text"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  required
                  disabled={isGateway}
                  title={isGateway ? 'Managed by OpenClaw gateway' : undefined}
                  className={`w-full min-h-11 bg-mc-bg border border-mc-border rounded-sm px-3 py-2 text-sm focus:outline-hidden focus:border-mc-accent ${
                    isGateway ? 'opacity-60 cursor-not-allowed' : ''
                  }`}
                  placeholder="Agent name"
                />
              </div>

              {/* Role */}
              <div>
                <label className="block text-sm font-medium mb-1">Role</label>
                <input
                  type="text"
                  value={form.role}
                  onChange={(e) => setForm({ ...form, role: e.target.value })}
                  required
                  className="w-full min-h-11 bg-mc-bg border border-mc-border rounded-sm px-3 py-2 text-sm focus:outline-hidden focus:border-mc-accent"
                  placeholder="e.g., Code & Automation"
                />
              </div>

              {/* Description */}
              <div>
                <label className="block text-sm font-medium mb-1">Description</label>
                <textarea
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                  rows={2}
                  disabled={isGateway}
                  title={isGateway ? 'Managed by OpenClaw gateway' : undefined}
                  className={`w-full bg-mc-bg border border-mc-border rounded-sm px-3 py-2 text-sm focus:outline-hidden focus:border-mc-accent resize-none ${
                    isGateway ? 'opacity-60 cursor-not-allowed' : ''
                  }`}
                  placeholder="What does this agent do?"
                />
              </div>

              {/* Status */}
              <div>
                <label className="block text-sm font-medium mb-1">Status</label>
                <select
                  value={form.status}
                  onChange={(e) => setForm({ ...form, status: e.target.value as AgentStatus })}
                  className="w-full min-h-11 bg-mc-bg border border-mc-border rounded-sm px-3 py-2 text-sm focus:outline-hidden focus:border-mc-accent"
                >
                  <option value="standby">Standby</option>
                  <option value="working">Working</option>
                  <option value="offline">Offline</option>
                </select>
              </div>

              {/* Master Toggle */}
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="is_master"
                  checked={form.is_master}
                  onChange={(e) => setForm({ ...form, is_master: e.target.checked })}
                  className="w-4 h-4"
                />
                <label htmlFor="is_master" className="text-sm">
                  Master Orchestrator (can coordinate other agents)
                </label>
              </div>

              {/* PM Toggle — one PM per workspace; the API enforces the
                  invariant (clears is_pm on every other agent in this
                  workspace) and forces role='pm' so the resolver's
                  legacy fallback agrees. */}
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="is_pm"
                  checked={form.is_pm}
                  onChange={(e) => setForm({ ...form, is_pm: e.target.checked })}
                  className="w-4 h-4"
                />
                <label htmlFor="is_pm" className="text-sm">
                  PM for this workspace (drives /pm chat + proposals)
                </label>
              </div>

              {/* Model Selection */}
              <div>
                <label className="block text-sm font-medium mb-1">
                  Model
                  {defaultModel && form.model === defaultModel && (
                    <span className="ml-2 text-xs text-mc-text-secondary">(Default)</span>
                  )}
                </label>
                {modelsLoading ? (
                  <div className="text-sm text-mc-text-secondary">Loading available models...</div>
                ) : (
                  <select
                    value={form.model}
                    onChange={(e) => setForm({ ...form, model: e.target.value })}
                    className="w-full min-h-11 bg-mc-bg border border-mc-border rounded-sm px-3 py-2 text-sm focus:outline-hidden focus:border-mc-accent"
                  >
                    <option value="">-- Use Default Model --</option>
                    {availableModels.map((model) => (
                      <option key={model} value={model}>
                        {model}{defaultModel === model ? ' (Default)' : ''}
                      </option>
                    ))}
                  </select>
                )}
                <p className="text-xs text-mc-text-secondary mt-1">
                  AI model used by this agent. Leave empty to use OpenClaw default.
                </p>
              </div>

              {/* Session Key Prefix */}
              <div>
                <label className="block text-sm font-medium mb-1">Session Key Prefix</label>
                <input
                  type="text"
                  value={form.session_key_prefix}
                  onChange={(e) => setForm({ ...form, session_key_prefix: e.target.value })}
                  className="w-full min-h-11 bg-mc-bg border border-mc-border rounded-sm px-3 py-2 text-sm focus:outline-hidden focus:border-mc-accent"
                  placeholder="agent:<name>:"
                />
                <p className="text-xs text-mc-text-secondary mt-1">
                  OpenClaw session routing prefix. Leave empty to default to
                  &quot;agent:&lt;gateway_agent_id&gt;:&quot; (or &quot;agent:&lt;name&gt;:&quot; for local agents).
                </p>
              </div>

              {/*
                Per-agent session reset. Mirrors the sidebar's "Reset all
                sessions" action but scoped to this one agent — clears the
                agent's openclaw_sessions rows and sends `/reset` to the
                gateway so the agent re-init's its persona files. Gated on
                an existing agent with a gateway_agent_id, since the route
                400s for local-only agents.
              */}
              {agent?.id && agent.gateway_agent_id && (
                <div className="pt-2 border-t border-mc-border">
                  <label className="block text-sm font-medium mb-1">Session</label>
                  <button
                    type="button"
                    onClick={handleReset}
                    disabled={isResetting}
                    className="inline-flex items-center gap-2 px-3 py-2 rounded-sm border border-mc-border text-sm hover:bg-mc-bg disabled:opacity-50"
                  >
                    <RotateCcw className={`w-4 h-4 ${isResetting ? 'animate-spin' : ''}`} />
                    {isResetting ? 'Resetting…' : 'Reset session'}
                  </button>
                  <p className="text-xs text-mc-text-secondary mt-1">
                    Clears MC-side session rows for this agent and sends
                    <code className="mx-1 px-1 rounded bg-mc-bg">/reset</code>
                    to the gateway. The agent re-init&rsquo;s its persona files
                    (SOUL.md / AGENTS.md / USER.md) on its next message.
                  </p>
                  {resetMsg && (
                    <p
                      className={`mt-2 text-xs px-2 py-1.5 rounded border ${
                        resetMsg.kind === 'ok'
                          ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
                          : 'bg-red-500/10 border-red-500/30 text-red-300'
                      }`}
                      role="status"
                    >
                      {resetMsg.text}
                    </p>
                  )}
                </div>
              )}
            </div>
          )}

          {activeTab === 'soul' && (
            <div>
              <label className="block text-sm font-medium mb-2">
                SOUL.md - Agent Personality & Identity
              </label>
              <textarea
                value={form.soul_md}
                onChange={(e) => setForm({ ...form, soul_md: e.target.value })}
                rows={15}
                className="w-full bg-mc-bg border border-mc-border rounded-sm px-3 py-2 text-sm font-mono focus:outline-hidden focus:border-mc-accent resize-none"
                placeholder="# Agent Name&#10;&#10;Define this agent's personality, values, and communication style..."
              />
            </div>
          )}

          {activeTab === 'user' && (
            <div>
              <label className="block text-sm font-medium mb-2">
                USER.md - Context About the Human
              </label>
              <textarea
                value={form.user_md}
                onChange={(e) => setForm({ ...form, user_md: e.target.value })}
                rows={15}
                className="w-full bg-mc-bg border border-mc-border rounded-sm px-3 py-2 text-sm font-mono focus:outline-hidden focus:border-mc-accent resize-none"
                placeholder="# User Context&#10;&#10;Information about the human this agent works with..."
              />
            </div>
          )}

          {activeTab === 'agents' && (
            <div>
              <label className="block text-sm font-medium mb-2">
                AGENTS.md - Team Awareness
              </label>
              <textarea
                value={form.agents_md}
                onChange={(e) => setForm({ ...form, agents_md: e.target.value })}
                rows={15}
                className="w-full bg-mc-bg border border-mc-border rounded-sm px-3 py-2 text-sm font-mono focus:outline-hidden focus:border-mc-accent resize-none"
                placeholder="# Team Roster&#10;&#10;Information about other agents this agent works with..."
              />
            </div>
          )}
        </form>
        )}

        {/* Footer — Save/Cancel only for form tabs; Activity/Chat tabs manage their own state */}
        {activeTab !== 'activity' && activeTab !== 'chat' && (
          <div className="flex items-center justify-between p-4 border-t border-mc-border">
            <div>
              {agent && !isGateway && (
                <button
                  type="button"
                  onClick={handleDelete}
                  className="min-h-11 flex items-center gap-2 px-3 py-2 text-mc-accent-red hover:bg-mc-accent-red/10 rounded-sm text-sm"
                >
                  <Trash2 className="w-4 h-4" />
                  Delete
                </button>
              )}
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={onClose}
                className="min-h-11 px-4 py-2 text-sm text-mc-text-secondary hover:text-mc-text"
              >
                Cancel
              </button>
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
    </div>
  );
}
