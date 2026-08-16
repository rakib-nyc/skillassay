import { getEncoding, type Tiktoken } from 'js-tiktoken';
import type { TokenCount, TokenMethod, ModelTarget } from '../types.js';

/**
 * Tokenization.
 *
 * bans word-count and character-count estimates. This module is
 * the only place in the codebase that produces a token number, and it always
 * uses a real BPE encoder.
 *
 * The honest caveat, stated here and repeated in the report and README:
 * Anthropic does not ship an offline tokenizer for current Claude models. Their
 * token-counting endpoint is authoritative but requires a network call and an
 * API key, which would break the offline-by-default guarantee. So for Claude
 * targets we count with cl100k_base and label the result a *proxy*. It is a real
 * BPE count of the real bytes; it is not Claude's own segmentation.
 */

let cached: Tiktoken | null = null;

function encoder(): Tiktoken {
  // Loading the ranks costs ~50ms and several MB, so do it once and only if a
  // count is actually requested.
  cached ??= getEncoding('cl100k_base');
  return cached;
}

export function countTokens(text: string, method: TokenMethod): TokenCount {
  if (text.length === 0) return { value: 0, method };
  /*
   * Special-token sequences are counted as ordinary text.
   *
   * `encode(text)` throws outright when the input contains `<|endoftext|>` or
   * any other control sequence. That is a hard crash on real repositories:
   * a public repository has one in a context file, and the tool died
   * with a stack trace rather than producing a report.
   *
   * Passing an empty `disallowedSpecial` set makes the encoder treat those
   * sequences as the literal characters they are, which is also the correct
   * model: a `<|endoftext|>` sitting in a markdown file is prose about a token,
   * not a control token. Counting it as one (`allowedSpecial: 'all'`) would
   * under-count 10 tokens as 1.
   */
  return { value: encoder().encode(text, [], []).length, method };
}

/** Count against a model target, picking the proxy label automatically. */
export function countFor(text: string, target: ModelTarget): TokenCount {
  return countTokens(text, target.tokenizerIsProxy ? 'cl100k_base-proxy' : 'cl100k_base');
}

export function addTokens(counts: readonly TokenCount[], method: TokenMethod): TokenCount {
  let value = 0;
  for (const c of counts) value += c.value;
  return { value, method };
}

const METHOD_LABELS: Record<TokenMethod, string> = {
  cl100k_base: 'cl100k_base (exact)',
  'cl100k_base-proxy': 'approx — cl100k_base proxy, not Claude’s own tokenizer',
};

export function describeMethod(method: TokenMethod): string {
  return METHOD_LABELS[method];
}
