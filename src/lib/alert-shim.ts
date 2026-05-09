/**
 * alert-shim — patches `window.alert` to route messages based on content.
 *
 * Heuristic routing:
 *   - Messages containing "Failed", "error", or "Error" → AlertDialog (blocking)
 *   - All other messages → Toast (non-blocking informational)
 *
 * This shim is a temporary safety net. Once all callers use explicit
 * showAlertDialog / showToast, this shim can be removed entirely.
 *
 * Usage:
 *   import '@/lib/alert-shim';  // side-effect import, installed early
 *   alert('Hello!');            // now routes per heuristic
 *
 * Because this is a side-effect import, it should be imported once at the
 * top of the root layout so it's active before any user interaction fires.
 */

import { showAlert } from '@/components/AlertDialog';
import { showToast } from '@/components/Toast';

// Capture the native alert before anyone else patches it.
const _nativeAlert =
  typeof window !== 'undefined' ? window.alert.bind(window) : null;

let _active = false;

/** Determine whether a message should go to AlertDialog (blocking) or Toast. */
function shouldShowAlertDialog(message: string): boolean {
  const lower = message.toLowerCase();
  return /failed|error/.test(lower);
}

if (typeof window !== 'undefined') {
  window.alert = function (message: string): void {
    // Guard against rapid successive calls — only one alert at a time.
    if (_active) return;
    _active = true;

    try {
      if (shouldShowAlertDialog(message)) {
        showAlert(message, message);
      } else {
        showToast({ type: 'info' as const, title: message });
      }
    } catch {
      // Fallback: nothing has wired up yet; fall back to native alert.
      if (_nativeAlert) _nativeAlert(message);
      _active = false;
    }
  };
}

/** Called when the user dismisses an AlertDialog. Allows future alert() calls. */
export function resolveAlert(): void {
  _active = false;
}

/** Restore the original window.alert (for testing / teardown). */
export function restoreNativeAlert(): void {
  if (typeof window !== 'undefined' && _nativeAlert) {
    window.alert = _nativeAlert;
  }
  _active = false;
}
