/**
 * Display-side timestamp helpers.
 *
 * Cover the IANA validation, the tz override resolution, and the
 * format paths. Note: we don't snapshot the exact formatted strings
 * across modes since `Intl.DateTimeFormat` output varies subtly by
 * Node version — we verify the *shape* (zone abbreviation present
 * for absolute mode, no zone for short, etc.).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatTimestamp,
  isValidTimezone,
  relativeTime,
  resolveDisplayTimezone,
} from './timestamps';

test('isValidTimezone accepts well-formed IANA names', () => {
  assert.equal(isValidTimezone('America/Los_Angeles'), true);
  assert.equal(isValidTimezone('Europe/London'), true);
  assert.equal(isValidTimezone('UTC'), true);
  assert.equal(isValidTimezone('Asia/Tokyo'), true);
});

test('isValidTimezone rejects garbage', () => {
  assert.equal(isValidTimezone('Mars/Olympus_Mons'), false);
  assert.equal(isValidTimezone('Not_A_Zone'), false);
  assert.equal(isValidTimezone(''), false);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assert.equal(isValidTimezone(null as any), false);
});

test('resolveDisplayTimezone honors the override first', () => {
  assert.equal(
    resolveDisplayTimezone('America/New_York'),
    'America/New_York',
  );
  // Whitespace-only treated as no override.
  const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
  assert.equal(resolveDisplayTimezone('   '), detected);
  assert.equal(resolveDisplayTimezone(null), detected);
  assert.equal(resolveDisplayTimezone(undefined), detected);
});

test('formatTimestamp renders the same instant differently in two zones', () => {
  // 2026-05-08 00:00:00 UTC. In NY that's 2026-05-07 evening; in
  // Tokyo that's 2026-05-08 morning. Different display dates.
  const iso = '2026-05-08T00:00:00Z';
  const ny = formatTimestamp(iso, { tz: 'America/New_York', mode: 'short' });
  const tokyo = formatTimestamp(iso, { tz: 'Asia/Tokyo', mode: 'short' });
  assert.notEqual(ny, tokyo);
  // NY is the previous calendar day at this UTC instant.
  assert.match(ny, /May 7/);
  assert.match(tokyo, /May 8/);
});

test('formatTimestamp absolute mode includes timezone label', () => {
  const out = formatTimestamp('2026-05-08T16:00:00Z', {
    tz: 'America/Los_Angeles',
    mode: 'absolute',
  });
  // PDT or PST depending on date; both end with 'T'.
  assert.match(out, /\bPDT\b|\bPST\b/);
});

test('formatTimestamp short mode excludes timezone label', () => {
  const out = formatTimestamp('2026-05-08T16:00:00Z', {
    tz: 'America/Los_Angeles',
    mode: 'short',
  });
  assert.doesNotMatch(out, /\bPDT\b|\bPST\b/);
});

test('formatTimestamp returns empty string for nullish or unparseable input', () => {
  assert.equal(formatTimestamp(null), '');
  assert.equal(formatTimestamp(undefined), '');
  assert.equal(formatTimestamp(''), '');
  assert.equal(formatTimestamp('not a date'), '');
});

test('formatTimestamp falls back gracefully when the override tz is rejected', () => {
  // We let invalid tz reach formatTimestamp at runtime because the
  // workspace value might be stale or an env quirk; the helper must
  // not throw out of a render.
  const out = formatTimestamp('2026-05-08T16:00:00Z', {
    tz: 'Mars/Olympus_Mons',
    mode: 'short',
  });
  assert.ok(out.length > 0, 'falls back to default Intl');
});

test('relativeTime returns a human-readable past phrase', () => {
  const fiveMinAgo = new Date(Date.now() - 5 * 60_000).toISOString();
  const out = relativeTime(fiveMinAgo);
  assert.match(out, /ago$/);
  assert.match(out, /minute/);
});

test('relativeTime handles future timestamps with "in" prefix', () => {
  const fiveMinFromNow = new Date(Date.now() + 5 * 60_000).toISOString();
  const out = relativeTime(fiveMinFromNow);
  assert.match(out, /^in /);
});

test('relativeTime returns empty string for unparseable input', () => {
  assert.equal(relativeTime(''), '');
  assert.equal(relativeTime(null), '');
  assert.equal(relativeTime('garbage'), '');
});
