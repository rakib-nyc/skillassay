import { contentWords, sentences } from '../text/normalize.js';
import { TfIdfIndex, jaccard } from '../text/similarity.js';
import { scoreTriggerPair, TRIGGER_OVERLAP_THRESHOLD } from './ambiguity.js';
import type { Finding, Severity, SkillRecord } from '../types.js';

/**
 * Tier 2 — contradiction detection.
 *
 * build normalised (subject, polarity, object) triples from
 * imperative sentences and flag polarity conflicts, with precision preferred
 * over recall because a false contradiction claim is worse than a miss.
 *
 * Severity is weighted by co-activation (§2.4): two skills that contradict each
 * other but never load together cannot actually conflict, so they are `info`.
 * Only overlapping triggers make a contradiction reachable, and those are
 * `error`.
 */

type Polarity = 'require' | 'forbid';

interface Directive {
  readonly polarity: Polarity;
  readonly objectTerms: ReadonlySet<string>;
  readonly sentence: string;
  readonly line: number;
}

/**
 * Markers, longest-first so "must not" is read as a prohibition rather than as
 * "must" followed by noise. Order within each array is significant.
 */
const FORBID_MARKERS: readonly RegExp[] = [
  /\bmust\s+not\b/i,
  /\bshould\s+not\b/i,
  /\bdo\s+not\b/i,
  /\bdon['’]t\b/i,
  /\bnever\b/i,
  /\bavoid\b/i,
  /\brefrain\s+from\b/i,
];

const REQUIRE_MARKERS: readonly RegExp[] = [
  /\balways\b/i,
  /\bmust\b/i,
  /\bshould\b/i,
  /\bprefer\b/i,
  /\bensure\s+(?:that\s+)?\b/i,
  /\bmake\s+sure\s+(?:that\s+)?\b/i,
];

/**
 * Mutually exclusive style dimensions.
 *
 * This is a lexicon, not a research finding, and it is declared as data so its
 * scope is visible rather than buried in a conditional. It exists because two
 * *positive* instructions can conflict without any negation being present:
 * "always use tabs" and "always use spaces" are both `require`, so the polarity
 * check alone cannot see the contradiction.
 *
 * The list is deliberately small. Every entry is a choice where picking one
 * option genuinely excludes the others in the same codebase.
 */
const EXCLUSIVE_DIMENSIONS: readonly { dimension: string; options: Record<string, readonly string[]> }[] = [
  {
    dimension: 'string quote style',
    options: {
      single: ['single quotes', "single-quotes", 'single quote'],
      double: ['double quotes', 'double-quotes', 'double quote'],
    },
  },
  {
    dimension: 'indentation',
    options: { tabs: ['tabs', 'tab indentation'], spaces: ['spaces', 'space indentation'] },
  },
  {
    dimension: 'semicolons',
    options: { required: ['semicolons', 'semi-colons'], omitted: ['no semicolons', 'without semicolons'] },
  },
  {
    dimension: 'module export style',
    options: { named: ['named exports'], default: ['default exports', 'default export'] },
  },
  {
    dimension: 'TypeScript object typing',
    options: { interface: ['interfaces', 'interface'], typeAlias: ['type aliases', 'type alias'] },
  },
  /*
   * Package manager (npm / yarn / pnpm / bun) was here and has been removed.
   *
   * It cannot work. Tool names appear constantly inside command examples —
   * "Run `npm run build`" is not a declaration that npm is preferred — so the
   * dimension cannot tell a preference from an incidental mention. On the
   * corpus it produced only false positives.
   *
   * A dimension belongs here only if naming the option is itself the assertion.
   */
];

/**
 * Lines that look like instructions but are not.
 *
 * Every entry here came from reviewing false positives on the 1,022-skill
 * corpus, where the detector was reporting rhetorical questions, markdown table
 * cells and section headings as contradictory instructions. Each of those is a
 * confident-sounding claim about something the author never asserted, which is
 * exactly the kind of finding that destroys trust in the whole report.
 */
function isNonDirectiveLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0) return true;
  // Markdown heading: a section title, not an instruction.
  if (/^#{1,6}\s/.test(trimmed)) return true;
  // Table row: "| Self-invoke | ❌ Always blocked |" is a cell, not a directive.
  if (/^\|/.test(trimmed)) return true;
  // Table separator.
  if (/^[|\s:-]+$/.test(trimmed)) return true;
  return false;
}

