import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface SpecPageProps {
  title: string;
  specFile: string;
  intro?: string;
}

export function SpecPage({ title, specFile, intro }: SpecPageProps) {
  let body: string;
  let resolvedPath = `docs/proposals/${specFile}`;
  try {
    body = readFileSync(join(process.cwd(), 'docs/proposals', specFile), 'utf8');
  } catch {
    try {
      body = readFileSync(join(process.cwd(), 'docs/reference', specFile), 'utf8');
      resolvedPath = `docs/reference/${specFile}`;
    } catch (err) {
      body = `_Spec file \`${specFile}\` not found in docs/proposals/ or docs/reference/._\n\n${(err as Error).message}`;
    }
  }

  return (
    <div className="px-6 py-5 max-w-4xl">
      <div className="mb-4">
        <h1 className="text-xl font-semibold text-mc-text">{title}</h1>
        {intro && <p className="text-sm text-mc-text-secondary mt-1">{intro}</p>}
        <p className="text-[11px] text-mc-text-secondary/60 mt-2">
          Spec preview · edit <code>{resolvedPath}</code> to update this page.
        </p>
      </div>
      <article className="prose prose-invert prose-sm max-w-none">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{body}</ReactMarkdown>
      </article>
    </div>
  );
}
