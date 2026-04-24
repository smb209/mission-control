'use client';

import { useEffect, useRef, useState } from 'react';
import { FileText, Link as LinkIcon, Package, Search, X } from 'lucide-react';

export interface PickerDeliverable {
  id: string;
  task_id: string;
  task_title: string;
  deliverable_type: 'file' | 'url' | 'artifact';
  title: string;
  path: string | null;
  description: string | null;
  created_at: string;
}

interface DeliverablePickerProps {
  workspaceId: string;
  excludeTaskId?: string;
  onPick: (d: PickerDeliverable) => void;
  onClose: () => void;
}

export function DeliverablePicker({ workspaceId, excludeTaskId, onPick, onClose }: DeliverablePickerProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PickerDeliverable[]>([]);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Autofocus the search input when the picker mounts so the keyboard-first
  // flow works without an extra click.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    // Debounce to avoid a query on every keystroke.
    const handle = setTimeout(async () => {
      setLoading(true);
      try {
        const params = new URLSearchParams({ workspace_id: workspaceId });
        if (query.trim()) params.set('q', query.trim());
        if (excludeTaskId) params.set('exclude_task_id', excludeTaskId);
        const res = await fetch(`/api/deliverables?${params.toString()}`);
        if (res.ok) {
          const data = await res.json();
          setResults(data.results || []);
        }
      } catch (err) {
        console.error('[DeliverablePicker] search failed:', err);
      } finally {
        setLoading(false);
      }
    }, 200);
    return () => clearTimeout(handle);
  }, [query, workspaceId, excludeTaskId]);

  const icon = (type: string) => {
    if (type === 'url') return <LinkIcon className="w-4 h-4" />;
    if (type === 'artifact') return <Package className="w-4 h-4" />;
    return <FileText className="w-4 h-4" />;
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[60] p-4" onClick={onClose}>
      <div
        className="bg-mc-bg-secondary border border-mc-border rounded-lg w-full max-w-lg max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-3 border-b border-mc-border">
          <h3 className="text-sm font-medium">Reference a prior deliverable</h3>
          <button onClick={onClose} className="p-1 hover:bg-mc-bg-tertiary rounded-sm">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="p-3 border-b border-mc-border">
          <div className="relative">
            <Search className="w-4 h-4 absolute left-2.5 top-2.5 text-mc-text-secondary pointer-events-none" />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by title, description, or task name..."
              className="w-full bg-mc-bg border border-mc-border rounded-sm pl-8 pr-3 py-2 text-sm focus:outline-hidden focus:border-mc-accent"
            />
          </div>
        </div>
        <div className="flex-1 overflow-y-auto">
          {loading && results.length === 0 ? (
            <div className="p-4 text-sm text-mc-text-secondary">Searching…</div>
          ) : results.length === 0 ? (
            <div className="p-4 text-sm text-mc-text-secondary">
              {query ? 'No deliverables match that search.' : 'No prior deliverables in this workspace yet.'}
            </div>
          ) : (
            <ul className="divide-y divide-mc-border">
              {results.map((d) => (
                <li key={d.id}>
                  <button
                    type="button"
                    onClick={() => onPick(d)}
                    className="w-full flex items-start gap-3 p-3 text-left hover:bg-mc-bg-tertiary transition-colors"
                  >
                    <span className="shrink-0 mt-0.5 text-mc-accent">{icon(d.deliverable_type)}</span>
                    <span className="flex-1 min-w-0">
                      <span className="block text-sm font-medium text-mc-text truncate">{d.title}</span>
                      <span className="block text-xs text-mc-text-secondary truncate">
                        From: {d.task_title}
                      </span>
                      {d.path && (
                        <span className="block text-xs text-mc-text-secondary font-mono truncate">
                          {d.path}
                        </span>
                      )}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
