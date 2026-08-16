import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyze } from '../src/analyze/index.js';
import { isOnContextChain } from '../src/analyze/budget.js';
import type { AnalysisResult } from '../src/types.js';

/**
 * Tier 0 budget model.
 *
 * These tests exist because the first implementation summed every artifact it
 * found, and on a real monorepo reported **123,567 always-on tokens (61.78% of
 * the window)** where the truthful figure for a Claude Code user at the
 * repository root was **~21,000 (10.5%)** — a 6× overstatement.
 *
 * It survived a complete build, a 1,029-file corpus validation and a hand
 * census of every finding, because every fixture was single-harness and flat.
 * The `multi-harness/` fixture exists specifically to make that class of error
 * impossible to ship again.
 *
 * The invariant under test: **only artifacts that actually co-load may be
 * summed**, and everything else must be visible in `excluded` rather than
 * silently dropped.
 */

const FIXTURES = path.resolve(import.meta.dirname, 'fixtures');
const MULTI = path.join(FIXTURES, 'multi-harness');

const lineFor = (result: AnalysisResult, relPath: string) =>
  result.budget.lines.find((l) => l.relPath === relPath);

describe('isOnContextChain', () => {
  it('puts the repository root on every chain', () => {
    expect(isOnContextChain('', '')).toBe(true);
    expect(isOnContextChain('', 'packages/api')).toBe(true);
  });

  it('includes a directory that contains the working directory', () => {
    expect(isOnContextChain('packages', 'packages/api')).toBe(true);
    expect(isOnContextChain('packages/api', 'packages/api')).toBe(true);
  });

  it('excludes sibling and descendant directories', () => {
    // A sibling package's context file is not loaded.
    expect(isOnContextChain('packages/web', 'packages/api')).toBe(false);
    // Nor is one from deeper than where you are working.
    expect(isOnContextChain('packages/api/src', 'packages/api')).toBe(false);
  });

  it('does not treat a name prefix as a path prefix', () => {
    // `packages/api-v2` must not match a chain rooted at `packages/api`.
    expect(isOnContextChain('packages/api', 'packages/api-v2')).toBe(false);
  });
});

describe('multi-harness/ — only what co-loads is summed', () => {
  const claude = analyze(MULTI, { harnessId: 'claude' });

  it('counts this harness only', () => {
    /*
     * Hand-derived from the fixture. For Claude Code at the repository root:
     *   CLAUDE.md                        counted (root context, this harness)
     *   .claude/skills/deploy/SKILL.md   counted (this harness's namespace)
     *   skills/shared/SKILL.md           counted (no harness dir — agnostic)
     * and nothing else.
     */
    expect(claude.budget.lines.map((l) => l.relPath).sort()).toEqual([
      '.claude/skills/deploy/SKILL.md',
      'CLAUDE.md',
      'skills/shared/SKILL.md',
    ]);
  });

  it('excludes other harnesses rather than summing them', () => {
    const reasons = claude.budget.excluded.map((e) => e.reason).join(' | ');
    expect(reasons).toContain('skills for other harnesses');
    expect(reasons).toContain('context files for other harnesses');

    // The same skill vendored for Codex and Gemini: two files, not counted.
    const otherSkills = claude.budget.excluded.find((e) =>
      e.reason.includes('skills for other harnesses'),
    );
    expect(otherSkills?.artifacts).toBe(2);
  });

  it('excludes directory-scoped context files off the current path', () => {
    const offPath = claude.budget.excluded.find((e) =>
      e.reason.includes('directory-scoped context files outside'),
    );
    // packages/api/CLAUDE.md and packages/web/CLAUDE.md, neither on the chain
    // from the root when cwd is the root.
    expect(offPath?.artifacts).toBe(2);
  });

  it('reconciles: counted plus excluded equals everything discovered', () => {
    // The guarantee that makes the headline checkable. Nothing.
    const counted = claude.budget.total.value;
    const excluded = claude.budget.excluded.reduce((s, e) => s + e.tokens, 0);

    const everything = analyze(MULTI, { harnessId: 'claude' });
    const allContext = everything.artifacts.filter(
      (a) => a.kind === 'context_file' || a.kind === 'cursor_rule',
    ).length;
    const allSkills = everything.skills.length;

    expect(counted).toBeGreaterThan(0);
    expect(excluded).toBeGreaterThan(0);
    // 5 context files + 4 skills = 9 artifacts, all accounted for.
    expect(allContext + allSkills).toBe(9);
    const accountedFiles =
      claude.budget.lines.length + claude.budget.excluded.reduce((s, e) => s + e.artifacts, 0);
    expect(accountedFiles).toBe(9);
  });

  it('gives a different, correct answer for a different harness', () => {
    const codex = analyze(MULTI, { harnessId: 'codex' });
    expect(codex.budget.lines.map((l) => l.relPath).sort()).toEqual([
      '.codex/skills/deploy/SKILL.md',
      'AGENTS.md',
      'skills/shared/SKILL.md',
    ]);
    // Different harnesses genuinely have different budgets; neither is "the"
    // total, which is why a single summed number was meaningless.
    expect(codex.budget.total.value).not.toBe(claude.budget.total.value);
  });

  it('never counts one harness\'s context file for another', () => {
    for (const harnessId of ['claude', 'codex', 'gemini'] as const) {
      const result = analyze(MULTI, { harnessId });
      const contextFiles = result.budget.lines
        .filter((l) => l.kind === 'context_file')
        .map((l) => l.relPath);
      const expected = { claude: 'CLAUDE.md', codex: 'AGENTS.md', gemini: 'GEMINI.md' }[harnessId];
      expect(contextFiles).toEqual([expected]);
    }
  });
});

