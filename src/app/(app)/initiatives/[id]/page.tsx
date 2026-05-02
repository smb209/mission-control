'use client';

/**
 * Standalone /initiatives/[id] route — a thin shell that delegates to
 * the shared <InitiativeDetailView variant="full"> component. The
 * 1300-line implementation that used to live here moved to
 * src/components/InitiativeDetailView.tsx so the master-detail pane on
 * /initiatives can host the same UI without duplicating it.
 *
 * Kept as a route so:
 *   - Deep links (operator bookmarks, agent-emitted URLs in chat) keep
 *     resolving.
 *   - "Open in focus mode" gives the operator a no-rails / full-width
 *     reading layout when the master-detail rail isn't useful.
 */

import { use } from 'react';
import { useRouter } from 'next/navigation';
import { InitiativeDetailView } from '@/components/InitiativeDetailView';

export default function InitiativeDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  return (
    <InitiativeDetailView
      initiativeId={id}
      variant="full"
      onDeleted={() => router.push('/initiatives')}
    />
  );
}
