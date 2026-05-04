'use client';

/**
 * Per-agent settings / details page. Mirrors the UX of the per-workspace
 * settings page (PageWithRails + section anchor nav + inline-editable
 * Section/Field cards + right-rail live preview), replacing the previous
 * tabbed AgentModal experience.
 *
 * Why this exists separately from AgentModal: the modal stayed cramped
 * even on big screens, hid the Activity/Chat/persona tabs behind tab
 * switches, and didn't surface the OpenClaw routing info that operators
 * need when debugging a misroute. The full-page view gets a real left
 * rail (anchor nav across all sections), a right rail (live routing
 * preview — what sessionKey will the gateway actually see?), and lets
 * the persona files breathe at normal page width.
 *
 * AgentModal still ships for the "New Agent" creation flow, where the
 * agent record doesn't exist yet so /agents/<id> isn't reachable.
 */

import { use, useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  AlertTriangle,
  ArrowLeft,
  ChevronDown,
  Loader,
  Lock,
  RotateCcw,
  Trash2,
} from 'lucide-react';
import { InlineText, InlineTextarea } from '@/components/inline/InlineEdit';
import { PageWithRails, SectionNav } from '@/components/shell/PageWithRails';
import { AgentActivityTab } from '@/components/AgentActivityTab';
import { AgentChatTab } from '@/components/AgentChatTab';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { useMissionControl } from '@/lib/store';
import type { Agent, AgentStatus, OpenClawSession } from '@/lib/types';

const EMOJI_OPTIONS = ['🤖', '🦞', '💻', '🔍', '✍️', '🎨', '📊', '🧠', '⚡', '🚀', '🎯', '🔧'];

// Standard role enum mirrors BriefingRole in src/lib/agents/briefing.ts —
// every dispatch-time role-resolver expects one of these strings. Free
// text still wins via the "Custom…" escape hatch for one-off agents
// (e.g. planners, glue agents) that don't fit the standard taxonomy.
const STANDARD_ROLES = [
  'pm',
  'coordinator',
  'builder',
  'researcher',
  'tester',
  'reviewer',
  'verifier',
  'writer',
  'learner',
] as const;

type SessionInfo = {
  agent_id: string;
  source: 'local' | 'gateway';
  gateway_agent_id: string | null;
  session_key_prefix: string | null;
  resolved_prefix: string;
  prefix_source: 'explicit' | 'gateway_agent_id' | 'runner_fallback';
  sessions: OpenClawSession[];
};

