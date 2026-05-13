#!/usr/bin/env node
// Discover and run *.test.ts files via node:test's programmatic run() API.
// Avoids the CLI's glob interpretation, which silently drops paths with
// literal `[` / `]` (e.g. Next.js `[id]` route segments).

import { run } from 'node:test';
import { spec } from 'node:test/reporters';
import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

async function walk(dir, out = []) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      await walk(p, out);
    } else if (entry.isFile() && entry.name.endsWith('.test.ts')) {
      out.push(resolve(p));
    }
  }
  return out;
}

const roots = process.argv.slice(2);
const searchRoots = roots.length ? roots : ['src'];

const files = [];
for (const root of searchRoots) {
  await walk(root, files);
}

if (files.length === 0) {
  console.error('No *.test.ts files found under:', searchRoots.join(', '));
  process.exit(1);
}

const stream = run({ files, concurrency: false });
let failed = false;
stream.on('test:fail', (event) => {
  if (event.details?.error && !event.todo && !event.skip) {
    failed = true;
  }
});
stream.compose(new spec()).pipe(process.stdout);
stream.once('end', () => {
  process.exit(failed ? 1 : 0);
});
