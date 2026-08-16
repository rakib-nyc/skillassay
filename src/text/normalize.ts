/**
 * Text normalisation for skill descriptions.
 *
 * a description is conventionally *what the skill does*
 * plus *when to use it*. Only the "when" half causes mis-routing. Two skills can
 * legitimately do near-identical things on disjoint triggers ("format Python" vs
 * "format Go"), and comparing whole descriptions conflates the two and produces
 * exactly the kind of noisy detector that destroys trust.
 *
 * So: split the description, and compare trigger surfaces to trigger surfaces.
 */

/**
 * Phrases that introduce a trigger clause, longest-first so that
 * "Use this skill when" wins over "Use this".
 *
 * Derived by reading the 1,073-skill corpus in scripts/corpus-validate.ts, not
 * invented: these are the lead-ins that actually occur. `scripts/trigger-audit.ts`
 * reports what fraction of a corpus each pattern matches.
 */
const TRIGGER_LEAD_INS: readonly RegExp[] = [
  /*
   * One general pattern rather than an enumeration of exact phrasings. The
   * earlier enumeration silently missed real forms — "Trigger this when …" was
   * present in the fixtures and matched nothing — and each miss degrades a
   * trigger comparison into a whole-description comparison, which is precisely
   * the conflation Layer B exists to avoid.
   *
   * Structure: an activation verb, optional determiner and noun, then a
   * condition word. Coverage against the 1,073-skill corpus is measured by
   * `npm run corpus:validate` and reported in README.md, so the pattern's
   * real-world hit rate is a published number rather than an assumption.
   */
  /\b(?:use|using|trigger|triggers|triggered|activate|activates|activated|invoke|invokes|invoked|apply|applies|applied|call|called|run|load|spawn|spawns|dispatch|dispatched|launch|engage)\b(?:\s+(?:proactively|automatically|immediately|only|always|directly|explicitly))?(?:\s+(?:this|the|it|that|them))?(?:\s+(?:skill|tool|agent|command|capability))?(?:\s+(?:is|are|should\s+be|must\s+be|can\s+be|to\s+be))?\s+(?=when\b|whenever\b|if\b|for\b|on\b|after\b|before\b|during\b|anytime\b|any\s+time\b)/i,
  /\b(?:should|must|can)\s+be\s+used\s+(?=when\b|whenever\b|if\b|for\b|to\b)/i,
  /\b(?:helpful|useful|ideal|perfect|relevant|appropriate|suitable|best|intended|designed|meant)\s+(?:for\s+use\s+)?(?=when\b|whenever\b|if\b|for\b)/i,
  /\bfor\s+use\s+(?=when\b|whenever\b|if\b|in\b)/i,
  /\b(?:trigger|activation|use)\s+(?:condition|case)s?\s*:/i,
  /\btriggers?\s+(?:on|include|includes|are|when)\b\s*:?/i,
  // Bare label forms: "Triggers: a, b, c" and "TRIGGER — read before ...".
  /\btriggers?\s*[:—–-]\s*(?=\S)/i,
  /\b(?:activates?|active)\s+on\b\s*:?/i,
  /\buse\s+cases?\s*:/i,
  /*
   * A bare "when …" clause with a strong following context word.
   *
   * Added after manual review of 50 corpus findings, where descriptions like
   * "Guidance for … visual design when building new UI" were reported as having
   * no trigger. They plainly do; the trigger simply is not introduced by an
   * activation verb.
   *
   * The following-word list is required, and deliberately narrow. A bare `when`
   * alone matches narrative prose ("useful when combined with …") and would
   * quietly turn this rule off altogether.
   */
  /\bwhen(?:ever)?\s+(?=the\s+user\b|users?\b|you\b|your\b|working\b|building\b|writing\b|creating\b|reviewing\b|debugging\b|editing\b|designing\b|testing\b|refactoring\b|analy[sz]ing\b|asked\b|dealing\b|handling\b|migrating\b|deploying\b|configuring\b|setting\s+up\b)/i,
];

export interface SplitDescription {
  /** What the skill does. Never empty; falls back to the whole description. */
  readonly capability: string;
  /**
   * When the skill fires, or `null` when the description never says.
   * A missing trigger is reported as its own finding (AMB-NO-TRIGGER) rather
   * than papered over by silently comparing whole descriptions.
   */
  readonly trigger: string | null;
}

export function splitDescription(description: string): SplitDescription {
  const text = description.trim();
  if (text.length === 0) return { capability: '', trigger: null };

  let earliest = -1;
  let matchLength = 0;

  for (const pattern of TRIGGER_LEAD_INS) {
    const m = pattern.exec(text);
    if (!m) continue;
    // Prefer the earliest split point; on a tie prefer the longer lead-in so
    // "use this skill when" does not get shortened to "use ... when".
    if (earliest === -1 || m.index < earliest || (m.index === earliest && m[0].length > matchLength)) {
      earliest = m.index;
      matchLength = m[0].length;
    }
  }

  if (earliest === -1) {
    return { capability: text, trigger: null };
  }

  const capability = text.slice(0, earliest).trim().replace(/[.,;:\s]+$/, '');
  const trigger = text.slice(earliest + matchLength).trim();

  // A lead-in at position 0 means the whole description is trigger-shaped, e.g.
  // "Use when the user asks to format code." There is no separate capability
  // statement; say so rather than inventing one.
  return {
    capability: capability.length > 0 ? capability : text,
    trigger: trigger.length > 0 ? trigger : null,
  };
}

