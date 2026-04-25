'use client';

import dynamic from 'next/dynamic';

// Pull the heavy timeline shell as a client-only chunk. SSR'ing the SVG
// canvas isn't useful — it depends on viewport width and localStorage zoom
// preference — and keeping it dynamic avoids hydration churn.
const RoadmapTimeline = dynamic(
  () => import('@/components/roadmap/RoadmapTimeline').then(m => m.RoadmapTimeline),
  { ssr: false },
);

export default function RoadmapPage() {
  return <RoadmapTimeline />;
}
