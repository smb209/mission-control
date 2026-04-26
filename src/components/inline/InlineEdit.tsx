'use client';

import {
  useState,
  useRef,
  useEffect,
  useCallback,
  type ReactNode,
  type KeyboardEvent,
} from 'react';
import { Check, X, Pencil } from 'lucide-react';

type SaveResult = void | Promise<void>;

interface CommonProps<T> {
  value: T;
  onSave: (next: T) => SaveResult;
  /** Render the read-only display. Defaults vary per primitive. */
  renderDisplay?: (value: T) => ReactNode;
  /** Shown when value is empty and not editing. */
  placeholder?: string;
  /** Wrapper className for both display and edit modes (layout). */
  className?: string;
  /** Disable editing entirely (still renders display). */
  disabled?: boolean;
  /** Optional aria-label for the edit trigger. */
  label?: string;
}

function useInlineEdit<T>(value: T, onSave: (next: T) => SaveResult) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<T>(value);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Re-sync the draft when the saved value changes from outside while idle.
  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  const begin = useCallback(() => {
    setDraft(value);
    setErr(null);
    setEditing(true);
  }, [value]);

  const cancel = useCallback(() => {
    setDraft(value);
    setErr(null);
    setEditing(false);
  }, [value]);

  const commit = useCallback(
    async (next: T) => {
      setSaving(true);
      setErr(null);
      try {
        await onSave(next);
        setEditing(false);
      } catch (e) {
        setErr(e instanceof Error ? e.message : 'Save failed');
      } finally {
        setSaving(false);
      }
    },
    [onSave],
  );

  return { editing, draft, setDraft, saving, err, begin, cancel, commit };
}

function ActionRow({
  onSave,
  onCancel,
  saving,
  err,
}: {
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
  err: string | null;
}) {
  return (
    <div className="flex items-center gap-2 mt-2">
      <button
        type="button"
        onClick={onSave}
        disabled={saving}
        className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded bg-mc-accent text-white disabled:opacity-50"
      >
        <Check className="w-3 h-3" /> {saving ? 'Saving…' : 'Save'}
      </button>
      <button
        type="button"
        onClick={onCancel}
        disabled={saving}
        className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-mc-border text-mc-text-secondary"
      >
        <X className="w-3 h-3" /> Cancel
      </button>
      {err && <span className="text-xs text-red-400 ml-1">{err}</span>}
    </div>
  );
}

const HOVER_CLS =
  'group relative cursor-text rounded -mx-1 px-1 hover:bg-mc-accent/5 hover:outline hover:outline-1 hover:outline-mc-accent/20';

function PencilHint() {
  return (
    <Pencil className="absolute right-1 top-1 w-3 h-3 text-mc-text-secondary/40 opacity-0 group-hover:opacity-100" />
  );
}

/* ---------- InlineText (single line) ---------- */

interface InlineTextProps extends CommonProps<string> {
  inputClassName?: string;
  /** number / text. Default text. */
  type?: 'text' | 'number';
  step?: string;
}

export function InlineText({
  value,
  onSave,
  renderDisplay,
  placeholder = 'Click to edit',
  className,
  disabled,
  inputClassName,
  type = 'text',
  step,
  label,
}: InlineTextProps) {
  const { editing, draft, setDraft, saving, err, begin, cancel, commit } =
    useInlineEdit<string>(value, onSave);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit(draft);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
    }
  };

  if (editing) {
    return (
      <div className={className}>
        <input
          ref={inputRef}
          type={type}
          step={step}
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={onKey}
          disabled={saving}
          className={
            inputClassName ??
            'w-full px-2 py-1 rounded bg-mc-bg border border-mc-accent/60 text-mc-text outline-none'
          }
        />
        <ActionRow
          onSave={() => commit(draft)}
          onCancel={cancel}
          saving={saving}
          err={err}
        />
      </div>
    );
  }

  const isEmpty = value == null || value === '';
  return (
    <div
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-label={label ?? 'Edit'}
      onClick={() => !disabled && begin()}
      onKeyDown={e => {
        if (!disabled && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          begin();
        }
      }}
      className={`${className ?? ''} ${disabled ? '' : HOVER_CLS}`}
    >
      {isEmpty ? (
        <span className="text-mc-text-secondary/60 italic">{placeholder}</span>
      ) : renderDisplay ? (
        renderDisplay(value)
      ) : (
        <span>{value}</span>
      )}
      {!disabled && <PencilHint />}
    </div>
  );
}

