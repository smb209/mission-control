/**
 * alert-shim — patches `window.alert` to show a non-blocking AlertDialog
 * instead of the native blocking dialog.
 *
 * The shim captures the original `alert`, replaces it on the global object,
 * and delegates to the module-level `showAlert` function exported by
 * AlertDialog (which routes through a dispatcher registered on mount).
 *
 * Usage:
 *   import '@/lib/alert-shim';  // side-effect import, installed early
 *   alert('Hello!');            // now triggers AlertDialog
 *
 * Because this is a side-effect import, it should be imported once at the
 * top of the root layout so it's active before any user interaction fires.
 */

// Capture the native alert before anyone else patches it.
// Guard for SSR safety — window may not exist during server-side rendering.
const _nativeAlert =
  typeof window !== 'undefined' ? window.alert.bind(window) : null;

let _active = false;

if (typeof window !== 'undefined') {
  window.alert = function (message: string): void {
    // Guard against rapid successive calls — only one alert at a time.
    if (_active) return;
    _active = true;

    try {
      const { showAlert } = require('@/components/AlertDialog') as {
        showAlert: (title: string, message?: string) => void;
      };
      showAlert(message, message);
    } catch {
      // Fallback: nothing has wired up yet; fall back to native alert.
      if (_nativeAlert) _nativeAlert(message);
      _active = false;
    }
  };
}

/** Called by AlertDialog when the user dismisses. Allows future alert() calls. */
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
