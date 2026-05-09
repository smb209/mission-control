'use client';

import { useState, useEffect, useMemo } from 'react';
import { ChatWidget } from './ChatWidget';
import { CommandPalette, buildDefaultCommands } from './CommandPalette';

/**
 * ChatProvider — wraps the app to provide:
 * 1. (Optional) floating ChatWidget (bottom-right) — gated on
 *    workspace.show_chat_widget so it doesn't collide with the
 *    initiative-detail floating TOC FAB by default.
 * 2. Cmd+K CommandPalette (global)
 * 3. Keyboard shortcut handlers
 * 4. Slash-command bridge from chat input → palette
 *
 * The widget gate is read by fetching the current workspace fresh on
 * mount + when the operator switches workspaces (via the `mc.currentWorkspaceId`
 * localStorage key written by `WorkspaceProvider`). ChatProvider sits at
 * the root layout, above the (app)-route WorkspaceProvider, so we can't
 * use the React context here — localStorage + a polled refresh covers
 * cross-route navigation without dragging the provider lower.
 */
const STORAGE_KEY = 'mc.currentWorkspaceId';

function useShowChatWidget(): boolean {
  const [show, setShow] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let lastWorkspaceId: string | null = null;

    const refresh = async () => {
      try {
        const wsId =
          (typeof window !== 'undefined' && window.localStorage.getItem(STORAGE_KEY)) ||
          'default';
        if (wsId === lastWorkspaceId) return;
        lastWorkspaceId = wsId;
        const res = await fetch(`/api/workspaces/${encodeURIComponent(wsId)}`);
        if (!res.ok) {
          if (!cancelled) setShow(false);
          return;
        }
        const data = (await res.json()) as { show_chat_widget?: number | boolean | null };
        if (!cancelled) setShow(!!data?.show_chat_widget);
      } catch {
        if (!cancelled) setShow(false);
      }
    };

    refresh();

    // React to workspace switches (the WorkspaceProvider writes the
    // selection into localStorage; the `storage` event fires on other
    // tabs only, so we also poll lightly for same-tab changes).
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) refresh();
    };
    window.addEventListener('storage', onStorage);
    const interval = window.setInterval(refresh, 10_000);

    return () => {
      cancelled = true;
      window.removeEventListener('storage', onStorage);
      window.clearInterval(interval);
    };
  }, []);

  return show;
}

export function ChatProvider({ children }: { children: React.ReactNode }) {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteFilter, setPaletteFilter] = useState('');
  const [activeTaskId, setActiveTaskId] = useState<string | undefined>(undefined);
  const showChatWidget = useShowChatWidget();

  // Cmd+K to open command palette
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setPaletteFilter('');
        setPaletteOpen(prev => !prev);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Listen for slash-command events from chat inputs
  useEffect(() => {
    const handleSlashOpen = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.taskId) setActiveTaskId(detail.taskId);
      setPaletteFilter(detail?.filter || '');
      setPaletteOpen(true);
    };
    window.addEventListener('commandpalette:open', handleSlashOpen);
    return () => window.removeEventListener('commandpalette:open', handleSlashOpen);
  }, []);

  const commands = useMemo(() => buildDefaultCommands({
    selectedTaskId: activeTaskId,
    onToggleChat: () => {
      window.dispatchEvent(new CustomEvent('chat:toggle'));
    },
  }), [activeTaskId]);

  return (
    <>
      {children}
      {showChatWidget && <ChatWidget />}
      <CommandPalette
        isOpen={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        commands={commands}
        initialFilter={paletteFilter}
      />
    </>
  );
}
