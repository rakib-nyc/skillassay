import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyze } from '../src/analyze/index.js';
import { renderJson } from '../src/report/json.js';
import { generatePatch } from '../src/report/patch.js';

/**
 * Portability.
 *
 * The suite has been run on macOS (Node 24) and Linux/musl (Node 20). It has
 * **not** been run on Windows, and saying otherwise would be a claim without a
 * measurement behind it.
 *
 * What these tests can do is pin the properties that would break there, so the
 * failure is caught by CI on any platform rather than discovered by the first
 * Windows user:
 *
 *  - every path the tool *emits* is POSIX, regardless of `path.sep`
 *  - path comparison never assumes a separator
 *  - output is byte-identical across platforms for the same input
 *
 * Windows-specific behaviour that genuinely cannot be tested here is listed in
 * README.md under Limitations rather than papered over.
 */

const FIXTURES = path.resolve(import.meta.dirname, 'fixtures');

describe('emitted paths are always POSIX', () => {
  const result = analyze(path.join(FIXTURES, 'multi-harness'));

  it('never emits a backslash in an artifact path', () => {
    for (const artifact of result.artifacts) {
      expect(artifact.relPath).not.toContain('\\');
    }
  });

  it('never emits a backslash in a budget line', () => {
    for (const line of result.budget.lines) {
      expect(line.relPath).not.toContain('\\');
    }
  });

  it('never emits a backslash in a finding location or deletion range', () => {
    for (const finding of result.findings) {
      for (const location of finding.locations) {
        expect(location.path).not.toContain('\\');
      }
      if (finding.deletion) expect(finding.deletion.path).not.toContain('\\');
    }
  });

  it('never emits a backslash anywhere in the JSON report', () => {
    // The catch-all. `\\` in JSON is an escaped backslash; a Windows path would
    // show up as one. Escaped quotes and newlines are fine.
    const json = renderJson(result);
    const parsed = JSON.parse(json) as Record<string, unknown>;
    const walk = (value: unknown, trail: string): void => {
      if (typeof value === 'string') {
        expect(value, `at ${trail}`).not.toMatch(/[A-Za-z0-9_.-]\\[A-Za-z0-9_.-]/);
        return;
      }
      if (Array.isArray(value)) {
        value.forEach((item, i) => walk(item, `${trail}[${i}]`));
        return;
      }
      if (value !== null && typeof value === 'object') {
        for (const [key, item] of Object.entries(value)) walk(item, `${trail}.${key}`);
      }
    };
    walk(parsed, '$');
  });

  it('emits POSIX paths in --fix patch headers', () => {
    // `git apply` requires forward slashes in `--- a/…` regardless of platform.
    const patch = generatePatch(analyze(path.join(FIXTURES, 'redundancy-bad')));
    for (const line of patch.split('\n')) {
      if (line.startsWith('--- a/') || line.startsWith('+++ b/')) {
        expect(line).not.toContain('\\');
      }
    }
  });

  it('renders the home directory as ~ rather than a platform path', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'assay-portable-'));
    try {
      fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
      fs.writeFileSync(path.join(home, '.claude', 'CLAUDE.md'), '# Personal\n\nA rule.\n');
      const withGlobal = analyze(path.join(FIXTURES, 'multi-harness'), {
        includeGlobal: true,
        homeDir: home,
      });
      const globalLine = withGlobal.budget.lines.find((l) => l.relPath.startsWith('~/'));
      expect(globalLine?.relPath).toBe('~/.claude/CLAUDE.md');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('path comparison does not assume a separator', () => {
  it('resolves --cwd given in either separator style', () => {
    const dir = path.join(FIXTURES, 'multi-harness');
    // `path.resolve` normalises both on every platform; asserting it here means
    // a regression shows up as a test failure rather than as a wrong budget.
    const posix = analyze(dir, { cwd: 'packages/api' });
    const native = analyze(dir, { cwd: path.join('packages', 'api') });
    expect(native.budget.total.value).toBe(posix.budget.total.value);
    expect(native.budget.cwdRelative).toBe('packages/api');
  });
});

describe('output is reproducible', () => {
  it('produces identical JSON for the same input across repeated runs', () => {
    // Cheap here, but this is the property that makes cross-platform diffing
    // meaningful at all: if it were unstable on one machine, comparing macOS
    // output to Windows output would prove nothing.
    const dir = path.join(FIXTURES, 'multi-harness');
    const first = JSON.parse(renderJson(analyze(dir))) as Record<string, unknown>;
    const second = JSON.parse(renderJson(analyze(dir))) as Record<string, unknown>;
    delete first['runtime'];
    delete second['runtime'];
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });
});
