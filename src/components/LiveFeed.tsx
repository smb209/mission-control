'use client';

import { useState } from 'react';
import { ChevronUp, ChevronDown, Clock, PanelRightClose, PanelRightOpen } from 'lucide-react';
import { useMissionControl } from '@/lib/store';
import type { Event } from '@/lib/types';
import { formatDistanceToNow } from 'date-fns';

type FeedFilter = 'all' | 'tasks' | 'agents';

interface LiveFeedProps {
  mobileMode?: boolean;
  isPortrait?: boolean;
  // Optional content rendered at the top of the rail, above the filter tabs.
  // Used by the desktop layout to stack the Ready Deliverables panel above
  // the feed without creating a competing w-80 wrapper.
  topSlot?: React.ReactNode;
}

export function LiveFeed({ mobileMode = false, isPortrait = true, topSlot }: LiveFeedProps) {
  const { events } = useMissionControl();
  const [filter, setFilter] = useState<FeedFilter>('all');
  const [isMinimized, setIsMinimized] = useState(false); // whole-rail collapse
  const [feedCollapsed, setFeedCollapsed] = useState(false); // only hide feed content

  const effectiveMinimized = mobileMode ? false : isMinimized;
  const toggleMinimize = () => setIsMinimized(!isMinimized);
  const toggleFeed = () => setFeedCollapsed(v => !v);

  const filteredEvents = events.filter((event) => {
    if (filter === 'all') return true;
    if (filter === 'tasks') return ['task_created', 'task_assigned', 'task_status_changed', 'task_completed'].includes(event.type);
    if (filter === 'agents') return ['agent_joined', 'agent_status_changed', 'message_sent'].includes(event.type);
    return true;
  });

  // Whole-rail collapsed view: a slim 12px-wide column with just the expand button.
  if (effectiveMinimized) {
    return (
      <aside className="w-12 bg-mc-bg-secondary border-l border-mc-border flex flex-col items-center py-2 transition-all duration-300 ease-in-out">
        <button
          onClick={toggleMinimize}
          className="p-1 rounded-sm hover:bg-mc-bg-tertiary text-mc-text-secondary hover:text-mc-text transition-colors"
          aria-label="Expand right panel"
          title="Expand right panel"
        >
          <PanelRightOpen className="w-4 h-4" />
        </button>
      </aside>
    );
  }

  return (
    <aside
      className={`bg-mc-bg-secondary ${mobileMode ? 'border border-mc-border rounded-lg h-full' : 'border-l border-mc-border'} flex flex-col transition-all duration-300 ease-in-out ${
        mobileMode ? 'w-full' : 'w-80'
      }`}
    >
      {/* Rail toolbar — whole-panel minimize lives here, independent of the
          LIVE FEED section header so it's always reachable even when the feed
          (or deliverables) is collapsed. */}
      {!mobileMode && (
        <div className="flex items-center justify-end px-2 py-1 border-b border-mc-border/60">
          <button
            onClick={toggleMinimize}
            className="p-1 rounded-sm hover:bg-mc-bg-tertiary text-mc-text-secondary hover:text-mc-text transition-colors"
            aria-label="Minimize right panel"
            title="Minimize right panel"
          >
            <PanelRightClose className="w-4 h-4" />
          </button>
        </div>
      )}

      {topSlot && <div className="shrink-0">{topSlot}</div>}

      {/* LIVE FEED section — the header itself is a button that collapses the
          section independently of the deliverables panel and the whole rail. */}
      <div className={`border-b border-mc-border shrink-0 ${feedCollapsed ? '' : ''}`}>
        <button
          onClick={toggleFeed}
          className="w-full flex items-center justify-between px-3 py-2 hover:bg-mc-bg-tertiary"
        >
          <span className="text-sm font-medium uppercase tracking-wider">Live Feed</span>
          {feedCollapsed ? <ChevronDown className="w-4 h-4 text-mc-text-secondary" /> : <ChevronUp className="w-4 h-4 text-mc-text-secondary" />}
        </button>
        {!feedCollapsed && (
          <div className={`px-3 pb-3 ${mobileMode && isPortrait ? 'grid grid-cols-3 gap-2' : 'flex gap-1'}`}>
            {(['all', 'tasks', 'agents'] as FeedFilter[]).map((tab) => (
              <button
                key={tab}
                onClick={() => setFilter(tab)}
                className={`min-h-11 text-xs rounded uppercase ${mobileMode && isPortrait ? 'px-1' : 'px-3'} ${
                  filter === tab ? 'bg-mc-accent text-mc-bg font-medium' : 'text-mc-text-secondary hover:bg-mc-bg-tertiary'
                }`}
              >
                {tab}
              </button>
            ))}
          </div>
        )}
      </div>

      {!feedCollapsed && (
        <div className="flex-1 overflow-y-auto p-2 space-y-1 pb-[calc(0.5rem+env(safe-area-inset-bottom))]">
          {filteredEvents.length === 0 ? (
            <div className="text-center py-8 text-mc-text-secondary text-sm">No events yet</div>
          ) : (
            filteredEvents.map((event) => <EventItem key={event.id} event={event} />)
          )}
        </div>
      )}
    </aside>
  );
}

function EventItem({ event }: { event: Event }) {
  const getEventIcon = (type: string) => {
    switch (type) {
      case 'task_created':
        return '📋';
      case 'task_assigned':
        return '👤';
      case 'task_status_changed':
        return '🔄';
      case 'task_completed':
        return '✅';
      case 'message_sent':
        return '💬';
      case 'agent_joined':
        return '🎉';
      case 'agent_status_changed':
        return '🔔';
      case 'system':
        return '⚙️';
      case 'task_dispatched':
        return '🚀';
      case 'convoy_created':
        return '🚚';
      case 'convoy_completed':
        return '🏁';
      case 'task_archived':
        return '📦';
      case 'task_unarchived':
        return '📤';
      default:
        return '📌';
    }
  };

  const isTaskEvent = ['task_created', 'task_assigned', 'task_completed'].includes(event.type);
  const isHighlight = event.type === 'task_created' || event.type === 'task_completed';

  return (
    <div
      className={`p-2 rounded border-l-2 animate-slide-in ${
        isHighlight ? 'bg-mc-bg-tertiary border-mc-accent-pink' : 'bg-transparent border-transparent hover:bg-mc-bg-tertiary'
      }`}
    >
      <div className="flex items-start gap-2">
        <span className="text-sm">{getEventIcon(event.type)}</span>
        <div className="flex-1 min-w-0">
          <p className={`text-sm ${isTaskEvent ? 'text-mc-accent-pink' : 'text-mc-text'}`}>{event.message}</p>
          <div className="flex items-center gap-1 mt-1 text-xs text-mc-text-secondary">
            <Clock className="w-3 h-3" />
            {formatDistanceToNow(new Date(event.created_at), { addSuffix: true })}
          </div>
        </div>
      </div>
    </div>
  );
}
