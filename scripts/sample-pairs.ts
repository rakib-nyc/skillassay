/**
 * Draws a stratified sample of real skill pairs for hand-labelling.
 *
 * Stratification matters: if you sample pairs uniformly at random from a large
 * corpus, essentially all of them have near-zero overlap, and a labelled set of
 * 200 obvious negatives cannot measure precision at the threshold. Sampling
 * evenly across score bands puts pairs on both sides of every candidate
 * threshold, which is what makes the resulting F1 curve meaningful.
 *
 * Usage: tsx scripts/sample-pairs.ts <corpus-dir> <out.json> [perBand]
 */
import fs from 'node:fs';
import { discoverArtifacts } from '../src/discovery/index.js';
import { parseSkill } from '../src/parse/skill.js';
import { normaliseSource } from '../src/parse/frontmatter.js';
import { splitDescription, contentWords } from '../src/text/normalize.js';
import { TfIdfIndex } from '../src/text/similarity.js';
import { scoreTriggerPair } from '../src/analyze/ambiguity.js';

const [corpusDir, outPath, perBandRaw] = process.argv.slice(2);
if (!corpusDir || !outPath) {
  console.error('usage: tsx scripts/sample-pairs.ts <corpus-dir> <out.json> [perBand]');
  process.exit(2);
}
const perBand = Number(perBandRaw ?? 25);

const discovery = discoverArtifacts(corpusDir);
const skills: { name: string; relPath: string; trigger: string; terms: string[] }[] = [];

for (const artifact of discovery.artifacts) {
  if (artifact.kind !== 'skill') continue;
  const parsed = parseSkill(normaliseSource(fs.readFileSync(artifact.path, 'utf8')));
  if (!parsed.ok) continue;
  const split = splitDescription(parsed.value.description);
  if (split.trigger === null) continue;
  const terms = contentWords(split.trigger);
  if (terms.length === 0) continue;
  skills.push({
    name: parsed.value.name,
    relPath: artifact.relPath,
    trigger: split.trigger.replace(/\s+/g, ' ').trim(),
    terms,
  });
}

console.error(`comparable skills: ${skills.length}`);

const tfidf = new TfIdfIndex(skills.map((s) => s.terms));

// Deterministic pseudo-sampling: walk pairs in index order and keep the first
// `perBand` distinct pairs that land in each band. No RNG anywhere — the sample
// is reproducible from the corpus alone.
const BANDS = [
  [0.0, 0.1],
  [0.1, 0.2],
  [0.2, 0.3],
  [0.3, 0.4],
  [0.4, 0.5],
  [0.5, 0.6],
  [0.6, 0.8],
  [0.8, 1.01],
] as const;

const buckets = BANDS.map(() => [] as unknown[]);
const seenPairKey = new Set<string>();

outer: for (let i = 0; i < skills.length; i++) {
  for (let j = i + 1; j < skills.length; j++) {
    const a = skills[i];
    const b = skills[j];
    if (!a || !b) continue;
    // Dedup on the skill-name pair, not on trigger text. Identical trigger text
    // across two differently-named skills is a real and important positive — it
    // is the exact situation a user hits after installing two overlapping skill
    // packs — so it must be sampled, not filtered out.
    const key = a.name < b.name ? `${a.name}||${b.name}` : `${b.name}||${a.name}`;
    if (a.name === b.name || seenPairKey.has(key)) continue;

    const score = scoreTriggerPair(a.terms, b.terms, tfidf).combined;
    const bandIndex = BANDS.findIndex(([lo, hi]) => score >= lo && score < hi);
    if (bandIndex === -1) continue;
    const bucket = buckets[bandIndex];
    if (!bucket || bucket.length >= perBand) continue;

    seenPairKey.add(key);
    bucket.push({
      id: `${bandIndex}-${bucket.length}`,
      band: `${BANDS[bandIndex]?.[0]}-${BANDS[bandIndex]?.[1]}`,
      score: Number(score.toFixed(4)),
      a: { name: a.name, path: a.relPath, trigger: a.trigger },
      b: { name: b.name, path: b.relPath, trigger: b.trigger },
      label: null,
    });

    if (buckets.every((x) => x.length >= perBand)) break outer;
  }
}

const all = buckets.flat();
fs.writeFileSync(outPath, `${JSON.stringify(all, null, 2)}\n`);
console.error(`wrote ${all.length} pairs to ${outPath}`);
for (let i = 0; i < BANDS.length; i++) {
  console.error(`  band ${BANDS[i]?.[0]}-${BANDS[i]?.[1]}: ${buckets[i]?.length ?? 0}`);
}
