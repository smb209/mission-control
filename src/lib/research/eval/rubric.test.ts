/**
 * Rubric scoring tests.
 *
 * Pure-function unit tests covering each axis at its boundaries
 * (0, 1, ramps) and the aggregate. Doesn't touch the DB or
 * orchestrator.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreRubric } from './rubric';

const HEALTHY_BODY = `# Executive summary

This is a thorough survey covering the topic at appropriate length. ` +
  `It explains the relevant background, identifies the moving pieces, and ` +
  `walks through the implications for downstream decisions. The reader ` +
  `gets a complete picture in one pass without needing to chase additional sources.

## Key findings

- First finding with citation [MDN](https://developer.mozilla.org/x).
- Second finding [Caniuse](https://caniuse.com/x).
- Third finding [Spec](https://www.w3.org/TR/x).

## Gaps

We did not address Y or Z; both deserve their own follow-up briefs.

## Recommended next steps

Open a follow-up on Y and ratify the decision on Z next sprint. ` +
  `(Padding to clear 200-word minimum: ` +
  Array.from({ length: 250 }, (_, i) => `word${i}`).join(' ') + `.)`;

test('scoreRubric: healthy brief → all axes high', () => {
  const r = scoreRubric({
    result_md: HEALTHY_BODY,
    citations: [
      { url: 'https://developer.mozilla.org/x' },
      { url: 'https://caniuse.com/x' },
      { url: 'https://www.w3.org/TR/x' },
    ],
  });
  assert.equal(r.axes.completion.score, 1);
  assert.equal(r.axes.citations.score, 1);
  assert.equal(r.axes.structure.score, 1);
  assert.equal(r.axes.length.score, 1);
  assert.equal(r.aggregate, 1);
});

test('scoreRubric: failed brief → completion 0, drags aggregate down', () => {
  const r = scoreRubric({
    result_md: null,
    citations: [],
    error_md: 'gateway timed out',
  });
  assert.equal(r.axes.completion.score, 0);
  assert.equal(r.axes.citations.score, 0);
  assert.equal(r.axes.structure.score, 0);
  assert.equal(r.axes.length.score, 0);
  assert.equal(r.aggregate, 0);
});

test('scoreRubric: empty body → completion 0', () => {
  const r = scoreRubric({ result_md: '   ', citations: [] });
  assert.equal(r.axes.completion.score, 0);
});

test('scoreRubric: deliberately bad one-sentence reply → low aggregate', () => {
  const r = scoreRubric({ result_md: 'no.', citations: [] });
  // Completion is 1 (body is non-empty) but citations/structure/length all 0,
  // so aggregate ≈ 0.25.
  assert.ok(r.aggregate < 0.4, `expected aggregate < 0.4, got ${r.aggregate}`);
  assert.equal(r.axes.completion.score, 1);
  assert.equal(r.axes.citations.score, 0);
});

test('scoreRubric: 1 citation gets partial credit (1/3)', () => {
  const r = scoreRubric({
    result_md: HEALTHY_BODY,
    citations: [{ url: 'https://x.example' }],
  });
  assert.ok(Math.abs(r.axes.citations.score - 1 / 3) < 0.001);
});

test('scoreRubric: structure score reflects fraction of expected sections', () => {
  const partial = `# Executive summary\n\nSome words. ` +
    Array.from({ length: 250 }, (_, i) => `w${i}`).join(' ');
  const r = scoreRubric({ result_md: partial, citations: [] });
  // "summary" = 1/4 expected sections.
  assert.equal(r.axes.structure.score, 0.25);
});

test('scoreRubric: length too short ramps toward 0', () => {
  const tiny = `# Summary\n\nshort. Findings: thin. Gaps: many. Next steps: do.`;
  const r = scoreRubric({ result_md: tiny, citations: [] });
  assert.ok(r.axes.length.score < 1);
});

test('scoreRubric: length way too long ramps down', () => {
  const verbose = `# Summary\nFindings\nGaps\nNext steps\n\n` +
    Array.from({ length: 5000 }, (_, i) => `word${i}`).join(' ');
  const r = scoreRubric({ result_md: verbose, citations: [] });
  assert.ok(r.axes.length.score < 1);
});
