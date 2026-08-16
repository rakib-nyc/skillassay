import { describe, it, expect } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { analyze } from '../src/analyze/index.js';
import { countTokens } from '../src/tokenize/index.js';
import { renderDiscoverySurface } from '../src/analyze/budget.js';
import { RULES, getRule, ruleIds } from '../src/rules/index.js';
import { TRIGGER_OVERLAP_THRESHOLD, TRIGGER_OVERLAP_PRECISION } from '../src/analyze/ambiguity.js';

const FIXTURES = path.resolve(import.meta.dirname, 'fixtures');

describe('tokenizer calibration against the official Anthropic skills', () => {
  const result = analyze(path.join(FIXTURES, 'anthropic-official'));

  it('parses every official skill without error', () => {
    // The parser must handle every file in this repository without error.
    // This is the conformance corpus, so any parse failure is a bug in
    // the parser, not in the corpus.
    const skillErrors = result.errors.filter((e) => e.kind === 'skill');
    expect(skillErrors).toEqual([]);
    expect(result.skills.length).toBeGreaterThanOrEqual(17);
  });

  it('reproduces the published order of magnitude for always-on discovery cost', () => {
    /*
     * A widely-cited blog measurement reports ~80 tokens median and ~1,700 total
     * across Anthropic's 17 official skills. That post could not be located and
     * read against a primary source, so this test does NOT assert its exact
     * figures — doing so would encode an unverified claim as ground truth.
     *
     * What it does assert is the property that actually matters: the entire
     * official skill library costs on the order of a thousand tokens at startup,
     * not the hundreds of thousands you would get by summing bodies. If this
     * ever fails, either progressive disclosure is being modelled wrongly or the
     * tokenizer is broken — both of which are the errors this project exists to
     * avoid.
     *
     * Measured on this vendored snapshot: see REGISTRY_AUDIT.md for the exact
     * current figures and the date they were taken.
     */
    const perSkill = result.skills.map((s) => s.discoveryCost.value).sort((a, b) => a - b);
    const median = perSkill[Math.floor(perSkill.length / 2)]!;
    const total = result.skills.reduce((sum, s) => sum + s.discoveryCost.value, 0);

    expect(median).toBeGreaterThan(30);
    expect(median).toBeLessThan(300);
    expect(total).toBeGreaterThan(800);
    expect(total).toBeLessThan(4000);
  });

  it('shows bodies dwarfing frontmatter, which is why the distinction matters', () => {
    const discovery = result.skills.reduce((s, r) => s + r.discoveryCost.value, 0);
    const bodies = result.skills.reduce((s, r) => s + r.bodyCost.value, 0);
    // If a tool summed bodies into the always-on figure it would overstate the
    // cost by more than an order of magnitude. Assert the gap is real so the
    // modelling decision stays justified.
    expect(bodies).toBeGreaterThan(discovery * 5);
  });
});

describe('tokenizer', () => {
  it('counts a known string identically on repeated calls', () => {
    const text = 'name: pdf\ndescription: Extract text from PDF files.';
    const a = countTokens(text, 'cl100k_base');
    const b = countTokens(text, 'cl100k_base');
    expect(a.value).toBe(b.value);
    expect(a.value).toBeGreaterThan(0);
  });

  it('returns zero only for genuinely empty input', () => {
    expect(countTokens('', 'cl100k_base').value).toBe(0);
    expect(countTokens(' ', 'cl100k_base').value).toBeGreaterThan(0);
  });

  it('carries its method on every count', () => {
    expect(countTokens('x', 'cl100k_base-proxy').method).toBe('cl100k_base-proxy');
  });

  it('models the discovery surface as name plus description only', () => {
    // The body must not be able to leak into this string.
    const surface = renderDiscoverySurface('foo', 'Does a thing. Use when asked.');
    expect(surface).toBe('name: foo\ndescription: Does a thing. Use when asked.');
  });
});

describe('rule registry integrity', () => {
  it('gives every rule at least one citation with a real quote and URL', () => {
    // The structural enforcement of "every rule maps to a citation".
    for (const rule of RULES) {
      expect(rule.citations.length).toBeGreaterThan(0);
      for (const citation of rule.citations) {
        expect(citation.url).toMatch(/^https:\/\//);
        expect(citation.quote.length).toBeGreaterThan(20);
        expect(citation.ref.length).toBeGreaterThan(10);
      }
    }
  });

  it('gives every rule a stated limitation', () => {
    for (const rule of RULES) {
      expect(rule.limitation.length).toBeGreaterThan(40);
    }
  });

  it('has no duplicate rule ids', () => {
    const ids = ruleIds();
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('refuses to look up an unregistered rule rather than returning a blank', () => {
    expect(() => getRule('NOT-A-RULE')).toThrow(/No rule registered/);
  });

  it('emits no finding whose ruleId is unregistered', () => {
    // Walk every fixture so this covers all four analyzers.
    const registered = new Set(ruleIds());
    for (const fixture of fs.readdirSync(FIXTURES)) {
      const result = analyze(path.join(FIXTURES, fixture), { experimentalAmbiguity: true });
      for (const finding of result.findings) {
        expect(registered.has(finding.ruleId)).toBe(true);
      }
    }
  });
});

describe('calibrated constants match the committed calibration results', () => {
  const results = fs.readFileSync(
    path.resolve(import.meta.dirname, '..', 'calibration', 'RESULTS.md'),
    'utf8',
  );

  it('uses the threshold that calibration selected', () => {
    // Guards against the constant drifting away from the measurement that
    // justifies it — the single easiest way for this tool to start lying.
    expect(results).toContain(`threshold ${TRIGGER_OVERLAP_THRESHOLD.toFixed(2)}`);
  });

  it('publishes the precision the code claims', () => {
    const percent = (TRIGGER_OVERLAP_PRECISION * 100).toFixed(1);
    expect(results).toContain(`Precision ${percent}%`);
  });

  it('keeps trigger-overlap detection off by default', () => {
    // Its measured precision is 62%. A detector that noisy must not be in the
    // default path.
    const dir = path.join(FIXTURES, 'known-distinct');
    const off = analyze(dir);
    expect(off.findings.filter((f) => f.ruleId === 'AMB-TRIGGER-OVERLAP')).toEqual([]);
    expect(off.stats.pairsCompared).toBe(0);
  });
});