function extractDirectives(text: string): Directive[] {
  const directives: Directive[] = [];
  const lines = text.split('\n');
  let inFence = false;

  lines.forEach((rawLine, lineIndex) => {
    // Fenced code is example content, not instructions to the model.
    if (/^\s*(?:```|~~~)/.test(rawLine)) {
      inFence = !inFence;
      return;
    }
    if (inFence || isNonDirectiveLine(rawLine)) return;

    for (const sentence of sentences(rawLine)) {
      // Interrogatives. "What explicitly should NOT be built?" is a prompt for
      // the reader, not a rule, and reading it as one inverts its meaning.
      if (sentence.trimEnd().endsWith('?')) continue;
      /*
       * Labels and headings that introduce content, rather than assert it.
       *
       * Real examples that produced false contradictions:
       *   "- You MUST use this skill for design → code:"
       *   "**Trigger:** library organism/tissue/modifications do not match…"
       * The first is a heading over a list; the second names a failure
       * condition. Both end in a colon, both were compared as if they were
       * imperatives, and both matched an unrelated line on two stray words.
       */
      if (sentence.trimEnd().endsWith(':')) continue;
      // Prohibitions are tested first: "must not" contains "must", and reading
      // it as a requirement would invert the meaning of the instruction.
      let polarity: Polarity | null = null;
      let markerEnd = -1;

      for (const marker of FORBID_MARKERS) {
        const m = marker.exec(sentence);
        if (m) {
          polarity = 'forbid';
          markerEnd = m.index + m[0].length;
          break;
        }
      }

      if (polarity === null) {
        for (const marker of REQUIRE_MARKERS) {
          const m = marker.exec(sentence);
          if (m) {
            polarity = 'require';
            markerEnd = m.index + m[0].length;
            break;
          }
        }
      }

      if (polarity === null) continue;

      const objectText = sentence.slice(markerEnd);
      const terms = contentWords(objectText);
      // A directive with no object is not actionable and cannot be compared.
      if (terms.length === 0) continue;

      directives.push({
        polarity,
        objectTerms: new Set(terms),
        sentence: sentence.trim(),
        line: lineIndex + 1,
      });
    }
  });

  return directives;
}

/**
 * Object-overlap required before two opposed directives are called a conflict.
 *
 * Set high on purpose. At 0.6 the two directives must be talking about
 * substantially the same thing, which is what keeps "never commit secrets" and
 * "always commit early" — which share the word "commit" — from being reported
 * as a contradiction.
 */
const OBJECT_OVERLAP_THRESHOLD = 0.6;

/**
 * Minimum number of shared content words before two opposed directives count as
 * being about the same thing.
 *
 * One shared word is not enough, and corpus review proved it: "should we build
 * X" and "don't build it" share exactly the word "build", score a perfect 1.0
 * Jaccard on a one-element set, and are not remotely a contradiction. Requiring
 * two substantive shared terms removes that entire class.
 */
const MIN_SHARED_OBJECT_TERMS = 2;

function findDimensionClash(
  a: Directive,
  b: Directive,
  textA: string,
  textB: string,
): { dimension: string; optionA: string; optionB: string } | null {
  if (a.polarity !== 'require' || b.polarity !== 'require') return null;

  const lowerA = textA.toLowerCase();
  const lowerB = textB.toLowerCase();

  /*
   * Word-boundary matching, not substring.
   *
   * `"...audits a bundle".includes("bun")` is true, which matched the bun
   * package manager against the word "bundle" and reported a contradiction
   * between two skills that agreed about everything. Every remaining conflict
   * finding on the 1,022-skill corpus came from that one bug.
   */
  const mentions = (haystack: string, phrase: string): boolean =>
    new RegExp(`\\b${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(haystack);

  for (const { dimension, options } of EXCLUSIVE_DIMENSIONS) {
    const entries = Object.entries(options);
    const matchedA = entries.filter(([, phrases]) => phrases.some((p) => mentions(lowerA, p)));
    const matchedB = entries.filter(([, phrases]) => phrases.some((p) => mentions(lowerB, p)));

    if (matchedA.length !== 1 || matchedB.length !== 1) continue;
    const optionA = matchedA[0]?.[0];
    const optionB = matchedB[0]?.[0];
    if (!optionA || !optionB || optionA === optionB) continue;

    return { dimension, optionA, optionB };
  }
  return null;
}

export interface ContextFileDirectives {
  readonly relPath: string;
  readonly text: string;
}

export function analyzeConflicts(
  skills: readonly SkillRecord[],
  contextFiles: readonly ContextFileDirectives[] = [],
): Finding[] {
  const findings: Finding[] = [];

  const skillDirectives = skills.map((record) => ({
    record,
    directives: extractDirectives(record.skill.body),
  }));

  // Co-activation model: reuse the Tier 1 trigger-overlap score, so "can these
  // two ever be loaded together?" is answered by the same measurement that
  // powers ambiguity rather than by a second, inconsistent heuristic.
  const comparable = skills.filter((s) => s.triggerSurface !== null);
  // Tokenise each trigger exactly once. Doing it inside the pair loop meant
  // re-tokenising the same string O(n) times and dominated the whole run: 790
  // skills took 13.9s, almost all of it here.
  const triggerTermCache = new Map<SkillRecord, string[]>();
  for (const record of skills) {
    triggerTermCache.set(record, contentWords(record.triggerSurface ?? ''));
  }
  const tfidf = new TfIdfIndex(comparable.map((s) => triggerTermCache.get(s) ?? []));

  const coActivationCache = new Map<string, boolean>();
  const coActivates = (a: SkillRecord, b: SkillRecord): boolean => {
    if (a.triggerSurface === null || b.triggerSurface === null) return false;
    const key = `${a.artifact.relPath} ${b.artifact.relPath}`;
    const cached = coActivationCache.get(key);
    if (cached !== undefined) return cached;
    const score = scoreTriggerPair(
      triggerTermCache.get(a) ?? [],
      triggerTermCache.get(b) ?? [],
      tfidf,
    );
    const result = score.combined >= TRIGGER_OVERLAP_THRESHOLD;
    coActivationCache.set(key, result);
    return result;
  };

  /*
   * Blocking on shared object terms.
   *
   * A polarity clash requires at least MIN_SHARED_OBJECT_TERMS shared content
   * words between the two directives, and a dimension clash requires both sides
   * to name an option from the same dimension. Either way the two directives
   * must share vocabulary, so an inverted index over object terms reaches every
   * candidate pair without changing the result — the same lossless trick the
   * ambiguity pass uses.
   *
   * The previous nested sweep compared every directive of every skill against
   * every directive of every other skill: on 790 skills that is ~312,000 skill
   * pairs before you even reach the directives.
   */
  interface Posting {
    readonly skillIndex: number;
    readonly directiveIndex: number;
  }
  const postings = new Map<string, Posting[]>();
  skillDirectives.forEach((entry, skillIndex) => {
    entry.directives.forEach((directive, directiveIndex) => {
      for (const term of directive.objectTerms) {
        const bucket = postings.get(term);
        const posting = { skillIndex, directiveIndex };
        if (bucket) bucket.push(posting);
        else postings.set(term, [posting]);
      }
    });
  });

  const candidatePairs = new Set<string>();
  for (const bucket of postings.values()) {
    // A term shared by hundreds of directives is boilerplate ("code", "file")
    // and cannot by itself indicate a clash; the real signal always co-occurs
    // with a rarer term, which reaches the same pairs through a smaller bucket.
    if (bucket.length > 300) continue;
    for (let a = 0; a < bucket.length; a++) {
      for (let b = a + 1; b < bucket.length; b++) {
        const left = bucket[a];
        const right = bucket[b];
        if (!left || !right || left.skillIndex === right.skillIndex) continue;
        const [x, y] =
          left.skillIndex < right.skillIndex ? [left, right] : [right, left];
        candidatePairs.add(`${x.skillIndex}:${x.directiveIndex}:${y.skillIndex}:${y.directiveIndex}`);
      }
    }
  }

  // --- skill vs skill --------------------------------------------------------
  for (const key of [...candidatePairs].sort()) {
    const [si, di, sj, dj] = key.split(':').map(Number) as [number, number, number, number];
    const left = skillDirectives[si];
    const right = skillDirectives[sj];
    if (!left || !right) continue;

    // The same skill vendored into two harness directories (.codex/ and
    // .gemini/, say) is one skill, not two that disagree. Comparing it with
    // itself produced a large share of the corpus false positives. Duplication
    // is already reported by AMB-DUPLICATE-NAME.
    if (left.record.skill.body === right.record.skill.body) continue;
    // Skills under different harness roots are never loaded together.
    if (left.record.artifact.namespace !== right.record.artifact.namespace) continue;

    const da = left.directives[di];
    const db = right.directives[dj];
    if (!da || !db) continue;

    const clash = detectClash(da, db);
    if (!clash) continue;

    const overlapping = coActivates(left.record, right.record);
    // Disjoint triggers cannot co-activate, so any contradiction between them
    // is unreachable in practice and reported at `info`.
    /*
     * Co-activation still sets the *relative* severity, as * requires: a contradiction between skills that can never load together is
     * unreachable and reported at `info`.
     *
     * But the absolute ceiling is `warn`, not `error`, because reachability and
     * *detection confidence* are different axes. Measured across two corpora
     * this rule found 0 contradictions in 1,022 skills and 1 correct out of 3 on
     * 33 repositories — the failures being qualified permissions read as
     * prohibitions ("MUST ask before using X" vs "do not use X"). One-in-three
     * precision does not justify failing anyone's build by default.
     */
    const severity: Severity = overlapping ? 'warn' : 'info';

    findings.push({
      ruleId: 'CFL-CONTRADICTION',
      severity,
      locations: [
        { path: left.record.artifact.relPath, line: da.line },
        { path: right.record.artifact.relPath, line: db.line },
      ],
      summary:
        `"${left.record.skill.name}" and "${right.record.skill.name}" give opposed ` +
        `instructions on ${clash.subject}`,
      evidence: {
        instructionA: da.sentence,
        instructionB: db.sentence,
        kind: clash.kind,
        triggersOverlap: overlapping ? 'yes' : 'no',
      },
      suggestion: overlapping
        ? 'These two skills can be selected for the same request. Reconcile the two ' +
          'instructions, or narrow one skill\'s trigger so they cannot co-activate.'
        : 'Their triggers do not currently overlap, so this is not reachable today. ' +
          'Reconcile the instructions if either description is later broadened.',
      alwaysOnSavings: 0,
    });
  }

  // --- skill vs context file -------------------------------------------------
  // A context file is loaded unconditionally, so it co-activates with every
  // skill by definition. Any contradiction here is always reachable.
  for (const file of contextFiles) {
    const fileDirectives = extractDirectives(file.text);
    for (const { record, directives } of skillDirectives) {
      for (const dSkill of directives) {
        for (const dFile of fileDirectives) {
          const clash = detectClash(dSkill, dFile);
          if (!clash) continue;

          findings.push({
            ruleId: 'CFL-CONTRADICTION',
            // Always reachable (a context file loads unconditionally), but
            // capped at `warn` for the confidence reason above.
            severity: 'warn',
            locations: [
              { path: record.artifact.relPath, line: dSkill.line },
              { path: file.relPath, line: dFile.line },
            ],
            summary:
              `Skill "${record.skill.name}" contradicts ${file.relPath} on ${clash.subject}`,
            evidence: {
              instructionA: dSkill.sentence,
              instructionB: dFile.sentence,
              kind: clash.kind,
              triggersOverlap: 'always (context file is unconditional)',
            },
            suggestion:
              'The context file loads every session, so this conflict is always live. ' +
              'Decide which instruction is correct and remove the other.',
            alwaysOnSavings: 0,
          });
        }
      }
    }
  }

  findings.sort((a, b) => {
    const pa = a.locations.map((l) => `${l.path}:${l.line ?? 0}`).join('|');
    const pb = b.locations.map((l) => `${l.path}:${l.line ?? 0}`).join('|');
    return pa < pb ? -1 : pa > pb ? 1 : 0;
  });

  return findings;
}

function detectClash(
  a: Directive,
  b: Directive,
): { subject: string; kind: string } | null {
  const dimension = findDimensionClash(a, b, a.sentence, b.sentence);
  if (dimension) {
    return {
      subject: `${dimension.dimension} (${dimension.optionA} vs ${dimension.optionB})`,
      kind: 'mutually-exclusive-options',
    };
  }

  if (a.polarity === b.polarity) return null;

  const overlap = jaccard(a.objectTerms, b.objectTerms);
  if (overlap < OBJECT_OVERLAP_THRESHOLD) return null;

  const shared = [...a.objectTerms].filter((t) => b.objectTerms.has(t)).sort();
  if (shared.length < MIN_SHARED_OBJECT_TERMS) return null;

  return { subject: shared.join(' '), kind: 'opposed-polarity' };
}
