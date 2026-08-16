import { getRule } from '../rules/index.js';
import { describeMethod } from '../tokenize/index.js';
import type { AnalysisResult, Severity } from '../types.js';

/**
 * Machine-readable output.
 *
 * Everything here is a pure function of the input tree except the single
 * `runtime` block, which is explicitly named so consumers — and the determinism
 * test in test/falsifiability.test.ts — can strip it. allows an
 * "explicitly-marked timestamp field"; this is it, and it is the only one.
 */
export function renderJson(result: AnalysisResult): string {
  const counts: Record<Severity, number> = { error: 0, warn: 0, info: 0 };
  for (const finding of result.findings) counts[finding.severity]++;

  // Clamped for the same reason as the terminal projection: a saving larger
  // than the counted budget would produce a negative "after" figure.
  const savings = Math.min(
    result.findings.reduce((sum, f) => sum + f.alwaysOnSavings, 0),
    result.budget.total.value,
  );

  const payload = {
    schemaVersion: 1,
    tool: { name: 'skillassay', version: VERSION },
    target: {
      id: result.target.id,
      label: result.target.label,
      contextWindow: result.target.contextWindow,
    },
    tokenizer: {
      method: result.budget.total.method,
      label: describeMethod(result.budget.total.method),
      isProxy: result.target.tokenizerIsProxy,
    },
    budget: {
      alwaysOnTokens: result.budget.total.value,
      contextWindowPercent: Number(
        ((result.budget.total.value / result.target.contextWindow) * 100).toFixed(4),
      ),
      conditionalTokens: result.budget.conditionalTotal.value,
      lines: result.budget.lines.map((line) => ({
        path: line.relPath,
        kind: line.kind,
        portion: line.portion,
        tokens: line.tokens.value,
      })),
      unmeasured: result.budget.unmeasured,
      excluded: result.budget.excluded,
      harness: result.budget.harness,
      harnessDetected: result.budget.harnessDetected,
      harnessAlternatives: result.budget.harnessAlternatives,
      cwdRelative: result.budget.cwdRelative,
    },
    projection: {
      alwaysOnTokensAfterFixes: result.budget.total.value - savings,
      tokensSaved: savings,
    },
    summary: {
      artifacts: result.artifacts.length,
      skillsParsed: result.stats.skillsParsed,
      skillsFailed: result.stats.skillsFailed,
      pairsCompared: result.stats.pairsCompared,
      findings: result.findings.length,
      error: counts.error,
      warn: counts.warn,
      info: counts.info,
    },
    findings: result.findings.map((finding) => {
      const rule = getRule(finding.ruleId);
      return {
        ruleId: finding.ruleId,
        severity: finding.severity,
        summary: finding.summary,
        locations: finding.locations,
        evidence: finding.evidence,
        suggestion: finding.suggestion,
        alwaysOnSavings: finding.alwaysOnSavings,
        deletion: finding.deletion ?? null,
        rule: {
          title: rule.title,
          citations: rule.citations,
          limitation: rule.limitation,
        },
      };
    }),
    unanalyzed: result.errors.map((error) => ({
      path: error.relPath,
      kind: error.kind,
      code: error.code,
      message: error.message,
    })),
    // Non-deterministic by nature. Isolated here so the rest of the document is
    // byte-stable across runs.
    runtime: {
      durationMs: result.stats.durationMs,
      filesScanned: result.stats.filesScanned,
    },
  };

  return JSON.stringify(payload, null, 2);
}

/** Kept in sync with package.json by test/meta.test.ts. */
export const VERSION = '0.1.0';
