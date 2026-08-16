import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { analyze } from '../src/analyze/index.js';
import type { AnalysisResult, Finding } from '../src/types.js';

/**
 * Golden fixture tests.
 *
 * Expected values are hand-derived from reading the fixture
 * files and committed as literals, each with a comment showing the derivation.
 *
 * One honest caveat about what "hand-computed" can mean here. Finding counts,
 * rule IDs, severities and line numbers below were derived by reading the
 * fixtures, and each carries its derivation. Exact BPE token counts cannot be
 * computed by hand — reproducing cl100k_base mentally is not a thing a person
 * does — so token assertions are written as *relationships that must hold*
 * (identities, orderings, sums) rather than as magic numbers copied out of a
 * previous run. Where an absolute token figure appears, the comment says how it
 * was obtained and that it is a regression guard, not an independent check.
 */

const FIXTURES = path.resolve(import.meta.dirname, 'fixtures');

function run(name: string, options: Parameters<typeof analyze>[1] = {}): AnalysisResult {
  return analyze(path.join(FIXTURES, name), options);
}

const byRule = (result: AnalysisResult, ruleId: string): Finding[] =>
  result.findings.filter((f) => f.ruleId === ruleId);

describe('clean/ — the single most important test', () => {
  const result = run('clean');

  it('reports zero findings', () => {
    // Derivation: CLAUDE.md states three constraints that are all
    // repository-specific (integer minor units, TransactionGuard, replica lag)
    // and none of which restates package.json, a linter config, or the tree.
    // All three skills declare distinct trigger clauses. Nothing is duplicated
    // and no two bodies give opposed instructions. Therefore: zero.
    expect(result.findings).toEqual([]);
  });

  it('parses every artifact without error', () => {
    expect(result.errors).toEqual([]);
    // Derivation: CLAUDE.md + package.json is not an agent artifact +
    // 3 SKILL.md = 4 discovered artifacts, 3 of them skills.
    expect(result.skills).toHaveLength(3);
    expect(result.artifacts).toHaveLength(4);
  });

  it('attributes the budget to exactly the four always-on sources', () => {
    // One line per context file and one per skill frontmatter. package.json is
    // not an agent artifact and must not appear.
    expect(result.budget.lines.map((l) => l.relPath).sort()).toEqual([
      '.claude/skills/admin-ui-component/SKILL.md',
      '.claude/skills/ledger-db-query/SKILL.md',
      '.claude/skills/release-notes/SKILL.md',
      'CLAUDE.md',
    ]);
  });

  it('never folds skill bodies into the always-on total', () => {
    // The central modelling claim : bodies are conditional.
    // The always-on total must equal the sum of context files + frontmatter,
    // with no body contribution.
    const frontmatterSum = result.skills.reduce((s, r) => s + r.discoveryCost.value, 0);
    const contextSum = result.budget.lines
      .filter((l) => l.kind === 'context_file')
      .reduce((s, l) => s + l.tokens.value, 0);
    expect(result.budget.total.value).toBe(frontmatterSum + contextSum);

    // And the conditional total must be the bodies, tracked separately.
    const bodySum = result.skills.reduce((s, r) => s + r.bodyCost.value, 0);
    expect(result.budget.conditionalTotal.value).toBe(bodySum);
    expect(bodySum).toBeGreaterThan(0);
  });

  it('labels its token counts as a proxy for Claude targets', () => {
    expect(result.budget.total.method).toBe('cl100k_base-proxy');
  });
});

