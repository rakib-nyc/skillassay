/**
 * Threshold calibration.
 *
 * The calibration rule: thresholds are chosen by sweeping a labelled set, not
 * guessed. Select
 * the threshold that maximizes F1. Document the resulting precision and recall
 * in the README. A similarity tool that will not state its false-positive rate
 * is not a measurement instrument."
 *
 * This sweeps several candidate scorers across all thresholds on the
 * hand-labelled set and writes calibration/RESULTS.md. It reports whatever the
 * numbers are — including when they are bad.
 *
 * Usage: npm run calibrate
 */
import fs from 'node:fs';
import { contentWords } from '../src/text/normalize.js';
import { TfIdfIndex, jaccard, charNgramJaccard } from '../src/text/similarity.js';

interface LabelledPair {
  id: string;
  score: number;
  a: { name: string; trigger: string };
  b: { name: string; trigger: string };
  label: 'collide' | 'distinct';
  rationale: string;
}

interface LabelledSet {
  criterion: string;
  provenance: string;
  labelledBy: string;
  counts: { total: number; collide: number; distinct: number };
  pairs: LabelledPair[];
}

const set = JSON.parse(fs.readFileSync('calibration/labelled-pairs.json', 'utf8')) as LabelledSet;

// IDF is built over the trigger surfaces present in the labelled set. This
// mirrors deployment, where IDF comes from the user's own installed skills.
const allTerms = set.pairs.flatMap((p) => [contentWords(p.a.trigger), contentWords(p.b.trigger)]);
const tfidf = new TfIdfIndex(allTerms);

type Scorer = (a: string, b: string) => number;

const SCORERS: Record<string, Scorer> = {
  contentJaccard: (a, b) => jaccard(new Set(contentWords(a)), new Set(contentWords(b))),
  tfidfCosine: (a, b) => tfidf.cosine(contentWords(a), contentWords(b)),
  charNgram4: (a, b) => charNgramJaccard(a, b, 4),
  'blend(jaccard+tfidf)/2': (a, b) => {
    const j = jaccard(new Set(contentWords(a)), new Set(contentWords(b)));
    return (j + tfidf.cosine(contentWords(a), contentWords(b))) / 2;
  },
  'max(jaccard,tfidf)': (a, b) => {
    const j = jaccard(new Set(contentWords(a)), new Set(contentWords(b)));
    return Math.max(j, tfidf.cosine(contentWords(a), contentWords(b)));
  },
  /*
   * Discriminator-aware scorers.
   *
   * Motivated by reading the labelled set rather than by theory. Nearly every
   * false positive of the plain-similarity scorers had the same shape: two
   * skills sharing generic framing vocabulary ("when the user runs … or asks
   * to …", "when using or adopting …") while each names a *different* specific
   * thing — /ar:loop vs /ar:status, spf13/cobra vs spf13/viper, sast-sqli vs
   * sast-xxe. That specific thing is exactly the discriminator my labelling
   * criterion looks for, and it shows up as a rare (high-IDF) term present in
   * one trigger and absent from the other.
   *
   * So: when BOTH sides carry a rare term the other lacks, the router does have
   * a documented basis to choose, and the similarity is discounted.
   */
  'tfidf×discriminator(0.5)': (a, b) => discriminatorScorer(a, b, 0.5),
  'tfidf×discriminator(0.35)': (a, b) => discriminatorScorer(a, b, 0.35),
  'tfidf×discriminator(0.65)': (a, b) => discriminatorScorer(a, b, 0.65),
};

/*
 * Clause-level scorers.
 *
 * Hypothesis, formed from reading the labelled set: a trigger is usually a LIST
 * of alternatives — "when the user asks to X, Y, or Z". Two skills collide when
 * *any single* alternative of A matches *any single* alternative of B, because
 * that one shared alternative is a request that fires both. Whole-trigger cosine
 * averages that single strong match against four unrelated alternatives and
 * dilutes it away, which is why the whole-trigger scorers cap out near 62%
 * precision no matter where the threshold goes.
 *
 * Max-over-clauses models the actual question — "does a request exist that
 * matches both?" — instead of "are these two descriptions similar overall?".
 */
function clauses(trigger: string): string[][] {
  return trigger
    .split(/[,;]|\bor\b|\.\s|\band then\b/i)
    .map((part) => contentWords(part))
    .filter((terms) => terms.length > 0);
}

function clauseMaxScorer(a: string, b: string): number {
  const clausesA = clauses(a);
  const clausesB = clauses(b);
  let best = 0;
  for (const ca of clausesA) {
    for (const cb of clausesB) {
      const score = tfidf.cosine(ca, cb);
      if (score > best) best = score;
    }
  }
  return best;
}

