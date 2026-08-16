/**
 * Measures recall for the redundancy rules (the gap the FP census cannot fill).
 *
 * The false-positive census only inspects lines the tool already flagged, so it
 * can say "when it speaks, it is right 94% of the time" and nothing at all about
 * how much it walks past. Recall needs labels drawn independently of the tool.
 *
 * Two measurements, because they answer different questions and neither alone
 * is honest:
 *
 *  1. **Population sample** — every substantive line from every context file in
 *     the corpus, sampled at a fixed stride, labelled by hand. Gives the base
 *     rate of redundant content and an unbiased but low-powered recall estimate.
 *
 *  2. **Curated positives** — lines hand-picked *because* they are redundant.
 *     This is not population recall and is never reported as such; it is a
 *     sharper estimate of "of the things that should be caught, how many are?".
 *
 * Usage: npm run measure:recall -- <corpus>
 */
import fs from 'node:fs';
import path from 'node:path';
import { analyzeRedundancy } from '../src/analyze/redundancy.js';
import { discoverArtifacts } from '../src/discovery/index.js';
import { normaliseSource } from '../src/parse/frontmatter.js';
import { resolveTarget } from '../src/config.js';

const corpusDir = process.argv[2] ?? 'corpus';
const labelFile = path.resolve(import.meta.dirname, '..', 'calibration', 'recall-labels.json');

interface LabelledLine {
  id: string;
  repo: string;
  file: string;
  line: number;
  text: string;
  /** `redundant` = a careful reviewer would say the agent can rediscover this. */
  label: 'redundant' | 'legitimate';
  rationale: string;
}

interface LabelSet {
  criterion: string;
  populationMethod: string;
  curatedMethod: string;
  population: LabelledLine[];
  curated: LabelledLine[];
}

const labels = JSON.parse(fs.readFileSync(labelFile, 'utf8')) as LabelSet;
const target = resolveTarget(undefined);

/** Every (file, line) the redundancy rules flag, across the whole corpus. */
function flaggedLines(): Set<string> {
  const flagged = new Set<string>();
  for (const repo of fs.readdirSync(corpusDir).sort()) {
    const repoDir = path.join(corpusDir, repo);
    if (!fs.statSync(repoDir).isDirectory()) continue;

    const discovery = discoverArtifacts(repoDir);
    const cache = new Map<string, string>();
    const readFile = (p: string): string => {
      const hit = cache.get(p);
      if (hit !== undefined) return hit;
      const text = normaliseSource(fs.readFileSync(p, 'utf8'));
      cache.set(p, text);
      return text;
    };

    for (const finding of analyzeRedundancy({
      artifacts: discovery.artifacts,
      root: repoDir,
      target,
      readFile,
    })) {
      const deletion = finding.deletion;
      if (!deletion) continue;
      /*
       * Membership in a proposed deletion range, not just the anchor line.
       * If `--fix` would remove a line, that line is "caught" for recall and
       * "collateral" if it was legitimate — which is exactly what a user
       * applying the patch experiences.
       */
      for (let n = deletion.startLine; n <= deletion.endLine; n++) {
        flagged.add(`${repo}|${deletion.path}|${n}`);
      }
    }
  }
  return flagged;
}

const flagged = flaggedLines();

interface Score {
  tp: number;
  fp: number;
  fn: number;
  tn: number;
}

function score(set: readonly LabelledLine[]): Score {
  const result: Score = { tp: 0, fp: 0, fn: 0, tn: 0 };
  for (const item of set) {
    const predicted = flagged.has(`${item.repo}|${item.file}|${item.line}`);
    const actual = item.label === 'redundant';
    if (predicted && actual) result.tp++;
    else if (predicted && !actual) result.fp++;
    else if (!predicted && actual) result.fn++;
    else result.tn++;
  }
  return result;
}

/** Wilson score interval — honest about small n, unlike a bare proportion. */
function wilson(successes: number, total: number): [number, number] {
  if (total === 0) return [0, 1];
  const z = 1.96;
  const p = successes / total;
  const denominator = 1 + (z * z) / total;
  const centre = p + (z * z) / (2 * total);
  const spread = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * total)) / total);
  return [(centre - spread) / denominator, (centre + spread) / denominator];
}

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const population = score(labels.population);
const curated = score(labels.curated);

