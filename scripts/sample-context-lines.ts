/**
 * Draws a labelling sample of real context-file lines.
 *
 * The false-positive census answers "when the tool speaks, is it right?".
 * It cannot answer "how much does the tool miss?", because it only ever looks
 * at lines the tool already flagged. Measuring recall needs a sample drawn
 * *independently of what the tool does*, labelled by hand, and then compared
 * against the tool's output.
 *
 * So this samples substantive lines from real `CLAUDE.md` / `AGENTS.md` /
 * `GEMINI.md` files with no reference to any rule, at a fixed stride. No RNG,
 * and the sample cannot be redrawn until it looks favourable.
 *
 * Usage: tsx scripts/sample-context-lines.ts <corpus> <out.json> [target]
 */
import fs from 'node:fs';
import path from 'node:path';
import { discoverArtifacts } from '../src/discovery/index.js';
import { normaliseSource } from '../src/parse/frontmatter.js';

const [corpusDir, outPath, targetRaw] = process.argv.slice(2);
if (!corpusDir || !outPath) {
  console.error('usage: tsx scripts/sample-context-lines.ts <corpus> <out.json> [target]');
  process.exit(2);
}
const targetSize = Number(targetRaw ?? 200);

interface Candidate {
  repo: string;
  file: string;
  line: number;
  text: string;
}

const candidates: Candidate[] = [];

for (const repo of fs.readdirSync(corpusDir).sort()) {
  const repoDir = path.join(corpusDir, repo);
  if (!fs.statSync(repoDir).isDirectory()) continue;

  for (const artifact of discoverArtifacts(repoDir).artifacts) {
    if (artifact.kind !== 'context_file') continue;
    const lines = normaliseSource(fs.readFileSync(artifact.path, 'utf8')).split('\n');

    let inFence = false;
    lines.forEach((raw, index) => {
      if (/^\s*(?:```|~~~)/.test(raw)) {
        inFence = !inFence;
        return;
      }
      const text = raw.trim();
      // Skip what no rule could sensibly judge: blank lines, pure punctuation,
      // and table separators. Fenced code is skipped above — but note that a
      // directory tree usually lives inside a fence, so tree lines are excluded
      // from this sample and recall for RED-REPO-OVERVIEW is measured on
      // headings and bullets only. Stated rather than hidden.
      if (text.length < 4) return;
      if (/^[|\s:*_-]+$/.test(text)) return;

      candidates.push({ repo, file: artifact.relPath, line: index + 1, text: raw });
    });
  }
}

candidates.sort((a, b) => {
  const ka = `${a.repo}|${a.file}|${String(a.line).padStart(6, '0')}`;
  const kb = `${b.repo}|${b.file}|${String(b.line).padStart(6, '0')}`;
  return ka < kb ? -1 : ka > kb ? 1 : 0;
});

const stride = Math.max(1, Math.floor(candidates.length / targetSize));
const sample: (Candidate & { id: string; label: null })[] = [];
for (let i = 0; i < candidates.length && sample.length < targetSize; i += stride) {
  const candidate = candidates[i];
  if (!candidate) continue;
  sample.push({ ...candidate, id: `L${sample.length}`, label: null });
}

fs.writeFileSync(
  outPath,
  `${JSON.stringify(
    {
      method:
        `All substantive lines from every context file in the corpus (${candidates.length} lines), ` +
        `sorted by (repo, file, line) and sampled at a fixed stride of ${stride}. ` +
        'Drawn without reference to any rule, so it measures what the tool misses as well ' +
        'as what it gets wrong. Deterministic: no RNG.',
      population: candidates.length,
      stride,
      sampleSize: sample.length,
      lines: sample,
    },
    null,
    2,
  )}\n`,
);

console.error(`population ${candidates.length}, stride ${stride}, sampled ${sample.length}`);