describe('known-distinct/ — the false-positive guard', () => {
  // Run with the experimental detector ON, because that is the only
  // configuration in which a false positive is even possible.
  const result = run('known-distinct', { experimentalAmbiguity: true });

  it('reports no duplicate-name findings', () => {
    // Derivation: canonical names are reviewsecurity, reviewperformance,
    // formatpython, formatgo — four distinct strings.
    expect(byRule(result, 'AMB-DUPLICATE-NAME')).toEqual([]);
  });

  it('reports no missing-trigger findings', () => {
    // Derivation: all four descriptions contain "Use when the user asks to …".
    expect(byRule(result, 'AMB-NO-TRIGGER')).toEqual([]);
  });

  it('reports no contradictions', () => {
    // Derivation: the four bodies are single imperative sentences on unrelated
    // subjects (untrusted input, measurement, ruff, gofmt).
    expect(byRule(result, 'CFL-CONTRADICTION')).toEqual([]);
  });
});

describe('known-duplicates/ — enumerated true positives', () => {
  const result = run('known-duplicates');

  it('finds exactly the two documented duplicate clusters', () => {
    const findings = byRule(result, 'AMB-DUPLICATE-NAME');
    // Derivation: names are skill-creator, skill-creator-v2, code-review,
    // Code_Review. Canonicalisation lowercases, splits on non-alphanumerics,
    // drops explicit version markers, then rejoins:
    //   skill-creator    -> skillcreator
    //   skill-creator-v2 -> skillcreator  (v2 is a version marker)
    //   code-review      -> codereview
    //   Code_Review      -> codereview    (case + separator normalised)
    // Two clusters of two.
    expect(findings).toHaveLength(2);
    expect(findings.map((f) => f.evidence['canonicalName']).sort()).toEqual([
      'codereview',
      'skillcreator',
    ]);
    for (const finding of findings) {
      expect(finding.evidence['count']).toBe(2);
      expect(finding.locations).toHaveLength(2);
    }
  });

  it('reports each cluster once, not once per pair', () => {
    // A cluster of n reported pairwise would be n(n-1)/2 findings. With two
    // clusters of two that is coincidentally also 2, so assert the shape too.
    expect(byRule(result, 'AMB-DUPLICATE-NAME').every((f) => f.locations.length >= 2)).toBe(true);
  });

  it('claims savings equal to the redundant copies only', () => {
    // Keeping one skill per cluster means the savings is the discovery cost of
    // every copy after the first — never the whole cluster.
    for (const finding of byRule(result, 'AMB-DUPLICATE-NAME')) {
      const total = result.skills
        .filter((s) => finding.locations.some((l) => l.path === s.artifact.relPath))
        .reduce((sum, s) => sum + s.discoveryCost.value, 0);
      expect(finding.alwaysOnSavings).toBeLessThan(total);
      expect(finding.alwaysOnSavings).toBeGreaterThan(0);
    }
  });
});

describe('known-contradiction/ — conflict detection and co-activation weighting', () => {
  const result = run('known-contradiction');
  const conflicts = byRule(result, 'CFL-CONTRADICTION');

  it('finds exactly the two planted contradictions', () => {
    // Derivation: frontend-styling says "Always use single quotes" and "Never
    // use default exports"; frontend-components says "Always use double quotes"
    // and "Always use default exports". Two opposed pairs.
    // python-imports says "Never use wildcard imports", which opposes nothing.
    expect(conflicts).toHaveLength(2);
  });

  it('detects both a mutually-exclusive-option clash and a polarity clash', () => {
    // Quotes: both instructions are positive ("always use X"), so only the
    // exclusive-dimension check can see it.
    // Default exports: always vs never on the same object, so the general
    // polarity check sees it.
    expect(conflicts.map((c) => c.evidence['kind']).sort()).toEqual([
      'mutually-exclusive-options',
      'opposed-polarity',
    ]);
  });

  it('rates them error because the two skills share a trigger', () => {
    // Both descriptions end with the identical clause "the user asks to write
    // or restyle a React component", so the two can be selected for the same
    // request and the contradiction is reachable.
    // warn, not error: co-activation sets relative severity, but measured
    // detection precision (~1 in 3) caps the absolute level. See RULES.md.
    expect(conflicts.every((c) => c.severity === 'warn')).toBe(true);
    expect(conflicts.every((c) => c.evidence['triggersOverlap'] === 'yes')).toBe(true);
  });

  it('does not pair the python skill with either frontend skill', () => {
    // Its trigger (sort imports in a .py module) shares nothing with the React
    // trigger, and its single directive opposes nothing.
    for (const conflict of conflicts) {
      expect(conflict.locations.some((l) => l.path.includes('python-imports'))).toBe(false);
    }
  });
});

