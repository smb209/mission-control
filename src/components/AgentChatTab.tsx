'use client';

import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { Send, Check, Loader, MessageSquare } from 'lucide-react';
import type { Agent, AgentChatMessage } from '@/lib/types';

interface AgentChatTabProps {
  agent: Agent;
}

export function AgentChatTab({ agent }: AgentChatTabProps) {
  const [messages, setMessages] = useState<AgentChatMessage[]>([]);
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const agentIdRef = useRef(agent.id);
  agentIdRef.current = agent.id;

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/agents/${agent.id}/chat`);
      if (res.ok) {
        const data: AgentChatMessage[] = await res.json();
        setMessages(data);
      }
    } catch {
      /* silent — retry on next tick */
    }
  }, [agent.id]);

  useEffect(() => {
    load();
    const interval = setInterval(load, 2000);
    return () => clearInterval(interval);
  }, [load]);

  // Live refresh via SSE — pick up assistant replies immediately.
  useEffect(() => {
    const es = new EventSource('/api/events/stream');
    es.onmessage = (evt) => {
      if (evt.data.startsWith(':')) return;
      try {
        const parsed = JSON.parse(evt.data) as { type: string; payload: { agentId?: string } };
        if (parsed.type === 'agent_chat_message' && parsed.payload?.agentId === agentIdRef.current) {
          load();
        }
      } catch {
        /* ignore */
      }
    };
    return () => es.close();
  }, [load]);

  const waiting = useMemo(() => {
    if (messages.length === 0) return false;
    const last = messages[messages.length - 1];
    if (last.role !== 'user') return false;
    if (last.status === 'pending') return true;
    const age = Date.now() - new Date(last.created_at).getTime();
    return age < 15000;
  }, [messages]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, waiting]);

  const handleSend = async () => {
    if (!message.trim() || sending) return;
    setError(null);
    setSending(true);
    try {
      const res = await fetch(`/api/agents/${agent.id}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: message.trim() }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: 'Failed to send' }));
        setError(data.error || 'Failed to send message');
        return;
      }
      setMessage('');
      await load();
    } catch {
      setError('Network error — please try again');
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="flex flex-col h-full min-h-[400px]">
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-3 space-y-3">
        {messages.length === 0 && !waiting && (
          <div className="text-center py-12">
            <MessageSquare className="w-8 h-8 text-mc-text-secondary mx-auto mb-3 opacity-50" />
            <p className="text-mc-text-secondary text-sm">No messages yet</p>
            <p className="text-mc-text-secondary/60 text-xs mt-1">
              Chat directly with {agent.name} — messages go to the agent&apos;s session, not a task.
            </p>
          </div>
        )}

        {messages.map(msg => {
          const isAgent = msg.role === 'assistant';
          return (
            <div key={msg.id} className={isAgent ? 'mr-8' : 'ml-8'}>
              <div className={`border rounded-lg px-3 py-2 ${
                isAgent
                  ? 'bg-green-500/10 border-green-500/20'
                  : 'bg-blue-500/10 border-blue-500/20'
              }`}>
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-xs font-medium text-mc-text-secondary">
                    {isAgent ? agent.name : 'You'}
                  </span>
                  {!isAgent && msg.status === 'pending' && (
                    <span className="flex items-center gap-1 text-xs text-amber-400">
                      <Loader className="w-3 h-3 animate-spin" />
                      Sending
                    </span>
                  )}
                  {!isAgent && msg.status === 'delivered' && (
                    <span className="flex items-center gap-1 text-xs text-green-400">
                      <Check className="w-3 h-3" />
                      Delivered
                    </span>
                  )}
                  <span className="ml-auto text-xs text-mc-text-secondary/50">
                    {new Date(msg.created_at.endsWith('Z') ? msg.created_at : msg.created_at + 'Z').toLocaleTimeString()}
                  </span>
                </div>
                <div className="text-sm text-mc-text whitespace-pre-wrap">{msg.content}</div>
              </div>
            </div>
          );
        })}

        {waiting && (
          <div className="mr-8">
            <div className="bg-green-500/10 border border-green-500/20 rounded-lg px-3 py-2 inline-flex items-center gap-2">
              <span className="text-xs font-medium text-mc-text-secondary">{agent.name}</span>
              <div className="flex gap-1">
                <span className="w-1.5 h-1.5 bg-green-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                <span className="w-1.5 h-1.5 bg-green-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                <span className="w-1.5 h-1.5 bg-green-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="border-t border-mc-border p-3 space-y-2">
        {error && (
          <div className="text-xs text-red-400 px-1">{error}</div>
        )}
        <div className="flex gap-2">
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={onKeyDown}
            rows={2}
            placeholder={`Message ${agent.name}...`}
            className="flex-1 bg-mc-bg border border-mc-border rounded-sm px-3 py-2 text-sm focus:outline-hidden focus:border-mc-accent resize-none"
          />
          <button
            type="button"
            onClick={handleSend}
            disabled={!message.trim() || sending}
            className="min-h-11 self-end flex items-center gap-2 px-3 py-2 bg-mc-accent text-mc-bg rounded-sm text-sm font-medium hover:bg-mc-accent/90 disabled:opacity-50"
          >
            <Send className="w-4 h-4" />
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