/**
 * English stopwords plus the boilerplate vocabulary that saturates skill
 * descriptions. These words carry no routing signal: "the user asks" appears in
 * a large share of all descriptions, so leaving them in makes every pair of
 * skills look similar and floods the report with false positives.
 */
const STOPWORDS = new Set([
  'a', 'about', 'all', 'also', 'an', 'and', 'any', 'are', 'as', 'at', 'be', 'been', 'being',
  'both', 'but', 'by', 'can', 'do', 'does', 'doing', 'done', 'each', 'either', 'for', 'from',
  'get', 'gets', 'had', 'has', 'have', 'he', 'her', 'his', 'how', 'i', 'if', 'in', 'into', 'is',
  'it', 'its', 'just', 'like', 'make', 'makes', 'may', 'me', 'might', 'more', 'most', 'must',
  'my', 'need', 'needs', 'no', 'not', 'of', 'on', 'once', 'one', 'only', 'or', 'other', 'our',
  'out', 'over', 'own', 'per', 'run', 'same', 'she', 'should', 'so', 'some', 'such', 'than',
  'that', 'the', 'their', 'them', 'then', 'there', 'these', 'they', 'this', 'those', 'through',
  'to', 'too', 'up', 'us', 'use', 'used', 'user', 'users', 'using', 'very', 'via', 'want',
  'wants', 'was', 'we', 'were', 'what', 'when', 'where', 'which', 'while', 'who', 'why', 'will',
  'with', 'would', 'you', 'your',
  // Skill-description boilerplate.
  'ask', 'asked', 'asking', 'asks', 'assist', 'help', 'helps', 'skill', 'tool', 'trigger',
  'triggers', 'invoke', 'activate', 'apply', 'perform', 'handle', 'work', 'working', 'task',
  'tasks', 'request', 'requests', 'requested', 'needed', 'e.g', 'eg', 'etc', 'i.e', 'ie',
]);

/**
 * Split into lowercase content words.
 *
 * Hyphenated and dotted identifiers are kept whole (`.eslintrc`, `read-file`)
 * because in this domain they are the highest-signal tokens in the string.
 */
export function contentWords(text: string): string[] {
  const words = text
    .toLowerCase()
    .replace(/[`"'“”‘’()[\]{}]/g, ' ')
    .split(/[^a-z0-9._\-+#]+/)
    .map((w) => w.replace(/^[._\-+#]+|[._\-+#]+$/g, ''))
    .filter((w) => w.length > 0);

  /*
   * Minimum length 2, not 3.
   *
   * This domain is full of two-character tokens that are the *only* thing
   * distinguishing two skills: go, py, js, ts, ui, db, io, os, ci, qa. Dropping
   * them made "format a .py file" and "format a .go file" identical strings and
   * produced a 100%-overlap false positive. Two-letter English function words
   * are already removed by the stopword set above, so the length floor is not
   * what was filtering them.
   */
  return words.filter((w) => !STOPWORDS.has(w) && w.length >= 2);
}

/** Content words as a set, for Jaccard-style comparisons. */
export function contentWordSet(text: string): Set<string> {
  return new Set(contentWords(text));
}

/**
 * Unambiguous version/copy markers only.
 *
 * Deliberately excludes bare digits and single letters. Dropping those looked
 * reasonable and was wrong: it collapsed `report-kind-1` and `report-kind-2`
 * into one canonical name, and `style-a` and `style-b` likewise — a numbered
 * series is a set of distinct skills, not a set of copies. The dose-response
 * test in test/falsifiability.test.ts is what surfaced this.
 *
 * It also keeps the rule close to its source. Ling et al. measure *name-based*
 * redundancy — the same name published repeatedly — so canonicalisation should
 * normalise spelling (case, separators) and explicit version suffixes, and
 * should not start guessing that two different names mean the same thing.
 */
const VERSION_TOKENS = new Set([
  'copy', 'backup', 'bak', 'old', 'new', 'final', 'alt', 'tmp', 'temp', 'duplicate',
]);

const VERSION_PATTERN = /^v\d+$/;

/**
 * Canonical form of a skill name for duplicate detection.
 *
 * Normalises case and separators, then drops explicit version markers:
 *   skill-creator, skill_creator, Skill Creator, skill-creator-v2
 *     -> skillcreator
 *
 * Uses exact equality of this form rather than edit distance. Edit distance on
 * short names treats a one-character difference as ~85% similarity, which
 * reports `style-a` and `style-b` as duplicates — a false positive the earlier
 * implementation actually produced.
 */
export function canonicalName(name: string): string {
  return name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0 && !VERSION_TOKENS.has(t) && !VERSION_PATTERN.test(t))
    .join('');
}

/** Sentences, for imperative extraction in conflict detection. */
export function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?;:])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
