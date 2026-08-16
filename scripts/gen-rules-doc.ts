/**
 * Generates RULES.md from the rule registry.
 *
 * Generated rather than written so the document cannot drift from the code.
 * Every rule must map to a citation; here that is
 * mechanical — a rule with no citation could not compile, and a rule missing
 * from this file could not exist.
 *
 * Usage: npm run docs:rules
 */
import fs from 'node:fs';
import path from 'node:path';
import { RULES } from '../src/rules/index.js';
import {
  TRIGGER_OVERLAP_THRESHOLD,
  TRIGGER_OVERLAP_PRECISION,
  TRIGGER_OVERLAP_RECALL,
} from '../src/analyze/ambiguity.js';

const OFF_BY_DEFAULT = new Set(['AMB-TRIGGER-OVERLAP']);

const out: string[] = [];
out.push('# Rules');
out.push('');
out.push(
  'Generated from `src/rules/index.ts` by `npm run docs:rules`. Do not edit by hand.',
);
out.push('');
out.push(
  'Every rule carries at least one citation with a quoted sentence from the source, and a ' +
    'statement of what the rule does **not** establish. Run `assay --explain <RULE-ID>` to ' +
    'print any of this from the CLI.',
);
out.push('');

out.push('| Rule | Severity | Default | Title |');
out.push('|---|---|---|---|');
for (const rule of RULES) {
  const enabled = OFF_BY_DEFAULT.has(rule.id) ? 'opt-in' : 'on';
  out.push(`| [\`${rule.id}\`](#${rule.id.toLowerCase()}) | ${rule.defaultSeverity} | ${enabled} | ${rule.title} |`);
}
out.push('');

for (const rule of RULES) {
  out.push(`## ${rule.id}`);
  out.push('');
  out.push(`**${rule.title}** · default severity \`${rule.defaultSeverity}\``);
  out.push('');

  if (OFF_BY_DEFAULT.has(rule.id)) {
    out.push(
      `> **Off by default.** Enable with \`--experimental-ambiguity\`. Measured precision ` +
        `**${(TRIGGER_OVERLAP_PRECISION * 100).toFixed(1)}%** and recall ` +
        `**${(TRIGGER_OVERLAP_RECALL * 100).toFixed(1)}%** at threshold ` +
        `${TRIGGER_OVERLAP_THRESHOLD.toFixed(2)} on the hand-labelled set in ` +
        `[calibration/RESULTS.md](calibration/RESULTS.md). Roughly two in five findings ` +
        `from this rule are wrong.`,
    );
    out.push('');
  }

  out.push('### Why this is a finding');
  out.push('');
  out.push(rule.rationale);
  out.push('');

  out.push('### Sources');
  out.push('');
  for (const citation of rule.citations) {
    out.push(`- **${citation.ref}** — <${citation.url}>`);
    out.push(`  > ${citation.quote}`);
  }
  out.push('');

  out.push('### What this rule does not establish');
  out.push('');
  out.push(rule.limitation);
  out.push('');
}

fs.writeFileSync(path.resolve(import.meta.dirname, '..', 'RULES.md'), `${out.join('\n')}\n`);
console.log(`RULES.md written: ${RULES.length} rules.`);
