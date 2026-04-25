'use client';

/**
 * Composes the unified shell: left nav, top bar, main panel.
 *
 * Lives as its own client component (rather than inline in the layout) so
 * the route group's `layout.tsx` can stay a server component if it ever
 * needs to. Mobile drawer state lives here.
 */

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { AppNav } from './AppNav';
import { AppTopBar } from './AppTopBar';
import { WorkspaceProvider } from './workspace-context';

export function AppShell({ children }: { children: React.ReactNode }) {
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const pathname = usePathname();

  // Close the drawer whenever the route changes — the operator just tapped
  // a nav link, no point leaving the overlay up.
  useEffect(() => {
    setMobileNavOpen(false);
  }, [pathname]);

  return (
    <WorkspaceProvider>
      <div className="flex h-screen bg-mc-bg text-mc-text">
        <AppNav
          mobileOpen={mobileNavOpen}
          onCloseMobile={() => setMobileNavOpen(false)}
        />
        <div className="flex-1 flex flex-col min-w-0">
          <AppTopBar onToggleNav={() => setMobileNavOpen(true)} />
          <main className="flex-1 overflow-y-auto min-w-0">{children}</main>
        </div>
      </div>
    </WorkspaceProvider>
  );
}
