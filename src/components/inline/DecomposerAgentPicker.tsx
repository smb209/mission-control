'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';

/**
 * Inline picker for "which agent should decompose this story into tasks?".
 *
 * Today the workspace PM is the only agent with a task-decomposition
 * prompt, so the picker shows it as the sole option. The shape is
 * forward-compatible: when other agents (Builder / Coordinator / custom)
 * grow `can_decompose_tasks` prompts, they get added to `agents` and the
 * picker grows automatically.
 *
 * Behavior:
 *   - Default click on the main face: invokes onPick with the first
 *     (and today only) agent — keeps the button feeling like a single
 *     action when there's nothing to choose.
 *   - Chevron click: opens a popover listing all decomposers with their
 *     description; selecting one fires onPick(id, label).
 */
export interface DecomposerOption {
  id: string;
  label: string;
  description: string;
  disabled?: boolean;
  disabledReason?: string;
}

export function DecomposerAgentPicker({
  icon,
  agents,
  onPick,
  children,
  title,
  disabled,
}: {
  icon: ReactNode;
  agents: DecomposerOption[];
  onPick: (agentId: string, agentLabel: string) => void;
  children: ReactNode;
  title?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const firstEnabled = agents.find(a => !a.disabled);
  const noneAvailable = !firstEnabled;

  return (
    <div ref={wrapRef} className="relative inline-flex">
      <button
        type="button"
        onClick={() => {
          if (firstEnabled) onPick(firstEnabled.id, firstEnabled.label);
        }}
        disabled={disabled || noneAvailable}
        title={noneAvailable ? 'No decomposer agents available in this workspace' : title}
        className="inline-flex items-center gap-1.5 text-xs px-2 py-1.5 rounded-l border border-mc-border border-r-0 text-mc-accent hover:bg-mc-accent/10 hover:border-mc-accent/40 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {icon}
        <span>{children}</span>
      </button>
      <button
        type="button"
        aria-label="Choose decomposer agent"
        onClick={() => setOpen(o => !o)}
        disabled={disabled || noneAvailable}
        className="inline-flex items-center px-1.5 py-1.5 rounded-r border border-mc-border text-mc-accent hover:bg-mc-accent/10 hover:border-mc-accent/40 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <ChevronDown className="w-3.5 h-3.5" />
      </button>
      {open && (
        <div
          className="absolute top-full left-0 mt-1 z-30 w-72 rounded border border-mc-border bg-mc-bg-secondary shadow-lg p-1"
          role="menu"
        >
          <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-mc-text-secondary/70">
            Decompose with…
          </div>
          {agents.length === 0 ? (
            <div className="px-2 py-2 text-xs text-mc-text-secondary">
              No decomposer agents in this workspace.
            </div>
          ) : (
            agents.map(a => (
              <button
                key={a.id}
                type="button"
                disabled={a.disabled}
                title={a.disabled ? a.disabledReason : undefined}
                onClick={() => {
                  setOpen(false);
                  onPick(a.id, a.label);
                }}
                className="w-full text-left px-2 py-2 rounded hover:bg-mc-bg disabled:opacity-50 disabled:cursor-not-allowed"
                role="menuitem"
              >
                <div className="text-sm text-mc-text">{a.label}</div>
                <div className="text-[11px] text-mc-text-secondary mt-0.5 leading-snug">
                  {a.description}
                </div>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