describe('context-file chain composes along the working directory', () => {
  const atRoot = analyze(MULTI, { harnessId: 'claude' });
  const atApi = analyze(MULTI, { harnessId: 'claude', cwd: 'packages/api' });
  const atWeb = analyze(MULTI, { harnessId: 'claude', cwd: 'packages/web' });

  it('adds the scoped file when working inside its directory', () => {
    expect(lineFor(atRoot, 'packages/api/CLAUDE.md')).toBeUndefined();
    expect(lineFor(atApi, 'packages/api/CLAUDE.md')).toBeDefined();
    expect(lineFor(atWeb, 'packages/web/CLAUDE.md')).toBeDefined();
  });

  it('keeps the root file in the chain at every depth', () => {
    for (const result of [atRoot, atApi, atWeb]) {
      expect(lineFor(result, 'CLAUDE.md')).toBeDefined();
    }
  });

  it('never loads a sibling package\'s context file', () => {
    expect(lineFor(atApi, 'packages/web/CLAUDE.md')).toBeUndefined();
    expect(lineFor(atWeb, 'packages/api/CLAUDE.md')).toBeUndefined();
  });

  it('costs exactly root plus the scoped file', () => {
    const rootTokens = lineFor(atRoot, 'CLAUDE.md')?.tokens.value ?? 0;
    const apiTokens = lineFor(atApi, 'packages/api/CLAUDE.md')?.tokens.value ?? 0;
    expect(apiTokens).toBeGreaterThan(0);
    expect(atApi.budget.total.value).toBe(atRoot.budget.total.value + apiTokens);
    expect(rootTokens).toBeGreaterThan(0);
  });

  it('rejects a working directory outside the analysed path', () => {
    expect(() => analyze(MULTI, { cwd: '../..' })).toThrow(/must be inside/);
  });
});

describe('global (user-level) config', () => {
  let home: string;

  beforeAll(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'assay-home-'));
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.claude', 'CLAUDE.md'),
      '# Personal defaults\n\nPrefer terse commit messages; no emoji in git history.\n',
    );
  });

  afterAll(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('is off by default so library calls stay machine-independent', () => {
    // A developer with a real ~/.claude/CLAUDE.md must not see different
    // numbers from CI for the same repository.
    const result = analyze(MULTI, { homeDir: home });
    expect(result.budget.lines.some((l) => l.relPath.startsWith('~/'))).toBe(false);
  });

  it('is counted when requested, because it loads in every session', () => {
    const withGlobal = analyze(MULTI, { includeGlobal: true, homeDir: home });
    const globalLine = withGlobal.budget.lines.find((l) => l.relPath === '~/.claude/CLAUDE.md');

    expect(globalLine).toBeDefined();
    expect(globalLine?.portion).toContain('user-level');
    expect(globalLine?.tokens.value).toBeGreaterThan(0);

    const withoutGlobal = analyze(MULTI, { homeDir: home });
    expect(withGlobal.budget.total.value).toBe(
      withoutGlobal.budget.total.value + (globalLine?.tokens.value ?? 0),
    );
  });

  it('renders the home path as ~ rather than leaking it', () => {
    const result = analyze(MULTI, { includeGlobal: true, homeDir: home });
    const serialised = JSON.stringify(result.budget.lines);
    expect(serialised).not.toContain(home);
    expect(serialised).toContain('~/.claude/CLAUDE.md');
  });

  it('does not attribute another harness\'s global config to this one', () => {
    fs.mkdirSync(path.join(home, '.gemini'), { recursive: true });
    fs.writeFileSync(path.join(home, '.gemini', 'GEMINI.md'), '# Gemini personal defaults\n');

    const result = analyze(MULTI, { includeGlobal: true, homeDir: home, harnessId: 'claude' });
    expect(result.budget.lines.some((l) => l.relPath === '~/.gemini/GEMINI.md')).toBe(false);
    expect(
      result.budget.excluded.some((e) => e.reason.includes('context files for other harnesses')),
    ).toBe(true);
  });
});

