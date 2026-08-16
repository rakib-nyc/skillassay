/**
 * Runs the analyzer across a directory of real repositories and reports what
 * broke, what it found, and how long it took.
 *
 * This exists because every serious bug in this tool was.md. Unit tests found none of
 * them. The rate has been roughly two bugs per new repository.
 *
 * It deliberately does NOT swallow failures: a crash is reported with its
 * message, because a crash on a user's repository is the worst outcome this tool
 * can produce and must never be summarised away as "0 findings".
 *
 * Usage: npm run wild -- <dir-of-clones> [--json out.json]
 */
import fs from 'node:fs';
import path from 'node:path';
import { analyze } from '../src/analyze/index.js';

const rootDir = process.argv[2] ?? 'wild';
const jsonIndex = process.argv.indexOf('--json');
const jsonOut = jsonIndex === -1 ? null : process.argv[jsonIndex + 1];

if (!fs.existsSync(rootDir)) {
  console.error(`No such directory: ${rootDir}`);
  process.exit(2);
}

interface RepoRun {
  repo: string;
  ok: boolean;
  crash?: string;
  durationMs: number;
  alwaysOnTokens: number;
  conditionalTokens: number;
  contextFiles: number;
  skills: number;
  parseErrors: number;
  findings: number;
  savings: number;
  byRule: Record<string, number>;
}

const runs: RepoRun[] = [];

for (const entry of fs.readdirSync(rootDir).sort()) {
  const dir = path.join(rootDir, entry);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(dir);
  } catch {
    continue;
  }
  if (!stat.isDirectory()) continue;

  const startedAt = Date.now();
  try {
    // No `includeGlobal`: the developer's own ~/.claude must not leak into a
    // measurement of other people's repositories.
    const result = analyze(dir);
    const byRule: Record<string, number> = {};
    for (const finding of result.findings) {
      byRule[finding.ruleId] = (byRule[finding.ruleId] ?? 0) + 1;
    }
    runs.push({
      repo: entry,
      ok: true,
      durationMs: Date.now() - startedAt,
      alwaysOnTokens: result.budget.total.value,
      conditionalTokens: result.budget.conditionalTotal.value,
      contextFiles: result.artifacts.filter((a) => a.kind === 'context_file').length,
      skills: result.skills.length,
      parseErrors: result.errors.length,
      findings: result.findings.length,
      savings: result.findings.reduce((s, f) => s + f.alwaysOnSavings, 0),
      byRule,
    });
  } catch (error) {
    runs.push({
      repo: entry,
      ok: false,
      crash: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      durationMs: Date.now() - startedAt,
      alwaysOnTokens: 0,
      conditionalTokens: 0,
      contextFiles: 0,
      skills: 0,
      parseErrors: 0,
      findings: 0,
      savings: 0,
      byRule: {},
    });
  }
}

const ok = runs.filter((r) => r.ok);
const crashed = runs.filter((r) => !r.ok);

const median = (values: number[]): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};

console.log(`\n=== Wild run: ${runs.length} repositories ===\n`);

if (crashed.length > 0) {
  console.log(`CRASHED: ${crashed.length}`);
  for (const run of crashed) console.log(`  ✖ ${run.repo}\n      ${run.crash}`);
  console.log('');
}

console.log(
  `Completed: ${ok.length}   ` +
    `crashed: ${crashed.length}   ` +
    `with parse errors: ${ok.filter((r) => r.parseErrors > 0).length}`,
);
console.log('');

console.log('repo                                   ctx  skills  always-on  findings  saves   ms');
for (const run of runs) {
  if (!run.ok) {
    console.log(`${run.repo.slice(0, 36).padEnd(38)}${'CRASHED'.padStart(30)}`);
    continue;
  }
  console.log(
    run.repo.slice(0, 36).padEnd(38) +
      String(run.contextFiles).padStart(4) +
      String(run.skills).padStart(8) +
      String(run.alwaysOnTokens).padStart(11) +
      String(run.findings).padStart(10) +
      String(run.savings).padStart(7) +
      String(run.durationMs).padStart(6),
  );
}

const alwaysOn = ok.map((r) => r.alwaysOnTokens);
const savings = ok.map((r) => r.savings);
const withFindings = ok.filter((r) => r.findings > 0);

console.log('\n--- distribution ---');
console.log(`always-on tokens : median ${median(alwaysOn)}  max ${Math.max(0, ...alwaysOn)}`);
console.log(`savings if fixed : median ${median(savings)}  max ${Math.max(0, ...savings)}`);
console.log(
  `repos with >=1 finding: ${withFindings.length}/${ok.length} ` +
    `(${((withFindings.length / Math.max(1, ok.length)) * 100).toFixed(0)}%)`,
);
console.log(`slowest run: ${Math.max(0, ...ok.map((r) => r.durationMs))}ms`);

const ruleTotals: Record<string, number> = {};
for (const run of ok) {
  for (const [rule, count] of Object.entries(run.byRule)) {
    ruleTotals[rule] = (ruleTotals[rule] ?? 0) + count;
  }
}
console.log('\n--- findings by rule ---');
for (const [rule, count] of Object.entries(ruleTotals).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${rule.padEnd(22)} ${count}`);
}

if (jsonOut) {
  fs.writeFileSync(jsonOut, `${JSON.stringify({ runs }, null, 2)}\n`);
  console.log(`\nWrote ${jsonOut}`);
}

// A crash is a hard failure: it is the outcome this script exists to catch.
process.exit(crashed.length > 0 ? 1 : 0);
