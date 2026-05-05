#!/usr/bin/env node
/**
 * sync-named-agent-workspaces.mjs
 *
 * Keeps the named gateway agents' on-disk workspace files
 * (~/.openclaw/workspaces/mc-{pm-*,runner}-{dev,stable}/) in sync with
 * the canonical templates in agent-templates/.
 *
 * Why: runner-hosted personas resolve _shared addenda dynamically at
 * MC's briefing-build time, so an edit to agent-templates/_shared/*.md
 * propagates next dispatch. Named gateway agents (PM, runner-host)
 * read AGENTS.md / SOUL.md / IDENTITY.md / MESSAGING-PROTOCOL.md /
 * SHARED-RULES.md as physical files at session start, OUTSIDE MC's
 * briefing pipeline. Without this script, edits to _shared or to
 * agent-templates/{pm,runner-host}/ silently diverge from what those
 * named agents actually read.
 *
 * What it does, idempotently:
 *
 *   For each workspace dir matching ~/.openclaw/workspaces/mc-{pm-*,runner}-{,-dev}/:
 *     - Detect role: mc-pm-* → 'pm', mc-runner / mc-runner-dev → 'runner-host'.
 *     - For each (workspace-file → template-source) pair:
 *         SOUL.md            ← agent-templates/<role>/SOUL.md
 *         AGENTS.md          ← agent-templates/<role>/AGENTS.md
 *         IDENTITY.md        ← agent-templates/<role>/IDENTITY.md
 *       PLUS (runner-host only — the PM workspace doesn't mirror these):
 *         MESSAGING-PROTOCOL.md ← agent-templates/_shared/messaging-protocol.md
 *         SHARED-RULES.md    ← agent-templates/_shared/shared-rules.md
 *       Write the template content into the workspace file if it differs.
 *       Take a .bak.<ts> snapshot before the first overwrite of each file.
 *
 *   Operator-managed files (TOOLS.md, HEARTBEAT.md, USER.md, MC-CONTEXT.json,
 *   MEMORY-ORG.md, the memory/, projects/, skills/ dirs, etc.) are not
 *   touched — they're outside the allowlist.
 *
 *   Dirs that don't match the mc-{pm,runner} regex are skipped silently
 *   (covers non-MC openclaw workspaces).
 *
 * Usage:
 *   node scripts/sync-named-agent-workspaces.mjs              # apply, write back
 *   node scripts/sync-named-agent-workspaces.mjs --dry-run    # report only (exits 2 on drift)
 *   node scripts/sync-named-agent-workspaces.mjs --root=PATH  # alt workspaces root
 *   node scripts/sync-named-agent-workspaces.mjs --templates=PATH  # alt agent-templates root
 *
 * Exits non-zero on parse errors or when --dry-run finds drift.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

// ─── role detection ─────────────────────────────────────────────────

const PM_DIR_RE = /^mc-pm-[a-z0-9-]+?(?:-dev)?$/;
const RUNNER_DIR_RE = /^mc-runner(?:-dev)?$/;

function roleForWorkspaceDir(dirName) {
  if (PM_DIR_RE.test(dirName)) return 'pm';
  if (RUNNER_DIR_RE.test(dirName)) return 'runner-host';
  return null;
}

// ─── file pair plan ─────────────────────────────────────────────────

/**
 * Per-role list of `{ wsFile, templatePath }` pairs to keep in sync.
 * `templatePath` is relative to `agent-templates/`.
 */
function syncPlanForRole(role) {
  const common = [
    { wsFile: 'SOUL.md',     templatePath: `${role}/SOUL.md` },
    { wsFile: 'AGENTS.md',   templatePath: `${role}/AGENTS.md` },
    { wsFile: 'IDENTITY.md', templatePath: `${role}/IDENTITY.md` },
  ];
  if (role === 'runner-host') {
    return [
      ...common,
      { wsFile: 'MESSAGING-PROTOCOL.md', templatePath: '_shared/messaging-protocol.md' },
      { wsFile: 'SHARED-RULES.md',       templatePath: '_shared/shared-rules.md' },
    ];
  }
  return common;
}

