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
  try {
    body = readFileSync(join(process.cwd(), 'specs', specFile), 'utf8');
  } catch (err) {
    body = `_Spec file \`specs/${specFile}\` not found._\n\n${(err as Error).message}`;
  }

  return (
    <div className="px-6 py-5 max-w-4xl">
      <div className="mb-4">
        <h1 className="text-xl font-semibold text-mc-text">{title}</h1>
        {intro && <p className="text-sm text-mc-text-secondary mt-1">{intro}</p>}
        <p className="text-[11px] text-mc-text-secondary/60 mt-2">
          Spec preview · edit <code>specs/{specFile}</code> to update this page.
        </p>
      </div>
      <article className="prose prose-invert prose-sm max-w-none">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{body}</ReactMarkdown>
      </article>
    </div>
  );
}
