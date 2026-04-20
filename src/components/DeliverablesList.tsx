/**
 * DeliverablesList Component
 * Displays deliverables (files, URLs, artifacts) for a task
 */

'use client';

import { useEffect, useState, useCallback } from 'react';
import { FileText, Link as LinkIcon, Package, ExternalLink, Eye, Download, Archive } from 'lucide-react';
import { debug } from '@/lib/debug';
import type { TaskDeliverable } from '@/lib/types';

interface DeliverablesListProps {
  taskId: string;
}

export function DeliverablesList({ taskId }: DeliverablesListProps) {
  const [deliverables, setDeliverables] = useState<TaskDeliverable[]>([]);
  const [loading, setLoading] = useState(true);

  const loadDeliverables = useCallback(async () => {
    try {
      const res = await fetch(`/api/tasks/${taskId}/deliverables`);
      if (res.ok) {
        const data = await res.json();
        setDeliverables(data);
      }
    } catch (error) {
      console.error('Failed to load deliverables:', error);
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  useEffect(() => {
    loadDeliverables();
  }, [loadDeliverables]);

  const getDeliverableIcon = (type: string) => {
    switch (type) {
      case 'file':
        return <FileText className="w-5 h-5" />;
      case 'url':
        return <LinkIcon className="w-5 h-5" />;
      case 'artifact':
        return <Package className="w-5 h-5" />;
      default:
        return <FileText className="w-5 h-5" />;
    }
  };

  const handleOpen = async (deliverable: TaskDeliverable) => {
    // URLs open directly in new tab
    if (deliverable.deliverable_type === 'url' && deliverable.path) {
      window.open(deliverable.path, '_blank');
      return;
    }

    // Files - try to open in Finder
    if (deliverable.path) {
      try {
        debug.file('Opening file in Finder', { path: deliverable.path });
        const res = await fetch('/api/files/reveal', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filePath: deliverable.path }),
        });

        if (res.ok) {
          debug.file('Opened in Finder successfully');
          return;
        }

        const error = await res.json();
        debug.file('Failed to open', error);

        if (res.status === 404) {
          alert(`File not found:\n${deliverable.path}\n\nThe file may have been moved or deleted.`);
        } else if (res.status === 403) {
          alert(`Cannot open this location:\n${deliverable.path}\n\nPath is outside allowed directories.`);
        } else {
          throw new Error(error.error || 'Unknown error');
        }
      } catch (error) {
        console.error('Failed to open file:', error);
        // Fallback: copy path to clipboard
        try {
          await navigator.clipboard.writeText(deliverable.path);
          alert(`Could not open Finder. Path copied to clipboard:\n${deliverable.path}`);
        } catch {
          alert(`File path:\n${deliverable.path}`);
        }
      }
    }
  };

  const handlePreview = (deliverable: TaskDeliverable) => {
    if (deliverable.path) {
      debug.file('Opening preview', { path: deliverable.path });
      window.open(`/api/files/preview?path=${encodeURIComponent(deliverable.path)}`, '_blank');
    }
  };

  const formatBytes = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
  };

  const formatTimestamp = (timestamp: string) => {
    const date = new Date(timestamp);
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <div className="text-mc-text-secondary">Loading deliverables...</div>
      </div>
    );
  }

  if (deliverables.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-8 text-mc-text-secondary">
        <div className="text-4xl mb-2">📦</div>
        <p>No deliverables yet</p>
      </div>
    );
  }

  const mcFileCount = deliverables.filter(
    d => d.deliverable_type === 'file' && d.storage_scheme === 'mc'
  ).length;

  return (
    <div className="space-y-3">
      {mcFileCount > 0 && (
        <div className="flex items-center justify-end">
          <a
            href={`/api/tasks/${taskId}/deliverables/download`}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded bg-mc-accent text-white hover:bg-mc-accent/90"
            title={`Download ${mcFileCount} file${mcFileCount === 1 ? '' : 's'} as a zip`}
          >
            <Archive className="w-4 h-4" />
            Download all ({mcFileCount})
          </a>
        </div>
      )}
      {deliverables.map((deliverable) => (
        <div
          key={deliverable.id}
          className="flex gap-3 p-3 bg-mc-bg rounded-lg border border-mc-border hover:border-mc-accent transition-colors"
        >
          {/* Icon */}
          <div className="flex-shrink-0 text-mc-accent">
            {getDeliverableIcon(deliverable.deliverable_type)}
          </div>

          {/* Content */}
          <div className="flex-1 min-w-0">
            {/* Title - clickable for URLs */}
            <div className="flex items-start justify-between gap-2">
              {deliverable.deliverable_type === 'url' && deliverable.path ? (
                <a
                  href={deliverable.path}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-medium text-mc-accent hover:text-mc-accent/80 hover:underline flex items-center gap-1.5"
                >
                  {deliverable.title}
                  <ExternalLink className="w-3.5 h-3.5" />
                </a>
              ) : (
                <h4 className="font-medium text-mc-text">{deliverable.title}</h4>
              )}
              <div className="flex items-center gap-1">
                {/* Download button (MC-managed file deliverables only) */}
                {deliverable.deliverable_type === 'file' && deliverable.storage_scheme === 'mc' && (
                  <a
                    href={`/api/deliverables/${deliverable.id}/download`}
                    className="flex-shrink-0 p-1.5 hover:bg-mc-bg-tertiary rounded text-mc-accent"
                    title="Download file"
                  >
                    <Download className="w-4 h-4" />
                  </a>
                )}
                {/* Preview button for HTML files */}
                {deliverable.deliverable_type === 'file' && deliverable.path?.endsWith('.html') && (
                  <button
                    onClick={() => handlePreview(deliverable)}
                    className="flex-shrink-0 p-1.5 hover:bg-mc-bg-tertiary rounded text-mc-accent-cyan"
                    title="Preview in browser"
                  >
                    <Eye className="w-4 h-4" />
                  </button>
                )}
                {/* Open/Reveal button */}
                {deliverable.path && (
                  <button
                    onClick={() => handleOpen(deliverable)}
                    className="flex-shrink-0 p-1.5 hover:bg-mc-bg-tertiary rounded text-mc-accent"
                    title={deliverable.deliverable_type === 'url' ? 'Open URL' : 'Reveal in Finder'}
                  >
                    <ExternalLink className="w-4 h-4" />
                  </button>
                )}
              </div>
            </div>

            {/* Description */}
            {deliverable.description && (
              <p className="text-sm text-mc-text-secondary mt-1">
                {deliverable.description}
              </p>
            )}

            {/* Path - clickable for URLs */}
            {deliverable.path && (
              deliverable.deliverable_type === 'url' ? (
                <a
                  href={deliverable.path}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-2 p-2 bg-mc-bg-tertiary rounded text-xs text-mc-accent hover:text-mc-accent/80 font-mono break-all block hover:bg-mc-bg-tertiary/80"
                >
                  {deliverable.path}
                </a>
              ) : (
                <div className="mt-2 p-2 bg-mc-bg-tertiary rounded text-xs text-mc-text-secondary font-mono break-all">
                  {deliverable.path}
                </div>
              )
            )}

            {/* Metadata */}
            <div className="flex items-center gap-2 mt-2 text-xs text-mc-text-secondary flex-wrap">
              <span className="capitalize">{deliverable.deliverable_type}</span>
              <span>•</span>
              <span>{formatTimestamp(deliverable.created_at)}</span>
              {deliverable.size_bytes != null && (
                <>
                  <span>•</span>
                  <span>{formatBytes(deliverable.size_bytes)}</span>
                </>
              )}
              {deliverable.deliverable_type === 'file' && deliverable.storage_scheme !== 'mc' && (
                <span
                  className="px-1.5 py-0.5 rounded bg-mc-bg-tertiary text-mc-text-secondary"
                  title="Stored on host filesystem; not downloadable from the web UI"
                >
                  host-only
                </span>
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
