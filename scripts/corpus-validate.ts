/**
 * Real-corpus validation.
 *
 * Runs the analyzer over every skill repository in the corpus and reports:
 * parse success rate, findings-per-skill distribution, wall-clock runtime, and
 * trigger-clause detection coverage.
 *
 * It also writes a deterministic sample of findings to
 * calibration/finding-sample.json for manual false-positive review. The sample
 * is taken by a fixed stride over a sorted list — no RNG — so the reviewed set
 * is reproducible and cannot be re-drawn until it looks good.
 *
 * Usage: npm run corpus:validate -- <corpus-dir>
 */
import fs from 'node:fs';
import path from 'node:path';
import { analyze } from '../src/analyze/index.js';
import { discoverArtifacts } from '../src/discovery/index.js';
import { parseSkill } from '../src/parse/skill.js';
import { normaliseSource } from '../src/parse/frontmatter.js';
import { splitDescription } from '../src/text/normalize.js';

const corpusDir = process.argv[2] ?? 'corpus';
if (!fs.existsSync(corpusDir)) {
  console.error(`Corpus not found at ${corpusDir}. Run: npm run corpus:fetch`);
  process.exit(2);
}

const repos = fs
  .readdirSync(corpusDir, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();

interface RepoResult {
  repo: string;
  skillFiles: number;
  parsed: number;
  failed: number;
  findings: number;
  durationMs: number;
}

const perRepo: RepoResult[] = [];
const allFindings: { repo: string; ruleId: string; summary: string; locations: string[] }[] = [];
const failureCodes = new Map<string, number>();
const findingsPerSkill: number[] = [];

let totalSkillFiles = 0;
let totalParsed = 0;
let withTrigger = 0;

for (const repo of repos) {
  const dir = path.join(corpusDir, repo);
  const started = Date.now();
  const result = analyze(dir, { experimentalAmbiguity: true });
  const durationMs = Date.now() - started;

  const skillArtifacts = result.artifacts.filter((a) => a.kind === 'skill');
  const skillErrors = result.errors.filter((e) => e.kind === 'skill');

  for (const error of skillErrors) {
    failureCodes.set(error.code, (failureCodes.get(error.code) ?? 0) + 1);
  }

  for (const record of result.skills) {
    if (record.triggerSurface !== null) withTrigger++;
  }

  for (const finding of result.findings) {
    allFindings.push({
      repo,
      ruleId: finding.ruleId,
      summary: finding.summary,
      locations: finding.locations.map((l) => `${l.path}${l.line ? `:${l.line}` : ''}`),
    });
  }

  totalSkillFiles += skillArtifacts.length;
  totalParsed += result.skills.length;

  if (result.skills.length > 0) {
    findingsPerSkill.push(result.findings.length / result.skills.length);
  }

  perRepo.push({
    repo,
    skillFiles: skillArtifacts.length,
    parsed: result.skills.length,
    failed: skillErrors.length,
    findings: result.findings.length,
    durationMs,
  });
}

// --- whole-corpus parse check, independent of the per-repo analyze() runs -----
// Re-parses every SKILL.md directly so the parse rate is not an artifact of how
// repositories were partitioned.
const flat = discoverArtifacts(corpusDir).artifacts.filter((a) => a.kind === 'skill');
let flatParsed = 0;
const flatFailureCodes = new Map<string, number>();
for (const artifact of flat) {
  const parsed = parseSkill(normaliseSource(fs.readFileSync(artifact.path, 'utf8')), {
    fallbackName: path.basename(path.dirname(artifact.path)),
  });
  if (parsed.ok) {
    flatParsed++;
    if (splitDescription(parsed.value.description).trigger !== null) {
      // counted separately above; recomputed here only for the flat total
    }
  } else {
    flatFailureCodes.set(parsed.code, (flatFailureCodes.get(parsed.code) ?? 0) + 1);
  }
}

const pct = (n: number) => `${(n * 100).toFixed(2)}%`;
const sorted = [...findingsPerSkill].sort((a, b) => a - b);
const at = (q: number) => sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)] ?? 0;
const durations = perRepo.map((r) => r.durationMs).sort((a, b) => a - b);

console.log('\n=== Corpus validation ===\n');
console.log(`Repositories:        ${repos.length}`);
console.log(`SKILL.md files:      ${flat.length}`);
console.log(`Parsed successfully: ${flatParsed} (${pct(flatParsed / flat.length)})`);
console.log(`Failed:              ${flat.length - flatParsed}`);
if (flatFailureCodes.size > 0) {
  for (const [code, count] of [...flatFailureCodes.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${code.padEnd(28)} ${count}`);
  }
}
console.log(`\nTrigger clause detected in: ${withTrigger} / ${totalParsed} (${pct(withTrigger / totalParsed)})`);
console.log(`\nFindings per skill: p50=${at(0.5).toFixed(3)} p90=${at(0.9).toFixed(3)} max=${at(1).toFixed(3)}`);
console.log(
  `Runtime per repo (ms): min=${durations[0]} p50=${durations[Math.floor(durations.length / 2)]} max=${durations[durations.length - 1]}`,
);
console.log(`Total findings: ${allFindings.length}\n`);

console.log('Per repository:');
console.log('  repo                              files  parsed  failed  findings   ms');
for (const r of perRepo) {
  console.log(
    `  ${r.repo.padEnd(34)}${String(r.skillFiles).padStart(5)}${String(r.parsed).padStart(8)}` +
      `${String(r.failed).padStart(8)}${String(r.findings).padStart(10)}${String(r.durationMs).padStart(5)}`,
  );
}

console.log('\nFindings by rule:');
const byRule = new Map<string, number>();
for (const finding of allFindings) byRule.set(finding.ruleId, (byRule.get(finding.ruleId) ?? 0) + 1);
for (const [rule, count] of [...byRule.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${rule.padEnd(24)} ${count}`);
}

// --- deterministic sample for manual review ---------------------------------
const SAMPLE_SIZE = 50;
// Sample ONLY from default-path findings. AMB-TRIGGER-OVERLAP is opt-in and
// its precision is already measured separately on the labelled pair set; mixing
// it in here would blend two different measurements into one misleading number.
const ordered = [...allFindings]
  .filter((f) => f.ruleId !== 'AMB-TRIGGER-OVERLAP')
  .sort((a, b) => {
    const ka = `${a.ruleId}|${a.repo}|${a.locations.join(',')}`;
    const kb = `${b.ruleId}|${b.repo}|${b.locations.join(',')}`;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
const stride = Math.max(1, Math.floor(ordered.length / SAMPLE_SIZE));
const sample = [];
for (let i = 0; i < ordered.length && sample.length < SAMPLE_SIZE; i += stride) {
  sample.push({ ...ordered[i], verdict: null as string | null, note: '' });
}

fs.mkdirSync('calibration', { recursive: true });
fs.writeFileSync(
  'calibration/finding-sample.json',
  `${JSON.stringify(
    {
      method:
        `Findings sorted by (ruleId, repo, location) then sampled at a fixed stride of ${stride}. ` +
        'Deterministic: no RNG, and the sample cannot be re-drawn until it looks favourable.',
      corpusSkills: flat.length,
      totalFindings: allFindings.length,
      sampleSize: sample.length,
      findings: sample,
    },
    null,
    2,
  )}\n`,
);

console.log(`\nWrote calibration/finding-sample.json (${sample.length} findings, stride ${stride})`);