/* ---------- InlineTextarea (multi-line) ---------- */

interface InlineTextareaProps extends CommonProps<string> {
  textareaClassName?: string;
  /** Min rows for the textarea while editing. Default 6. */
  minRows?: number;
  /** Render display as `<pre>`-like wrap. Default true. */
  preWrap?: boolean;
  /** Apply mono font in both display and edit. */
  mono?: boolean;
}

export function InlineTextarea({
  value,
  onSave,
  renderDisplay,
  placeholder = 'Click to add…',
  className,
  disabled,
  textareaClassName,
  minRows = 6,
  preWrap = true,
  mono = false,
  label,
}: InlineTextareaProps) {
  const { editing, draft, setDraft, saving, err, begin, cancel, commit } =
    useInlineEdit<string>(value, onSave);
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editing) {
      const ta = taRef.current;
      if (ta) {
        ta.focus();
        // Place caret at end.
        ta.setSelectionRange(ta.value.length, ta.value.length);
        autoResize(ta);
      }
    }
  }, [editing]);

  const autoResize = (ta: HTMLTextAreaElement) => {
    ta.style.height = 'auto';
    ta.style.height = `${ta.scrollHeight}px`;
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      commit(draft);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
    }
  };

  if (editing) {
    return (
      <div className={className}>
        <textarea
          ref={taRef}
          value={draft}
          onChange={e => {
            setDraft(e.target.value);
            autoResize(e.currentTarget);
          }}
          onKeyDown={onKey}
          rows={minRows}
          disabled={saving}
          className={
            textareaClassName ??
            `w-full px-3 py-2 rounded bg-mc-bg border border-mc-accent/60 text-mc-text outline-none resize-y ${
              mono ? 'font-mono text-xs' : ''
            }`
          }
        />
        <div className="flex items-center justify-between gap-2 mt-2">
          <ActionRow
            onSave={() => commit(draft)}
            onCancel={cancel}
            saving={saving}
            err={err}
          />
          <span className="text-[10px] text-mc-text-secondary/60">
            ⌘/Ctrl+Enter saves · Esc cancels
          </span>
        </div>
      </div>
    );
  }

  const isEmpty = value == null || value === '';
  return (
    <div
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-label={label ?? 'Edit'}
      onClick={() => !disabled && begin()}
      onKeyDown={e => {
        if (!disabled && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          begin();
        }
      }}
      className={`${className ?? ''} ${disabled ? '' : HOVER_CLS} ${
        preWrap ? 'whitespace-pre-wrap' : ''
      } ${mono ? 'font-mono text-xs' : ''} min-h-[1.5em]`}
    >
      {isEmpty ? (
        <span className="text-mc-text-secondary/60 italic">{placeholder}</span>
      ) : renderDisplay ? (
        renderDisplay(value)
      ) : (
        <span>{value}</span>
      )}
      {!disabled && <PencilHint />}
    </div>
  );
}

/* ---------- InlineSelect ---------- */

export interface InlineSelectOption<T extends string> {
  value: T;
  label: string;
}

interface InlineSelectProps<T extends string> extends CommonProps<T> {
  options: InlineSelectOption<T>[];
  selectClassName?: string;
}

