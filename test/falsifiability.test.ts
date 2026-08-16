import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyze } from '../src/analyze/index.js';
import { renderJson } from '../src/report/json.js';

/**
 * Falsifiability tests.
 *
 * These do not check that the tool produces some output. They check that its
 * output *responds to reality* — that injecting a problem creates a finding,
 * removing it destroys the finding, more problems produce more findings, and
 * that nothing about the answer depends on filesystem ordering or wall time.
 *
 * A detector that passes the fixture tests but fails these is not measuring
 * anything; it is pattern-matching its own test data.
 */

let workspace: string;

function scaffold(dir: string): void {
  fs.mkdirSync(path.join(dir, '.claude', 'skills'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'CLAUDE.md'),
    '# Service\n\nRefunds go through `RefundGateway`, which is rate limited to 3 rps by contract.\n',
  );
}

function addSkill(dir: string, slug: string, name: string, description: string, body = '# Body\n'): void {
  const skillDir = path.join(dir, '.claude', 'skills', slug);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}`,
  );
}

function removeSkill(dir: string, slug: string): void {
  fs.rmSync(path.join(dir, '.claude', 'skills', slug), { recursive: true, force: true });
}

const countRule = (dir: string, ruleId: string): number =>
  analyze(dir).findings.filter((f) => f.ruleId === ruleId).length;

beforeAll(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'assay-falsify-'));
});

afterAll(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe('injection test', () => {
  it('creates a finding when a duplicate is injected and destroys it when removed', () => {
    const dir = path.join(workspace, 'injection');
    scaffold(dir);
    addSkill(dir, 'alpha', 'ledger-export', 'Exports ledger data. Use when the user asks to export postings to CSV.');

    // Baseline: one skill, nothing to collide with.
    expect(countRule(dir, 'AMB-DUPLICATE-NAME')).toBe(0);

    // Inject a duplicate name.
    addSkill(dir, 'beta', 'ledger_export_v2', 'Exports ledger data. Use when the user asks to dump postings to a file.');
    expect(countRule(dir, 'AMB-DUPLICATE-NAME')).toBe(1);

    // Remove it: the finding must disappear, not linger.
    removeSkill(dir, 'beta');
    expect(countRule(dir, 'AMB-DUPLICATE-NAME')).toBe(0);
  });

  it('creates and destroys a redundancy finding the same way', () => {
    const dir = path.join(workspace, 'injection-red');
    scaffold(dir);
    const contextFile = path.join(dir, 'CLAUDE.md');
    const original = fs.readFileSync(contextFile, 'utf8');

    expect(countRule(dir, 'RED-GENERIC')).toBe(0);

    fs.writeFileSync(contextFile, `${original}\nWrite clean code.\n`);
    expect(countRule(dir, 'RED-GENERIC')).toBe(1);

    fs.writeFileSync(contextFile, original);
    expect(countRule(dir, 'RED-GENERIC')).toBe(0);
  });
});

describe('dose-response test', () => {
  it('reports monotonically more duplicate clusters as more are injected', () => {
    const dir = path.join(workspace, 'dose');
    scaffold(dir);

    const observed: number[] = [];
    for (let dose = 1; dose <= 8; dose++) {
      // Each dose adds one *new* duplicated pair, so the expected cluster count
      // equals the dose exactly.
      // Distinct base words per dose, so each dose adds one independent
      // cluster rather than growing a single shared one. The duplicate is
      // created by a `-v2` suffix, which canonicalisation strips.
      const base = ['ledger', 'invoice', 'payroll', 'tax', 'refund', 'dispute', 'payout', 'audit'][dose - 1]!;
      addSkill(dir, `dup-${dose}-a`, `${base}-report`, `Builds the ${base} report. Use when the user asks for the ${base} report.`);
      addSkill(dir, `dup-${dose}-b`, `${base}-report-v2`, `Builds the ${base} report. Use when the user wants the ${base} report regenerated.`);
      observed.push(countRule(dir, 'AMB-DUPLICATE-NAME'));
    }

    expect(observed).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);

    // Strictly increasing: a detector whose output does not track input
    // magnitude is not measuring the input.
    for (let i = 1; i < observed.length; i++) {
      expect(observed[i]!).toBeGreaterThan(observed[i - 1]!);
    }
  });
});

describe('null test', () => {
  it('finds no ambiguity in single-skill directories', () => {
    // Ambiguity requires a pair. Any finding here is a bug by construction.
    for (let i = 0; i < 20; i++) {
      const dir = path.join(workspace, `null-${i}`);
      scaffold(dir);
      addSkill(
        dir,
        'only',
        `solo-skill-${i}`,
        `Handles case ${i}. Use when the user asks about scenario ${i}.`,
      );

      const findings = analyze(dir, { experimentalAmbiguity: true }).findings;
      expect(findings.filter((f) => f.ruleId === 'AMB-DUPLICATE-NAME')).toEqual([]);
      expect(findings.filter((f) => f.ruleId === 'AMB-TRIGGER-OVERLAP')).toEqual([]);
      expect(findings.filter((f) => f.ruleId === 'CFL-CONTRADICTION')).toEqual([]);
    }
  });
});

describe('permutation invariance', () => {
  it('produces identical output regardless of on-disk creation order', () => {
    const names = ['zulu', 'alpha', 'mike', 'bravo', 'yankee', 'charlie'];

    const build = (dir: string, order: string[]): string => {
      scaffold(dir);
      for (const slug of order) {
        addSkill(
          dir,
          slug,
          `task-${slug}`,
          `Handles ${slug} work. Use when the user asks to process a ${slug} record.`,
        );
      }
      // Strip the path-dependent root and the explicitly-marked runtime block.
      const json = JSON.parse(renderJson(analyze(dir, { experimentalAmbiguity: true })));
      delete json.runtime;
      return JSON.stringify(json);
    };

    const forward = build(path.join(workspace, 'perm-forward'), names);
    const reverse = build(path.join(workspace, 'perm-reverse'), [...names].reverse());
    const shuffledButDeterministic = build(
      path.join(workspace, 'perm-shuffled'),
      // A fixed, arbitrary order — written out rather than randomised so this
      // test cannot itself become a source of nondeterminism.
      ['mike', 'yankee', 'alpha', 'charlie', 'zulu', 'bravo'],
    );

    expect(reverse).toBe(forward);
    expect(shuffledButDeterministic).toBe(forward);
  });
});

describe('determinism', () => {
  it('produces byte-identical JSON across 10 runs, excluding the runtime block', () => {
    const dir = path.resolve(import.meta.dirname, 'fixtures', 'redundancy-bad');

    const outputs = new Set<string>();
    for (let i = 0; i < 10; i++) {
      const json = JSON.parse(renderJson(analyze(dir, { experimentalAmbiguity: true })));
      // `runtime` holds durationMs, which is wall-clock and cannot be stable.
      // It is the ONLY excluded field, and it is named as such in the schema.
      delete json.runtime;
      outputs.add(JSON.stringify(json));
    }

    expect(outputs.size).toBe(1);
  });

  it('contains no wall-clock value outside the runtime block', () => {
    const dir = path.resolve(import.meta.dirname, 'fixtures', 'clean');
    const json = JSON.parse(renderJson(analyze(dir)));
    delete json.runtime;
    const serialised = JSON.stringify(json);
    // ISO timestamps and epoch-like integers would both break reproducibility.
    expect(serialised).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    expect(serialised).not.toMatch(/\b17\d{11}\b/);
  });
});

describe('discovery robustness', () => {
  it('terminates on a symlink cycle instead of recursing forever', () => {
    const dir = path.join(workspace, 'symlink-loop');
    scaffold(dir);
    addSkill(dir, 'real', 'real-skill', 'Does a thing. Use when the user asks for the thing.');

    const loopDir = path.join(dir, '.claude', 'skills', 'loop');
    fs.mkdirSync(loopDir, { recursive: true });
    try {
      // A directory that contains a symlink back to its own ancestor.
      fs.symlinkSync(path.join(dir, '.claude'), path.join(loopDir, 'back'), 'dir');
    } catch {
      // Some environments disallow symlink creation; the guard is still tested
      // by the depth cap, so skip rather than fail spuriously.
      return;
    }

    const result = analyze(dir);
    expect(result.skills.map((s) => s.skill.name)).toContain('real-skill');
    // The loop must not multiply the skill into many copies.
    expect(result.skills.filter((s) => s.skill.name === 'real-skill')).toHaveLength(1);
  });

  it('records an oversized file as an error rather than reading it into memory', () => {
    const dir = path.join(workspace, 'huge');
    scaffold(dir);
    const skillDir = path.join(dir, '.claude', 'skills', 'huge');
    fs.mkdirSync(skillDir, { recursive: true });
    // 6MB, above the 5MB cap in src/config.ts.
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      `---\nname: huge\ndescription: Enormous. Use when testing.\n---\n${'x'.repeat(6 * 1024 * 1024)}`,
    );

    const result = analyze(dir);
    const error = result.errors.find((e) => e.relPath.includes('huge'));
    expect(error?.code).toBe('file_too_large');
    // And it must not silently contribute zero tokens as though it were fine.
    expect(result.skills.some((s) => s.skill.name === 'huge')).toBe(false);
  });
});
