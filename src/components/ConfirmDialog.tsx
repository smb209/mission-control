'use client';

/**
 * Lightweight confirmation modal — drop-in replacement for `window.confirm()`.
 *
 * Native `confirm()` blocks the JS event loop and can't be driven by
 * preview/automation tooling, which surfaced as a §1.7 finding while
 * walking PREVIEW_TEST_FLOW.md (`Reset all sessions`).
 *
 * Usage (controlled):
 *
 *   const [confirm, setConfirm] = useState<null | (() => void)>(null);
 *   …
 *   <ConfirmDialog
 *     open={confirm !== null}
 *     title="Reset ALL agent sessions?"
 *     body={<p>This will… </p>}
 *     confirmLabel="Reset"
 *     destructive
 *     onConfirm={() => { confirm?.(); setConfirm(null); }}
 *     onCancel={() => setConfirm(null)}
 *   />
 *
 * The component renders only when `open` is true, traps focus on the
 * primary button, and returns the user's choice via the two callbacks.
 */

import { useEffect, useRef } from 'react';
import { AlertTriangle } from 'lucide-react';

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  body: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Style the confirm button as destructive (red). */
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  destructive = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const confirmRef = useRef<HTMLButtonElement | null>(null);

  // Focus the primary button on open + close on Escape.
  useEffect(() => {
    if (!open) return;
    confirmRef.current?.focus();
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-dialog-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={(e) => {
        // Click outside the panel cancels — same affordance as window.confirm cancel.
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="w-full max-w-md rounded-lg border border-mc-border bg-mc-bg p-5 shadow-2xl">
        <div className="flex items-start gap-3">
          {destructive && <AlertTriangle className="mt-1 h-5 w-5 shrink-0 text-amber-400" aria-hidden="true" />}
          <div className="flex-1">
            <h2 id="confirm-dialog-title" className="text-base font-semibold text-mc-text">
              {title}
            </h2>
            <div className="mt-2 text-sm text-mc-text-secondary">{body}</div>
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="px-3 py-1.5 rounded border border-mc-border text-sm text-mc-text-secondary hover:bg-mc-bg-secondary"
          >
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={onConfirm}
            className={
              'px-3 py-1.5 rounded text-sm font-medium ' +
              (destructive
                ? 'bg-red-500 text-white hover:bg-red-600'
                : 'bg-mc-accent text-white hover:bg-mc-accent/90')
            }
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
