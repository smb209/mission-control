/**
 * Shared layout for all "main" Mission Control pages — the unified
 * navigation shell modeled on standard SaaS dashboards (left nav with
 * sections, top bar with status indicators, main panel for content).
 *
 * The route group `(app)` does NOT change URLs. Pages move into here
 * purely to inherit the shell. Pages kept outside the group:
 *   - /api-docs           (full-page Scalar)
 *   - /debug, /debug/mcp  (debugging surfaces, intentionally chrome-free)
 *   - /deliverables/[id]/view (markdown viewer, embedded surface)
 */

import { AppShell } from '@/components/shell/AppShell';

export default function AppGroupLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <AppShell>{children}</AppShell>;
}
