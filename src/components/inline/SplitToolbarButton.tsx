'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, Loader2, Send, X } from 'lucide-react';

/**
 * Two-piece toolbar button for AI-assistant actions:
 *
 *   [icon Plan with PM]  [▾]
 *
 * Main face fires the default action immediately. The chevron opens a
 * small popover with a textarea where the operator can type
 * additional guidance — what to focus on, what to avoid, constraints
 * — that gets passed alongside the same default action via a separate
 * callback. This is the reusable shape for any "freeform AI helper"
 * button on the page; the host owns the actual action plumbing.
 *
 * Visual style mirrors ToolbarButton's `accent` palette so AI helpers
 * stay distinct from structural / read-only / destructive buttons.
 */
export function SplitToolbarButton({
  icon,
  onClick,
  onClickWithGuidance,
  children,
  guidanceLabel,
  guidancePlaceholder,
  guidanceCta,
  title,
  disabled,
  busy,
}: {
  icon: ReactNode;
  /** Default action — fired by clicking the main face. */
  onClick: () => void;
  /**
   * Action with operator-provided guidance — fired when the operator
   * submits the popover form. Same destination as `onClick` in
   * practice; the host plumbs `guidance` into its API call.
   */
  onClickWithGuidance: (guidance: string) => void;
  children: ReactNode;
  /** Label above the textarea inside the popover. */
  guidanceLabel?: string;
  /** Placeholder inside the textarea. */
  guidancePlaceholder?: string;
  /** CTA button label inside the popover. Defaults to "Run with guidance". */
  guidanceCta?: string;
  title?: string;
  disabled?: boolean;
  busy?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (open) {
      // Focus the textarea so the operator can start typing immediately.
      requestAnimationFrame(() => taRef.current?.focus());
    } else {
      setText('');
    }
  }, [open]);

  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    onClickWithGuidance(trimmed);
    setOpen(false);
  };

  const palette = 'border-mc-accent/40 text-mc-accent bg-mc-accent/5 hover:bg-mc-accent/10';

  return (
    <div className="relative inline-flex">
      <button
        type="button"
        onClick={onClick}
        title={title}
        disabled={disabled || busy}
        className={`inline-flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-l border border-r-0 ${palette} disabled:opacity-50`}
      >
        {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : icon}
        <span>{children}</span>
      </button>
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        title="Run with operator guidance"
        aria-label="Run with operator guidance"
        disabled={disabled || busy}
        aria-expanded={open}
        className={`inline-flex items-center px-1.5 rounded-r border ${palette} disabled:opacity-50 ${open ? 'bg-mc-accent/15' : ''}`}
      >
        <ChevronDown className="w-3.5 h-3.5" />
      </button>

      {open && (
        <>
          {/* Click-outside dismissal. */}
          <div
            className="fixed inset-0 z-40"
            aria-hidden
            onClick={() => setOpen(false)}
          />
          <div className="absolute top-full right-0 mt-1 w-80 z-50 bg-mc-bg-secondary border border-mc-border rounded-md shadow-lg p-3">
            <div className="flex items-start justify-between gap-2 mb-2">
              <span className="text-xs font-medium text-mc-text">
                {guidanceLabel ?? 'Add guidance'}
              </span>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="text-mc-text-secondary/70 hover:text-mc-text"
                aria-label="Close"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
            <textarea
              ref={taRef}
              value={text}
              onChange={e => setText(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  submit();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  setOpen(false);
                }
              }}
              rows={4}
              placeholder={guidancePlaceholder ?? 'What should the agent focus on?'}
              className="w-full px-2 py-1.5 rounded bg-mc-bg border border-mc-border text-xs text-mc-text outline-none focus:border-mc-accent/60 resize-y"
            />
            <div className="flex items-center justify-between gap-2 mt-2">
              <span className="text-[10px] text-mc-text-secondary/70">
                ⌘/Ctrl+Enter to submit · Esc to cancel
              </span>
              <button
                type="button"
                onClick={submit}
                disabled={!text.trim()}
                className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded bg-mc-accent text-white disabled:opacity-50"
              >
                <Send className="w-3 h-3" /> {guidanceCta ?? 'Run with guidance'}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
