'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Drawer from '@/components/Drawer';

interface TopicOption { id: string; name: string }

interface Props {
  open: boolean;
  onClose: () => void;
  workspaceId: string;
  topics: TopicOption[];
  defaultTopicId: string | null;
  /**
   * When set, the dispatched brief is scoped to this initiative
   * (auto-note on completion, etc.). Used by InitiativeDetailView's
   * Research section.
   */
  initiativeId?: string;
  /** Called after the brief is created + dispatched. */
  onLaunched: (briefId: string) => void;
}

export function RunBriefDrawer({
  open, onClose, workspaceId, topics, defaultTopicId, initiativeId, onLaunched,
}: Props) {
  const router = useRouter();
  const [topicId, setTopicId] = useState<string>(defaultTopicId ?? '');
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) setTopicId(defaultTopicId ?? '');
  }, [open, defaultTopicId]);

  const reset = () => {
    setTitle(''); setPrompt(''); setError(null);
    setTopicId(defaultTopicId ?? '');
  };
  const handleClose = () => {
    if (submitting) return;
    reset();
    onClose();
  };

  const submit = async () => {
    if (!title.trim() || !prompt.trim()) {
      setError('Title and prompt are required.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const createRes = await fetch('/api/briefs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspace_id: workspaceId,
          template: 'general_brief',
          title,
          prompt,
          topic_id: topicId || null,
          initiative_id: initiativeId ?? null,
        }),
      });
      if (!createRes.ok) {
        const body = await createRes.json().catch(() => ({}));
        throw new Error(body.error ?? `Create failed (${createRes.status})`);
      }
      const { brief } = await createRes.json();

      const runRes = await fetch(`/api/briefs/${brief.id}/run`, { method: 'POST' });
      if (!runRes.ok && runRes.status !== 202) {
        const body = await runRes.json().catch(() => ({}));
        throw new Error(body.error ?? `Run failed (${runRes.status})`);
      }

      reset();
      onLaunched(brief.id);
      router.push(`/research/briefs/${brief.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to run brief');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Drawer
      open={open}
      title="Run a brief"
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
            disabled={submitting || !title.trim() || !prompt.trim()}
            className="px-3 py-1.5 text-sm rounded-sm bg-mc-accent text-mc-bg disabled:opacity-50 hover:opacity-90"
          >{submitting ? 'Dispatching…' : 'Dispatch'}</button>
        </div>
      }
    >
      <div className="space-y-4">
        {error && (
          <div className="px-3 py-2 rounded-sm bg-red-900/20 border border-red-500/30 text-red-300 text-sm">
            {error}
          </div>
        )}
        <Field label="Template">
          <select
            value="general_brief"
            disabled
            className="w-full px-2 py-1.5 bg-mc-bg border border-mc-border rounded-sm text-sm text-mc-text"
          >
            <option value="general_brief">General brief</option>
          </select>
          <span className="text-[11px] text-mc-text-secondary/60 mt-1 block">More templates ship in phase 3.</span>
        </Field>
        <Field label="Topic" hint="Optional">
          <select
            value={topicId}
            onChange={e => setTopicId(e.target.value)}
            className="w-full px-2 py-1.5 bg-mc-bg border border-mc-border rounded-sm text-sm text-mc-text"
          >
            <option value="">— No topic —</option>
            {topics.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </Field>
        <Field label="Title" required>
          <input
            type="text"
            value={title}
            onChange={e => setTitle(e.target.value)}
            placeholder="What is the brief about? (one line)"
            className="w-full px-2 py-1.5 bg-mc-bg border border-mc-border rounded-sm text-sm text-mc-text"
            autoFocus
          />
        </Field>
        <Field label="Prompt" required hint="Sent verbatim to the researcher persona alongside template instructions and topic context (if any).">
          <textarea
            value={prompt}
            onChange={e => setPrompt(e.target.value)}
            placeholder="Be specific about scope, depth, and what would make this useful."
            rows={8}
            className="w-full px-2 py-1.5 bg-mc-bg border border-mc-border rounded-sm text-sm text-mc-text resize-y"
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