describe('harness auto-detection', () => {
  /*
   * Defaulting to Claude Code was wrong on real repositories. `a real repository`
   * ships AGENTS.md and .agents/skills and nothing Claude-shaped, so the
   * default reported 0 always-on tokens while printing 17 findings about
   * AGENTS.md — and the projection read "0 to -51 tokens (-Infinity%)".
   */
  function repoWith(files: Record<string, string>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'assay-detect-'));
    for (const [rel, contents] of Object.entries(files)) {
      const full = path.join(dir, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, contents);
    }
    return dir;
  }

  const SKILL = '---\nname: ship\ndescription: Ships. Use when the user asks to deploy.\n---\n# S\n';

  it('detects Codex from AGENTS.md alone', () => {
    const dir = repoWith({ 'AGENTS.md': '# Repo\n\nA real constraint.\n' });
    try {
      const result = analyze(dir);
      expect(result.budget.harness).toBe('codex');
      expect(result.budget.harnessDetected).toBe(true);
      // The whole point: the file it analyses is the file it counts.
      expect(result.budget.total.value).toBeGreaterThan(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never reports findings about a file excluded from its own budget', () => {
    // The incoherence that motivated detection.
    const dir = repoWith({
      'AGENTS.md': '# Repo\n\nWrite clean code.\n\n## Project structure\n\n- src/\n',
      'src/index.ts': 'export const x = 1;\n',
    });
    try {
      const result = analyze(dir);
      const savings = result.findings.reduce((s, f) => s + f.alwaysOnSavings, 0);
      expect(result.findings.length).toBeGreaterThan(0);
      // Savings can never exceed a budget that supposedly excludes the file.
      expect(savings).toBeLessThanOrEqual(result.budget.total.value);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('respects an explicit --harness over detection', () => {
    const dir = repoWith({ 'AGENTS.md': '# Repo\n\nA constraint.\n' });
    try {
      const result = analyze(dir, { harnessId: 'claude' });
      expect(result.budget.harness).toBe('claude');
      expect(result.budget.harnessDetected).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('weights context files above skill count', () => {
    // One CLAUDE.md plus a handful of .codex skills is still a Claude repo;
    // the reverse would flip on skill count alone.
    const dir = repoWith({
      'CLAUDE.md': '# Repo\n\nA constraint.\n',
      '.codex/skills/a/SKILL.md': SKILL,
      '.codex/skills/b/SKILL.md': SKILL.replace('ship', 'shipb'),
    });
    try {
      expect(analyze(dir).budget.harness).toBe('claude');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('falls back to the default when there is nothing to detect', () => {
    const dir = repoWith({ 'README.md': '# nothing agent-shaped\n' });
    try {
      const result = analyze(dir);
      expect(result.budget.harness).toBe('claude');
      expect(result.budget.harnessDetected).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('unknown harness directories', () => {
  it('are not counted against a named harness', () => {
    // `.hermes/skills/…` in the validation corpus was silently counted against
    // Claude Code because the namespace list was hardcoded. Any dot-directory
    // is now treated as a harness root.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'assay-unknown-'));
    try {
      const skillDir = path.join(dir, '.hermes', 'skills', 'thing');
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(
        path.join(skillDir, 'SKILL.md'),
        '---\nname: thing\ndescription: Does a thing. Use when the user asks for a thing.\n---\n# Thing\n',
      );
      fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# Root\n\nA real constraint lives here.\n');

      const result = analyze(dir, { harnessId: 'claude' });
      expect(result.budget.lines.some((l) => l.relPath.includes('.hermes'))).toBe(false);
      expect(
        result.budget.excluded.some((e) => e.reason.includes('skills for other harnesses')),
      ).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('still counts skills that sit outside any harness directory', () => {
    // A bare `skills/` folder has no harness marker, so it counts for whichever
    // harness is selected.
    const result = analyze(MULTI, { harnessId: 'claude' });
    expect(lineFor(result, 'skills/shared/SKILL.md')).toBeDefined();
  });
});
