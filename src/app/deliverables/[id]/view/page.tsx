'use client';

import { use, useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ArrowLeft, Download, ExternalLink, FileText } from 'lucide-react';
import type { TaskDeliverable } from '@/lib/types';

const MAX_INLINE_BYTES = 5 * 1024 * 1024; // 5 MB cap on the viewer — anything bigger should download

interface ViewState {
  meta?: TaskDeliverable;
  content?: string;
  error?: string;
}

export default function DeliverableViewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [state, setState] = useState<ViewState>({});

  useEffect(() => {
    document.title = 'Deliverable viewer';
    let cancelled = false;
    (async () => {
      try {
        const metaRes = await fetch(`/api/deliverables/${id}`);
        if (!metaRes.ok) {
          const err = await metaRes.json().catch(() => ({}));
          if (!cancelled) setState({ error: err.error || `Failed to load deliverable (${metaRes.status})` });
          return;
        }
        const meta = (await metaRes.json()) as TaskDeliverable;

        const rawRes = await fetch(`/api/deliverables/${id}/raw`);
        if (!rawRes.ok) {
          const err = await rawRes.json().catch(() => ({}));
          if (!cancelled) setState({ meta, error: err.error || `Failed to fetch file (${rawRes.status})` });
          return;
        }
        const lenHeader = rawRes.headers.get('Content-Length');
        if (lenHeader && Number(lenHeader) > MAX_INLINE_BYTES) {
          if (!cancelled)
            setState({
              meta,
              error: `File is ${(Number(lenHeader) / 1024 / 1024).toFixed(1)} MB — too large to render inline. Use the download link below.`,
            });
          return;
        }
        const text = await rawRes.text();
        if (!cancelled) {
          setState({ meta, content: text });
          if (meta.title) document.title = `${meta.title} — Deliverable viewer`;
        }
      } catch (err) {
        if (!cancelled) setState({ error: err instanceof Error ? err.message : 'Unexpected error' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  const meta = state.meta;
  const path = meta?.path;
  const looksMarkdown = !!path && /\.(md|markdown|mdx)$/i.test(path);
  const downloadHref = meta && meta.deliverable_type === 'file' ? `/api/deliverables/${id}/download` : null;

  return (
    <div className="min-h-screen bg-mc-bg text-mc-text">
      <header className="sticky top-0 z-10 border-b border-mc-border bg-mc-bg-secondary/95 backdrop-blur">
        <div className="max-w-4xl mx-auto px-4 py-3 flex items-center gap-3">
          <button
            onClick={() => {
              if (window.history.length > 1) window.history.back();
              else window.close();
            }}
            className="inline-flex items-center gap-1.5 px-2 py-1 text-sm text-mc-text-secondary hover:text-mc-text rounded-sm hover:bg-mc-bg-tertiary"
          >
            <ArrowLeft className="w-4 h-4" />
            Back
          </button>
          <div className="flex-1 min-w-0">
            <h1 className="text-sm font-medium text-mc-text truncate flex items-center gap-2">
              <FileText className="w-4 h-4 text-mc-accent shrink-0" />
              {meta?.title ?? 'Loading…'}
            </h1>
            {path && (
              <p className="text-xs text-mc-text-secondary font-mono truncate">{path}</p>
            )}
          </div>
          {downloadHref && (
            <a
              href={downloadHref}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-sm border border-mc-border hover:border-mc-accent hover:bg-mc-bg-tertiary"
            >
              <Download className="w-3.5 h-3.5" />
              Download
            </a>
          )}
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 py-6">
        {state.error && (
          <div className="p-4 rounded-md border border-red-500/30 bg-red-500/10 text-sm text-red-300">
            {state.error}
            {downloadHref && (
              <p className="mt-2">
                <a className="text-mc-accent hover:underline inline-flex items-center gap-1" href={downloadHref}>
                  <Download className="w-3.5 h-3.5" /> Download original
                </a>
              </p>
            )}
          </div>
        )}

        {!state.error && state.content !== undefined && looksMarkdown && (
          <article className="mc-md">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{state.content}</ReactMarkdown>
          </article>
        )}

        {!state.error && state.content !== undefined && !looksMarkdown && (
          <pre className="text-xs font-mono whitespace-pre-wrap break-words bg-mc-bg-secondary border border-mc-border rounded-md p-4">
            {state.content}
          </pre>
        )}

        {!state.error && state.content === undefined && (
          <div className="text-sm text-mc-text-secondary">Loading…</div>
        )}

        {!state.error && state.content !== undefined && !looksMarkdown && path && (
          <p className="mt-4 text-xs text-mc-text-secondary inline-flex items-center gap-1.5">
            <ExternalLink className="w-3.5 h-3.5" />
            Showing raw text. Markdown rendering activates for .md / .markdown / .mdx files.
          </p>
        )}
      </main>
    </div>
  );
}
