'use client';

import { useState } from 'react';
import Drawer from '@/components/Drawer';

interface Props {
  open: boolean;
  onClose: () => void;
  workspaceId: string;
  onCreated: () => void;
}

export function CreateTopicDrawer({ open, onClose, workspaceId, onCreated }: Props) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [tagsRaw, setTagsRaw] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setName(''); setDescription(''); setTagsRaw(''); setError(null);
  };
  const handleClose = () => {
    if (submitting) return;
    reset();
    onClose();
  };

  const submit = async () => {
    if (!name.trim()) {
      setError('Name is required.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const tags = tagsRaw.split(',').map(s => s.trim()).filter(Boolean);
      const res = await fetch('/api/topics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace_id: workspaceId, name, description, tags }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `Failed (${res.status})`);
      }
      reset();
      onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create topic');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Drawer
      open={open}
      title="Create topic"
      onClose={handleClose}
      footer={
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={handleClose}
            disabled={submitting}
            className="px-3 py-1.5 text-sm rounded-sm text-mc-text-secondary hover:bg-mc-bg-tertiary"
          >Cancel</button>
          <button
            type="button"
            onClick={submit}
            disabled={submitting || !name.trim()}
            className="px-3 py-1.5 text-sm rounded-sm bg-mc-accent text-mc-bg disabled:opacity-50 hover:opacity-90"
          >{submitting ? 'Creating…' : 'Create topic'}</button>
        </div>
      }
    >
      <div className="space-y-4">
        {error && (
          <div className="px-3 py-2 rounded-sm bg-red-900/20 border border-red-500/30 text-red-300 text-sm">
            {error}
          </div>
        )}
        <Field label="Name" required>
          <input
            type="text"
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="e.g. GLP-1 regulation"
            className="w-full px-2 py-1.5 bg-mc-bg border border-mc-border rounded-sm text-sm text-mc-text"
            autoFocus
          />
        </Field>
        <Field label="Description">
          <textarea
            value={description}
            onChange={e => setDescription(e.target.value)}
            placeholder="What's this topic about? Why does it matter?"
            rows={4}
            className="w-full px-2 py-1.5 bg-mc-bg border border-mc-border rounded-sm text-sm text-mc-text resize-y"
          />
        </Field>
        <Field label="Tags" hint="Comma-separated">
          <input
            type="text"
            value={tagsRaw}
            onChange={e => setTagsRaw(e.target.value)}
            placeholder="pharma, regulation"
            className="w-full px-2 py-1.5 bg-mc-bg border border-mc-border rounded-sm text-sm text-mc-text"
          />
        </Field>
      </div>
    </Drawer>
  );
}

function Field({ label, hint, required, children }: {
  label: string; hint?: string; required?: boolean; children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="text-xs text-mc-text-secondary mb-1 block">
        {label}{required && <span className="text-mc-accent ml-0.5">*</span>}
        {hint && <span className="text-mc-text-secondary/60 ml-2">{hint}</span>}
      </span>
      {children}
    </label>
  );
}
