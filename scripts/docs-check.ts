#!/usr/bin/env tsx
// Validates YAML frontmatter on docs/reference/**/*.md, docs/proposals/**/*.md,
// and docs/decisions/**/*.md. Files without frontmatter are skipped (gradual
// migration). docs/archive/ is intentionally not scanned — archived content
// is frozen historical state.

import { readFileSync, statSync, readdirSync } from "node:fs";
import { join, resolve, relative } from "node:path";

const REPO_ROOT = resolve(__dirname, "..");
const REFERENCE_DIR = join(REPO_ROOT, "docs", "reference");
const PROPOSALS_DIR = join(REPO_ROOT, "docs", "proposals");
const DECISIONS_DIR = join(REPO_ROOT, "docs", "decisions");
const SKIP_FILES = new Set([
  join(REPO_ROOT, "docs", "README.md"),
  join(DECISIONS_DIR, "README.md"),
]);
const ALLOWED_STATUS = new Set(["current", "aspirational", "archived", "superseded"]);
const ALLOWED_ADR_STATUS = new Set(["proposed", "accepted", "superseded"]);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ADR_FILENAME_RE = /^(\d+)-[a-z0-9-]+\.md$/;

type Violation = { file: string; field: string; reason: string };

function walk(dir: string, out: string[] = []): string[] {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const ent of entries) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) {
      walk(full, out);
    } else if (ent.isFile() && ent.name.endsWith(".md")) {
      if (SKIP_FILES.has(full)) continue;
      out.push(full);
    }
  }
  return out;
}

function extractFrontmatter(src: string): string | null {
  if (!src.startsWith("---\n")) return null;
  const end = src.indexOf("\n---", 4);
  if (end < 0) return null;
  // Require a newline (or EOF) after the closing ---.
  const after = src.charAt(end + 4);
  if (after !== "" && after !== "\n") return null;
  return src.slice(4, end);
}

type FM = Record<string, string | string[]>;

function parseFrontmatter(yaml: string): FM {
  const out: FM = {};
  const lines = yaml.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith("#")) { i++; continue; }
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!m) { i++; continue; }
    const key = m[1];
    const rest = m[2];
    if (rest.trim() === "") {
      // Possibly a list on following indented lines.
      const list: string[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const lm = lines[j].match(/^\s+-\s*(.*)$/);
        if (!lm) break;
        list.push(stripQuotes(lm[1].trim()));
        j++;
      }
      out[key] = list;
      i = j;
    } else {
      out[key] = stripQuotes(rest.trim());
      i++;
    }
  }
  return out;
}

function stripQuotes(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

function normalizeAnchor(anchor: string): string {
  // Strip trailing parenthetical descriptions: "src/foo.ts (notes)" -> "src/foo.ts"
  let s = anchor.replace(/\s*\(.*\)\s*$/, "").trim();
  // Strip #L... fragments.
  s = s.replace(/#L[\d\-,]+$/, "");
  // Strip :N or :N-M line ranges (but not Windows drive letters; anchors are repo-relative).
  s = s.replace(/:\d+(-\d+)?$/, "");
  return s;
}

function pathExists(p: string): boolean {
  try { statSync(p); return true; } catch { return false; }
}

function validate(file: string, fm: FM, violations: Violation[]): void {
  const rel = relative(REPO_ROOT, file);
  const isAdr = file.startsWith(DECISIONS_DIR + "/") || file.startsWith(DECISIONS_DIR + "\\");
  const allowedStatus = isAdr ? ALLOWED_ADR_STATUS : ALLOWED_STATUS;
  const status = fm.status;
  if (status === undefined) {
    violations.push({ file: rel, field: "status", reason: "missing" });
  } else if (typeof status !== "string" || !allowedStatus.has(status)) {
    violations.push({ file: rel, field: "status", reason: `invalid value '${status}' (must be one of ${[...allowedStatus].join(", ")})` });
  }
  // Specs use `last-verified`; ADRs use `date`. Both are YYYY-MM-DD.
  const dateField = isAdr ? "date" : "last-verified";
  const lv = fm[dateField];
  if (lv === undefined) {
    violations.push({ file: rel, field: dateField, reason: "missing" });
  } else if (typeof lv !== "string" || !DATE_RE.test(lv)) {
    violations.push({ file: rel, field: dateField, reason: `invalid date '${lv}' (must be YYYY-MM-DD)` });
  }
  if (isAdr) {
    const adrNum = fm["adr-number"];
    const base = file.slice(file.lastIndexOf("/") + 1);
    const m = base.match(ADR_FILENAME_RE);
    if (!m) {
      violations.push({ file: rel, field: "filename", reason: `ADR filename must match NNN-slug.md (got '${base}')` });
    } else if (adrNum === undefined) {
      violations.push({ file: rel, field: "adr-number", reason: "missing" });
    } else if (typeof adrNum !== "string" || !/^\d+$/.test(adrNum)) {
      violations.push({ file: rel, field: "adr-number", reason: `must be an integer (got '${adrNum}')` });
    } else if (parseInt(adrNum, 10) !== parseInt(m[1], 10)) {
      violations.push({ file: rel, field: "adr-number", reason: `frontmatter '${adrNum}' does not match filename prefix '${m[1]}'` });
    }
  }
  const anchors = fm["code-anchors"];
  if (anchors !== undefined) {
    if (!Array.isArray(anchors)) {
      violations.push({ file: rel, field: "code-anchors", reason: "must be a list" });
    } else {
      for (const raw of anchors) {
        const norm = normalizeAnchor(raw);
        if (!norm) continue;
        const abs = resolve(REPO_ROOT, norm);
        if (!pathExists(abs)) {
          violations.push({ file: rel, field: "code-anchors", reason: `path not found: ${norm}` });
        }
      }
    }
  }
}

function main(): void {
  const files: string[] = [];
  walk(REFERENCE_DIR, files);
  walk(PROPOSALS_DIR, files);
  walk(DECISIONS_DIR, files);
  const violations: Violation[] = [];
  let withFm = 0;
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    const fmRaw = extractFrontmatter(src);
    if (fmRaw === null) continue;
    withFm++;
    const fm = parseFrontmatter(fmRaw);
    validate(f, fm, violations);
  }
  for (const v of violations) {
    process.stderr.write(`${v.file}:${v.field}: ${v.reason}\n`);
  }
  process.stdout.write(`Checked ${files.length} doc files; ${withFm} had frontmatter; ${violations.length} violations.\n`);
  process.exit(violations.length > 0 ? 1 : 0);
}

main();