export function InlineSelect<T extends string>({
  value,
  onSave,
  options,
  renderDisplay,
  placeholder = 'Click to set',
  className,
  disabled,
  selectClassName,
  label,
}: InlineSelectProps<T>) {
  const { editing, draft, setDraft, saving, err, begin, cancel, commit } =
    useInlineEdit<T>(value, onSave);
  const selectRef = useRef<HTMLSelectElement>(null);

  useEffect(() => {
    if (editing) selectRef.current?.focus();
  }, [editing]);

  if (editing) {
    return (
      <div className={className}>
        <select
          ref={selectRef}
          value={draft}
          onChange={e => setDraft(e.target.value as T)}
          onKeyDown={e => {
            if (e.key === 'Escape') {
              e.preventDefault();
              cancel();
            }
          }}
          disabled={saving}
          className={
            selectClassName ??
            'w-full px-2 py-1 rounded bg-mc-bg border border-mc-accent/60 text-mc-text outline-none'
          }
        >
          {options.map(o => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <ActionRow
          onSave={() => commit(draft)}
          onCancel={cancel}
          saving={saving}
          err={err}
        />
      </div>
    );
  }

  const isEmpty = value == null || (value as unknown as string) === '';
  return (
    <div
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-label={label ?? 'Edit'}
      onClick={() => !disabled && begin()}
      onKeyDown={e => {
        if (!disabled && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          begin();
        }
      }}
      className={`${className ?? ''} ${disabled ? '' : HOVER_CLS} inline-block`}
    >
      {isEmpty ? (
        <span className="text-mc-text-secondary/60 italic">{placeholder}</span>
      ) : renderDisplay ? (
        renderDisplay(value)
      ) : (
        <span>{options.find(o => o.value === value)?.label ?? value}</span>
      )}
      {!disabled && <PencilHint />}
    </div>
  );
}

/* ---------- InlineDate (yyyy-mm-dd) ---------- */

interface InlineDateProps extends CommonProps<string> {
  /** Allow null/clearing — if true, an explicit "Clear" button appears. */
  clearable?: boolean;
}

export function InlineDate({
  value,
  onSave,
  placeholder = '—',
  className,
  disabled,
  clearable = true,
  label,
}: InlineDateProps) {
  const { editing, draft, setDraft, saving, err, begin, cancel, commit } =
    useInlineEdit<string>(value ?? '', onSave);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  if (editing) {
    return (
      <div className={className}>
        <input
          ref={inputRef}
          type="date"
          value={draft.slice(0, 10)}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commit(draft);
            } else if (e.key === 'Escape') {
              e.preventDefault();
              cancel();
            }
          }}
          disabled={saving}
          className="w-full px-2 py-1 rounded bg-mc-bg border border-mc-accent/60 text-mc-text outline-none"
        />
        <div className="flex items-center gap-2 mt-2">
          <button
            type="button"
            onClick={() => commit(draft)}
            disabled={saving}
            className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded bg-mc-accent text-white disabled:opacity-50"
          >
            <Check className="w-3 h-3" /> {saving ? 'Saving…' : 'Save'}
          </button>
          <button
            type="button"
            onClick={cancel}
            disabled={saving}
            className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-mc-border text-mc-text-secondary"
          >
            <X className="w-3 h-3" /> Cancel
          </button>
          {clearable && (
            <button
              type="button"
              onClick={() => commit('')}
              disabled={saving}
              className="text-xs px-2 py-1 rounded border border-mc-border text-mc-text-secondary ml-auto"
              title="Clear this date"
            >
              Clear
            </button>
          )}
          {err && <span className="text-xs text-red-400 ml-1">{err}</span>}
        </div>
      </div>
    );
  }

  const display = value && value.length > 0 ? value.slice(0, 10) : null;
  return (
    <div
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-label={label ?? 'Edit date'}
      onClick={() => !disabled && begin()}
      onKeyDown={e => {
        if (!disabled && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          begin();
        }
      }}
      className={`${className ?? ''} ${disabled ? '' : HOVER_CLS}`}
    >
      {display ?? (
        <span className="text-mc-text-secondary/60">{placeholder}</span>
      )}
      {!disabled && <PencilHint />}
    </div>
  );
}
