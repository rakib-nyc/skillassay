import fs from 'node:fs';
import path from 'node:path';
import { discoverArtifacts, type DiscoveryOptions } from '../discovery/index.js';
import { parseSkill } from '../parse/skill.js';
import { normaliseSource } from '../parse/frontmatter.js';
import { splitDescription } from '../text/normalize.js';
import { countFor } from '../tokenize/index.js';
import { resolveTarget, resolveHarness, detectHarness } from '../config.js';
import { analyzeBudget, renderDiscoverySurface } from './budget.js';
import { analyzeRedundancy } from './redundancy.js';
import { analyzeAmbiguity } from './ambiguity.js';
import { analyzeConflicts, type ContextFileDirectives } from './conflict.js';
import { SEVERITY_ORDER } from '../types.js';
import type {
  AnalysisResult,
  ArtifactError,
  Finding,
  SkillRecord,
} from '../types.js';

/**
 * Top 1% of the public skill-length distribution, from Ling et al. (2026) §3.1.
 *
 * A measured percentile from a published corpus, not a threshold someone picked
 * because it sounded round. Note the tokenizers differ — that paper's counts and
 * ours are both BPE but not the same encoding — so this is a percentile estimate,
 * and the finding says so.
 */
const BODY_TOP_1_PERCENT_TOKENS = 9253;

export interface AnalyzeOptions extends DiscoveryOptions {
  readonly targetId?: string;
  /** Which harness's always-on budget to compute. Defaults to Claude Code. */
  readonly harnessId?: string;
  /**
   * Working directory, absolute or relative to `root`. Determines which
   * directory-scoped context files compose into the budget. Defaults to root.
   */
  readonly cwd?: string;
  /** Overrides the calibrated trigger-overlap threshold. Used by calibration. */
  readonly threshold?: number;
  /** Enables the opt-in AMB-TRIGGER-OVERLAP rule (62% measured precision). */
  readonly experimentalAmbiguity?: boolean;
  /** Measured MCP tool-schema cost, from the opt-in `--mcp-probe` pass. */
  readonly mcpMeasurements?: readonly import('../types.js').McpMeasurement[];
}

