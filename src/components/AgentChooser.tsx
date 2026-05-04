'use client';

/**
 * +Add Agent chooser modal. Replaces opening the blank AgentModal
 * directly so first-time workspace setup gets a guided start:
 *
 *  - Top: "Common teams" preset cards (PM-only, build-and-ship, …).
 *    Clicking one bulk-creates the listed roles via
 *    POST /api/agents/from-template.
 *  - Middle: grid of individual role templates from
 *    `agent-templates/<role>/`. Click → create one agent.
 *  - Bottom: "Custom (blank agent)" link that hands off to the
 *    operator's original AgentModal flow.
 *
 * PM gating: every workspace must have a PM. If the workspace lacks
 * one, the chooser highlights the requirement and disables presets
 * that don't include a PM. Once a PM exists, everything is fair game
 * — `is_pm` flags on subsequent presets are demoted server-side so
 * the existing PM keeps its role.
 */

import { useEffect, useState } from 'react';
import { Loader, Sparkles, UserPlus, X } from 'lucide-react';

interface AgentChooserProps {
  workspaceId: string;
  /** Whether the workspace already has a PM (drives gating + copy). */
  workspaceHasPm: boolean;
  onClose: () => void;
  /** Called after a successful create. The page refetches its
   *  roster from this; if `firstCreatedId` is provided and the caller
   *  wants to navigate, it can do so. */
  onCreated: (createdIds: string[]) => void;
  /** Open the legacy blank-agent modal for advanced/custom creation. */
  onOpenCustomModal: () => void;
}

interface TemplateRow {
  role: string;
  display_name: string;
  emoji: string;
  blurb: string;
}

interface TeamPreset {
  id: string;
  name: string;
  description: string;
  roles: Array<{ role: string; as_pm?: boolean }>;
}

interface CatalogResponse {
  templates: TemplateRow[];
  presets: TeamPreset[];
}

