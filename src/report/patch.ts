import fs from 'node:fs';
import path from 'node:path';
import type { AnalysisResult, DeletionRange } from '../types.js';

/**
 * `--fix` patch generation.
 *
 * deletion recommendations must always be presented as a diff
 * and must NEVER be auto-applied. This module returns patch text. Nothing in the
 * codebase writes to a discovered artifact — the human applies the patch with
 * `git apply`, having read it.
 *
 * Only findings that carry an explicit `deletion` range are included. Routing
 * findings (ambiguity, conflict) need a human rewrite, so they are listed as a
 * comment block above the diff rather than guessed at.
 */

const CONTEXT_LINES = 3;

interface MergedRange {
  readonly startLine: number;
  readonly endLine: number;
  readonly ruleIds: string[];
  /** Exactly which 1-indexed lines this hunk removes. */
  readonly deleted: ReadonlySet<number>;
}

/**
 * Merge deletion ranges whose context windows would overlap.
 *
 * The threshold is `2 * CONTEXT_LINES`, not adjacency. Two deletions four lines
 * apart each want three lines of context around them, so their hunks would
 * overlap and `git apply` rejects the patch outright — which is exactly what the
 * first version of this produced. Anything closer than two context windows has
 * to become one hunk.
 */
function mergeRanges(ranges: readonly (DeletionRange & { ruleId: string })[]): MergedRange[] {
  const sorted = [...ranges].sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);
  const merged: MergedRange[] = [];

  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range.startLine <= last.endLine + 2 * CONTEXT_LINES + 1) {
      merged[merged.length - 1] = {
        startLine: last.startLine,
        endLine: Math.max(last.endLine, range.endLine),
        ruleIds: last.ruleIds.includes(range.ruleId) ? last.ruleIds : [...last.ruleIds, range.ruleId],
        // Lines inside the merged span that are NOT being deleted must survive,
        // so the set of deleted lines is tracked explicitly rather than assumed
        // to be the whole span.
        deleted: new Set([...last.deleted, ...lineRange(range.startLine, range.endLine)]),
      };
    } else {
      merged.push({
        startLine: range.startLine,
        endLine: range.endLine,
        ruleIds: [range.ruleId],
        deleted: new Set(lineRange(range.startLine, range.endLine)),
      });
    }
  }
  return merged;
}

function lineRange(start: number, end: number): number[] {
  const out: number[] = [];
  for (let n = start; n <= end; n++) out.push(n);
  return out;
}

export function generatePatch(result: AnalysisResult): string {
  const byFile = new Map<string, (DeletionRange & { ruleId: string })[]>();

  for (const finding of result.findings) {
    if (!finding.deletion) continue;
    const list = byFile.get(finding.deletion.path);
    const entry = { ...finding.deletion, ruleId: finding.ruleId };
    if (list) list.push(entry);
    else byFile.set(finding.deletion.path, [entry]);
  }

  const manual = result.findings.filter((f) => !f.deletion);
  const out: string[] = [];

  out.push('# skillassay --fix');
  out.push('#');
  out.push('# Review this patch, then apply it yourself:');
  out.push('#     assay --fix . > assay.patch && git apply assay.patch');
  out.push('#');
  out.push('# skillassay never edits your files.');

  if (byFile.size === 0) {
    out.push('#');
    out.push('# No mechanically-deletable findings. Nothing to patch.');
  }

  if (manual.length > 0) {
    out.push('#');
    out.push(`# ${manual.length} finding(s) need a human decision and are NOT in this patch:`);
    for (const finding of manual) {
      out.push(`#   [${finding.ruleId}] ${finding.summary}`);
    }
  }
  out.push('');

  for (const [relPath, ranges] of [...byFile.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const absolute = path.join(result.root, relPath);
    let lines: string[];
    try {
      lines = fs.readFileSync(absolute, 'utf8').split('\n');
    } catch (error) {
      // Refuse to emit a hunk for a file that cannot be read. A patch built on a
      // guess about file contents would corrupt the target on apply.
      out.push(`# SKIPPED ${relPath}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }

    const merged = mergeRanges(ranges);
    out.push(`--- a/${relPath}`);
    out.push(`+++ b/${relPath}`);

    /*
     * `+` start lines accumulate the net change of every earlier hunk in the
     * same file. Emitting the original start line for both sides — as the first
     * version did — produces a patch git rejects once more than one hunk
     * removes lines.
     */
    let offset = 0;

    for (const range of merged) {
      const start = Math.max(1, range.startLine - CONTEXT_LINES);
      const end = Math.min(lines.length, range.endLine + CONTEXT_LINES);

      const oldCount = end - start + 1;
      let removed = 0;
      for (let n = start; n <= end; n++) if (range.deleted.has(n)) removed++;
      const newCount = oldCount - removed;

      out.push(
        `@@ -${start},${oldCount} +${start + offset},${newCount} @@ ${range.ruleIds.join(', ')}`,
      );

      for (let n = start; n <= end; n++) {
        const text = lines[n - 1] ?? '';
        out.push(`${range.deleted.has(n) ? '-' : ' '}${text}`);
      }

      offset -= removed;
    }
    out.push('');
  }

  return out.join('\n');
}
