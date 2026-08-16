import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyze } from '../src/analyze/index.js';
import { renderJson } from '../src/report/json.js';
import { renderTerminal } from '../src/report/terminal.js';

/**
 * The interface an agent consumes.
 *
 * A human reads the terminal report top to bottom and stops when satisfied. An
 * agent has different constraints: it needs a bounded response that will not
 * swallow its context, a field it can branch on without parsing prose, and the
 * ability to ask about one file rather than a whole repository.
 *
 * These test that surface specifically, because it is easy to build a tool that
 * is pleasant for a person and unusable for a program.
 */

const ROOT = path.resolve(import.meta.dirname, '..');

function tempRepo(skills: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'assay-agent-'));
  for (const [dir, frontmatter] of Object.entries(skills)) {
    const skillDir = path.join(root, '.claude', 'skills', dir);
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `---\n${frontmatter}\n---\n\n# Body\n`);
  }
  return root;
}

describe('conformance is a single field an agent can branch on', () => {
  it('is true when every skill satisfies the hard constraints', () => {
    const root = tempRepo({ 'good-skill': 'name: good-skill\ndescription: Does it. Use when asked.' });
    try {
      const result = analyze(root);
      expect(result.conformance.willLoad).toBe(true);
      expect(result.conformance.blockingFindings).toBe(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('is false, with a count, when a skill would be rejected', () => {
    const root = tempRepo({
      'good-skill': 'name: good-skill\ndescription: Does it. Use when asked.',
      bad: 'name: Bad_Name\ndescription: Does it. Use when asked.',
    });
    try {
      const result = analyze(root);
      expect(result.conformance.willLoad).toBe(false);
      expect(result.conformance.blockingFindings).toBe(1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('is not affected by non-blocking findings', () => {
    // A skill can be verbose, duplicated or redundant and still load. Only the
    // hard specification constraints set this flag.
    const root = tempRepo({
      'alpha-skill': 'name: alpha-skill\ndescription: Ships a release. Use when the user asks to deploy.',
      'beta-skill': 'name: beta-skill\ndescription: Ships a release. Use when the user asks to deploy.',
    });
    try {
      const result = analyze(root, { experimentalAmbiguity: true });
      expect(result.findings.length).toBeGreaterThan(0);
      expect(result.conformance.willLoad).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('appears in the JSON payload', () => {
    const root = tempRepo({ bad: 'name: Bad_Name\ndescription: Does it. Use when asked.' });
    try {
      const payload = JSON.parse(renderJson(analyze(root))) as {
        conformance: { willLoad: boolean; blockingFindings: number };
      };
      expect(payload.conformance.willLoad).toBe(false);
      expect(payload.conformance.blockingFindings).toBe(1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('a single SKILL.md is a valid target', () => {
  it('analyses only that file, leaving its neighbours alone', () => {
    const root = tempRepo({
      'first-skill': 'name: first-skill\ndescription: Does it. Use when asked.',
      second: 'name: Bad_Name\ndescription: Does it. Use when asked.',
    });
    try {
      // Whole repo: the bad skill is reported.
      expect(analyze(root).conformance.willLoad).toBe(false);

      // Just the good one: silent about the other.
      // `only` is an exact relative path, not a suffix — unambiguous by design.
      const scoped = analyze(root, { only: '.claude/skills/first-skill/SKILL.md' });
      expect(scoped.skills).toHaveLength(1);
      expect(scoped.skills[0]?.skill.name).toBe('first-skill');
      expect(scoped.conformance.willLoad).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('still sees the skill directory, so the name/directory rule works', () => {
    // The rule needs the parent directory name. Targeting a file must not
    // rebase the root so high that the directory is lost.
    const root = tempRepo({ 'some-dir': 'name: other-name\ndescription: Does it. Use when asked.' });
    try {
      const scoped = analyze(root, { only: '.claude/skills/some-dir/SKILL.md' });
      const mismatch = scoped.findings.filter((f) => f.ruleId === 'SPEC-NAME-DIR-MISMATCH');
      expect(mismatch).toHaveLength(1);
      expect(mismatch[0]?.evidence['directory']).toBe('some-dir');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('works end to end through the CLI', () => {
    const root = tempRepo({ 'cli-skill': 'name: Bad_Name\ndescription: Does it. Use when asked.' });
    const target = path.join(root, '.claude', 'skills', 'cli-skill', 'SKILL.md');
    try {
      let stdout = '';
      try {
        stdout = execFileSync(
          'node',
          ['--import', 'tsx', path.join(ROOT, 'src', 'cli.ts'), target, '--json', '--no-global'],
          { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' },
        );
      } catch (error) {
        // Non-zero exit is expected: there is a blocking finding.
        stdout = String((error as { stdout?: string }).stdout ?? '');
      }
      const payload = JSON.parse(stdout) as {
        conformance: { willLoad: boolean };
        summary: { skillsParsed: number };
      };
      expect(payload.summary.skillsParsed).toBe(1);
      expect(payload.conformance.willLoad).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('an exclusion that skipped nothing is reported', () => {
  /*
   * `--exclude` compares literal repository-relative prefixes. A caller who
   * passes a glob, or a bare directory name, gets a run that succeeds with the
   * supposedly-excluded files still in the budget. Nothing about the output
   * reveals it, which is what makes silence the wrong behaviour here.
   */
  it('warns on stderr and leaves stdout machine-readable', () => {
    const root = tempRepo({ 'ex-skill': 'name: ex-skill\ndescription: Does it. Use when asked.' });
    try {
      const cli = path.join(ROOT, 'src', 'cli.ts');
      let stdout = '';
      let stderr = '';
      try {
        stdout = execFileSync(
          'node',
          ['--import', 'tsx', cli, root, '--json', '--no-global', '--exclude', '**/ex-skill/**'],
          { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' },
        );
      } catch (error) {
        const err = error as { stdout?: string; stderr?: string };
        stdout = String(err.stdout ?? '');
        stderr = String(err.stderr ?? '');
      }
      // stderr is only populated on the throwing path; re-read it either way by
      // asserting on the combined stream the caller would see.
      const combined = stderr;
      expect(() => JSON.parse(stdout)).not.toThrow();
      expect(combined + stdout).not.toContain('"warning');

      // The warning itself, captured deliberately.
      const proc = execFileSync(
        'sh',
        [
          '-c',
          `node --import tsx ${JSON.stringify(cli)} ${JSON.stringify(root)} --json --no-global --exclude '**/ex-skill/**' 2>&1 >/dev/null`,
        ],
        { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' },
      );
      expect(proc).toContain('matched nothing');
      expect(proc).toContain('not globs');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  it('stays silent when the exclusion actually matches', () => {
    const root = tempRepo({ 'ex-skill': 'name: ex-skill\ndescription: Does it. Use when asked.' });
    try {
      const cli = path.join(ROOT, 'src', 'cli.ts');
      const proc = execFileSync(
        'sh',
        [
          '-c',
          `node --import tsx ${JSON.stringify(cli)} ${JSON.stringify(root)} --json --no-global --exclude '.claude/skills/ex-skill' 2>&1 >/dev/null`,
        ],
        { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' },
      );
      expect(proc).not.toContain('matched nothing');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('stdout survives being piped', () => {
  /*
   * An agent does not read a terminal; it reads a pipe, usually through `jq` or
   * a captured buffer. Node's stdout is asynchronous when it is not a TTY, so a
   * `process.exit()` immediately after writing discards whatever is still in the
   * buffer past the operating system's 64 KiB pipe capacity.
   *
   * That failure is invisible in every convenient way of checking: redirecting
   * to a file works, small repositories work, and `assay --json | wc -c` often
   * works because `wc` drains fast enough to keep up. It only breaks on a real
   * repository consumed by a real reader, and it breaks by producing JSON that
   * is a prefix of the truth rather than an error. So the test uses a shell
   * pipeline with a slow-to-schedule reader, and asserts on parseability.
   */
  function bigRepo(): string {
    const skills: Record<string, string> = {};
    for (let i = 0; i < 40; i++) {
      skills[`dir${i}`] = `name: Bad_Name_${i}\ndescription: Does it. Use when asked.`;
    }
    return tempRepo(skills);
  }

  it('does not truncate a report larger than the pipe buffer', () => {
    const root = bigRepo();
    try {
      const cli = path.join(ROOT, 'src', 'cli.ts');
      // `| cat` is the reader: an extra process hop is enough to expose the
      // race that a directly-attached consumer can hide.
      const piped = execFileSync(
        'sh',
        ['-c', `node --import tsx ${JSON.stringify(cli)} ${JSON.stringify(root)} --json --no-global | cat`],
        { cwd: ROOT, encoding: 'utf8', stdio: 'pipe', maxBuffer: 64 * 1024 * 1024 },
      );

      expect(piped.length).toBeGreaterThan(65_536);
      const payload = JSON.parse(piped) as { findings: unknown[] };
      expect(payload.findings.length).toBeGreaterThanOrEqual(40);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  it('exits quietly when the reader closes early', () => {
    const root = bigRepo();
    try {
      const cli = path.join(ROOT, 'src', 'cli.ts');
      // `head -1` closes the pipe after one line, which raises EPIPE on the
      // writer. That is a normal end to the conversation, not a crash.
      const out = execFileSync(
        'sh',
        [
          '-c',
          `node --import tsx ${JSON.stringify(cli)} ${JSON.stringify(root)} --json --no-global 2>&1 | head -1`,
        ],
        { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' },
      );
      expect(out).not.toContain('EPIPE');
      expect(out).not.toContain('Error');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('output stays bounded without hiding anything', () => {
  function manyFindings(): string {
    const skills: Record<string, string> = {};
    for (let i = 0; i < 12; i++) {
      skills[`dir${i}`] = `name: Bad_Name_${i}\ndescription: Does it. Use when asked.`;
    }
    return tempRepo(skills);
  }

  it('caps the rendered findings at --top', () => {
    const root = manyFindings();
    try {
      const result = analyze(root);
      const full = renderTerminal(result, { color: false, verbose: false });
      const capped = renderTerminal(result, { color: false, verbose: false, top: 3 });
      expect(capped.length).toBeLessThan(full.length);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('states how many findings it withheld, rather than dropping them silently', () => {
    const root = manyFindings();
    try {
      const result = analyze(root);
      const capped = renderTerminal(result, { color: false, verbose: false, top: 3 });
      expect(capped).toMatch(/further finding\(s\) not shown/);
      // The headline count is still the true total.
      expect(capped).toContain(`${result.findings.length} error`);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('never truncates the JSON payload, which is the machine interface', () => {
    const root = manyFindings();
    try {
      const result = analyze(root);
      const payload = JSON.parse(renderJson(result)) as { findings: unknown[] };
      expect(payload.findings).toHaveLength(result.findings.length);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