// ─── sync loop ──────────────────────────────────────────────────────

async function readIfExists(p) {
  try {
    return await fs.readFile(p, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

async function syncWorkspace({ wsDir, role, templatesRoot, dryRun, results }) {
  const plan = syncPlanForRole(role);
  for (const { wsFile, templatePath } of plan) {
    const fullWsFile = path.join(wsDir, wsFile);
    const fullTemplate = path.join(templatesRoot, templatePath);

    const [wsContent, templateContent] = await Promise.all([
      readIfExists(fullWsFile),
      readIfExists(fullTemplate),
    ]);

    if (templateContent === null) {
      results.push({
        wsDir,
        wsFile,
        kind: 'skip',
        reason: `template missing: ${templatePath}`,
      });
      continue;
    }

    if (wsContent === null) {
      // Workspace file doesn't exist. We don't create files implicitly —
      // that surfaces as a misconfiguration the operator should review.
      results.push({
        wsDir,
        wsFile,
        kind: 'missing',
        reason: 'workspace file does not exist (skipping; create manually if intended)',
      });
      continue;
    }

    if (wsContent === templateContent) {
      results.push({ wsDir, wsFile, kind: 'in-sync' });
      continue;
    }

    if (!dryRun) {
      const backupPath = `${fullWsFile}.bak.${Date.now()}`;
      await fs.copyFile(fullWsFile, backupPath);
      await fs.writeFile(fullWsFile, templateContent, 'utf8');
      results.push({
        wsDir,
        wsFile,
        kind: 'updated',
        backup: path.basename(backupPath),
      });
    } else {
      results.push({ wsDir, wsFile, kind: 'drift' });
    }
  }
}

// ─── main ───────────────────────────────────────────────────────────

function repoRoot() {
  // This file lives at <repo>/scripts/sync-named-agent-workspaces.mjs.
  const here = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(here), '..');
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');

  const rootFlag = args.find((a) => a.startsWith('--root='));
  const wsRoot = rootFlag
    ? rootFlag.slice('--root='.length).replace(/^~/, os.homedir())
    : path.join(os.homedir(), '.openclaw', 'workspaces');

  const tplFlag = args.find((a) => a.startsWith('--templates='));
  const templatesRoot = tplFlag
    ? tplFlag.slice('--templates='.length).replace(/^~/, os.homedir())
    : path.join(repoRoot(), 'agent-templates');

  console.log(`[sync-named-agents] workspaces root: ${wsRoot}`);
  console.log(`[sync-named-agents] templates root: ${templatesRoot}`);
  console.log(`[sync-named-agents] mode: ${dryRun ? 'dry-run' : 'write'}`);

  const entries = await fs.readdir(wsRoot, { withFileTypes: true });

  const results = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const role = roleForWorkspaceDir(entry.name);
    if (!role) continue;
    const wsDir = path.join(wsRoot, entry.name);
    await syncWorkspace({ wsDir, role, templatesRoot, dryRun, results });
  }

  let drift = 0;
  let updated = 0;
  let inSync = 0;
  let missing = 0;
  let skipped = 0;
  for (const r of results) {
    const tag = `[sync-named-agents] ${path.basename(r.wsDir)}/${r.wsFile}`;
    switch (r.kind) {
      case 'in-sync': inSync++; break;
      case 'updated':
        updated++;
        console.log(`${tag}: updated (backup: ${r.backup})`);
        break;
      case 'drift':
        drift++;
        console.log(`${tag}: drift — would update`);
        break;
      case 'missing':
        missing++;
        console.log(`${tag}: ${r.reason}`);
        break;
      case 'skip':
        skipped++;
        console.log(`${tag}: skip — ${r.reason}`);
        break;
    }
  }

  console.log(
    `[sync-named-agents] summary: ` +
      `${inSync} in-sync, ${updated} updated, ${drift} drift, ${missing} missing, ${skipped} skipped`,
  );

  if (dryRun && drift > 0) {
    process.exitCode = 2;
  }
}

main().catch((err) => {
  console.error(`[sync-named-agents] ERROR: ${err.message}`);
  process.exit(1);
});
