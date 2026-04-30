import test from 'node:test';
import assert from 'node:assert/strict';
import { getRoleSoul, formatRoleSoulSection } from './role-souls';

test('getRoleSoul loads builder soul from disk', () => {
  const md = getRoleSoul('builder');
  assert.ok(md);
  assert.match(md, /Builder/);
  assert.match(md, /run-and-forward/i);
});

test('getRoleSoul loads tester soul', () => {
  const md = getRoleSoul('tester');
  assert.ok(md);
  assert.match(md, /Tester/);
  assert.match(md, /test_full/);
});

test('getRoleSoul loads reviewer soul', () => {
  const md = getRoleSoul('reviewer');
  assert.ok(md);
  assert.match(md, /Reviewer/);
  assert.match(md, /review_static/);
});

test('formatRoleSoulSection wraps soul in dispatch-ready header', () => {
  const out = formatRoleSoulSection('builder');
  assert.match(out, /ROLE: BUILDER/);
  assert.match(out, /Wiring trace/i);
});