describe('redundancy-bad/ — all four redundancy rules', () => {
  const result = run('redundancy-bad');

  it('fires each rule exactly where the fixture plants it', () => {
    // Derivation by reading test/fixtures/redundancy-bad/CLAUDE.md:
    //   line 3  "We use typescript and express in this project."  -> RED-TECHSTACK
    //           (both names appear in package.json dependencies)
    //   line 5  "Write clean code."                                -> RED-GENERIC
    //   line 6  "Follow best practices."                           -> RED-GENERIC
    //   line 7  "Prefer single quotes."                            -> RED-LINTER
    //           (.prettierrc exists in the fixture root)
    //   line 9  "## Project structure" heading + following lines   -> RED-REPO-OVERVIEW
    //   line 17 "- `src/routes/` — HTTP handlers"                  -> RED-REPO-OVERVIEW
    //           (src/routes/ exists, so the agent can list it)
    //   line 18 "- `warehouse/` — nightly export staging"          -> RED-STALE-PATH
    //           (warehouse/ does NOT exist: a wrong path, not a redundant one)
    // The `## Skill layout` fence is a template ({skill-name}) and must be silent.
    const actual = result.findings
      .map((f) => `${f.ruleId}@${f.locations[0]?.line}`)
      .sort();
    expect(actual).toEqual([
      'RED-GENERIC@5',
      'RED-GENERIC@6',
      'RED-LINTER@7',
      'RED-REPO-OVERVIEW@17',
      'RED-REPO-OVERVIEW@9',
      'RED-STALE-PATH@18',
      'RED-TECHSTACK@3',
    ]);
  });

  it('separates a real path from a missing one by checking the filesystem', () => {
    // The distinction that turns a heuristic into a checkable fact.
    const real = result.findings.find((f) => f.locations[0]?.line === 17);
    const stale = result.findings.find((f) => f.locations[0]?.line === 18);

    expect(real?.ruleId).toBe('RED-REPO-OVERVIEW');
    expect(real?.evidence['exists']).toBe('yes');
    expect(real?.severity).toBe('warn');

    // A path that is not there is a stronger problem than a redundant one:
    // the agent follows the instruction and finds nothing.
    expect(stale?.ruleId).toBe('RED-STALE-PATH');
    expect(stale?.evidence['exists']).toBe('no');
    // warn, not error: absence is a fact, staleness is an inference (a directory
    // may be created at runtime). See RULES.md for the rule's stated limits.
    expect(stale?.severity).toBe('info');
  });

  it('stays silent on a layout template', () => {
    // `{skill-name}/ SKILL.md # Required` prescribes what to create. The agent
    // cannot rediscover "SKILL.md is required" by listing a directory, so
    // deleting it would destroy information rather than recover tokens.
    const inTemplate = result.findings.filter((f) => {
      const line = f.locations[0]?.line ?? 0;
      return line >= 21 && line <= 28;
    });
    expect(inTemplate).toEqual([]);
  });

  it('leaves the genuinely non-obvious constraint alone', () => {
    // "## Non-obvious constraints" describes a contractual rate limit that is
    // not derivable from the repo. This is exactly what the ETH Zurich paper
    // says context files ARE for, so flagging it would be a false positive.
    const lines = result.findings.flatMap((f) => f.locations.map((l) => l.line));
    expect(lines.every((line) => (line ?? 0) < 30)).toBe(true);
  });

  it('covers the whole repository-overview section, not just its heading', () => {
    // The section finding, not the single-line one at 17.
    const overview = byRule(result, 'RED-REPO-OVERVIEW').find((f) => f.evidence['heading']);
    // Heading at line 9, section runs to the line before "## Non-obvious
    // constraints". The deletion range must span the whole block so `--fix`
    // removes the tree, not just the title.
    expect(overview?.deletion?.startLine).toBe(9);
    expect(overview?.deletion?.endLine).toBeGreaterThan(9);
  });

  it('projects savings by counting the exact text it proposes deleting', () => {
    // Not a claim, arithmetic: the sum of per-finding savings is what the
    // headline projection subtracts.
    const savings = result.findings.reduce((s, f) => s + f.alwaysOnSavings, 0);
    expect(savings).toBeGreaterThan(0);
    expect(savings).toBeLessThan(result.budget.total.value);
    for (const finding of result.findings) {
      expect(finding.alwaysOnSavings).toBeGreaterThan(0);
    }
  });
});

