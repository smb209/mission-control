'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Activity } from 'lucide-react';
import type { DebugEvent } from '@/lib/debug-log';
import { DebugEventRow } from '@/components/debug/DebugEventRow';

interface AgentActivityTabProps {
  agentId: string;
}

export function AgentActivityTab({ agentId }: AgentActivityTabProps) {
  const [events, setEvents] = useState<DebugEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const agentIdRef = useRef(agentId);
  agentIdRef.current = agentId;

  const refetch = useCallback(async () => {
    try {
      const res = await fetch(`/api/debug/events?agent_id=${encodeURIComponent(agentId)}&limit=100`);
      if (!res.ok) return;
      const data = await res.json();
      setEvents(data.events || []);
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  useEffect(() => {
    setLoading(true);
    refetch();
  }, [refetch]);

  // Live tail — subscribe to SSE, filter to this agent.
  useEffect(() => {
    const es = new EventSource('/api/events/stream');
    es.onmessage = (event) => {
      if (event.data.startsWith(':')) return;
      try {
        const parsed = JSON.parse(event.data) as { type: string; payload: unknown };
        if (parsed.type === 'debug_event_logged') {
          const incoming = parsed.payload as DebugEvent;
          if (incoming.agent_id !== agentIdRef.current) return;
          setEvents(prev => [incoming, ...prev].slice(0, 100));
        } else if (parsed.type === 'debug_events_cleared') {
          setEvents([]);
        }
      } catch {
        /* ignore */
      }
    };
    return () => es.close();
  }, []);

  const toggleExpanded = (id: string) => {
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="flex-1 overflow-y-auto p-4">
      {loading ? (
        <div className="text-sm text-mc-text-secondary py-8 text-center">Loading activity…</div>
      ) : events.length === 0 ? (
        <div className="text-sm text-mc-text-secondary py-12 text-center">
          <Activity className="w-8 h-8 mx-auto mb-3 opacity-40" />
          <div>No recorded activity for this agent.</div>
          <div className="mt-2 text-xs">
            Make sure collection is on —{' '}
            <Link href="/debug" className="text-mc-accent hover:underline">
              open /debug
            </Link>
            .
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          {events.map(event => (
            <DebugEventRow
              key={event.id}
              event={event}
              expanded={expandedIds.has(event.id)}
              onToggle={() => toggleExpanded(event.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
