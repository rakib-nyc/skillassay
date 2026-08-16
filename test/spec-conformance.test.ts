import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyze } from '../src/analyze/index.js';
import { checkName } from '../src/analyze/spec.js';
import type { Finding } from '../src/types.js';

/**
 * Agent Skills specification conformance.
 *
 * These answer the question a skill author asks first and every other rule
 * ignores: **will this load?** A skill whose `name` breaks the format is
 * rejected by compliant clients, silently — it simply never appears in the
 * catalogue. That makes these the highest-confidence findings the tool emits,
 * because unlike a judgement about redundancy they are decidable.
 *
 * Source: https://agentskills.io/specification
 */

function repoWithSkill(dirName: string, frontmatter: string, body = '# Body\n'): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'assay-spec-'));
  const skillDir = path.join(root, '.claude', 'skills', dirName);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `---\n${frontmatter}\n---\n\n${body}`);
  return root;
}

function findingsFor(root: string, ruleId: string): Finding[] {
  try {
    return analyze(root).findings.filter((f) => f.ruleId === ruleId);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe('checkName — every clause reported separately', () => {
  it('accepts the specification\'s valid examples', () => {
    for (const name of ['pdf-processing', 'data-analysis', 'code-review', 'a', 'x1', 'a-1-b']) {
      expect(checkName(name), name).toBeNull();
    }
  });

  it('rejects the specification\'s invalid examples with the right clause', () => {
    expect(checkName('PDF-Processing')?.clause).toMatch(/lowercase/);
    expect(checkName('-pdf')?.clause).toMatch(/start or end with a hyphen/);
    expect(checkName('pdf-')?.clause).toMatch(/start or end with a hyphen/);
    expect(checkName('pdf--processing')?.clause).toMatch(/consecutive hyphens/);
  });

  it('enforces the length bounds', () => {
    expect(checkName('')?.clause).toMatch(/1-64/);
    expect(checkName('a'.repeat(64))).toBeNull();
    expect(checkName('a'.repeat(65))?.clause).toMatch(/1-64/);
  });

  it('names the offending characters rather than just failing', () => {
    // An author needs to know *which* character to remove.
    const violation = checkName('my_skill');
    expect(violation?.detail).toContain('_');
  });

  it('reports the most specific clause when several apply', () => {
    // `-a--b-` breaks three clauses; the message must pick one and be right.
    const violation = checkName('-a--b-');
    expect(violation).not.toBeNull();
    expect(violation?.clause).toMatch(/hyphen/);
  });
});

describe('SPEC-NAME-INVALID', () => {
  it('is an error, because the skill will not load at all', () => {
    const findings = findingsFor(
      repoWithSkill('bad', 'name: Bad-Caps\ndescription: Does a thing. Use when asked.'),
      'SPEC-NAME-INVALID',
    );
    expect(findings).toHaveLength(1);
    // Not a style warning: a conforming client rejects it.
    expect(findings[0]?.severity).toBe('error');
    expect(findings[0]?.evidence['specification']).toContain('agentskills.io');
  });

  it('stays silent on a conformant skill', () => {
    expect(
      findingsFor(
        repoWithSkill('good-skill', 'name: good-skill\ndescription: Does a thing. Use when asked.'),
        'SPEC-NAME-INVALID',
      ),
    ).toEqual([]);
  });
});

describe('SPEC-NAME-DIR-MISMATCH', () => {
  it('fires when the declared name differs from the directory', () => {
    const findings = findingsFor(
      repoWithSkill('some-dir', 'name: other-name\ndescription: Does a thing. Use when asked.'),
      'SPEC-NAME-DIR-MISMATCH',
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.evidence['directory']).toBe('some-dir');
    expect(findings[0]?.evidence['name']).toBe('other-name');
  });

  it('does not fire when the name was inferred from that directory', () => {
    // Comparing an inferred name against its own source is circular, and would
    // report a violation the author cannot act on.
    const findings = findingsFor(
      repoWithSkill('inferred-name', 'description: No name key. Use when asked.'),
      'SPEC-NAME-DIR-MISMATCH',
    );
    expect(findings).toEqual([]);
  });

  it('does not pile on when the name is already invalid', () => {
    // One actionable message per problem: fixing the format comes first.
    const findings = findingsFor(
      repoWithSkill('dir', 'name: Bad-Caps\ndescription: Does a thing. Use when asked.'),
      'SPEC-NAME-DIR-MISMATCH',
    );
    expect(findings).toEqual([]);
  });
});

describe('SPEC-DESCRIPTION-TOO-LONG', () => {
  it('fires past 1024 characters and says by how much', () => {
    const long = `Does a thing. Use when asked. ${'x'.repeat(1100)}`;
    const findings = findingsFor(
      repoWithSkill('desc', `name: desc\ndescription: "${long}"`),
      'SPEC-DESCRIPTION-TOO-LONG',
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('error');
    expect(Number(findings[0]?.evidence['excess'])).toBeGreaterThan(0);
  });

  it('accepts a description at exactly the limit', () => {
    const exact = `Use when asked. ${'x'.repeat(1024 - 16)}`;
    expect(exact.length).toBe(1024);
    expect(
      findingsFor(
        repoWithSkill('exact', `name: exact\ndescription: "${exact}"`),
        'SPEC-DESCRIPTION-TOO-LONG',
      ),
    ).toEqual([]);
  });
});

describe('SPEC-BODY-TOO-LARGE', () => {
  it('warns rather than errors, because the skill still loads', () => {
    const body = `${'This is a line of instructional prose about the task.\n'.repeat(600)}`;
    const findings = findingsFor(
      repoWithSkill('big', 'name: big\ndescription: Does a thing. Use when asked.', body),
      'SPEC-BODY-TOO-LARGE',
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('warn');
    expect(findings[0]?.evidence['note']).toContain('Conditional');
  });

  it('fires on the line ceiling even when the token count is fine', () => {
    // 600 near-empty lines: few tokens, but past the 500-line recommendation.
    const body = `${'x\n'.repeat(600)}`;
    const findings = findingsFor(
      repoWithSkill('lines', 'name: lines\ndescription: Does a thing. Use when asked.', body),
      'SPEC-BODY-TOO-LARGE',
    );
    expect(findings).toHaveLength(1);
    expect(Number(findings[0]?.evidence['bodyLines'])).toBeGreaterThan(500);
    expect(Number(findings[0]?.evidence['bodyTokens'])).toBeLessThan(5000);
  });

  it('stays silent on a normal-sized body', () => {
    expect(
      findingsFor(
        repoWithSkill('small', 'name: small\ndescription: Does a thing. Use when asked.'),
        'SPEC-BODY-TOO-LARGE',
      ),
    ).toEqual([]);
  });
});

describe('.agents/skills is loaded by every client', () => {
  /*
   * The cross-client convention from the specification's implementation guide.
   * Treating it as an unknown third-party harness excluded the one location
   * whose entire purpose is to be shared.
   */
  function repoWithAgentsSkill(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'assay-agents-'));
    const skillDir = path.join(root, '.agents', 'skills', 'shared-tool');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: shared-tool\ndescription: Does a shared thing. Use when the user asks for it.\n---\n# Body\n',
    );
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# Root\n\nA real constraint.\n');
    return root;
  }

  it('counts toward every harness, not just one', () => {
    const root = repoWithAgentsSkill();
    try {
      for (const harnessId of ['claude', 'codex', 'gemini', 'cursor'] as const) {
        const result = analyze(root, { harnessId });
        const counted = result.budget.lines.some((l) => l.relPath.includes('.agents/skills'));
        expect(counted, `harness ${harnessId} should load .agents/skills`).toBe(true);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('is never listed as belonging to another harness', () => {
    const root = repoWithAgentsSkill();
    try {
      const result = analyze(root, { harnessId: 'codex' });
      const excludedAgents = result.budget.excluded.some((e) =>
        e.examples.some((x) => x.includes('.agents/skills')),
      );
      expect(excludedAgents).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
