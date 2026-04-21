'use client';

import { useEffect, useState } from 'react';
import { ArrowUp, ArrowDown } from 'lucide-react';

/**
 * Two-arrow liveness indicator for an agent row. Up arrow = MC → agent
 * (last outbound message), down arrow = agent → MC (last reply). Each
 * arrow independently fades from green → amber → red → gray as its
 * timestamp ages past 60s. When no timestamp exists yet the arrow is
 * rendered dimmed gray so the slot doesn't shift when the first ping
 * lands.
 */

const FADE_TICK_MS = 1_000;

// Buckets chosen to match the operator's mental model of "recent / active /
// cooling off / stale". Thresholds are inclusive upper bounds in seconds.
interface Bucket { maxSeconds: number; className: string; label: string }
const BUCKETS: Bucket[] = [
  { maxSeconds: 5,  className: 'text-green-400',        label: 'just now' },
  { maxSeconds: 20, className: 'text-green-500/70',     label: 'recent' },
  { maxSeconds: 40, className: 'text-amber-400',        label: 'cooling' },
  { maxSeconds: 60, className: 'text-red-400',          label: 'stale' },
];
const INACTIVE_CLASS = 'text-mc-text-secondary/30';

function ageSeconds(iso: string | undefined, now: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.max(0, (now - t) / 1000);
}

function classify(age: number | null): { className: string; title: string } {
  if (age == null) return { className: INACTIVE_CLASS, title: 'no activity yet' };
  for (const bucket of BUCKETS) {
    if (age <= bucket.maxSeconds) {
      return { className: bucket.className, title: `${bucket.label} (${Math.floor(age)}s ago)` };
    }
  }
  return { className: INACTIVE_CLASS, title: `idle (${Math.floor(age)}s ago)` };
}

interface AgentPingIndicatorProps {
  sentAt?: string;
  receivedAt?: string;
}

export function AgentPingIndicator({ sentAt, receivedAt }: AgentPingIndicatorProps) {
  const [now, setNow] = useState(() => Date.now());

  // Only keep the ticker alive while at least one arrow is still within the
  // fade window — otherwise the component is visually static and the
  // interval is wasted work.
  const stillFading = (() => {
    const a = ageSeconds(sentAt, now);
    const b = ageSeconds(receivedAt, now);
    if (a != null && a <= 60) return true;
    if (b != null && b <= 60) return true;
    return false;
  })();

  useEffect(() => {
    if (!stillFading) return;
    const id = setInterval(() => setNow(Date.now()), FADE_TICK_MS);
    return () => clearInterval(id);
  }, [stillFading]);

  const sent = classify(ageSeconds(sentAt, now));
  const received = classify(ageSeconds(receivedAt, now));

  return (
    <div className="flex flex-col items-center gap-0 leading-none" aria-label="Agent message activity">
      <span title={`Sent: ${sent.title}`} className="flex">
        <ArrowUp className={`w-3 h-3 transition-colors duration-500 ${sent.className}`} aria-label="last sent" />
      </span>
      <span title={`Received: ${received.title}`} className="flex">
        <ArrowDown className={`w-3 h-3 transition-colors duration-500 ${received.className}`} aria-label="last received" />
      </span>
    </div>
  );
}
