#!/usr/bin/env node
/**
 * Anti-simulation check.
 *
 * Fails the build if the analysis path contains anything that could fabricate a
 * result: randomness, demo branches, hardcoded findings, unlabelled estimates,
 * unfinished code reachable from a documented command, or a catch block that
 * swallows an error and substitutes a plausible default.
 *
 * This is a lint, not a proof. It cannot detect a fabricated number that looks
 * like an ordinary constant. What it does is make the *easy* ways to fake output
 * impossible to merge, and give a reviewer a fixed list to check by hand.
 *
 * Run: npm run lint:honesty
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC = path.join(ROOT, 'src');

/** Files whose job is to describe the rules, not to compute results. */
const DOC_ONLY = new Set([path.join(SRC, 'rules', 'index.ts')]);

const CHECKS = [
  {
    id: 'no-rng',
    // Any nondeterminism in analysis makes the report unreproducible.
    pattern: /\bMath\.random\s*\(|\bcrypto\.randomBytes\s*\(|\brandomUUID\s*\(/,
    message: 'randomness in the analysis path',
  },
  {
    id: 'no-demo-branch',
    pattern: /\b(?:demoMode|DEMO_MODE|process\.env\.DEMO|IS_DEMO|MOCK_MODE|process\.env\.MOCK)\b/,
    message: 'a demo/mock branch that could alter reported results',
  },
  {
    id: 'no-simulation-language',
    // Catches the specific failure this project is guarding against: code that
    // announces it is producing a result it did not compute.
    pattern: /\b(?:simulat(?:e|ed|ing|ion)|mock(?:ed|ing)?\s+(?:the\s+)?(?:result|completion|output|data)|fake\s+(?:result|data|finding)|placeholder\s+(?:number|value|finding)|hardcoded\s+(?:finding|result|number))\b/i,
    message: 'language indicating a fabricated result',
  },
  {
    id: 'no-unfinished-code',
    pattern: /\b(?:TODO|FIXME|XXX|HACK)\b|\bnot\s+implemented\b/i,
    message: 'unfinished code reachable from a documented command',
  },
  {
    id: 'no-unlabelled-token-estimate',
    // Word-count and character-count token estimates (§6.1, "Banned").
    pattern: /\.split\s*\(\s*\/\\s\+\/\s*\)\s*\.length\s*\*|\.length\s*\/\s*4\b|\blength\s*\*\s*1\.3\b/,
    message: 'a word- or character-count token estimate',
  },
];

/**
 * Catch blocks that swallow an error and return a plausible default.
 *
 * Detected structurally rather than by keyword: a `catch` whose body contains a
 * `return` of a literal, with no rethrow and no recording of the error. Every
 * legitimate swallow in this codebase either records the failure as an
 * ArtifactError or is annotated with why absence-of-data is safe there.
 */
function findSilentCatches(source) {
  const hits = [];
  const pattern = /catch\s*(?:\([^)]*\))?\s*\{([\s\S]*?)\}/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const body = match[1] ?? '';
    const returnsLiteral = /return\s+(?:0\b|''|""|`|\[\]|\{\}|null\b|true\b|false\b)/.test(body);
    const recorded = /(push|errors|throw|code:|message:)/.test(body);
    const annotated = /\/\//.test(body);
    if (returnsLiteral && !recorded && !annotated) {
      const line = source.slice(0, match.index).split('\n').length;
      hits.push(line);
    }
  }
  return hits;
}

function walk(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(full));
    else if (entry.name.endsWith('.ts')) files.push(full);
  }
  return files;
}

const violations = [];

for (const file of walk(SRC)) {
  const source = fs.readFileSync(file, 'utf8');
  const rel = path.relative(ROOT, file);
  const lines = source.split('\n');

  lines.forEach((line, index) => {
    // Comments explain the rules and quote the banned words on purpose;
    // the prohibition is on executable code, not on documentation of it.
    const code = line.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');

    for (const check of CHECKS) {
      // Comment-only lines are skipped for code checks, but NOT for the
      // unfinished-work check, whose whole subject is comments.
      if (code.trim().length === 0 && check.id !== 'no-unfinished-code') continue;
      if (DOC_ONLY.has(file) && check.id === 'no-simulation-language') continue;
      // Unfinished-work markers live in comments by nature, so that check must
      // see the raw line. Stripping comments first made it dead code — which is
      // itself the failure mode this script exists to catch, so it is asserted
      // in test/honesty.test.ts rather than trusted.
      const subject = check.id === 'no-unfinished-code' ? line : code;
      if (check.pattern.test(subject)) {
        violations.push(`${rel}:${index + 1}  [${check.id}] ${check.message}\n    ${line.trim()}`);
      }
    }
  });

  for (const line of findSilentCatches(source)) {
    violations.push(
      `${rel}:${line}  [no-silent-catch] catch block returns a default without recording the failure`,
    );
  }
}

// Block-comment bodies are stripped line-by-line above only when the delimiters
// share a line. Re-scan for the highest-risk pattern across whole files with
// comments removed properly, so a multi-line comment cannot hide code.
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
for (const file of walk(SRC)) {
  const stripped = stripComments(fs.readFileSync(file, 'utf8'));
  if (/\bMath\.random\s*\(/.test(stripped)) {
    violations.push(`${path.relative(ROOT, file)}  [no-rng] Math.random in executable code`);
  }
}

if (violations.length > 0) {
  console.error('\nAnti-simulation check FAILED\n');
  for (const violation of violations) console.error(`  ${violation}`);
  console.error(`
${violations.length} violation(s). These rules keep reported numbers trustworthy.
`);
  process.exit(1);
}

console.log(`Anti-simulation check passed (${walk(SRC).length} files, ${CHECKS.length + 1} checks).`);
