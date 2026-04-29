'use client';

/**
 * AlertDialog — lightweight non-blocking alert modal.
 *
 * Mirrors ConfirmDialog's visual style exactly: fixed inset-0 z-50 backdrop,
 * centered card, max-w-md, rounded-lg, same border/background/text color tokens.
 * Single "Dismiss" button in footer.
 *
 * Uses a module-level dispatcher so the global shim (alert-shim) can trigger
 * it from anywhere, even before React mounts — just like how Toast works.
 */

import { useEffect, useRef, useState } from 'react';
import { resolveAlert } from '@/lib/alert-shim';

export interface AlertDialogProps {
  /** Set by the dialog itself; not meant for external consumption. */
  open?: boolean;
  title?: string;
  message?: string;
}

// ── Global dispatcher (module-level singleton) ────────────────────────
// Pattern copied from Toast.tsx: a mutable ref that AlertDialog sets on mount
// and the shim reads at call time.

interface AlertDispatcher {
  show(title: string, message: string): void;
}

let _dispatcher: AlertDispatcher | null = null;

/** Called by the global alert() shim to show an alert. */
export function showAlert(title: string, message?: string): void {
  if (_dispatcher) {
    _dispatcher.show(title, message ?? '');
  }
  // If no dispatcher yet (called before React mounted), silently drop.
  // The shim is imported in layout.tsx so this shouldn't happen.
}

/** Register the dispatcher with the module-level state. */
export function setAlertDispatcher(fn: AlertDispatcher | null): void {
  _dispatcher = fn;
}

// ── Component ─────────────────────────────────────────────────────────

export function AlertDialog({ open: _controlledOpen }: AlertDialogProps = {}) {
  const [state, setState] = useState<{
    open: boolean;
    title: string;
    message: string;
  }>({ open: false, title: '', message: '' });

  const dismissRef = useRef<HTMLButtonElement | null>(null);

  // Register ourselves as the dispatcher on mount.
  useEffect(() => {
    setAlertDispatcher({
      show: (title: string, message: string) => {
        setState({ open: true, title, message });
      },
    });
    return () => {
      setAlertDispatcher(null);
    };
  }, []);

  // Focus the dismiss button on open + close on Escape.
  useEffect(() => {
    if (!state.open) return;
    dismissRef.current?.focus();
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') handleDismiss();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [state.open]);

  const handleDismiss = () => {
    setState({ open: false, title: '', message: '' });
    // Allow future alert() calls.
    resolveAlert();
  };

  if (!state.open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="alert-dialog-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={(e) => {
        // Click outside the panel dismisses.
        if (e.target === e.currentTarget) handleDismiss();
      }}
    >
      <div className="w-full max-w-md rounded-lg border border-mc-border bg-mc-bg p-5 shadow-2xl">
        <div className="flex items-start gap-3">
          <div className="flex-1">
            <h2 id="alert-dialog-title" className="text-base font-semibold text-mc-text">
              {state.title}
            </h2>
            <div className="mt-2 text-sm text-mc-text-secondary">{state.message}</div>
          </div>
        </div>
        <div className="mt-5 flex justify-end">
          <button
            ref={dismissRef}
            type="button"
            onClick={handleDismiss}
            className="px-3 py-1.5 rounded border border-mc-border text-sm text-mc-text-secondary hover:bg-mc-bg-secondary"
          >
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
}