/** Max-over-clauses, tempered by whole-trigger similarity to damp one-word hits. */
function clauseBlendScorer(a: string, b: string): number {
  const whole = tfidf.cosine(contentWords(a), contentWords(b));
  return Math.sqrt(clauseMaxScorer(a, b) * Math.max(whole, 0.01));
}

SCORERS['clauseMax'] = clauseMaxScorer;
SCORERS['clauseBlend'] = clauseBlendScorer;

/*
 * Sharper sibling-entity variants: penalise only when the unique terms are in
 * the top decile of IDF, i.e. genuine proper identifiers rather than merely
 * uncommon words.
 */
const SHARP_IDF = () => tfidf.idfQuantile(0.9);
for (const penalty of [0.2, 0.4]) {
  SCORERS[`sharpSibling(${penalty})`] = (a, b) => {
    const aTerms = contentWords(a);
    const bTerms = contentWords(b);
    const base = tfidf.cosine(aTerms, bTerms);
    const setA = new Set(aTerms);
    const setB = new Set(bTerms);
    const cut = SHARP_IDF();
    const rareA = [...setA].some((t) => !setB.has(t) && tfidf.idfOf(t) >= cut);
    const rareB = [...setB].some((t) => !setA.has(t) && tfidf.idfOf(t) >= cut);
    return rareA && rareB ? base * penalty : base;
  };
}

/** IDF above which a term counts as specific enough to discriminate. */
const DISCRIMINATOR_IDF = tfidf.idfQuantile(0.6);

function discriminatorScorer(a: string, b: string, penalty: number): number {
  const aTerms = contentWords(a);
  const bTerms = contentWords(b);
  const base = tfidf.cosine(aTerms, bTerms);

  const setA = new Set(aTerms);
  const setB = new Set(bTerms);
  const rareUniqueA = [...setA].filter((t) => !setB.has(t) && tfidf.idfOf(t) >= DISCRIMINATOR_IDF);
  const rareUniqueB = [...setB].filter((t) => !setA.has(t) && tfidf.idfOf(t) >= DISCRIMINATOR_IDF);

  const bothDiscriminate = rareUniqueA.length > 0 && rareUniqueB.length > 0;
  return bothDiscriminate ? base * penalty : base;
}

interface Point {
  threshold: number;
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  precision: number;
  recall: number;
  f1: number;
}

function evaluate(scorer: Scorer, threshold: number): Point {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;

  for (const pair of set.pairs) {
    const predicted = scorer(pair.a.trigger, pair.b.trigger) >= threshold;
    const actual = pair.label === 'collide';
    if (predicted && actual) tp++;
    else if (predicted && !actual) fp++;
    else if (!predicted && actual) fn++;
    else tn++;
  }

  const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { threshold, tp, fp, fn, tn, precision, recall, f1 };
}

const results: { name: string; best: Point; curve: Point[] }[] = [];

for (const [name, scorer] of Object.entries(SCORERS)) {
  const curve: Point[] = [];
  for (let t = 0.02; t <= 0.98; t += 0.01) {
    curve.push(evaluate(scorer, Number(t.toFixed(2))));
  }
  // Ties broken toward higher precision: a false contradiction/collision claim
  // costs more trust than a miss (§6.4, §11).
  const best = [...curve].sort(
    (x, y) => y.f1 - x.f1 || y.precision - x.precision || x.threshold - y.threshold,
  )[0];
  if (best) results.push({ name, best, curve });
}

results.sort((a, b) => b.best.f1 - a.best.f1);

const winner = results[0];
if (!winner) throw new Error('No scorers evaluated');

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const DEEP_SECTION: readonly string[] = [
  '',
  '## Why `--deep` (local embeddings) is not implemented',
  '',
  'the design requirements gates the semantic layer on "step 7\'s numbers justifying it".',
  'They do not — but the more useful reason is *why*, and it is a reasoned',
  'prediction rather than a measurement, so it is labelled as one.',
  '',
  'The dominant failure class is not a similarity problem. Reading every',
  'misclassified pair above, the false positives are overwhelmingly **sibling',
  'skills that share a frame and differ by one named entity**:',
  '',
  '| Pair | Shared frame | Discriminator |',
  '|---|---|---|',
  '| `loop` × `status` | "when the user runs /ar:… or asks to …" | `loop` vs `status` |',
  '| `golang-spf13-cobra` × `golang-spf13-viper` | "when using or adopting …, or when the codebase imports …" | `cobra` vs `viper` |',
  '| `sast-sqli` × `sast-xxe` | "when asked to find … bugs" | `SQLi` vs `XXE` |',
  '',
  'Deciding these correctly requires answering *"does A\'s stated trigger **exclude**',
  'a request matching B\'s?"* — an entailment question. A sentence embedding answers',
  '*"how similar are these?"*, and on these pairs the honest answer is "extremely",',
  'because they are near-identical by construction. A semantic model would likely',
  'score them **higher** than the lexical scorers do, not lower.',
  '',
  'So embeddings are the wrong instrument for this failure, and adding a model',
  'download to an offline-first tool to make the dominant error worse is not a',
  'trade worth making. What would plausibly work is an entailment or NLI-style',
  'judgement over trigger pairs, which means an LLM call — non-deterministic, and',
  'therefore behind an explicit flag if it is ever built.',
  '',
  'This is a prediction. It has not been tested, and it is recorded here so that',
  'anyone who does test it can say whether it was right.',
];

