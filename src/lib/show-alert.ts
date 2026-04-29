'use client';

/**
 * showAlertDialog — importable drop-in replacement for window.alert().
 *
 * Call this from anywhere inside a React component tree (event handlers,
 * hooks, etc.) to show the non-blocking AlertDialog instead of the native
 * blocking dialog.
 */

import { showAlert } from '@/components/AlertDialog';

export function showAlertDialog(title: string, message?: string): void {
  showAlert(title, message);
}
