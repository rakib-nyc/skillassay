import { getRule } from '../rules/index.js';
import { describeMethod } from '../tokenize/index.js';
import type { AnalysisResult, Finding, Severity } from '../types.js';

/**
 * Terminal report.
 *
 * this is the artifact people screenshot, and it must be
 * capable of reporting a clean bill of health. A tool that always finds
 * something is manufacturing findings, so the zero-finding path is a designed
 * output here, not a fallback.
 */

export interface TerminalOptions {
  readonly color: boolean;
  readonly verbose: boolean;
}

const SEVERITY_ICON: Record<Severity, string> = { error: '✖', warn: '▲', info: '·' };
const SEVERITY_COLOR: Record<Severity, string> = { error: '31', warn: '33', info: '90' };

function makePaint(enabled: boolean) {
  return (text: string, code: string): string =>
    enabled ? `[${code}m${text}[0m` : text;
}

function bar(fraction: number, width: number): string {
  const filled = Math.max(0, Math.min(width, Math.round(fraction * width)));
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

export function renderTerminal(result: AnalysisResult, options: TerminalOptions): string {
  const paint = makePaint(options.color);
  const out: string[] = [];
  const { budget, findings, target } = result;

  const counts: Record<Severity, number> = { error: 0, warn: 0, info: 0 };
  for (const f of findings) counts[f.severity]++;

  const pct = (budget.total.value / target.contextWindow) * 100;

  // --- header ---------------------------------------------------------------
  out.push('');
  out.push(paint('  skillassay', '1') + paint(`  ·  ${target.label}`, '90'));
  out.push(
    paint(
      `  harness: ${budget.harness}${budget.harnessDetected ? ' (detected)' : ''}` +
        (budget.cwdRelative === '' ? '  ·  at repository root' : `  ·  cwd: ${budget.cwdRelative}/`) +
        (budget.harnessAlternatives.length > 0
          ? `\n  also configured: ${budget.harnessAlternatives.join(', ')} — use --harness to switch`
          : ''),
      '90',
    ),
  );
  out.push(paint('  ' + '─'.repeat(66), '90'));
  out.push('');

  // --- Tier 0 headline ------------------------------------------------------
  out.push(
    `  ${paint('ALWAYS-ON CONTEXT', '1')}   ` +
      paint(`${budget.total.value.toLocaleString()} tokens`, '36') +
      paint(`  ${pct.toFixed(2)}% of ${(target.contextWindow / 1000).toFixed(0)}K window`, '90'),
  );
  out.push(`  ${paint(bar(pct / 100, 40), '36')}`);
  out.push(paint(`  Counted with ${describeMethod(budget.total.method)}`, '90'));
  out.push(
    paint(
      `  Loaded every session, before you type anything. Skill bodies are NOT included:`,
      '90',
    ),
  );
  out.push(
    paint(
      `  they load only on trigger (${budget.conditionalTotal.value.toLocaleString()} tokens across ` +
        `${result.skills.length} skills, conditional).`,
      '90',
    ),
  );
  out.push('');

  // --- contributors ---------------------------------------------------------
  if (budget.lines.length > 0) {
    out.push(`  ${paint('Where it goes', '1')}`);
    const shown = options.verbose ? budget.lines : budget.lines.slice(0, 8);
    const widest = Math.max(...shown.map((l) => l.tokens.value.toString().length), 5);
    for (const line of shown) {
      const share = budget.total.value > 0 ? line.tokens.value / budget.total.value : 0;
      out.push(
        `    ${line.tokens.value.toString().padStart(widest)}  ` +
          paint(bar(share, 12), '90') +
          `  ${line.relPath} ` +
          paint(`(${line.portion})`, '90'),
      );
    }
    if (!options.verbose && budget.lines.length > 8) {
      const rest = budget.lines.slice(8).reduce((s, l) => s + l.tokens.value, 0);
      out.push(
        paint(
          `    ${rest.toString().padStart(widest)}  ${' '.repeat(12)}  … and ${budget.lines.length - 8} more (--verbose to list)`,
          '90',
        ),
      );
    }
    out.push('');
  }

  // --- excluded --------------------------------------------------------------
  // Everything found but not counted, with the reason. Without this the
  // headline is unreconcilable against the file tree, and a reader has no way
  // to tell a correct exclusion from a missing file.
  if (budget.excluded.length > 0) {
    out.push(
      `  ${paint('Found but not counted', '1')}  ` +
        paint(`(real files, not loaded by ${budget.harness} here)`, '90'),
    );
    for (const item of budget.excluded) {
      out.push(
        `    ${item.tokens.toLocaleString().padStart(7)}  ${item.reason} ` +
          paint(`(${item.artifacts} file${item.artifacts === 1 ? '' : 's'})`, '90'),
      );
      out.push(paint(`             e.g. ${item.examples.join(', ')}`, '90'));
    }
    out.push('');
  }

  // --- unmeasured -----------------------------------------------------------
  if (budget.unmeasured.length > 0) {
    out.push(`  ${paint('Not counted above', '1')}  ${paint('(real cost, not statically measurable)', '90')}`);
    for (const item of budget.unmeasured) {
      out.push(`    ${paint('?', '33')} ${item.source}`);
      for (const chunk of wrap(item.reason, 62)) out.push(paint(`      ${chunk}`, '90'));
    }
    out.push('');
  }

  // --- parse failures -------------------------------------------------------
  if (result.errors.length > 0) {
    out.push(`  ${paint(`Could not analyze ${result.errors.length} file(s)`, '1')}`);
    for (const error of result.errors) {
      out.push(`    ${paint('!', '31')} ${error.relPath}`);
      out.push(paint(`      ${error.code}: ${error.message}`, '90'));
    }
    out.push('');
  }

  // --- findings -------------------------------------------------------------
  if (findings.length === 0) {
    if (result.errors.length > 0) {
      // "Clean" would be a lie here: files that could not be parsed were never
      // checked, so the absence of findings is partly an absence of coverage.
      out.push(`  ${paint('No findings in what could be analyzed.', '33')}`);
      out.push(
        paint(
          `     ${result.errors.length} file(s) above could not be parsed and were not checked, ` +
            `so this is not a clean bill of health.`,
          '90',
        ),
      );
    } else {
      out.push(`  ${paint('✓  Clean bill of health.', '32')}`);
      out.push(
        paint(
          `     ${result.skills.length} skill(s) and ${result.artifacts.length} artifact(s) checked ` +
            `across ${result.stats.pairsCompared} skill pair(s). No findings.`,
          '90',
        ),
      );
    }
    out.push('');
    return out.join('\n');
  }

  const summary = [
    counts.error > 0 ? paint(`${counts.error} error`, '31') : null,
    counts.warn > 0 ? paint(`${counts.warn} warning`, '33') : null,
    counts.info > 0 ? paint(`${counts.info} info`, '90') : null,
  ]
    .filter(Boolean)
    .join(paint(' · ', '90'));

  out.push(`  ${paint('FINDINGS', '1')}   ${summary}`);
  out.push('');

  /*
   * Collapse a rule that fires many times.
   *
   * On a real 198-skill repository `AMB-NO-TRIGGER` fired 197 times — all of
   * them correct, and all of them one problem: that library's descriptions
   * systematically omit trigger conditions. Printing 197 near-identical blocks
   * buries the two findings that differ and makes the report unreadable, which
   * is a good way to have a correct tool ignored.
   */
  const MAX_PER_RULE = 5;
  const byRule = new Map<string, Finding[]>();
  for (const finding of findings) {
    const bucket = byRule.get(finding.ruleId);
    if (bucket) bucket.push(finding);
    else byRule.set(finding.ruleId, [finding]);
  }

  const seen = new Set<string>();
  for (const finding of findings) {
    const group = byRule.get(finding.ruleId) ?? [];
    if (options.verbose || group.length <= MAX_PER_RULE) {
      out.push(renderFinding(finding, paint, options.verbose));
      continue;
    }

    if (seen.has(finding.ruleId)) continue;
    seen.add(finding.ruleId);

    for (const shown of group.slice(0, MAX_PER_RULE)) {
      out.push(renderFinding(shown, paint, options.verbose));
    }
    const rest = group.length - MAX_PER_RULE;
    out.push(
      paint(
        `      … and ${rest} more ${finding.ruleId} finding${rest === 1 ? '' : 's'} ` +
          `(--verbose to list, or --json for all of them)`,
        '90',
      ),
    );
    out.push('');
  }

  // --- projection -----------------------------------------------------------
  /*
   * Clamped, because an unclamped projection printed "0 to -51 tokens
   * (0.00% → -0.03% of window; −Infinity%)" on a real repository. Savings can
   * exceed the counted budget when a finding lands on a file the active harness
   * does not load; scoping the analyzers to the harness fixes the cause, and
   * this clamp makes the arithmetic incapable of producing nonsense regardless.
   */
  const rawSavings = findings.reduce((sum, f) => sum + f.alwaysOnSavings, 0);
  const savings = Math.min(rawSavings, budget.total.value);
  if (savings > 0) {
    const after = budget.total.value - savings;
    const afterPct = (after / target.contextWindow) * 100;
    out.push(`  ${paint('PROJECTION', '1')}`);
    out.push(
      `    Applying every deletion above reduces always-on context from ` +
        paint(`${budget.total.value.toLocaleString()}`, '36') +
        ` to ` +
        paint(`${after.toLocaleString()}`, '32') +
        ` tokens`,
    );
    out.push(
      paint(
        `    (${pct.toFixed(2)}% → ${afterPct.toFixed(2)}% of window; ` +
          `−${savings.toLocaleString()} tokens, −${
            budget.total.value === 0 ? '0.0' : ((savings / budget.total.value) * 100).toFixed(1)
          }%).`,
        '90',
      ),
    );
    out.push(
      paint(
        `    Measured by counting the exact text each finding proposes deleting.`,
        '90',
      ),
    );
    out.push('');
  }

  out.push(
    paint(
      `  ${result.stats.skillsParsed} skills · ${result.stats.pairsCompared} pairs compared · ` +
        `${result.stats.filesScanned} files scanned in ${result.stats.durationMs}ms`,
      '90',
    ),
  );
  out.push(paint(`  assay --explain <RULE-ID> for the rule, its source, and its limits.`, '90'));
  out.push('');

  return out.join('\n');
}

function renderFinding(
  finding: Finding,
  paint: (t: string, c: string) => string,
  verbose: boolean,
): string {
  const rule = getRule(finding.ruleId);
  const lines: string[] = [];

  lines.push(
    `  ${paint(SEVERITY_ICON[finding.severity], SEVERITY_COLOR[finding.severity])} ` +
      paint(`[${finding.ruleId}]`, '1') +
      ` ${finding.summary}`,
  );

  for (const loc of finding.locations) {
    lines.push(paint(`      ${loc.path}${loc.line !== undefined ? `:${loc.line}` : ''}`, '90'));
  }

  for (const [key, value] of Object.entries(finding.evidence)) {
    const text = String(value);
    if (text.length === 0) continue;
    const label = `${key}:`;
    const wrapped = wrap(text, 58);
    lines.push(paint(`      ${label} ${wrapped[0] ?? ''}`, '90'));
    for (const extra of wrapped.slice(1)) {
      lines.push(paint(`      ${' '.repeat(label.length + 1)}${extra}`, '90'));
    }
  }

  lines.push('');
  for (const chunk of wrap(finding.suggestion, 62)) {
    lines.push(`      ${paint('→', '32')} ${chunk}`);
  }

  if (finding.alwaysOnSavings > 0) {
    lines.push(paint(`      saves ${finding.alwaysOnSavings} always-on tokens`, '32'));
  }

  const citation = rule.citations[0];
  if (citation) {
    lines.push(paint(`      source: ${citation.ref}`, '90'));
    if (verbose) {
      for (const chunk of wrap(`“${citation.quote}”`, 60)) {
        lines.push(paint(`              ${chunk}`, '90'));
      }
      for (const chunk of wrap(`limits: ${rule.limitation}`, 60)) {
        lines.push(paint(`      ${chunk}`, '90'));
      }
    }
  }

  lines.push('');
  return lines.join('\n');
}

function wrap(text: string, width: number): string[] {
  const words = text.replace(/\s+/g, ' ').trim().split(' ');
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    if (current.length === 0) current = word;
    else if (current.length + 1 + word.length <= width) current += ` ${word}`;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines.length > 0 ? lines : [''];
}