export function analyze(root: string, options: AnalyzeOptions = {}): AnalysisResult {
  const startedAt = Date.now();
  const target = resolveTarget(options.targetId);

  // Working directory relative to the analysis root, POSIX, '' at the root.
  const absoluteRoot = path.resolve(root);
  const cwdRelative = (() => {
    if (options.cwd === undefined) return '';
    const relative = path.relative(absoluteRoot, path.resolve(absoluteRoot, options.cwd));
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`--cwd must be inside the analysed path; got "${options.cwd}"`);
    }
    return relative.split(path.sep).join('/');
  })();

  const discovery = discoverArtifacts(root, options);
  const errors: ArtifactError[] = [...discovery.errors];

  // Detect from what the repository actually contains unless told otherwise.
  const detection =
    options.harnessId === undefined
      ? detectHarness(discovery.artifacts)
      : { harness: resolveHarness(options.harnessId), detected: false, alternatives: [] };
  const harness = detection.harness;

  // One read per file, shared by every analyzer. Cached rather than re-read so
  // a file that changes mid-run cannot produce two different numbers in the
  // same report.
  const cache = new Map<string, string>();
  const readFile = (filePath: string): string => {
    const hit = cache.get(filePath);
    if (hit !== undefined) return hit;
    const text = normaliseSource(fs.readFileSync(filePath, 'utf8'));
    cache.set(filePath, text);
    return text;
  };

  // --- parse skills and agent definitions -----------------------------------
  const skills: SkillRecord[] = [];

  for (const artifact of discovery.artifacts) {
    if (artifact.kind !== 'skill' && artifact.kind !== 'agent_definition') continue;

    let source: string;
    try {
      source = readFile(artifact.path);
    } catch (error) {
      errors.push({
        path: artifact.path,
        relPath: artifact.relPath,
        kind: artifact.kind,
        code: 'unreadable_file',
        message: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    // The containing directory is the conventional fallback name.
    const parentDir = path.basename(path.dirname(artifact.path));
    const parsed = parseSkill(source, { fallbackName: parentDir });
    if (!parsed.ok) {
      // Recorded, counted, and printed. A file that failed to parse is never
      // silently dropped, because a dropped skill is a skill missing from the
      // budget and from every pairwise comparison.
      errors.push({
        path: artifact.path,
        relPath: artifact.relPath,
        kind: artifact.kind,
        code: parsed.code,
        message: parsed.message,
      });
      continue;
    }

    const skill = parsed.value;
    const split = splitDescription(skill.description);

    skills.push({
      artifact,
      skill,
      discoveryCost: countFor(renderDiscoverySurface(skill.name, skill.description), target),
      bodyCost: countFor(skill.body, target),
      triggerSurface: split.trigger,
      capabilitySurface: split.capability,
    });
  }

  // --- analyses --------------------------------------------------------------
  const budget = analyzeBudget({
    artifacts: discovery.artifacts,
    skills,
    target,
    harness,
    harnessDetected: detection.detected,
    harnessAlternatives: detection.alternatives,
    cwdRelative,
    readFile,
    ...(options.mcpMeasurements === undefined
      ? {}
      : { mcpMeasurements: options.mcpMeasurements }),
  });

  const redundancy = analyzeRedundancy({
    artifacts: discovery.artifacts,
    root,
    target,
    harnessId: harness.id,
    readFile,
  });

  const ambiguity = analyzeAmbiguity(skills, {
    ...(options.threshold === undefined ? {} : { threshold: options.threshold }),
    ...(options.experimentalAmbiguity === undefined
      ? {}
      : { experimentalAmbiguity: options.experimentalAmbiguity }),
  });

  const contextFiles: ContextFileDirectives[] = discovery.artifacts
    .filter(
      (a) =>
        (a.kind === 'context_file' || a.kind === 'cursor_rule') && a.harness === harness.id,
    )
    .map((a) => ({ relPath: a.relPath, text: readFile(a.path) }));

  const conflicts = analyzeConflicts(skills, contextFiles);

  const bodyOutliers: Finding[] = skills
    .filter((record) => record.bodyCost.value > BODY_TOP_1_PERCENT_TOKENS)
    .map((record) => ({
      ruleId: 'BUD-BODY-OUTLIER',
      severity: 'info' as const,
      locations: [{ path: record.artifact.relPath }],
      summary:
        `Skill body is ${record.bodyCost.value} tokens, above the published 99th percentile ` +
        `(${BODY_TOP_1_PERCENT_TOKENS})`,
      evidence: {
        bodyTokens: record.bodyCost.value,
        percentile99: BODY_TOP_1_PERCENT_TOKENS,
        note: 'Conditional cost — loaded only when this skill triggers, not always-on.',
      },
      suggestion:
        'Consider splitting reference material into separate files the skill links to, so it ' +
        'loads only when actually needed.',
      alwaysOnSavings: 0,
    }));

  /*
   * Zero the claimed savings for findings in files the budget does not count.
   *
   * The analyzers deliberately look at every context file this harness reads,
   * including directory-scoped ones off the current chain — a problem in
   * `packages/api/CLAUDE.md` is worth reporting even when you are analysing
   * from the root. But those files contribute nothing to the headline, so
   * counting their savings against it produced projections that subtracted
   * tokens the total never contained. On `2025Emma/vibe-coding-cn`, which
   * vendors example `CLAUDE.md` files under `i18n/`, that was most of the
   * claimed saving.
   *
   * The finding still appears, with its location; only the arithmetic changes.
   */
  const countedPaths = new Set(budget.lines.map((line) => line.relPath));
  const scoped = redundancy.map((finding) => {
    const filePath = finding.locations[0]?.path;
    if (filePath !== undefined && countedPaths.has(filePath)) return finding;
    return {
      ...finding,
      alwaysOnSavings: 0,
      evidence: {
        ...finding.evidence,
        note: 'Not loaded from the current working directory, so no always-on saving is claimed.',
      },
    };
  });

  const findings = [...scoped, ...ambiguity.findings, ...conflicts, ...bodyOutliers].sort(
    (a, b) => {
      const bySeverity = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
      if (bySeverity !== 0) return bySeverity;
      if (a.ruleId !== b.ruleId) return a.ruleId < b.ruleId ? -1 : 1;
      const pa = a.locations.map((l) => `${l.path}:${l.line ?? 0}`).join('|');
      const pb = b.locations.map((l) => `${l.path}:${l.line ?? 0}`).join('|');
      return pa < pb ? -1 : pa > pb ? 1 : 0;
    },
  );

  return {
    root,
    target,
    artifacts: discovery.artifacts,
    skills,
    errors,
    budget,
    findings,
    stats: {
      filesScanned: discovery.filesScanned,
      skillsParsed: skills.length,
      skillsFailed: errors.filter((e) => e.kind === 'skill' || e.kind === 'agent_definition').length,
      pairsCompared: ambiguity.pairsCompared,
      durationMs: Date.now() - startedAt,
    },
  };
}