export function AgentChooser({
  workspaceId,
  workspaceHasPm,
  onClose,
  onCreated,
  onOpenCustomModal,
}: AgentChooserProps) {
  const [catalog, setCatalog] = useState<CatalogResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/agent-templates')
      .then(async r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data: CatalogResponse) => { if (!cancelled) setCatalog(data); })
      .catch(e => { if (!cancelled) setErr(e instanceof Error ? e.message : 'Failed to load'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const submit = async (
    body: { preset_id?: string; roles?: Array<{ role: string; as_pm?: boolean }> },
    busyKey: string,
  ) => {
    setSubmitting(busyKey);
    setErr(null);
    try {
      const res = await fetch('/api/agents/from-template', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, workspace_id: workspaceId }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      const data = (await res.json()) as { created: Array<{ id: string }> };
      onCreated(data.created.map(a => a.id));
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Create failed');
      setSubmitting(null);
    }
  };

  const presetIncludesPm = (p: TeamPreset) => p.roles.some(r => r.as_pm);
  const showPmRequiredBanner = !workspaceHasPm;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-3 sm:p-4">
      <div className="bg-mc-bg-secondary border border-mc-border rounded-lg w-full max-w-4xl max-h-[92vh] flex flex-col">
        <header className="flex items-center justify-between p-4 border-b border-mc-border">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-mc-accent" />
            <h2 className="text-base font-semibold">Add agents</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 hover:bg-mc-bg-tertiary rounded-sm"
            aria-label="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto p-5 space-y-6">
          {showPmRequiredBanner && (
            <div className="px-3 py-2 rounded-sm border border-amber-500/40 bg-amber-500/10 text-amber-200 text-xs">
              <strong>This workspace needs a PM.</strong> Pick a team that includes one
              (or the &quot;PM only&quot; preset) before adding role-only agents.
            </div>
          )}

          {err && (
            <div className="px-3 py-2 rounded-sm border border-red-500/40 bg-red-500/10 text-red-300 text-xs">
              {err}
            </div>
          )}

          {loading ? (
            <div className="flex items-center justify-center py-12 text-mc-text-secondary">
              <Loader className="w-5 h-5 animate-spin mr-2" /> Loading templates…
            </div>
          ) : !catalog ? null : (
            <>
              <section>
                <h3 className="text-xs uppercase tracking-wide text-mc-text-secondary/70 mb-2">
                  Common teams
                </h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {catalog.presets.map(p => {
                    const includesPm = presetIncludesPm(p);
                    const disabled =
                      submitting !== null ||
                      (showPmRequiredBanner && !includesPm);
                    return (
                      <button
                        key={p.id}
                        type="button"
                        disabled={disabled}
                        onClick={() => submit({ preset_id: p.id }, `preset:${p.id}`)}
                        className={`text-left p-3 rounded-lg border bg-mc-bg hover:bg-mc-bg-tertiary disabled:opacity-40 disabled:cursor-not-allowed ${
                          includesPm ? 'border-mc-accent/40' : 'border-mc-border'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2 mb-1">
                          <div className="text-sm font-medium">{p.name}</div>
                          {includesPm && (
                            <span className="text-[10px] uppercase tracking-wide text-mc-accent">
                              includes PM
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-mc-text-secondary">{p.description}</p>
                        <div className="mt-2 flex flex-wrap gap-1">
                          {p.roles.map((r, i) => (
                            <span
                              key={i}
                              className="text-[10px] px-1.5 py-0.5 rounded bg-mc-bg-tertiary text-mc-text-secondary font-mono"
                            >
                              {r.role}
                              {r.as_pm ? '*' : ''}
                            </span>
                          ))}
                        </div>
                        {submitting === `preset:${p.id}` && (
                          <div className="mt-2 text-[11px] text-mc-text-secondary inline-flex items-center gap-1">
                            <Loader className="w-3 h-3 animate-spin" /> Creating…
                          </div>
                        )}
                      </button>
                    );
                  })}
                </div>
              </section>

              <section>
                <h3 className="text-xs uppercase tracking-wide text-mc-text-secondary/70 mb-2">
                  Or pick individual roles
                </h3>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  {catalog.templates.map(t => {
                    const isPmRole = t.role === 'pm';
                    const disabled =
                      submitting !== null ||
                      (showPmRequiredBanner && !isPmRole);
                    return (
                      <button
                        key={t.role}
                        type="button"
                        disabled={disabled}
                        onClick={() =>
                          submit(
                            { roles: [{ role: t.role, as_pm: isPmRole && !workspaceHasPm }] },
                            `role:${t.role}`,
                          )
                        }
                        className="text-left p-3 rounded-lg border border-mc-border bg-mc-bg hover:bg-mc-bg-tertiary disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        <div className="flex items-start gap-2">
                          <div className="text-2xl leading-none">{t.emoji}</div>
                          <div className="min-w-0">
                            <div className="text-sm font-medium truncate">{t.display_name}</div>
                            <div className="text-[10px] uppercase tracking-wide text-mc-text-secondary/70 font-mono">
                              {t.role}
                            </div>
                          </div>
                        </div>
                        <p className="mt-2 text-xs text-mc-text-secondary line-clamp-2">{t.blurb}</p>
                        {submitting === `role:${t.role}` && (
                          <div className="mt-2 text-[11px] text-mc-text-secondary inline-flex items-center gap-1">
                            <Loader className="w-3 h-3 animate-spin" /> Creating…
                          </div>
                        )}
                      </button>
                    );
                  })}
                </div>
              </section>

              <section className="pt-2 border-t border-mc-border">
                <button
                  type="button"
                  onClick={() => {
                    onClose();
                    onOpenCustomModal();
                  }}
                  className="inline-flex items-center gap-2 text-sm text-mc-text-secondary hover:text-mc-text"
                >
                  <UserPlus className="w-4 h-4" />
                  Custom — start a blank agent and configure manually
                </button>
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
