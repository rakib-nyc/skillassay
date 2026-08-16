import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { analyze } from '../src/analyze/index.js';
import { checkName } from '../src/analyze/spec.js';

/**
 * The project's own skill, held to the project's own rules.
 *
 * A linter for skill authors that ships a non-conformant skill has refuted
 * itself. This is the cheapest possible dogfooding and the most embarrassing
 * thing to get wrong, so it is asserted rather than assumed.
 */

const ROOT = path.resolve(import.meta.dirname, '..');
const SKILL = path.join(ROOT, '.agents', 'skills', 'skillassay', 'SKILL.md');

describe('our own skill', () => {
  it('exists in .agents/skills, the cross-client location', () => {
    // Not `.claude/skills`: the whole point is that Codex and Gemini CLI see it
    // from the same file.
    expect(fs.existsSync(SKILL), `${SKILL} should exist`).toBe(true);
  });

  it('passes every rule the tool enforces on everyone else', () => {
    const result = analyze(ROOT, { only: '.agents/skills/skillassay/SKILL.md' });
    expect(result.skills).toHaveLength(1);
    expect(result.findings).toEqual([]);
    expect(result.conformance.willLoad).toBe(true);
  });

  it('has a specification-legal name matching its directory', () => {
    const record = analyze(ROOT, { only: '.agents/skills/skillassay/SKILL.md' }).skills[0]!;
    expect(checkName(record.skill.name)).toBeNull();
    expect(record.skill.name).toBe('skillassay');
    expect(record.skill.nameInferred).toBe(false);
  });

  it('declares a trigger clause, which is the rule it most often reports', () => {
    const record = analyze(ROOT, { only: '.agents/skills/skillassay/SKILL.md' }).skills[0]!;
    expect(record.triggerSurface).not.toBeNull();
    expect(record.skill.description.toLowerCase()).toContain('use when');
  });

  it('keeps its always-on cost small, since every user pays it every session', () => {
    const record = analyze(ROOT, { only: '.agents/skills/skillassay/SKILL.md' }).skills[0]!;
    // The published catalogue tier is ~50-100 tokens per skill. Ours should sit
    // in that band rather than being an outlier in its own audit.
    expect(record.discoveryCost.value).toBeLessThan(150);
  });

  it('is loaded by Claude Code, Codex and Gemini CLI alike', () => {
    for (const harnessId of ['claude', 'codex', 'gemini'] as const) {
      const result = analyze(ROOT, {
        harnessId,
        exclude: ['test/fixtures', 'ship', 'corpus', 'wild'],
      });
      const loaded = result.budget.lines.some((l) =>
        l.relPath.includes('.agents/skills/skillassay/SKILL.md'),
      );
      expect(loaded, `${harnessId} should load the skill`).toBe(true);
    }
  });

  it('tells the agent to defer to the CLI rather than reason about tokens itself', () => {
    // The determinism guarantee lives in the CLI. A skill that starts
    // estimating token counts turns this into the non-deterministic tool it was
    // built to replace.
    // Whitespace-tolerant: the assertion is about the instruction being
    // present, not about where the line happens to wrap.
    const body = fs.readFileSync(SKILL, 'utf8').replace(/\s+/g, ' ');
    expect(body).toMatch(/All analysis happens in the CLI/i);
    expect(body).toMatch(/[Nn]ever estimate a token count/);
  });
});
