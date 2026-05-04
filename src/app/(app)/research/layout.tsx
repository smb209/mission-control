/**
 * Persistent research shell. The left rail (topics + recent briefs)
 * stays mounted while the operator navigates between the hub, topic
 * detail, and brief detail pages — so the rail acts as actual
 * navigation rather than a one-page accent.
 */

import type { ReactNode } from 'react';
import { ResearchSideRail } from '@/components/research/ResearchSideRail';

export default function ResearchLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full">
      <ResearchSideRail />
      <div className="flex-1 overflow-y-auto">{children}</div>
    </div>
  );
}
