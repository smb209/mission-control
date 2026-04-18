'use client';

import { getBlockedState, type BlockedState } from '@/lib/blocked-state';
import type { Task } from '@/lib/types';

interface BlockedBadgeProps {
  task: Task;
  portraitMode?: boolean;
}

/**
 * Rich replacement for the scattered "Assigned, but blocked: {err}" /
 * "In queue — waiting for verification" / "Needs agent" rows that
 * previously lived inline in MissionQueue.tsx. Single source of truth
 * for block detection is src/lib/blocked-state.ts.
 */
export function BlockedBadge({ task, portraitMode = true }: BlockedBadgeProps) {
  const state = getBlockedState(task);
  if (!state) return null;

  return <BlockedBadgeInner state={state} portraitMode={portraitMode} />;
}

function BlockedBadgeInner({ state, portraitMode }: { state: BlockedState; portraitMode: boolean }) {
  const toneClasses =
    state.tone === 'error'
      ? 'bg-red-500/10 border-red-500/30 text-red-300'
      : state.tone === 'warn'
      ? 'bg-amber-500/10 border-amber-500/30 text-amber-200'
      : 'bg-cyan-500/10 border-cyan-500/30 text-cyan-200';

  const dotColor =
    state.tone === 'error' ? 'bg-red-400' : state.tone === 'warn' ? 'bg-amber-400' : 'bg-cyan-400';

  return (
    <div
      className={`flex items-start gap-2 ${portraitMode ? 'mb-3 py-2 px-3' : 'mb-2 py-1.5 px-2.5'} rounded-md border ${toneClasses}`}
      title={state.tooltip}
    >
      <div className={`w-2 h-2 rounded-full mt-1 flex-shrink-0 ${dotColor}`} />
      <span className="text-xs leading-snug">{state.label}</span>
    </div>
  );
}
