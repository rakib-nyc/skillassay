/**
 * Similarity metrics.
 *
 * All are deterministic and order-independent: sim(a,b) === sim(b,a) for every
 * function here, which is what makes the permutation-invariance test in
 * test/falsifiability.test.ts meaningful rather than accidental.
 */

/** Levenshtein edit distance. Iterative, two-row, O(min(a,b)) memory. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr = new Array<number>(b.length + 1).fill(0);

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        (prev[j] ?? 0) + 1,
        (curr[j - 1] ?? 0) + 1,
        (prev[j - 1] ?? 0) + cost,
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length] ?? 0;
}

/** Jaro similarity. */
function jaro(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;

  const window = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aMatched = new Array<boolean>(a.length).fill(false);
  const bMatched = new Array<boolean>(b.length).fill(false);

  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    const start = Math.max(0, i - window);
    const end = Math.min(i + window + 1, b.length);
    for (let j = start; j < end; j++) {
      if (bMatched[j] || a[i] !== b[j]) continue;
      aMatched[i] = true;
      bMatched[j] = true;
      matches++;
      break;
    }
  }
  if (matches === 0) return 0;

  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < a.length; i++) {
    if (!aMatched[i]) continue;
    while (!bMatched[k]) k++;
    if (a[i] !== b[k]) transpositions++;
    k++;
  }

  const t = transpositions / 2;
  return (matches / a.length + matches / b.length + (matches - t) / matches) / 3;
}

/** Jaro-Winkler, with the standard 0.1 prefix scale over up to 4 characters. */
export function jaroWinkler(a: string, b: string): number {
  const base = jaro(a, b);
  if (base === 0) return 0;
  let prefix = 0;
  const max = Math.min(4, a.length, b.length);
  while (prefix < max && a[prefix] === b[prefix]) prefix++;
  return base + prefix * 0.1 * (1 - base);
}

/** Jaccard index over two sets. Returns 0 for two empty sets. */
export function jaccard<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  // Iterate the smaller set so the cost is O(min) rather than O(max).
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const item of small) if (large.has(item)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** Character n-grams of a normalised string. */
export function charNgrams(text: string, n: number): Set<string> {
  const normalised = text.toLowerCase().replace(/\s+/g, ' ').trim();
  const grams = new Set<string>();
  if (normalised.length < n) {
    if (normalised.length > 0) grams.add(normalised);
    return grams;
  }
  for (let i = 0; i <= normalised.length - n; i++) grams.add(normalised.slice(i, i + n));
  return grams;
}

export function charNgramJaccard(a: string, b: string, n = 4): number {
  return jaccard(charNgrams(a, n), charNgrams(b, n));
}

/**
 * TF-IDF cosine over a fixed document corpus.
 *
 * IDF is computed over the *user's own* skill set (Layer A), so
 * vocabulary that is ubiquitous in this particular library is discounted
 * automatically. That matters: in a repo of twenty React skills, the word
 * "react" carries no routing signal, and a global IDF table would not know it.
 *
 * Caveat, stated plainly because it bounds what this metric can claim: with a
 * small corpus IDF is unstable, and below `MIN_CORPUS_FOR_IDF` documents it is
 * close to meaningless. `usable` reports whether the corpus was large enough.
 */
export const MIN_CORPUS_FOR_IDF = 5;

export class TfIdfIndex {
  private readonly idf = new Map<string, number>();
  readonly usable: boolean;
  readonly documentCount: number;

  constructor(documents: readonly (readonly string[])[]) {
    this.documentCount = documents.length;
    this.usable = documents.length >= MIN_CORPUS_FOR_IDF;

    const documentFrequency = new Map<string, number>();
    for (const doc of documents) {
      for (const term of new Set(doc)) {
        documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
      }
    }
    // Smoothed IDF; the +1 outside the log keeps weights strictly positive so a
    // term appearing in every document contributes nothing rather than negatively.
    for (const [term, df] of documentFrequency) {
      this.idf.set(term, Math.log((documents.length + 1) / (df + 1)) + 1);
    }
  }

  /** IDF weight of a term. Unseen terms get the neutral weight 1. */
  idfOf(term: string): number {
    return this.idf.get(term) ?? 1;
  }

  /** The IDF value at a given quantile of the vocabulary, for threshold choice. */
  idfQuantile(q: number): number {
    const values = [...this.idf.values()].sort((a, b) => a - b);
    if (values.length === 0) return 1;
    const rank = Math.max(1, Math.ceil(q * values.length));
    return values[rank - 1] ?? 1;
  }

  private vector(terms: readonly string[]): Map<string, number> {
    const counts = new Map<string, number>();
    for (const term of terms) counts.set(term, (counts.get(term) ?? 0) + 1);

    const vector = new Map<string, number>();
    for (const [term, tf] of counts) {
      vector.set(term, (tf / terms.length) * (this.idf.get(term) ?? 1));
    }
    return vector;
  }

  cosine(a: readonly string[], b: readonly string[]): number {
    if (a.length === 0 || b.length === 0) return 0;
    const va = this.vector(a);
    const vb = this.vector(b);

    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (const [term, weight] of va) {
      normA += weight * weight;
      const other = vb.get(term);
      if (other !== undefined) dot += weight * other;
    }
    for (const weight of vb.values()) normB += weight * weight;

    if (normA === 0 || normB === 0) return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
  }
}
