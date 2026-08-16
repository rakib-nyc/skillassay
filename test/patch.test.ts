import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyze } from '../src/analyze/index.js';
import { generatePatch } from '../src/report/patch.js';

/**
 * `--fix` patch tests.
 *
 * These run `git apply` for real rather than eyeballing the diff text. The first
 * implementation produced a patch that looked plausible and that git rejected
 * outright — overlapping hunks and `+` start lines that ignored earlier
 * deletions — and no amount of reading the output revealed it.
 *
 * The final test closes the loop on the headline projection: after applying the
 * patch, the tool is re-run and the new always-on total is compared against the
 * number the projection promised.
 */

const FIXTURES = path.resolve(import.meta.dirname, 'fixtures');
let workspace: string;

/**
 * These tests shell out to `git apply`, which is the point — verifying a patch
 * by reading it is how the first, invalid version of the generator passed
 * review. But a missing `git` is an absent tool, not a failing tool, and a
 * suite that reports red on a machine without git teaches people to ignore red.
 *
 * So they skip, loudly. CI installs git, and `test/honesty.test.ts` asserts
 * that these did not silently vanish there.
 */
function hasGit(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

const GIT_AVAILABLE = hasGit();
if (!GIT_AVAILABLE) {
  console.warn('[patch.test] SKIPPING patch tests: `git` is not on PATH in this environment.');
}

function gitInit(dir: string): void {
  const opts = { cwd: dir, stdio: 'pipe' as const };
  execFileSync('git', ['init', '-q', '.'], opts);
  execFileSync('git', ['config', 'user.email', 'test@example.com'], opts);
  execFileSync('git', ['config', 'user.name', 'test'], opts);
  execFileSync('git', ['add', '-A'], opts);
  execFileSync('git', ['commit', '-qm', 'init'], opts);
}

beforeAll(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'assay-patch-'));
});

afterAll(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe('--fix', () => {
  it.skipIf(!GIT_AVAILABLE)('produces a patch git accepts', () => {
    const dir = path.join(workspace, 'apply');
    fs.cpSync(path.join(FIXTURES, 'redundancy-bad'), dir, { recursive: true });
    gitInit(dir);

    const patchFile = path.join(workspace, 'a.patch');
    fs.writeFileSync(patchFile, generatePatch(analyze(dir)));

    // --check verifies applicability without touching the tree; it exits
    // non-zero and throws if any hunk is malformed or does not match.
    expect(() =>
      execFileSync('git', ['apply', '--check', patchFile], { cwd: dir, stdio: 'pipe' }),
    ).not.toThrow();
  });

  it.skipIf(!GIT_AVAILABLE)('deletes exactly the flagged lines and keeps everything else', () => {
    const dir = path.join(workspace, 'content');
    fs.cpSync(path.join(FIXTURES, 'redundancy-bad'), dir, { recursive: true });
    gitInit(dir);

    const patchFile = path.join(workspace, 'b.patch');
    fs.writeFileSync(patchFile, generatePatch(analyze(dir)));
    execFileSync('git', ['apply', patchFile], { cwd: dir, stdio: 'pipe' });

    const after = fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8');

    // Removed: the stack claim, the generic advice, the linter-enforced style
    // rule, and the whole directory-tree section.
    expect(after).not.toContain('We use typescript');
    expect(after).not.toContain('Write clean code');
    expect(after).not.toContain('Follow best practices');
    expect(after).not.toContain('Prefer single quotes');
    expect(after).not.toContain('## Project structure');
    expect(after).not.toContain('- routes/');

    // Kept: the heading, and the constraint that is genuinely not discoverable
    // from the repository. Deleting this would be the tool destroying the one
    // thing the research says context files are actually for.
    expect(after).toContain('# Payments API');
    expect(after).toContain('## Non-obvious constraints');
    expect(after).toContain('RefundGateway');
    expect(after).toContain('3 requests per second');
  });

  it.skipIf(!GIT_AVAILABLE)('delivers the token reduction the projection promised', () => {
    const dir = path.join(workspace, 'projection');
    fs.cpSync(path.join(FIXTURES, 'redundancy-bad'), dir, { recursive: true });
    gitInit(dir);

    const before = analyze(dir);
    const promisedSavings = before.findings.reduce((s, f) => s + f.alwaysOnSavings, 0);
    expect(promisedSavings).toBeGreaterThan(0);

    const patchFile = path.join(workspace, 'c.patch');
    fs.writeFileSync(patchFile, generatePatch(before));
    execFileSync('git', ['apply', patchFile], { cwd: dir, stdio: 'pipe' });

    const after = analyze(dir);
    const actualSavings = before.budget.total.value - after.budget.total.value;

    /*
     * Exact equality is not expected and would be a false promise. Deleting a
     * line removes its tokens, but the surrounding text re-tokenises: two blank
     * lines that were separated by content can merge into a sequence the BPE
     * encoder represents differently. The projection is a close estimate of a
     * real quantity, so assert it lands within two tokens rather than claiming
     * precision the method does not have.
     */
    expect(Math.abs(actualSavings - promisedSavings)).toBeLessThanOrEqual(2);
    expect(after.budget.total.value).toBeLessThan(before.budget.total.value);
  });

  it('leaves the tree clean when applied to a setup with no findings', () => {
    const dir = path.join(workspace, 'clean');
    fs.cpSync(path.join(FIXTURES, 'clean'), dir, { recursive: true });

    const patch = generatePatch(analyze(dir));
    expect(patch).toContain('No mechanically-deletable findings');
    expect(patch).not.toContain('@@');
  });

  it('lists routing findings as needing a human instead of guessing a fix', () => {
    const dir = path.join(FIXTURES, 'known-duplicates');
    const patch = generatePatch(analyze(dir));

    // Duplicate-name findings have no deletion range: which copy to keep is a
    // human decision, and the patch must not pick one.
    expect(patch).toContain('need a human decision');
    expect(patch).toContain('AMB-DUPLICATE-NAME');
    expect(patch).not.toContain('@@');
  });
});
