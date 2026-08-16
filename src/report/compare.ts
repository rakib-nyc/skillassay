import type { AnalysisResult, Severity } from '../types.js';

/**
 * Baseline comparison (`--baseline` / `--compare`).
 *
 * Regression tracking between runs. A finding's identity is `ruleId` plus its
 * sorted location paths — not its line numbers, which shift whenever anything
 * above them is edited and would otherwise report every finding as both new and
 * resolved after a one-line insertion.
 */

export interface BaselineComparison {
  readonly baselineTokens: number;
  readonly currentTokens: number;
  readonly tokenDelta: number;
  readonly newFindings: readonly { ruleId: string; summary: string }[];
  readonly resolvedFindings: readonly { ruleId: string; summary: string }[];
  readonly unchangedCount: number;
}

interface BaselineShape {
  budget?: { alwaysOnTokens?: unknown };
  findings?: unknown;
}

function identity(ruleId: string, paths: readonly string[]): string {
  return `${ruleId}::${[...paths].sort().join('|')}`;
}

export function compareToBaseline(
  result: AnalysisResult,
  baselineJson: string,
): BaselineComparison {
  let parsed: BaselineShape;
  try {
    parsed = JSON.parse(baselineJson) as BaselineShape;
  } catch (error) {
    throw new Error(
      `Baseline file is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const rawTokens = parsed.budget?.alwaysOnTokens;
  if (typeof rawTokens !== 'number') {
    throw new Error(
      'Baseline file is missing budget.alwaysOnTokens — it does not look like assay --json output',
    );
  }

  const baselineFindings = Array.isArray(parsed.findings) ? parsed.findings : [];
  const baselineIds = new Map<string, { ruleId: string; summary: string }>();

  for (const entry of baselineFindings) {
    if (entry === null || typeof entry !== 'object') continue;
    const record = entry as {
      ruleId?: unknown;
      summary?: unknown;
      locations?: unknown;
    };
    if (typeof record.ruleId !== 'string') continue;
    const paths = Array.isArray(record.locations)
      ? record.locations
          .map((l) => (l && typeof l === 'object' ? (l as { path?: unknown }).path : undefined))
          .filter((p): p is string => typeof p === 'string')
      : [];
    baselineIds.set(identity(record.ruleId, paths), {
      ruleId: record.ruleId,
      summary: typeof record.summary === 'string' ? record.summary : '',
    });
  }

  const currentIds = new Map<string, { ruleId: string; summary: string }>();
  for (const finding of result.findings) {
    currentIds.set(
      identity(
        finding.ruleId,
        finding.locations.map((l) => l.path),
      ),
      { ruleId: finding.ruleId, summary: finding.summary },
    );
  }

  const newFindings = [...currentIds.entries()]
    .filter(([key]) => !baselineIds.has(key))
    .map(([, value]) => value);

  const resolvedFindings = [...baselineIds.entries()]
    .filter(([key]) => !currentIds.has(key))
    .map(([, value]) => value);

  return {
    baselineTokens: rawTokens,
    currentTokens: result.budget.total.value,
    tokenDelta: result.budget.total.value - rawTokens,
    newFindings,
    resolvedFindings,
    unchangedCount: currentIds.size - newFindings.length,
  };
}

export const SEVERITY_RANK: Record<Severity, number> = { error: 3, warn: 2, info: 1 };