const md: string[] = [];

md.push('# Threshold calibration');
md.push('');
md.push('Generated by `npm run calibrate`. Do not edit by hand.');
md.push('');
md.push('## Labelled set');
md.push('');
md.push(`- Pairs: **${set.counts.total}** (${set.counts.collide} colliding, ${set.counts.distinct} distinct)`);
md.push(`- Provenance: ${set.provenance}`);
md.push(`- Labelling criterion: ${set.criterion}`);
md.push(`- Annotators: ${set.labelledBy}`);
md.push('');
md.push('## Scorer comparison (best F1 per scorer)');
md.push('');
md.push('| Scorer | Threshold | Precision | Recall | F1 | TP | FP | FN | TN |');
md.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|');
for (const { name, best } of results) {
  md.push(
    `| \`${name}\` | ${best.threshold.toFixed(2)} | ${pct(best.precision)} | ${pct(best.recall)} | ` +
      `${best.f1.toFixed(3)} | ${best.tp} | ${best.fp} | ${best.fn} | ${best.tn} |`,
  );
}
md.push('');
md.push(`## Selected: \`${winner.name}\` at threshold ${winner.best.threshold.toFixed(2)}`);
md.push('');
md.push(`- **Precision ${pct(winner.best.precision)}** — of the pairs the tool flags, this share are real collisions.`);
md.push(`- **Recall ${pct(winner.best.recall)}** — of the real collisions in the set, this share are flagged.`);
md.push(`- **False-positive rate ${pct(winner.best.fp / (winner.best.fp + winner.best.tn))}** — of genuinely distinct pairs, this share are wrongly flagged.`);
md.push(`- F1 ${winner.best.f1.toFixed(3)}`);
md.push('');
md.push('## Precision/recall trade-off for the selected scorer');
md.push('');
md.push('| Threshold | Precision | Recall | F1 |');
md.push('|---:|---:|---:|---:|');
for (const point of winner.curve.filter((p) => Math.round(p.threshold * 100) % 5 === 0)) {
  md.push(
    `| ${point.threshold.toFixed(2)} | ${pct(point.precision)} | ${pct(point.recall)} | ${point.f1.toFixed(3)} |`,
  );
}
md.push('');
md.push('## Misclassified pairs at the selected threshold');
md.push('');
md.push('Listed in full rather than summarised: these are the cases where the shipped');
md.push('detector is wrong, and a reader deciding whether to trust it needs to see them.');
md.push('');

const scorer = SCORERS[winner.name];
if (scorer) {
  const errors = set.pairs
    .map((pair) => ({ pair, score: scorer(pair.a.trigger, pair.b.trigger) }))
    .filter(({ pair, score }) => (score >= winner.best.threshold) !== (pair.label === 'collide'));

  md.push('| Pair | Score | Labelled | Predicted | Why it was labelled that way |');
  md.push('|---|---:|---|---|---|');
  for (const { pair, score } of errors) {
    const predicted = score >= winner.best.threshold ? 'collide' : 'distinct';
    md.push(
      `| \`${pair.a.name}\` × \`${pair.b.name}\` | ${score.toFixed(3)} | ${pair.label} | ` +
        `${predicted} | ${pair.rationale} |`,
    );
  }
}
md.push('');

/*
 * Appended by the generator, not by hand. This section was originally written
 * straight into RESULTS.md, and the CI reproducibility check caught it on the
 * very first push: `npm run calibrate` rewrites the file, so anything added by
 * hand silently disappears. Generated files have one author.
 */
md.push(...DEEP_SECTION);

fs.writeFileSync('calibration/RESULTS.md', `${md.join('\n')}\n`);

console.log(`\nBest scorer: ${winner.name} @ ${winner.best.threshold.toFixed(2)}`);
console.log(
  `  precision ${pct(winner.best.precision)}  recall ${pct(winner.best.recall)}  F1 ${winner.best.f1.toFixed(3)}`,
);
console.log('\nAll scorers:');
for (const { name, best } of results) {
  console.log(
    `  ${name.padEnd(24)} t=${best.threshold.toFixed(2)}  P=${pct(best.precision).padStart(6)}  R=${pct(best.recall).padStart(6)}  F1=${best.f1.toFixed(3)}`,
  );
}
console.log('\nWrote calibration/RESULTS.md');
