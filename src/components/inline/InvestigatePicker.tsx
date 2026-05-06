'use client';

/**
 * Two-item dropdown for the Investigate ▾ split-button.
 *
 * Shape mirrors DecomposerAgentPicker so the action toolbar reads
 * uniformly: a left-face "primary action" button plus a chevron that
 * opens a small popover. The primary action defaults to the first
 * enabled item ("Just this initiative (narrow)"); the chevron lists
 * all options including the disabled "Whole subtree" entry so
 * operators see that the path exists even before PR 4 turns it on.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, Search } from 'lucide-react';

export interface InvestigateOption {
  id: 'narrow' | 'subtree';
  label: string;
  description: string;
  disabled?: boolean;
  disabledReason?: string;
}

export function InvestigatePicker({
  options,
  onPick,
  disabled,
}: {
  options: InvestigateOption[];
  onPick: (id: InvestigateOption['id']) => void;
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

  const firstEnabled = options.find(o => !o.disabled);
  const palette = 'border-mc-accent/40 text-mc-accent bg-mc-accent/5 hover:bg-mc-accent/10';

  return (
    <div ref={wrapRef} className="relative inline-flex">
      <button
        type="button"
        onClick={() => firstEnabled && onPick(firstEnabled.id)}
        disabled={disabled || !firstEnabled}
        title="Audit this initiative against the codebase"
        className={`inline-flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-l border border-r-0 ${palette} disabled:opacity-50 disabled:cursor-not-allowed`}
      >
        <Search className="w-3.5 h-3.5" />
        <span>Investigate</span>
      </button>
      <button
        type="button"
        aria-label="Choose investigate scope"
        aria-expanded={open}
        onClick={() => setOpen(o => !o)}
        disabled={disabled}
        className={`inline-flex items-center px-1.5 rounded-r border ${palette} disabled:opacity-50 ${open ? 'bg-mc-accent/15' : ''}`}
      >
        <ChevronDown className="w-3.5 h-3.5" />
      </button>
      {open && (
        <div
          className="absolute top-full left-0 mt-1 z-30 w-72 rounded border border-mc-border bg-mc-bg-secondary shadow-lg p-1"
          role="menu"
        >
          <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-mc-text-secondary/70">
            Investigate scope
          </div>
          {options.map(o => (
            <button
              key={o.id}
              type="button"
              role="menuitem"
              disabled={o.disabled}
              title={o.disabled ? o.disabledReason : undefined}
              onClick={() => {
                if (o.disabled) return;
                setOpen(false);
                onPick(o.id);
              }}
              className="w-full text-left px-2 py-2 rounded hover:bg-mc-bg disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <div className="text-sm text-mc-text">{o.label}</div>
              <div className="text-[11px] text-mc-text-secondary mt-0.5 leading-snug">
                {o.description}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
