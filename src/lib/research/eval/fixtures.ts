/**
 * Eval fixtures for the Research Area.
 *
 * Deterministic prompts that we re-run periodically against the
 * researcher persona to track output quality regressions. Each
 * fixture pairs an input (template + title + prompt) with optional
 * expected-content hints used by the rubric.
 *
 * The deliberately-bad fixture (`bad_one_sentence`) exercises the
 * rubric's failure detection — its score should drag the aggregate
 * down meaningfully (R6.2 in the validation plan).
 */

import type { BriefTemplate } from '@/lib/db/briefs';

export interface BriefFixture {
  id: string;
  template: BriefTemplate;
  title: string;
  prompt: string;
  /** Free-text notes for the operator. */
  notes?: string;
  /** When set, the eval runner uses this canned reply instead of
   *  dispatching to the gateway. Lets the harness self-test without
   *  burning gateway tokens, and gives R6.2 its known-bad fixture. */
  cannedReply?: string;
}

export const FIXTURES: BriefFixture[] = [
  {
    id: 'webgpu_support',
    template: 'general_brief',
    title: 'WebGPU browser support',
    prompt:
      'Survey WebGPU support in Chrome, Safari, and Firefox as of today. ' +
      'Note which features are still behind flags, and link to the official compatibility data.',
    notes: 'Tests structural output + citation parsing on a topic with ample primary sources.',
  },
  {
    id: 'sqlite_wal_macos',
    template: 'general_brief',
    title: 'SQLite WAL gotchas on macOS bind mounts',
    prompt:
      'Summarize the known issues with running SQLite in WAL mode inside a Docker container ' +
      'whose database file lives on a macOS bind mount. Cite primary sources where possible.',
    notes: 'Narrower technical question; tests synthesis when sources are scattered.',
  },
  {
    id: 'bad_one_sentence',
    template: 'general_brief',
    title: 'Deliberately bad fixture',
    prompt:
      'A canned bad output is supplied; this fixture exercises the rubric.',
    notes: 'R6.2 in validation: the rubric must flag this.',
    cannedReply: 'no.',
  },
];
