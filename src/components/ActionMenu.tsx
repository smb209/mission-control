'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { MoreVertical } from 'lucide-react';

export interface ActionMenuItem {
  label: string;
  icon?: React.ReactNode;
  onClick: () => void;
  destructive?: boolean;
  disabled?: boolean;
  /** Optional title for hover tooltip. */
  title?: string;
}

/**
 * Lightweight accessible dropdown menu triggered by a `⋮` button.
 *
 * - Opens on click or Enter/Space.
 * - Arrow up/down moves between items, Enter activates, Esc closes.
 * - Focus returns to the trigger when the menu closes.
 * - Closes on outside click.
 *
 * No portal — the menu is positioned absolutely relative to the trigger,
 * which is fine for the table-row use case in `/initiatives`.
 */
export default function ActionMenu({
  items,
  ariaLabel = 'Actions',
}: {
  items: ActionMenuItem[];
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const close = useCallback((restoreFocus = true) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  // Outside-click close.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!menuRef.current || !triggerRef.current) return;
      const target = e.target as Node;
      if (!menuRef.current.contains(target) && !triggerRef.current.contains(target)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  // Focus active item when active index changes.
  useEffect(() => {
    if (!open) return;
    itemRefs.current[activeIndex]?.focus();
  }, [open, activeIndex]);

  const enabledItems = items.filter(i => !i.disabled);

  const onTriggerKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const firstEnabled = items.findIndex(i => !i.disabled);
      setActiveIndex(firstEnabled >= 0 ? firstEnabled : 0);
      setOpen(true);
    }
  };

  const onMenuKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      // Move to next enabled item, wrapping.
      let next = activeIndex;
      for (let i = 0; i < items.length; i++) {
        next = (next + 1) % items.length;
        if (!items[next].disabled) break;
      }
      setActiveIndex(next);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      let next = activeIndex;
      for (let i = 0; i < items.length; i++) {
        next = (next - 1 + items.length) % items.length;
        if (!items[next].disabled) break;
      }
      setActiveIndex(next);
    } else if (e.key === 'Home') {
      e.preventDefault();
      const first = items.findIndex(i => !i.disabled);
      if (first >= 0) setActiveIndex(first);
    } else if (e.key === 'End') {
      e.preventDefault();
      for (let i = items.length - 1; i >= 0; i--) {
        if (!items[i].disabled) {
          setActiveIndex(i);
          break;
        }
      }
    } else if (e.key === 'Tab') {
      // Tab closes the menu so focus can move on.
      setOpen(false);
    }
  };

  if (enabledItems.length === 0) return null;

  return (
    <div className="relative inline-block">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => setOpen(o => !o)}
        onKeyDown={onTriggerKey}
        className="p-1.5 rounded hover:bg-mc-bg text-mc-text-secondary hover:text-mc-text"
      >
        <MoreVertical className="w-4 h-4" />
      </button>

      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label={ariaLabel}
          onKeyDown={onMenuKey}
          className="absolute right-0 top-full mt-1 z-30 min-w-[180px] rounded-lg border border-mc-border bg-mc-bg-secondary shadow-xl py-1"
        >
          {items.map((item, idx) => (
            <button
              key={`${item.label}-${idx}`}
              ref={el => {
                itemRefs.current[idx] = el;
              }}
              role="menuitem"
              type="button"
              tabIndex={idx === activeIndex ? 0 : -1}
              disabled={item.disabled}
              title={item.title}
              onClick={() => {
                if (item.disabled) return;
                item.onClick();
                close(false);
              }}
              className={`w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left ${
                item.disabled
                  ? 'text-mc-text-secondary/40 cursor-not-allowed'
                  : item.destructive
                    ? 'text-red-400 hover:bg-red-500/10 focus:bg-red-500/10'
                    : 'text-mc-text hover:bg-mc-bg focus:bg-mc-bg'
              } focus:outline-none`}
            >
              {item.icon && <span className="w-4 h-4 flex items-center justify-center">{item.icon}</span>}
              <span className="flex-1">{item.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
