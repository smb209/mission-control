'use client';

/**
 * Create-workspace form rendered inside the standard right-side Drawer.
 *
 * Used from two places:
 *   1. The "+ New Workspace" entry inside the workspace switcher dropdown
 *      in the left nav.
 *   2. The empty-state on the home redirect when no workspaces exist.
 *
 * On success, the new workspace becomes the active one (via the shell's
 * workspace context) and the operator is routed to its task board.
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Drawer from '@/components/Drawer';
import { useSetCurrentWorkspaceId } from './workspace-context';
import type { Workspace } from '@/lib/types';

const ICON_PRESETS = ['📁', '💼', '🏢', '🚀', '💡', '🎯', '📊', '🔧', '🌟', '🏠'];

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export interface CreateWorkspaceDrawerProps {
  open: boolean;
  onClose: () => void;
  /** Optional callback fired with the new workspace after a successful create. */
  onCreated?: (workspace: Workspace) => void;
}

export function CreateWorkspaceDrawer({ open, onClose, onCreated }: CreateWorkspaceDrawerProps) {
  const router = useRouter();
  const setCurrentWorkspaceId = useSetCurrentWorkspaceId();

  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugDirty, setSlugDirty] = useState(false);
  const [icon, setIcon] = useState('📁');
  const [description, setDescription] = useState('');
  const [cloneAgentsFrom, setCloneAgentsFrom] = useState<string>('');
  const [workspaces, setWorkspaces] = useState<Array<{ id: string; name: string; icon?: string | null }>>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset state every time the drawer is opened.
  useEffect(() => {
    if (!open) return;
    setName('');
    setSlug('');
    setSlugDirty(false);
    setIcon('📁');
    setDescription('');
    setCloneAgentsFrom('');
    setSubmitting(false);
    setError(null);
  }, [open]);

  // Pre-load workspace list for the "copy agents from" dropdown when the
  // drawer opens. Cheap (one /api/workspaces call) and avoids a flicker.
  useEffect(() => {
    if (!open) return;
    (async () => {
      try {
        const res = await fetch('/api/workspaces');
        if (!res.ok) return;
        const list = await res.json();
        setWorkspaces(Array.isArray(list) ? list : []);
      } catch { /* non-fatal */ }
    })();
  }, [open]);

  // Keep slug in sync with name unless the operator has explicitly edited it.
  useEffect(() => {
    if (!slugDirty) setSlug(slugify(name));
  }, [name, slugDirty]);

  const canSubmit = name.trim().length > 0 && !submitting;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;

    setSubmitting(true);
    setError(null);

    try {
      const res = await fetch('/api/workspaces', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          // The POST handler currently re-derives slug from name; we send
          // both to be future-proof if it grows to honor an explicit slug.
          slug: slug.trim() || undefined,
          icon,
          description: description.trim() || undefined,
          clone_agents_from: cloneAgentsFrom || undefined,
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || `Failed to create workspace (${res.status})`);
        setSubmitting(false);
        return;
      }

      const workspace = (await res.json()) as Workspace;
      setCurrentWorkspaceId(workspace.id);
      onCreated?.(workspace);
      onClose();
      router.push(`/workspace/${workspace.slug}`);
    } catch (err) {
      console.error('Create workspace failed:', err);
      setError(err instanceof Error ? err.message : 'Failed to create workspace');
      setSubmitting(false);
    }
  }

  return (
    <Drawer
      open={open}
      title="New workspace"
      onClose={onClose}
      footer={
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-sm rounded-sm border border-mc-border text-mc-text-secondary hover:bg-mc-bg-tertiary"
          >
            Cancel
          </button>
          <button
            type="submit"
            form="create-workspace-form"
            disabled={!canSubmit}
            className="px-3 py-1.5 text-sm rounded-sm bg-mc-accent text-mc-bg font-medium hover:bg-mc-accent/90 disabled:opacity-50"
          >
            {submitting ? 'Creating…' : 'Create workspace'}
          </button>
        </div>
      }
    >
      <form id="create-workspace-form" onSubmit={handleSubmit} className="space-y-4">
        {/* Icon */}
        <div>
          <label className="block text-xs uppercase tracking-wider text-mc-text-secondary mb-2">Icon</label>
          <div className="flex flex-wrap gap-2 mb-2">
            {ICON_PRESETS.map(i => (
              <button
                key={i}
                type="button"
                onClick={() => setIcon(i)}
                className={`w-9 h-9 rounded-sm text-lg flex items-center justify-center transition-colors ${
                  icon === i
                    ? 'bg-mc-accent/20 border-2 border-mc-accent'
                    : 'bg-mc-bg border border-mc-border hover:border-mc-accent/50'
                }`}
                aria-pressed={icon === i}
              >
                {i}
              </button>
            ))}
          </div>
          <input
            type="text"
            value={icon}
            onChange={e => setIcon(e.target.value.slice(0, 4) || '📁')}
            className="w-24 px-2 py-1 bg-mc-bg border border-mc-border rounded-sm text-sm text-mc-text focus:border-mc-accent focus:outline-hidden"
            aria-label="Custom icon"
          />
        </div>

        {/* Name */}
        <div>
          <label htmlFor="ws-name" className="block text-xs uppercase tracking-wider text-mc-text-secondary mb-1">
            Name <span className="text-mc-accent-red">*</span>
          </label>
          <input
            id="ws-name"
            type="text"
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="e.g., Acme Corp"
            required
            autoFocus
            className="w-full px-3 py-2 bg-mc-bg border border-mc-border rounded-sm text-sm text-mc-text focus:border-mc-accent focus:outline-hidden"
          />
        </div>

        {/* Slug */}
        <div>
          <label htmlFor="ws-slug" className="block text-xs uppercase tracking-wider text-mc-text-secondary mb-1">
            URL slug
          </label>
          <input
            id="ws-slug"
            type="text"
            value={slug}
            onChange={e => {
              setSlug(slugify(e.target.value));
              setSlugDirty(true);
            }}
            placeholder="auto-generated"
            className="w-full px-3 py-2 bg-mc-bg border border-mc-border rounded-sm text-sm text-mc-text font-mono focus:border-mc-accent focus:outline-hidden"
          />
          <p className="text-xs text-mc-text-secondary mt-1">
            /workspace/<span className="font-mono">{slug || 'your-slug'}</span>
          </p>
        </div>

        {/* Description */}
        <div>
          <label htmlFor="ws-description" className="block text-xs uppercase tracking-wider text-mc-text-secondary mb-1">
            Description <span className="text-mc-text-secondary/70">(optional)</span>
          </label>
          <textarea
            id="ws-description"
            value={description}
            onChange={e => setDescription(e.target.value)}
            rows={3}
            placeholder="What lives in this workspace?"
            className="w-full px-3 py-2 bg-mc-bg border border-mc-border rounded-sm text-sm text-mc-text focus:border-mc-accent focus:outline-hidden resize-none"
          />
        </div>

        {/* Agents */}
        <div>
          <label htmlFor="ws-clone-agents" className="block text-xs uppercase tracking-wider text-mc-text-secondary mb-1">
            Agents
          </label>
          <select
            id="ws-clone-agents"
            value={cloneAgentsFrom}
            onChange={e => setCloneAgentsFrom(e.target.value)}
            className="w-full px-3 py-2 bg-mc-bg border border-mc-border rounded-sm text-sm text-mc-text focus:border-mc-accent focus:outline-hidden"
          >
            <option value="">Default (placeholder PM only)</option>
            {workspaces.map(w => (
              <option key={w.id} value={w.id}>
                Copy from: {w.icon ? `${w.icon} ` : ''}{w.name}
              </option>
            ))}
          </select>
          <p className="text-xs text-mc-text-secondary mt-1">
            Copies every active agent from the chosen workspace, preserving roles
            and gateway links. Pick "Default" if you want this workspace to start
            empty (just the PM placeholder).
          </p>
        </div>

        {error && (
          <div className="p-3 rounded-sm bg-mc-accent-red/10 border border-mc-accent-red/30 text-sm text-mc-accent-red">
            {error}
          </div>
        )}
      </form>
    </Drawer>
  );
}
