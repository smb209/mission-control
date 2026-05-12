#!/usr/bin/env tsx
// Validates YAML frontmatter on specs/**/*.md.
// Files without frontmatter are skipped (gradual migration).

import { readFileSync, statSync, readdirSync } from "node:fs";
import { join, resolve, relative } from "node:path";

const REPO_ROOT = resolve(__dirname, "..");
const SPECS_DIR = join(REPO_ROOT, "specs");
const SKIP_DIRS = new Set(["audit-reports"]);
const SKIP_FILES = new Set([join(SPECS_DIR, "SPEC_AUDIT.md")]);
const ALLOWED_STATUS = new Set(["current", "aspirational", "archived", "superseded"]);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

type Violation = { file: string; field: string; reason: string };

function walk(dir: string, out: string[] = []): string[] {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(ent.name)) continue;
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
  const status = fm.status;
  if (status === undefined) {
    violations.push({ file: rel, field: "status", reason: "missing" });
  } else if (typeof status !== "string" || !ALLOWED_STATUS.has(status)) {
    violations.push({ file: rel, field: "status", reason: `invalid value '${status}' (must be one of ${[...ALLOWED_STATUS].join(", ")})` });
  }
  const lv = fm["last-verified"];
  if (lv === undefined) {
    violations.push({ file: rel, field: "last-verified", reason: "missing" });
  } else if (typeof lv !== "string" || !DATE_RE.test(lv)) {
    violations.push({ file: rel, field: "last-verified", reason: `invalid date '${lv}' (must be YYYY-MM-DD)` });
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
  const files = walk(SPECS_DIR);
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
  process.stdout.write(`Checked ${files.length} spec files; ${withFm} had frontmatter; ${violations.length} violations.\n`);
  process.exit(violations.length > 0 ? 1 : 0);
}

main();