export default function AgentDetailsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const { updateAgent } = useMissionControl();

  const [agent, setAgent] = useState<Agent | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // Model picker — populated from /api/openclaw/models so the operator
  // sees the same set the modal previously showed.
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [defaultModel, setDefaultModel] = useState<string>('');

  // Session-routing info for the right-rail preview + the Routing card.
  const [sessionInfo, setSessionInfo] = useState<SessionInfo | null>(null);
  const [sessionInfoLoading, setSessionInfoLoading] = useState(false);
  const [sessionInfoError, setSessionInfoError] = useState<string | null>(null);
  const [sessionRefreshTick, setSessionRefreshTick] = useState(0);

  // Per-agent reset (gateway agents only).
  const [isResetting, setIsResetting] = useState(false);
  const [resetMsg, setResetMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  // Per-row session action state — keyed by openclaw_sessions.id so
  // multiple rows can show their own busy/error state independently.
  const [sessionRowBusy, setSessionRowBusy] = useState<Record<string, 'reset' | 'delete' | null>>({});
  const [sessionRowError, setSessionRowError] = useState<Record<string, string>>({});
  // Replaces native window.confirm so the operator's confirmation
  // dialogs go through the project's ConfirmDialog component (no
  // event-loop blocking, drivable by automation).
  const [pendingConfirm, setPendingConfirm] = useState<null | {
    title: string;
    body: React.ReactNode;
    confirmLabel: string;
    destructive?: boolean;
    onConfirm: () => void | Promise<void>;
  }>(null);

  // Delete confirmation flow.
  const [showDelete, setShowDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const r = await fetch(`/api/agents/${id}`);
      if (!r.ok) throw new Error(`Failed to load (${r.status})`);
      setAgent(await r.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load agent');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/openclaw/models')
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (cancelled || !d) return;
        setAvailableModels(d.availableModels || []);
        setDefaultModel(d.defaultModel || '');
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setSessionInfoLoading(true);
    setSessionInfoError(null);
    fetch(`/api/agents/${id}/sessions`)
      .then(async r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data: SessionInfo) => { if (!cancelled) setSessionInfo(data); })
      .catch(e => { if (!cancelled) setSessionInfoError(e instanceof Error ? e.message : 'Failed to load'); })
      .finally(() => { if (!cancelled) setSessionInfoLoading(false); });
    return () => { cancelled = true; };
  }, [id, sessionRefreshTick]);

  // PATCH a partial update and update both local + global stores so
  // sidebar/list views reflect the change without a refetch.
  const patch = useCallback(
    async (body: Record<string, unknown>) => {
      setActionError(null);
      const res = await fetch(`/api/agents/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        const msg = data.error || `Update failed (${res.status})`;
        setActionError(msg);
        throw new Error(msg);
      }
      const updated = (await res.json()) as Agent;
      setAgent(updated);
      updateAgent(updated);
      // Routing prefix derivation depends on session_key_prefix /
      // gateway_agent_id, so refresh the right-rail preview when those
      // change. Cheap to always bump it.
      setSessionRefreshTick(t => t + 1);
    },
    [id, updateAgent],
  );

  const requestSessionRowAction = (sessionId: string, action: 'reset' | 'delete') => {
    setPendingConfirm({
      title: action === 'reset' ? 'Reset this session?' : 'Delete this session row?',
      body: action === 'reset'
        ? 'Sends /reset to the gateway and clears the MC-side row so the next message re-inits.'
        : 'Removes the MC-side tracking only — the gateway session stays as-is.',
      confirmLabel: action === 'reset' ? 'Reset' : 'Delete',
      destructive: action === 'delete',
      onConfirm: () => doSessionRowAction(sessionId, action),
    });
  };

  const doSessionRowAction = async (
    sessionId: string,
    action: 'reset' | 'delete',
  ) => {
    const verb = action === 'reset' ? 'reset' : 'delete';
    setSessionRowBusy(prev => ({ ...prev, [sessionId]: action }));
    setSessionRowError(prev => {
      const { [sessionId]: _, ...rest } = prev;
      return rest;
    });
    try {
      const url = action === 'reset'
        ? `/api/openclaw/sessions/${sessionId}/reset`
        : `/api/openclaw/sessions/${sessionId}`;
      const res = await fetch(url, { method: action === 'reset' ? 'POST' : 'DELETE' });
      if (!res.ok && res.status !== 502) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `${verb} failed (${res.status})`);
      }
      // 502 from /reset means MC-side cleared but gateway didn't ack.
      // That's a partial success — surface as inline warning, but
      // still refresh the list since the row is gone.
      if (action === 'reset' && res.status === 502) {
        const body = await res.json().catch(() => ({}));
        setSessionRowError(prev => ({
          ...prev,
          [sessionId]: `MC-side cleared, gateway didn't ack: ${body.error ?? 'send failed'}`,
        }));
      }
      setSessionRefreshTick(t => t + 1);
    } catch (e) {
      setSessionRowError(prev => ({
        ...prev,
        [sessionId]: e instanceof Error ? e.message : `${verb} failed`,
      }));
    } finally {
      setSessionRowBusy(prev => ({ ...prev, [sessionId]: null }));
    }
  };

  const handleReset = async () => {
    if (!agent) return;
    setPendingConfirm({
      title: 'Reset agent session?',
      body: `Reset ${agent.name}'s session? The agent will re-init its persona files on the next message.`,
      confirmLabel: 'Reset session',
      onConfirm: doResetAgent,
    });
  };

  // Clear the visible chat thread (agent_chat_messages rows). The
  // gateway session is NOT touched — pair with the per-agent or
  // per-session reset for a true "start over". The chat tab listens
  // for the cleared broadcast and reloads.
  const handleClearChatHistory = () => {
    if (!agent) return;
    setPendingConfirm({
      title: 'Clear chat history?',
      body: 'Removes the visible thread for this agent in MC. The gateway session keeps its memory — use Reset session in Routing if you want the agent to forget too.',
      confirmLabel: 'Clear history',
      destructive: true,
      onConfirm: async () => {
        try {
          const res = await fetch(`/api/agents/${agent.id}/chat`, { method: 'DELETE' });
          if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            throw new Error(body.error || `Clear failed (${res.status})`);
          }
        } catch (e) {
          setActionError(e instanceof Error ? e.message : 'Clear failed');
        }
      },
    });
  };

  const doResetAgent = async () => {
    if (!agent) return;
    setIsResetting(true);
    setResetMsg(null);
    try {
      const res = await fetch(`/api/agents/${agent.id}/reset`, { method: 'POST' });
      const body = await res.json().catch(() => ({}));
      if (res.ok) setSessionRefreshTick(t => t + 1);
      if (res.ok && body.sent) {
        setResetMsg({ kind: 'ok', text: `Reset sent — gateway re-init in flight (cleared ${body.deleted ?? 0} session row(s)).` });
      } else if (res.ok && !body.sent) {
        setResetMsg({ kind: 'err', text: `MC-side cleared (${body.deleted ?? 0} row(s)) but gateway didn't ack: ${body.error ?? body.gateway_error ?? 'send failed'}.` });
      } else {
        setResetMsg({ kind: 'err', text: body.error ?? `Reset failed (${res.status})` });
      }
    } catch (e) {
      setResetMsg({ kind: 'err', text: e instanceof Error ? e.message : 'Reset failed' });
    } finally {
      setIsResetting(false);
    }
  };

  const handleDelete = async () => {
    if (!agent) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/agents/${agent.id}`, { method: 'DELETE' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Delete failed (${res.status})`);
      }
      // Remove from store and route back to the agents list.
      useMissionControl.setState(s => ({
        agents: s.agents.filter(a => a.id !== agent.id),
        selectedAgent: s.selectedAgent?.id === agent.id ? null : s.selectedAgent,
      }));
      router.replace('/agents');
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Delete failed');
      setDeleting(false);
      setShowDelete(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-mc-bg flex items-center justify-center">
        <Loader className="w-6 h-6 animate-spin text-mc-text-secondary" />
      </div>
    );
  }
  if (error || !agent) {
    return (
      <div className="min-h-screen bg-mc-bg p-6">
        <div className="max-w-3xl mx-auto p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-300 text-sm">
          {error || 'Agent not found'}
        </div>
      </div>
    );
  }

  const isGateway = agent.source === 'gateway';
  const isPm = !!agent.is_pm;

  const sections = [
    { id: 'identity', label: 'Identity' },
    { id: 'behavior', label: 'Behavior' },
    { id: 'routing', label: 'Routing' },
    ...(isGateway
      ? []
      : [
          { id: 'soul', label: 'SOUL.md' },
          { id: 'user', label: 'USER.md' },
          { id: 'agents-md', label: 'AGENTS.md' },
        ]),
    { id: 'chat', label: 'Chat' },
    { id: 'danger-zone', label: 'Danger zone' },
  ];

  const header = (
    <div className="flex items-center justify-between gap-4">
      <div className="flex items-center gap-3 min-w-0">
        <Link
          href="/agents"
          className="inline-flex items-center gap-1 px-2 py-1 rounded text-mc-text-secondary hover:text-mc-text text-sm shrink-0"
        >
          <ArrowLeft className="w-4 h-4" /> Back
        </Link>
        <span className="text-2xl shrink-0">{agent.avatar_emoji}</span>
        <div className="min-w-0">
          <h1 className="text-base font-semibold truncate">{agent.name}</h1>
          <div className="text-[11px] text-mc-text-secondary font-mono truncate">
            /agents/{agent.name.toLowerCase().replace(/\s+/g, '-')} — {isGateway ? 'gateway' : 'local'} agent
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <PageWithRails
      header={header}
      leftRail={<SectionNav sections={sections} />}
      rightRail={
        <div className="space-y-4">
          <RoutingPreview info={sessionInfo} loading={sessionInfoLoading} error={sessionInfoError} />
          <div className="rounded-lg border border-mc-border/60 bg-mc-bg-secondary">
            <header className="px-4 py-2 border-b border-mc-border/60 flex items-center justify-between gap-2">
              <h2 className="text-[10px] uppercase tracking-wide text-mc-text-secondary/70">Activity</h2>
              <span className="text-[10px] text-mc-text-secondary/60">recent dispatches & events</span>
            </header>
            <div className="h-[420px] overflow-hidden flex flex-col">
              <AgentActivityTab agentId={agent.id} />
            </div>
          </div>
        </div>
      }
      rightRailTitle="Routing & activity"
      outerMaxWidth={null}
      mainMaxWidth="max-w-none"
    >
      <>
        {actionError && (
          <div className="mb-4 p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-300 text-sm">
            {actionError}
          </div>
        )}

        {isGateway && (
          <div className="mb-4 flex items-start gap-2 px-3 py-2 bg-mc-bg-tertiary/60 border border-mc-border rounded-sm text-xs text-mc-text-secondary">
            <Lock className="w-3.5 h-3.5 mt-[1px] shrink-0" />
            <span>
              Synced from OpenClaw gateway
              {agent.gateway_agent_id && (
                <> — <span className="font-mono">{agent.gateway_agent_id}</span></>
              )}
              . Name, description, and SOUL/USER/AGENTS are managed upstream.
            </span>
          </div>
        )}

        {/* Identity — compact: avatar dropdown + name on one row, then
            role select (with Custom… option for free-text), then optional
            description for local agents. */}
        <Section id="identity" title="Identity">
          <div className="flex items-start gap-4">
            <Field label="Avatar">
              <AvatarPicker
                value={agent.avatar_emoji}
                onPick={e => patch({ avatar_emoji: e }).catch(() => {})}
              />
            </Field>
            <div className="flex-1 min-w-0">
              <Field label="Name">
                <InlineText
                  value={agent.name}
                  onSave={next => patch({ name: next })}
                  placeholder="Agent name"
                  disabled={isGateway}
                  label="Edit agent name"
                />
              </Field>
            </div>
          </div>
          <Field label="Role">
            <RoleSelect
              value={agent.role}
              onChange={next => patch({ role: next }).catch(() => {})}
            />
          </Field>
          {!isGateway && (
            <Field label="Description">
              <InlineTextarea
                value={agent.description ?? ''}
                onSave={next => patch({ description: next })}
                placeholder="What does this agent do?"
                minRows={3}
                label="Edit agent description"
              />
            </Field>
          )}
        </Section>

        {/* Behavior — status, master/PM toggles, model. These commit on
            change (no inline edit/save dance) since they're discrete
            values, not free text. */}
        <Section
          id="behavior"
          title="Behavior"
          description="Lifecycle status, orchestration role, and which model the gateway should run this agent on."
        >
          <Field label="Status">
            <select
              value={agent.status}
              onChange={e => patch({ status: e.target.value as AgentStatus }).catch(() => {})}
              className="w-full max-w-xs min-h-9 bg-mc-bg border border-mc-border rounded-sm px-3 py-1.5 text-sm focus:outline-hidden focus:border-mc-accent"
            >
              <option value="standby">Standby</option>
              <option value="working">Working</option>
              <option value="offline">Offline</option>
            </select>
          </Field>

          <Field label="Roles">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={agent.is_master}
                onChange={e => patch({ is_master: e.target.checked }).catch(() => {})}
                className="w-4 h-4 accent-mc-accent"
              />
              <span>Master Orchestrator (can coordinate other agents)</span>
            </label>
            <label className="flex items-center gap-2 text-sm mt-1.5">
              <input
                type="checkbox"
                checked={isPm}
                onChange={e => patch({ is_pm: e.target.checked }).catch(() => {})}
                className="w-4 h-4 accent-mc-accent"
              />
              <span>PM for this workspace (drives /pm chat + proposals)</span>
            </label>
            <p className="text-[11px] text-mc-text-secondary mt-1.5">
              The API enforces one PM per workspace — toggling this on clears the flag on every other agent here.
            </p>
          </Field>

          <Field label="Model">
            <select
              value={agent.model ?? ''}
              onChange={e => patch({ model: e.target.value }).catch(() => {})}
              className="w-full max-w-md min-h-9 bg-mc-bg border border-mc-border rounded-sm px-3 py-1.5 text-sm focus:outline-hidden focus:border-mc-accent"
            >
              <option value="">— Use default model{defaultModel && ` (${defaultModel})`} —</option>
              {availableModels.map(m => (
                <option key={m} value={m}>
                  {m}{defaultModel === m ? ' (default)' : ''}
                </option>
              ))}
            </select>
            <p className="text-[11px] text-mc-text-secondary mt-1">
              AI model the gateway uses for this agent. Empty = OpenClaw default.
            </p>
          </Field>
        </Section>

        {/* Routing — session key prefix override + Session info table.
            Right rail mirrors the resolved prefix as a live preview. */}
        <Section
          id="routing"
          title="Routing"
          description={
            <>
              How MC reaches this agent on the OpenClaw gateway. The
              resolved prefix below is what every dispatch (chat, task,
              subagent) gets prepended with — see the right rail for a
              live preview as you edit.
            </>
          }
        >
          <Field label="Gateway agent ID">
            <InlineText
              value={agent.gateway_agent_id ?? ''}
              onSave={next => patch({ gateway_agent_id: next.trim() || null })}
              placeholder="(none — falls back to org runner)"
              disabled={isGateway}
              label="Edit gateway agent ID"
            />
            <p className="text-[11px] text-mc-text-secondary mt-1">
              Pin this MC agent to a specific gateway-synced agent (e.g.{' '}
              <code className="text-mc-text">mc-runner-dev</code>). Empty falls
              back to the org runner via the resolver.
              {isGateway && (
                <span className="block mt-1 text-amber-300">
                  Locked — gateway-synced agents own their own ID.
                </span>
              )}
            </p>
          </Field>

          <Field label="Session key prefix override">
            <InlineText
              value={agent.session_key_prefix ?? ''}
              onSave={next => {
                const trimmed = next.trim();
                const normalized = !trimmed ? '' : (trimmed.endsWith(':') ? trimmed : trimmed + ':');
                return patch({ session_key_prefix: normalized || null });
              }}
              placeholder="agent:<gateway_agent_id>:"
              label="Edit session key prefix"
            />
            <p className="text-[11px] text-mc-text-secondary mt-1">
              Last-resort override. Leave blank to derive from Gateway agent ID
              above (or fall back to{' '}
              <code className="text-mc-text">agent:&lt;runner&gt;:&lt;name-slug&gt;:</code>).
            </p>
          </Field>

          <Field label="Recent OpenClaw sessions">
            {sessionInfoError ? (
              <p className="text-xs px-2 py-1.5 rounded border bg-red-500/10 border-red-500/30 text-red-300">
                Failed to load: {sessionInfoError}
              </p>
            ) : !sessionInfo ? (
              <p className="text-xs text-mc-text-secondary">Loading…</p>
            ) : sessionInfo.sessions.length === 0 ? (
              <p className="text-xs text-mc-text-secondary italic px-2 py-1.5 border border-dashed border-mc-border rounded-sm">
                No sessions yet — one will be created on the next dispatch using{' '}
                <span className="font-mono">{sessionInfo.resolved_prefix}…</span>
              </p>
            ) : (
              <div className="border border-mc-border rounded-sm overflow-hidden">
                <table className="w-full text-xs">
                  <thead className="bg-mc-bg-tertiary/50">
                    <tr className="text-left text-mc-text-secondary">
                      <th className="px-2 py-1.5 font-medium">Session key</th>
                      <th className="px-2 py-1.5 font-medium">Type</th>
                      <th className="px-2 py-1.5 font-medium">Status</th>
                      <th className="px-2 py-1.5 font-medium">Stage</th>
                      <th className="px-2 py-1.5 font-medium">Updated</th>
                      <th className="px-2 py-1.5 font-medium text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sessionInfo.sessions.map(s => {
                      const busy = sessionRowBusy[s.id] ?? null;
                      const rowErr = sessionRowError[s.id];
                      return (
                        <tr key={s.id} className="border-t border-mc-border align-top">
                          <td className="px-2 py-1.5 font-mono break-all">
                            {s.openclaw_session_id}
                            {s.task_id && (
                              <div className="text-mc-text-secondary">task: <span className="font-mono">{s.task_id}</span></div>
                            )}
                            {rowErr && (
                              <div className="mt-1 text-amber-300 text-[11px] not-italic">{rowErr}</div>
                            )}
                          </td>
                          <td className="px-2 py-1.5">{s.session_type}</td>
                          <td className="px-2 py-1.5">
                            <span className={s.status === 'active' ? 'text-emerald-300' : 'text-mc-text-secondary'}>
                              {s.status}
                            </span>
                          </td>
                          <td className="px-2 py-1.5">{s.stage ?? <span className="text-mc-text-secondary">—</span>}</td>
                          <td className="px-2 py-1.5 text-mc-text-secondary whitespace-nowrap">
                            {new Date(s.updated_at || s.created_at).toLocaleString()}
                          </td>
                          <td className="px-2 py-1.5 whitespace-nowrap text-right">
                            <button
                              type="button"
                              onClick={() => requestSessionRowAction(s.id, 'reset')}
                              disabled={busy !== null}
                              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-mc-border text-[11px] hover:bg-mc-bg-tertiary disabled:opacity-50"
                              title="Send /reset to the gateway and clear this row"
                            >
                              <RotateCcw className={`w-3 h-3 ${busy === 'reset' ? 'animate-spin' : ''}`} />
                              {busy === 'reset' ? 'Resetting…' : 'Reset'}
                            </button>
                            <button
                              type="button"
                              onClick={() => requestSessionRowAction(s.id, 'delete')}
                              disabled={busy !== null}
                              className="ml-1 inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-red-500/40 text-red-300 text-[11px] hover:bg-red-500/10 disabled:opacity-50"
                              title="Delete the MC-side session row (gateway not contacted)"
                            >
                              <Trash2 className="w-3 h-3" />
                              {busy === 'delete' ? 'Deleting…' : 'Delete'}
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            <button
              type="button"
              onClick={() => setSessionRefreshTick(t => t + 1)}
              disabled={sessionInfoLoading}
              className="mt-2 text-[11px] text-mc-text-secondary hover:text-mc-text disabled:opacity-50"
            >
              {sessionInfoLoading ? 'Refreshing…' : 'Refresh'}
            </button>
          </Field>

          {agent.gateway_agent_id && (
            <Field label="Reset session">
              <button
                type="button"
                onClick={handleReset}
                disabled={isResetting}
                className="inline-flex items-center gap-2 px-3 py-1.5 rounded-sm border border-mc-border text-sm hover:bg-mc-bg-tertiary disabled:opacity-50"
              >
                <RotateCcw className={`w-4 h-4 ${isResetting ? 'animate-spin' : ''}`} />
                {isResetting ? 'Resetting…' : 'Reset session'}
              </button>
              <p className="text-[11px] text-mc-text-secondary mt-1">
                Clears MC-side session rows for this agent and sends{' '}
                <code className="text-mc-text">/reset</code> to the gateway.
                The agent re-init&apos;s its persona files on its next message.
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
            </Field>
          )}
        </Section>

        {/* Persona files — local agents only. Gateway agents' persona
            files live upstream and PATCH ignores these fields anyway. */}
        {!isGateway && (
          <>
            <Section
              id="soul"
              title={
                <PersonaHeaderTitle
                  fileLabel="SOUL.md"
                  header={agent.soul_header ?? ''}
                  defaultHeader="Who you are"
                  onSave={next => patch({ soul_header: next || null })}
                />
              }
              description="Loaded on first message and cached until /reset. The section header above is what gets prepended to the persona-init block."
            >
              <InlineTextarea
                value={agent.soul_md ?? ''}
                onSave={next => patch({ soul_md: next })}
                placeholder="# Agent Name&#10;&#10;Define this agent's personality, values, and communication style..."
                minRows={12}
                mono
                label="Edit SOUL.md"
              />
            </Section>

            <Section
              id="user"
              title={
                <PersonaHeaderTitle
                  fileLabel="USER.md"
                  header={agent.user_header ?? ''}
                  defaultHeader="Who the operator is"
                  onSave={next => patch({ user_header: next || null })}
                />
              }
              description="Context about the human this agent works with."
            >
              <InlineTextarea
                value={agent.user_md ?? ''}
                onSave={next => patch({ user_md: next })}
                placeholder="# User Context&#10;&#10;Information about the human this agent works with..."
                minRows={12}
                mono
                label="Edit USER.md"
              />
            </Section>

            <Section
              id="agents-md"
              title={
                <PersonaHeaderTitle
                  fileLabel="AGENTS.md"
                  header={agent.agents_header ?? ''}
                  defaultHeader="Your team"
                  onSave={next => patch({ agents_header: next || null })}
                />
              }
              description="Doesn't have to be team info — operators often use this for behavioural rules, output format, or prohibitions. The header above is what the agent sees prepended."
            >
              <InlineTextarea
                value={agent.agents_md ?? ''}
                onSave={next => patch({ agents_md: next })}
                placeholder="# Rules / team / format&#10;&#10;e.g. 'Reply in 7 word sentences', 'Cite sources', or team-roster info."
                minRows={12}
                mono
                label="Edit AGENTS.md"
              />
            </Section>
          </>
        )}

        {/* Chat — embedded inline so the operator can talk to the agent
            without leaving the page. Activity moved to the right rail. */}
        <Section id="chat" title="Chat" description="Direct chat session with this agent.">
          <div className="-mt-1 mb-2 flex justify-end">
            <button
              type="button"
              onClick={handleClearChatHistory}
              className="inline-flex items-center gap-1 px-2 py-1 rounded border border-mc-border text-[11px] text-mc-text-secondary hover:bg-mc-bg-tertiary hover:text-mc-text"
              title="Clear the visible chat thread (does not reset the gateway session)"
            >
              <Trash2 className="w-3 h-3" />
              Clear chat history
            </button>
          </div>
          <div className="-mx-5 -mb-4 h-[480px] overflow-hidden flex flex-col">
            <AgentChatTab agent={agent} />
          </div>
        </Section>

        {/* Danger zone — Delete. Mirrors the workspace settings pattern:
            red border, typed-confirmation in a modal so a stray click
            doesn't nuke an agent. */}
        <section
          id="danger-zone"
          className="mt-10 rounded-lg border border-red-500/40 bg-red-500/5 scroll-mt-20"
        >
          <header className="px-5 py-3 border-b border-red-500/30">
            <h2 className="text-sm font-semibold text-red-300 flex items-center gap-2">
              <AlertTriangle className="w-4 h-4" /> Danger Zone
            </h2>
          </header>
          <div className="px-5 py-4 flex items-start justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-mc-text">Delete this agent</h3>
              <p className="text-xs text-mc-text-secondary mt-0.5">
                Permanently removes this agent from MC. Sessions, mailbox rows, and history attached to it cascade.
                {isGateway && (
                  <span className="block mt-1 text-amber-300">
                    Gateway-synced agents will reappear on next sync unless you also remove them upstream.
                  </span>
                )}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setShowDelete(true)}
              className="px-3 py-1.5 text-sm rounded border border-red-500/40 text-red-200 hover:bg-red-500/10 inline-flex items-center gap-1.5 shrink-0"
            >
              <Trash2 className="w-3.5 h-3.5" />
              Delete agent
            </button>
          </div>
        </section>

        {showDelete && (
          <DeleteModal
            agent={agent}
            deleting={deleting}
            onCancel={() => setShowDelete(false)}
            onConfirm={handleDelete}
          />
        )}

        <ConfirmDialog
          open={pendingConfirm !== null}
          title={pendingConfirm?.title ?? ''}
          body={pendingConfirm?.body ?? null}
          confirmLabel={pendingConfirm?.confirmLabel ?? 'Confirm'}
          destructive={pendingConfirm?.destructive}
          onCancel={() => setPendingConfirm(null)}
          onConfirm={() => {
            const action = pendingConfirm?.onConfirm;
            setPendingConfirm(null);
            if (action) Promise.resolve(action()).catch(err => console.error(err));
          }}
        />
      </>
    </PageWithRails>
  );
}

/**
 * Right-rail live preview — shows the resolved sessionKey prefix and
 * the derivation path so the operator can see at a glance how the
 * gateway will route a dispatch right now.
 */
function RoutingPreview({
  info,
  loading,
  error,
}: {
  info: SessionInfo | null;
  loading: boolean;
  error: string | null;
}) {
  if (error) {
    return (
      <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-4 text-xs text-red-300">
        <div className="text-[10px] uppercase tracking-wide text-red-300/70 mb-2">Routing preview</div>
        Failed to load: {error}
      </div>
    );
  }
  if (!info) {
    return (
      <div className="rounded-lg border border-mc-border/60 bg-mc-bg-secondary p-4 text-xs text-mc-text-secondary">
        <div className="text-[10px] uppercase tracking-wide text-mc-text-secondary/70 mb-2">Routing preview</div>
        {loading ? 'Loading…' : '—'}
      </div>
    );
  }
  const activeCount = info.sessions.filter(s => s.status === 'active').length;
  return (
    <div className="rounded-lg border border-mc-border/60 bg-mc-bg-secondary">
      <header className="px-4 py-2 border-b border-mc-border/60 flex items-center justify-between gap-2">
        <h2 className="text-[10px] uppercase tracking-wide text-mc-text-secondary/70">Routing preview</h2>
        <span className="text-[10px] text-mc-text-secondary/60">live</span>
      </header>
      <div className="p-4 space-y-3 text-xs">
        <div>
          <div className="text-[10px] uppercase tracking-wide text-mc-text-secondary/70 mb-1">Resolved prefix</div>
          <code className="block px-2 py-1.5 rounded-sm bg-mc-bg border border-mc-border font-mono break-all text-mc-text">
            {info.resolved_prefix}
          </code>
          <p className="text-[11px] text-mc-text-secondary mt-1">
            {info.prefix_source === 'explicit' && 'Explicit override (Routing → Session key prefix).'}
            {info.prefix_source === 'gateway_agent_id' && 'Derived from gateway_agent_id.'}
            {info.prefix_source === 'runner_fallback' && (
              <>Hosted on the org runner — slug appended for namespacing.</>
            )}
          </p>
        </div>

        <dl className="grid grid-cols-[110px_1fr] gap-x-3 gap-y-1.5">
          <dt className="text-mc-text-secondary">Source</dt>
          <dd>{info.source}</dd>

          <dt className="text-mc-text-secondary">Gateway ID</dt>
          <dd className="font-mono break-all">
            {info.gateway_agent_id ?? <span className="text-mc-text-secondary">—</span>}
          </dd>

          <dt className="text-mc-text-secondary">MC ID</dt>
          <dd className="font-mono break-all">{info.agent_id}</dd>

          <dt className="text-mc-text-secondary">Sessions</dt>
          <dd>
            <span className="text-emerald-300">{activeCount} active</span>
            <span className="text-mc-text-secondary"> / {info.sessions.length} total</span>
          </dd>
        </dl>
      </div>
    </div>
  );
}

function Section({
  id,
  title,
  description,
  children,
}: {
  id?: string;
  title: React.ReactNode;
  description?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section
      id={id}
      className="mb-6 rounded-lg border border-mc-border bg-mc-bg-secondary scroll-mt-20"
    >
      <header className="px-5 py-3 border-b border-mc-border/60">
        <h2 className="text-sm font-semibold text-mc-text">{title}</h2>
        {description && (
          <p className="text-xs text-mc-text-secondary mt-1">{description}</p>
        )}
      </header>
      <div className="px-5 py-4 space-y-4">{children}</div>
    </section>
  );
}

/**
 * Section title for the persona files (SOUL/USER/AGENTS) — renders
 * the file label plus the editable in-prompt section header used in
 * the persona-init block. Display reads `SOUL.md — ## Who you are`,
 * with the right side being inline-editable. Empty value falls back
 * to `defaultHeader` (italic, "(default)") to make clear what the
 * agent will actually see.
 */
function PersonaHeaderTitle({
  fileLabel,
  header,
  defaultHeader,
  onSave,
}: {
  fileLabel: string;
  header: string;
  defaultHeader: string;
  onSave: (next: string) => Promise<void> | void;
}) {
  const display = header.trim();
  return (
    <span className="inline-flex items-center gap-2 flex-wrap">
      <span>{fileLabel}</span>
      <span className="text-mc-text-secondary">—</span>
      <span className="font-mono text-xs text-mc-text-secondary">##</span>
      <span className="text-xs font-normal flex-1 min-w-[10ch]">
        <InlineText
          value={display}
          onSave={onSave}
          placeholder={`${defaultHeader} (default)`}
          label={`Edit ${fileLabel} section header`}
          inputClassName="w-full px-1.5 py-0.5 rounded bg-mc-bg border border-mc-accent/60 text-mc-text outline-none text-xs"
        />
      </span>
    </span>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-mc-text-secondary/70 mb-1">
        {label}
      </div>
      {children}
    </div>
  );
}

/**
 * Inline avatar dropdown — current emoji as a button, click reveals an
 * emoji grid popover. Click-outside / Escape close it. Used in Identity
 * so the avatar lives on the same row as the name instead of consuming
 * a full grid row.
 */
function AvatarPicker({
  value,
  onPick,
}: {
  value: string;
  onPick: (emoji: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div ref={wrapRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="inline-flex items-center gap-1 px-2 py-1 rounded border border-mc-border bg-mc-bg hover:bg-mc-bg-tertiary"
        title="Change avatar"
        aria-label="Change avatar"
      >
        <span className="text-xl leading-none">{value}</span>
        <ChevronDown className="w-3 h-3 text-mc-text-secondary" />
      </button>
      {open && (
        <div className="absolute left-0 top-full mt-1 z-30 p-2 rounded-lg border border-mc-border bg-mc-bg shadow-lg flex flex-wrap gap-1 w-44">
          {EMOJI_OPTIONS.map(opt => (
            <button
              key={opt}
              type="button"
              onClick={() => { onPick(opt); setOpen(false); }}
              className={`w-8 h-8 text-xl rounded hover:bg-mc-bg-tertiary ${
                opt === value ? 'bg-mc-accent/15 ring-1 ring-mc-accent' : ''
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
 * Role select with a "Custom…" escape hatch. If the agent's current
 * role isn't in STANDARD_ROLES we treat it as custom by default and
 * show the free-text input alongside the select. Commits on change /
 * blur via PATCH so there's no separate save step.
 */
function RoleSelect({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  const isStandard = (STANDARD_ROLES as readonly string[]).includes(value);
  const [mode, setMode] = useState<'standard' | 'custom'>(isStandard || !value ? 'standard' : 'custom');
  const [customDraft, setCustomDraft] = useState(isStandard ? '' : value);

  // Re-sync if the underlying value changes (e.g. after a refresh).
  useEffect(() => {
    if ((STANDARD_ROLES as readonly string[]).includes(value)) {
      setMode('standard');
    } else if (value) {
      setMode('custom');
      setCustomDraft(value);
    }
  }, [value]);

  const selectValue = mode === 'custom' ? '__custom__' : value || '';

  return (
    <div className="flex items-center gap-2">
      <select
        value={selectValue}
        onChange={e => {
          const v = e.target.value;
          if (v === '__custom__') {
            setMode('custom');
            // Don't PATCH yet — wait for the operator to type a value
            // and blur, otherwise we'd persist an empty role.
            return;
          }
          setMode('standard');
          onChange(v);
        }}
        className="min-h-9 bg-mc-bg border border-mc-border rounded-sm px-3 py-1.5 text-sm focus:outline-hidden focus:border-mc-accent"
      >
        {!value && <option value="">— Pick a role —</option>}
        {STANDARD_ROLES.map(r => (
          <option key={r} value={r}>{r}</option>
        ))}
        <option value="__custom__">Custom…</option>
      </select>
      {mode === 'custom' && (
        <input
          type="text"
          value={customDraft}
          onChange={e => setCustomDraft(e.target.value)}
          onBlur={() => {
            const trimmed = customDraft.trim();
            if (trimmed && trimmed !== value) onChange(trimmed);
          }}
          onKeyDown={e => {
            if (e.key === 'Enter') {
              e.preventDefault();
              (e.target as HTMLInputElement).blur();
            }
          }}
          placeholder="custom role"
          autoFocus={!customDraft}
          className="flex-1 min-h-9 bg-mc-bg border border-mc-border rounded-sm px-3 py-1.5 text-sm focus:outline-hidden focus:border-mc-accent"
        />
      )}
    </div>
  );
}

function DeleteModal({
  agent,
  deleting,
  onCancel,
  onConfirm,
}: {
  agent: Agent;
  deleting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const [confirmText, setConfirmText] = useState('');
  const canConfirm = confirmText.trim() === agent.name;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="bg-mc-bg-secondary border border-mc-border rounded-lg w-full max-w-lg p-5">
        <h2 className="text-lg font-semibold mb-2 text-red-300 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4" /> Delete agent
        </h2>
        <p className="text-sm text-mc-text-secondary mb-4">
          You&apos;re about to permanently delete{' '}
          <strong className="text-mc-text">{agent.name}</strong>. This cannot be undone.
        </p>
        <label className="block">
          <span className="text-xs text-mc-text-secondary">
            Type <code className="text-mc-text">{agent.name}</code> to confirm:
          </span>
          <input
            type="text"
            autoFocus
            value={confirmText}
            onChange={e => setConfirmText(e.target.value)}
            className="mt-1 w-full px-3 py-2 bg-mc-bg border border-mc-border rounded-sm text-sm text-mc-text focus:border-red-500/60 focus:outline-hidden"
          />
        </label>
        <div className="flex items-center justify-end gap-2 mt-4">
          <button
            type="button"
            onClick={onCancel}
            disabled={deleting}
            className="px-3 py-1.5 text-sm rounded border border-mc-border text-mc-text-secondary hover:bg-mc-bg-tertiary"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={!canConfirm || deleting}
            className="px-3 py-1.5 text-sm rounded bg-red-500/20 border border-red-500/40 text-red-200 hover:bg-red-500/30 disabled:opacity-30 inline-flex items-center gap-1.5"
          >
            <Trash2 className="w-3.5 h-3.5" />
            {deleting ? 'Deleting…' : 'Delete forever'}
          </button>
        </div>
      </div>
    </div>
  );
}
