import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Tests for the honesty tooling itself.
 *
 * The anti-simulation script is the thing standing between this repo and a
 * fabricated number, so "it passes" is not evidence it works — a check that can
 * never fail passes too. These tests plant each violation class and assert the
 * script rejects it.
 *
 * This is not hypothetical: the `no-unfinished-code` check was initially dead
 * because it tested comment-stripped lines while TODO markers live in comments.
 * It passed cleanly and detected nothing.
 */

const ROOT = path.resolve(import.meta.dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'anti-simulation.mjs');

function runCheck(): { code: number; output: string } {
  try {
    const output = execFileSync('node', [SCRIPT], { cwd: ROOT, encoding: 'utf8' });
    return { code: 0, output };
  } catch (error) {
    const err = error as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, output: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

function withProbeFile(contents: string, assertion: (result: ReturnType<typeof runCheck>) => void) {
  const probe = path.join(ROOT, 'src', '__anti_simulation_probe.ts');
  fs.writeFileSync(probe, contents);
  try {
    assertion(runCheck());
  } finally {
    fs.rmSync(probe, { force: true });
  }
}

describe('anti-simulation check', () => {
  it('passes on the real source tree', () => {
    const result = runCheck();
    expect(result.output).toContain('passed');
    expect(result.code).toBe(0);
  });

  it('rejects randomness', () => {
    withProbeFile('export const x = () => Math.random();\n', (result) => {
      expect(result.code).toBe(1);
      expect(result.output).toContain('no-rng');
    });
  });

  it('rejects a demo branch', () => {
    withProbeFile('export const x = () => (process.env.DEMO ? 1 : 2);\n', (result) => {
      expect(result.code).toBe(1);
      expect(result.output).toContain('no-demo-branch');
    });
  });

  it('rejects a word-count token estimate', () => {
    withProbeFile('export const t = (s: string) => s.split(/\\s+/).length * 1.3;\n', (result) => {
      expect(result.code).toBe(1);
      expect(result.output).toContain('no-unlabelled-token-estimate');
    });
  });

  it('rejects a TODO marker, which lives in a comment', () => {
    // The regression guard for the dead-check bug described above.
    withProbeFile('// TODO: finish this\nexport const x = 1;\n', (result) => {
      expect(result.code).toBe(1);
      expect(result.output).toContain('no-unfinished-code');
    });
  });

  it('rejects a catch block that returns a default without recording anything', () => {
    withProbeFile(
      'export function f(): number {\n  try {\n    return 1;\n  } catch {\n    return 0;\n  }\n}\n',
      (result) => {
        expect(result.code).toBe(1);
        expect(result.output).toContain('no-silent-catch');
      },
    );
  });

  it('rejects simulation language in executable code', () => {
    withProbeFile('export const msg = "Running tasks... (simulated)";\n', (result) => {
      expect(result.code).toBe(1);
      expect(result.output).toContain('no-simulation-language');
    });
  });
});

describe('the CLI does not expose unimplemented features', () => {
  const cliSource = fs.readFileSync(path.join(ROOT, 'src', 'cli.ts'), 'utf8');

  it('defines no --deep flag', () => {
    // Semantic embedding search is not implemented. A flag that accepted the
    // argument and printed something would imply otherwise.
    expect(cliSource).not.toMatch(/\.option\(\s*['"`]--deep/);
  });

  it('defines no --empirical flag', () => {
    // A/B measurement is not implemented. The previous version of this tool
    // printed "+2.1% success" from a string literal here.
    expect(cliSource).not.toMatch(/\.option\(\s*['"`]--empirical/);
  });

  it('exits non-zero on an unknown flag rather than ignoring it', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'assay-cli-'));
    try {
      execFileSync('node', ['--import', 'tsx', path.join(ROOT, 'src', 'cli.ts'), '--deep', tmp], {
        cwd: ROOT,
        encoding: 'utf8',
        stdio: 'pipe',
      });
      throw new Error('expected a non-zero exit for an unknown flag');
    } catch (error) {
      const err = error as { status?: number; stderr?: string };
      expect(err.status).not.toBe(0);
      expect(err.stderr ?? '').toContain('unknown option');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('version consistency', () => {
  it('keeps the reported version in step with package.json', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
      version: string;
    };
    const json = fs.readFileSync(path.join(ROOT, 'src', 'report', 'json.ts'), 'utf8');
    expect(json).toContain(`export const VERSION = '${pkg.version}'`);
  });
});

describe('the package always carries a compiled CLI', () => {
  /*
   * `dist/` is generated, so it is not in the repository, and the published
   * package is unusable without it — `npx skillassay` resolves a bin that is
   * not there.
   *
   * The build must therefore run on `prepack`, not `prepublishOnly`. The two
   * differ in exactly one case that matters: `npm pack` runs `prepack` and skips
   * `prepublishOnly`, so a tarball built for review, for CI, or to hand to
   * someone to publish came out with the sources and no CLI. That happened, and
   * the tarball looked ordinary — 6 files instead of 60, with no error.
   */
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
    files?: string[];
    bin?: Record<string, string>;
    scripts?: Record<string, string>;
  };

  it('builds on prepack, so `npm pack` and `npm publish` agree', () => {
    expect(pkg.scripts?.['prepack']).toBe('npm run build');
  });

  it('includes every path the bin entries point into', () => {
    const files = pkg.files ?? [];
    for (const target of Object.values(pkg.bin ?? {})) {
      const top = target.replace(/^\.\//, '').split('/')[0];
      expect(files).toContain(top);
    }
  });
});
