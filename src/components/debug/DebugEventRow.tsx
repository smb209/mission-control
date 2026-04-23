'use client';

import { useMemo } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import type { DebugEvent } from '@/lib/debug-log';

export function DebugEventRow({
  event,
  expanded,
  onToggle,
}: {
  event: DebugEvent;
  expanded: boolean;
  onToggle: () => void;
}) {
  const directionBadge = useMemo(() => {
    const m = {
      outbound: { label: 'OUT', cls: 'bg-blue-500/15 text-blue-300 border-blue-500/30' },
      inbound: { label: 'IN', cls: 'bg-purple-500/15 text-purple-300 border-purple-500/30' },
      internal: { label: 'INT', cls: 'bg-mc-text-secondary/10 text-mc-text-secondary border-mc-border' },
    }[event.direction];
    return m || { label: event.direction, cls: '' };
  }, [event.direction]);

  const hasError = Boolean(event.error);
  const subject = useMemo(() => pickSubject(event), [event]);

  const sessionTail = useMemo(() => {
    if (!event.session_key) return null;
    const k = event.session_key;
    return k.length > 16 ? `…${k.slice(-14)}` : k;
  }, [event.session_key]);

  const errorSnippet = useMemo(() => {
    if (!event.error) return null;
    const one = event.error.replace(/\s+/g, ' ').trim();
    return one.length > 48 ? one.slice(0, 45) + '…' : one;
  }, [event.error]);

  return (
    <div className={`rounded-lg border ${hasError ? 'border-red-500/40 bg-red-500/5' : 'border-mc-border bg-mc-bg-secondary'}`}>
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-mc-bg-tertiary/40 rounded-lg"
      >
        {expanded ? <ChevronDown className="w-4 h-4 shrink-0" /> : <ChevronRight className="w-4 h-4 shrink-0" />}
        <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded-sm border ${directionBadge.cls} shrink-0`}>
          {directionBadge.label}
        </span>
        <span className="font-mono text-sm shrink-0">{event.event_type}</span>
        {subject && (
          <span
            className="font-mono text-xs px-1.5 py-0.5 rounded-sm border border-mc-accent/40 bg-mc-accent/10 text-mc-accent shrink-0 max-w-[36ch] truncate"
            title={subject.full}
          >
            {subject.kind}:{subject.display}
          </span>
        )}
        <span className="text-xs text-mc-text-secondary truncate flex-1">
          {event.task_id && <span className="mr-3">task={event.task_id.slice(0, 8)}</span>}
          {event.agent_id && <span className="mr-3">agent={event.agent_id.slice(0, 8)}</span>}
          {sessionTail && (
            <span className="mr-3" title={event.session_key || ''}>
              sess={sessionTail}
            </span>
          )}
          {event.duration_ms != null && <span className="mr-3">{event.duration_ms}ms</span>}
          {errorSnippet && <span className="text-red-300">✗ {errorSnippet}</span>}
        </span>
        <span className="text-[11px] text-mc-text-secondary/70 shrink-0">
          {formatDistanceToNow(new Date(event.created_at), { addSuffix: true })}
        </span>
      </button>

      {expanded && (
        <div className="border-t border-mc-border px-4 py-3 text-xs font-mono space-y-3">
          <DebugField label="created_at" value={event.created_at} />
          {event.session_key && <DebugField label="session_key" value={event.session_key} />}
          {event.task_id && <DebugField label="task_id" value={event.task_id} />}
          {event.agent_id && <DebugField label="agent_id" value={event.agent_id} />}
          {event.duration_ms != null && <DebugField label="duration_ms" value={String(event.duration_ms)} />}
          {event.error && <DebugField label="error" value={event.error} tone="error" />}
          {event.metadata && <DebugField label="metadata" value={prettyJson(event.metadata)} block />}
          {event.request_body && <DebugField label="request_body" value={prettyJson(event.request_body)} block />}
          {event.response_body && <DebugField label="response_body" value={prettyJson(event.response_body)} block />}
        </div>
      )}
    </div>
  );
}

export function DebugField({
  label,
  value,
  block = false,
  tone,
}: {
  label: string;
  value: string;
  block?: boolean;
  tone?: 'error';
}) {
  const toneCls = tone === 'error' ? 'text-red-300' : 'text-mc-text';
  if (block) {
    return (
      <div>
        <div className="text-mc-text-secondary mb-1">{label}</div>
        <pre className={`whitespace-pre-wrap break-all bg-mc-bg px-3 py-2 rounded-sm border border-mc-border max-h-96 overflow-auto ${toneCls}`}>{value}</pre>
      </div>
    );
  }
  return (
    <div className="flex gap-3">
      <span className="text-mc-text-secondary w-28 shrink-0">{label}</span>
      <span className={`break-all ${toneCls}`}>{value}</span>
    </div>
  );
}

export function prettyJson(value: string | null): string {
  if (value == null) return '';
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

/**
 * Extract a per-event-type "subject" to surface in the row header — the
 * single field that disambiguates similar rows without requiring an
 * expand. Returns null when nothing useful stands out.
 */
export function pickSubject(event: DebugEvent): { kind: string; display: string; full: string } | null {
  const parseJson = (s: string | null): unknown => {
    if (!s) return null;
    try { return JSON.parse(s); } catch { return null; }
  };

  const meta = parseJson(event.metadata) as Record<string, unknown> | null;

  if (event.event_type === 'mcp.tool_call' && meta && typeof meta.tool_name === 'string') {
    return { kind: 'tool', display: meta.tool_name, full: meta.tool_name };
  }

  if (event.event_type === 'gateway.rpc') {
    const body = parseJson(event.request_body) as Record<string, unknown> | null;
    const method = typeof body?.method === 'string' ? body.method : null;
    if (method) return { kind: 'rpc', display: method, full: method };
  }

  if (event.event_type === 'chat.response') {
    const body = parseJson(event.response_body) as Record<string, unknown> | null;
    const runId = typeof body?.runId === 'string' ? body.runId : null;
    if (runId) {
      const tail = runId.length > 12 ? `…${runId.slice(-10)}` : runId;
      return { kind: 'run', display: tail, full: runId };
    }
  }

  if (event.event_type === 'stall.flagged' && meta && typeof meta.minutes_idle === 'number') {
    const m = meta.minutes_idle;
    return { kind: 'idle', display: `${m}m`, full: `idle ${m} minutes` };
  }

  if (event.event_type === 'diagnostic.step' && meta && typeof meta.step === 'string') {
    return { kind: 'step', display: meta.step, full: meta.step };
  }

  if (event.event_type.startsWith('autopilot.') && meta) {
    const model = typeof meta.model === 'string' ? meta.model : null;
    if (model) return { kind: 'model', display: model, full: model };
    const cycleId = typeof meta.cycle_id === 'string' ? meta.cycle_id : null;
    if (cycleId) {
      const tail = cycleId.length > 12 ? `…${cycleId.slice(-10)}` : cycleId;
      return { kind: 'cycle', display: tail, full: cycleId };
    }
  }

  return null;
}
