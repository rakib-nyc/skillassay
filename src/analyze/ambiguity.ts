import { canonicalName, contentWords } from '../text/normalize.js';
import { TfIdfIndex, jaccard } from '../text/similarity.js';
import type { Finding, SkillRecord } from '../types.js';

/**
 * Tier 1 — selection ambiguity.
 *
 * The core claim of the tool: the description is a routing rule, so two skills
 * that declare the same triggering conditions compete for the same slot and the
 * author no longer controls which one loads.
 *
 * Two things keep this from being the noisy detector the accuracy gate warns about:
 *
 *  - Only *trigger surfaces* are compared, never whole descriptions. Skills that
 *    do similar things on disjoint triggers are legitimate and must not fire.
 *  - The threshold is not a guess. It is chosen by sweeping a hand-labelled set
 *    of real skill pairs for maximum F1 (scripts/calibrate.ts), and the resulting
 *    precision and recall are published in README.md.
 */

/**
 * Trigger-overlap threshold and the precision it actually achieves.
 *
 * CALIBRATED VALUES — regenerate with `npm run calibrate`, do not edit by hand.
 * Nine scorer variants were swept across every threshold on a 124-pair
 * hand-labelled set drawn from 948 real skills; full table in
 * calibration/RESULTS.md.
 *
 * The honest outcome: precision tops out at ~64% for every scorer tried
 * (TF-IDF cosine, content Jaccard, character n-grams, clause-maximum,
 * discriminator-penalised variants). There is no operating point with both
 * useful precision and useful recall — at the only thresholds where precision
 * reaches 100%, recall falls below 10%.
 *
 * the accuracy gate anticipated this exact case: "If the calibrated F1 on the
 * hand-labelled set is poor, ship the budget attribution and redundancy
 * analysis first and hold ambiguity detection back rather than shipping a noisy
 * detector." So AMB-TRIGGER-OVERLAP is OFF by default and must be opted into
 * with `--experimental-ambiguity`. The two ambiguity rules that need no
 * threshold — AMB-DUPLICATE-NAME (exact canonical-name match) and
 * AMB-NO-TRIGGER (deterministic) — remain on by default.
 */
export const TRIGGER_OVERLAP_THRESHOLD = 0.14;
export const TRIGGER_OVERLAP_PRECISION = 0.622;
export const TRIGGER_OVERLAP_RECALL = 0.962;

export interface PairScore {
  readonly contentJaccard: number;
  readonly tfidfCosine: number;
  /** The figure the threshold is applied to. */
  readonly combined: number;
  readonly sharedTerms: readonly string[];
}

/**
 * Score the routing collision risk between two trigger surfaces.
 *
 * TF-IDF cosine, selected by calibration as the best of nine candidates. IDF is
 * computed over the user's own skill set, so vocabulary that is ubiquitous in
 * *this* library is discounted automatically — in a repo of twenty React skills
 * the word "react" carries no routing signal, and a global IDF table could not
 * know that.
 *
 * Falls back to content Jaccard when the corpus is too small for IDF to mean
 * anything (fewer than `MIN_CORPUS_FOR_IDF` skills), because a degenerate IDF
 * table produces confident-looking numbers with nothing behind them.
 */
export function scoreTriggerPair(
  aTerms: readonly string[],
  bTerms: readonly string[],
  index: TfIdfIndex,
): PairScore {
  const setA = new Set(aTerms);
  const setB = new Set(bTerms);
  const shared = [...setA].filter((t) => setB.has(t)).sort();

  const contentJaccard = jaccard(setA, setB);
  const tfidfCosine = index.usable ? index.cosine(aTerms, bTerms) : contentJaccard;

  return {
    contentJaccard,
    tfidfCosine,
    combined: index.usable ? tfidfCosine : contentJaccard,
    sharedTerms: shared,
  };
}

/** Terms used for comparison: the trigger surface when present. */
function triggerTerms(record: SkillRecord): string[] {
  return contentWords(record.triggerSurface ?? '');
}

export interface AmbiguityOptions {
  readonly threshold?: number;
  /**
   * Enables AMB-TRIGGER-OVERLAP. Off by default: its measured precision on the
   * calibration set is 62%, which is too noisy to put in a default report.
   */
  readonly experimentalAmbiguity?: boolean;
}

export interface AmbiguityOutcome {
  readonly findings: readonly Finding[];
  readonly pairsCompared: number;
}