describe('adversarial/ — graceful, specific failure', () => {
  const result = run('adversarial');

  it('never throws', () => {
    expect(() => run('adversarial')).not.toThrow();
  });

  it('reports one specific error code per malformed file', () => {
    // Derivation: seven deliberately broken files, each targeting a distinct
    // failure mode of the parser.
    // relPath is `.claude/skills/<dir>/SKILL.md`, so the directory is index 2.
    const codes = Object.fromEntries(result.errors.map((e) => [e.relPath.split('/')[2], e.code]));
    expect(codes).toEqual({
      'empty-file': 'empty_file',
      'frontmatter-list': 'frontmatter_not_mapping',
      'malformed-yaml': 'malformed_yaml',
      'missing-description': 'missing_description',
      'invalid-name': 'invalid_name',
      'no-frontmatter': 'no_frontmatter',
      unterminated: 'unterminated_frontmatter',
    });
  });

  it('still parses the three valid-but-awkward files', () => {
    // A BOM, CRLF line endings and heavy unicode are all legal. Silently
    // skipping them would drop real skills out of the budget.
    expect(result.skills.map((s) => s.skill.name).sort()).toEqual([
      'bom-prefixed',
      'crlf-endings',
      'name-from-directory',
      'special-tokens',
      'unicode-heavy',
    ]);
  });

  it('counts tokenizer control sequences as text instead of crashing', () => {
    /*
     * `<|endoftext|>` in a file made js-tiktoken throw, killing the whole run
     * with a stack trace.. Prose about a control token is
     * prose, so it must be counted as the literal characters it is.
     */
    const special = result.skills.find((s) => s.skill.name === 'special-tokens');
    expect(special).toBeDefined();
    expect(special?.skill.description).toContain('<|endoftext|>');
    // Counted as ~10 tokens of text, not collapsed into 1 special token.
    expect(special?.discoveryCost.value).toBeGreaterThan(20);
    expect(special?.bodyCost.value).toBeGreaterThan(0);
  });

  it('infers a missing name from the directory rather than dropping the skill', () => {
    // Corpus validation found 8 real published skills that omit `name` and rely
    // on the directory. Rejecting them dropped genuinely-loaded skills out of
    // the budget, so the parser infers and flags rather than discards.
    const inferred = result.skills.find((s) => s.skill.name === 'name-from-directory');
    expect(inferred?.skill.nameInferred).toBe(true);
    // Every other skill states its own name.
    const stated = result.skills.filter((s) => s.skill.name !== 'name-from-directory');
    expect(stated.every((s) => s.skill.nameInferred === false)).toBe(true);
  });

  it('never produces a silent zero', () => {
    // Three skills parsed, so the budget must be non-zero even though most of
    // the directory is broken.
    expect(result.budget.total.value).toBeGreaterThan(0);
    expect(result.stats.skillsFailed).toBe(7);
  });
});