const populationRecall = population.tp + population.fn === 0 ? 0 : population.tp / (population.tp + population.fn);
/*
 * Collateral rate, not precision.
 *
 * Precision is already measured per-finding by the hand census in
 * FALSE_POSITIVES.md. What this set adds is different and cannot be measured
 * there: of the legitimate lines in a context file, what share would `--fix`
 * delete? Section-level findings remove a whole block, so a correct finding can
 * still take good content with it, and a user applying the patch feels that
 * loss regardless of whether the finding was "right".
 */
const collateralRate =
  population.fp + population.tn === 0 ? 0 : population.fp / (population.fp + population.tn);
const curatedRecall = curated.tp + curated.fn === 0 ? 0 : curated.tp / (curated.tp + curated.fn);

const [prLow, prHigh] = wilson(population.tp, population.tp + population.fn);
const [crLow, crHigh] = wilson(curated.tp, curated.tp + curated.fn);
const baseRate = labels.population.filter((l) => l.label === 'redundant').length / labels.population.length;

const md: string[] = [];
md.push('# Recall');
md.push('');
md.push('Generated by `npm run measure:recall`. Do not edit by hand.');
md.push('');
md.push(
  'The false-positive census in `FALSE_POSITIVES.md` inspects only lines the tool already ' +
    'flagged, so it measures precision and is structurally incapable of measuring what the ' +
    'tool misses. These labels were drawn without reference to any rule.',
);
md.push('');
md.push(`**Labelling criterion.** ${labels.criterion}`);
md.push('');

md.push('## 1. Population sample (unbiased)');
md.push('');
md.push(labels.populationMethod);
md.push('');
md.push(`- Lines labelled: **${labels.population.length}**`);
md.push(`- Redundant content base rate: **${pct(baseRate)}**`);
md.push('');
md.push('| | Inside a proposed deletion | Untouched |');
md.push('|---|---:|---:|');
md.push(`| **Labelled redundant** | ${population.tp} | ${population.fn} |`);
md.push(`| **Labelled legitimate** | ${population.fp} | ${population.tn} |`);
md.push('');
md.push(
  `- **Recall ${pct(populationRecall)}** (95% CI ${pct(prLow)}–${pct(prHigh)}) — of redundant ` +
    'lines present, this share is caught.',
);
md.push(
  `- **Collateral ${pct(collateralRate)}** — of lines labelled legitimate, this share falls ` +
    'inside a proposed deletion range and would be removed by `--fix`. Section-level findings ' +
    'delete a whole block, so this is not the same as precision (measured per finding in ' +
    '`FALSE_POSITIVES.md`) and is the number that matters when applying a patch.',
);
md.push('');
md.push(
  `> The interval is wide because redundant lines are rare: only ${population.tp + population.fn} ` +
    `of ${labels.population.length} sampled lines are positives. A tighter population estimate ` +
    'needs a far larger hand-labelled sample. This is stated rather than hidden behind a ' +
    'point estimate.',
);
md.push('');

md.push('## 2. Curated positives (higher power, biased by construction)');
md.push('');
md.push(labels.curatedMethod);
md.push('');
md.push(`- Known-redundant lines: **${curated.tp + curated.fn}**`);
md.push(`- Caught: **${curated.tp}** · Missed: **${curated.fn}**`);
md.push(`- **Recall ${pct(curatedRecall)}** (95% CI ${pct(crLow)}–${pct(crHigh)})`);
md.push('');
md.push(
  '> This is **not** population recall. The set was assembled by looking for redundant ' +
    'content, so it over-represents forms that are easy to find by eye. Read it as "of the ' +
    'clear-cut cases, how many are caught?".',
);
md.push('');

md.push('## What is missed, by class');
md.push('');
md.push('| Missed line | Why it is redundant | Why the tool misses it |');
md.push('|---|---|---|');
for (const item of [...labels.population, ...labels.curated]) {
  if (item.label !== 'redundant') continue;
  if (flagged.has(`${item.repo}|${item.file}|${item.line}`)) continue;
  const text = item.text.trim().replace(/\|/g, '\\|').slice(0, 70);
  md.push(`| \`${text}\` | ${item.rationale} | see below |`);
}
md.push('');

fs.writeFileSync(
  path.resolve(import.meta.dirname, '..', 'calibration', 'RECALL.md'),
  `${md.join('\n')}\n`,
);

console.log(`population: recall ${pct(populationRecall)} (${population.tp}/${population.tp + population.fn}), collateral ${pct(collateralRate)} (${population.fp}/${population.fp + population.tn})`);
console.log(`  base rate of redundant lines: ${pct(baseRate)}`);
console.log(`curated:    recall ${pct(curatedRecall)} (${curated.tp}/${curated.tp + curated.fn})`);
console.log('\nWrote calibration/RECALL.md');
