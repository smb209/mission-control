'use client';

import { useCompletionPercentage } from '@/hooks/useCompletionPercentage';

/**
 * Completion percentage bar — displays "X/Y done" with a visual progress
 * bar.  Reusable on initiative cards (tree rows) and detail pages.
 *
 * Props:
 *   - initiativeId: the initiative whose children to count
 *   - variant: "compact" (inline, no bar) or "full" (bar + label)
 *   - size: "sm" (tree row) or "md" (detail page)
 *   - className: additional Tailwind classes
 */

interface CompletionPercentageBarProps {
  initiativeId: string;
  /** Render style. "compact" shows just the label; "full" shows bar + label. */
  variant?: 'compact' | 'full';
  /** Visual size. "sm" for tree rows, "md" for detail pages. */
  size?: 'sm' | 'md';
  /** Extra Tailwind classes applied to the root element. */
  className?: string;
}

const VARIANT_STYLES: Record<'compact' | 'full', string> = {
  compact: '',
  full: 'flex items-center gap-2',
};

interface SizeStyle {
  barHeight: string;
  label: string;
  barWidth: string;
}

const SIZE_STYLES: Record<'sm' | 'md', SizeStyle> = {
  sm: {
    barHeight: 'h-1',
    label: 'text-[10px] text-mc-text-secondary',
    barWidth: 'w-16',
  },
  md: {
    barHeight: 'h-2',
    label: 'text-xs text-mc-text-secondary',
    barWidth: 'w-24',
  },
};

export function CompletionPercentageBar({
  initiativeId,
  variant = 'full',
  size = 'md',
  className = '',
}: CompletionPercentageBarProps) {
  const { done, total, percentage, label } = useCompletionPercentage(initiativeId);
  const barStyle = SIZE_STYLES[size];

  // Edge case: zero children → show "0/0" with an empty bar.
  const barWidthPercent = total === 0 ? 0 : percentage;

  return (
    <div className={`${VARIANT_STYLES[variant]} ${className}`}>
      {variant === 'full' && (
        <div
          className={`${barStyle.barWidth} ${barStyle.barHeight} bg-mc-bg-tertiary rounded-full overflow-hidden`}
        >
          <div
            className={`h-full rounded-full ${
              done === total && total > 0
                ? 'bg-green-500'
                : done > 0
                  ? 'bg-blue-500'
                  : 'bg-mc-text-secondary/30'
            }`}
            style={{ width: `${barWidthPercent}%` }}
          />
        </div>
      )}
      <span className={barStyle.label} title={`${done} of ${total} children completed`}>
        {label}
      </span>
    </div>
  );
}