export function analyzeAmbiguity(
  skills: readonly SkillRecord[],
  options: AmbiguityOptions = {},
): AmbiguityOutcome {
  const threshold = options.threshold ?? TRIGGER_OVERLAP_THRESHOLD;
  const findings: Finding[] = [];

  // --- Skills with no declared trigger --------------------------------------
  for (const record of skills) {
    if (record.triggerSurface === null) {
      findings.push({
        ruleId: 'AMB-NO-TRIGGER',
        severity: 'info',
        locations: [{ path: record.artifact.relPath }],
        summary: `Skill "${record.skill.name}" does not say when to use it`,
        evidence: { description: truncate(record.skill.description, 160) },
        suggestion:
          'Add an explicit trigger clause to the description, e.g. "Use when the user asks ' +
          'to …", so the router has a condition to match rather than only a topic.',
        alwaysOnSavings: 0,
      });
    }
  }

  // --- Duplicate canonical names --------------------------------------------
  const byCanonical = new Map<string, SkillRecord[]>();
  for (const record of skills) {
    // Namespaced: two skills only compete if the same harness loads both.
    const key = `${record.artifact.namespace}\u0000${canonicalName(record.skill.name)}`;
    if (canonicalName(record.skill.name).length === 0) continue;
    const bucket = byCanonical.get(key);
    if (bucket) bucket.push(record);
    else byCanonical.set(key, [record]);
  }

  for (const [key, bucket] of [...byCanonical.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (bucket.length < 2) continue;
    const canonical = key.split('\u0000')[1] ?? key;
    const sorted = [...bucket].sort((a, b) =>
      a.artifact.relPath < b.artifact.relPath ? -1 : 1,
    );
    // Report the cluster once, not once per pair: a name duplicated 12 times is
    // one problem, and 66 pairwise findings would bury the report.
    const savings = sorted
      .slice(1)
      .reduce((sum, record) => sum + record.discoveryCost.value, 0);

    findings.push({
      ruleId: 'AMB-DUPLICATE-NAME',
      severity: 'warn',
      locations: sorted.map((r) => ({ path: r.artifact.relPath })),
      summary: `${sorted.length} skills share the canonical name "${canonical}"`,
      evidence: {
        canonicalName: canonical,
        names: sorted.map((r) => r.skill.name).join(', '),
        count: sorted.length,
      },
      suggestion:
        `Keep one skill for "${canonical}" and delete the rest, or rename each to describe the ` +
        'specific case it handles so the descriptions no longer compete.',
      alwaysOnSavings: savings,
    });
  }

  // --- Trigger-surface overlap (opt-in only) --------------------------------
  // Held back from the default path because calibration measured 62% precision.
  // See the constants at the top of this file for the full reasoning.
  if (options.experimentalAmbiguity !== true) {
    return { findings, pairsCompared: 0 };
  }

  const comparable = skills.filter((s) => s.triggerSurface !== null);
  const termsByIndex = comparable.map(triggerTerms);
  const tfidf = new TfIdfIndex(termsByIndex);

  /*
   * Blocking: only compare skills that share at least one content term.
   *
   * This is lossless, not an approximation. Both metrics in the blend are zero
   * when two term sets are disjoint — Jaccard has an empty intersection and the
   * TF-IDF dot product has no shared dimensions — so a skipped pair could never
   * have crossed the threshold. It turns an O(n²) sweep into something that runs
   * on a 40,000-skill registry.
   */
  const postings = new Map<string, number[]>();
  termsByIndex.forEach((terms, i) => {
    for (const term of new Set(terms)) {
      const list = postings.get(term);
      if (list) list.push(i);
      else postings.set(term, [i]);
    }
  });

  const candidates = new Set<string>();
  for (const list of postings.values()) {
    for (let a = 0; a < list.length; a++) {
      for (let b = a + 1; b < list.length; b++) {
        candidates.add(`${list[a]}:${list[b]}`);
      }
    }
  }

  let pairsCompared = 0;
  const overlapFindings: Finding[] = [];

  for (const key of candidates) {
    const [rawI, rawJ] = key.split(':');
    const i = Number(rawI);
    const j = Number(rawJ);
    const a = comparable[i];
    const b = comparable[j];
    const aTerms = termsByIndex[i];
    const bTerms = termsByIndex[j];
    if (!a || !b || !aTerms || !bTerms) continue;

    pairsCompared++;
    const score = scoreTriggerPair(aTerms, bTerms, tfidf);
    if (score.combined < threshold) continue;

    // Suppress pairs already reported as a name-duplicate cluster: it is the
    // same underlying problem and the user should see it once.
    if (canonicalName(a.skill.name) === canonicalName(b.skill.name)) continue;
    // Different harnesses never share a routing surface.
    if (a.artifact.namespace !== b.artifact.namespace) continue;

    overlapFindings.push({
      ruleId: 'AMB-TRIGGER-OVERLAP',
      severity: 'warn',
      locations: [{ path: a.artifact.relPath }, { path: b.artifact.relPath }],
      summary:
        `"${a.skill.name}" and "${b.skill.name}" declare overlapping triggers ` +
        `(${(score.combined * 100).toFixed(0)}% surface overlap)`,
      evidence: {
        skillA: a.skill.name,
        skillB: b.skill.name,
        triggerA: truncate(a.triggerSurface ?? '', 120),
        triggerB: truncate(b.triggerSurface ?? '', 120),
        sharedTerms: score.sharedTerms.join(', '),
        combinedScore: Number(score.combined.toFixed(4)),
        contentJaccard: Number(score.contentJaccard.toFixed(4)),
        tfidfCosine: Number(score.tfidfCosine.toFixed(4)),
        detectorPrecision:
          `${(TRIGGER_OVERLAP_PRECISION * 100).toFixed(0)}% measured on 124 hand-labelled pairs ` +
          `— expect roughly 2 in 5 of these to be wrong`,
      },
      suggestion:
        'Narrow one description so the two trigger conditions are mutually exclusive, or ' +
        'merge the skills if they genuinely serve the same request.',
      alwaysOnSavings: 0,
    });
  }

  // Strongest overlap first, then by path pair, so output is fully determined.
  overlapFindings.sort((x, y) => {
    const sx = Number(x.evidence['combinedScore'] ?? 0);
    const sy = Number(y.evidence['combinedScore'] ?? 0);
    if (sy !== sx) return sy - sx;
    const px = x.locations.map((l) => l.path).join('|');
    const py = y.locations.map((l) => l.path).join('|');
    return px < py ? -1 : px > py ? 1 : 0;
  });

  findings.push(...overlapFindings);
  return { findings, pairsCompared };
}

function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}
