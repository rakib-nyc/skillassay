import { countFor, addTokens } from '../tokenize/index.js';
import { parseMcpConfig } from '../parse/mcp.js';
import { AGNOSTIC_NAMESPACE, type HarnessDefinition } from '../config.js';
import type {
  HarnessId,
  BudgetLine,
  McpMeasurement,
  BudgetReport,
  DiscoveredArtifact,
  ExcludedCost,
  ModelTarget,
  SkillRecord,
  TokenCount,
  UnmeasuredCost,
} from '../types.js';

/**
 * Tier 0 — the always-on budget.
 *
 * Two modelling rules, both learned the hard way.
 *
 * **1. Bodies are conditional.** Skills use progressive disclosure, so only
 * `name` and `description` are resident at startup. Summing skill bodies into
 * an always-on total is the specific error the progressive-disclosure model says will get the tool
 * publicly discredited.
 *
 * **2. Only what co-loads may be summed.** a naive implementation got rule 1 right
 * and then broke the same principle a different way: it summed every artifact
 * it could find, across every harness and every directory. On a real monorepo
 * that reported **123,567 always-on tokens (61.78% of the window)** where the
 * defensible figure for a Claude Code user at the repository root was **20,704
 * (10.35%)** — a 6× overstatement built from `.gemini/` and `.codex/` skills
 * that Claude Code never loads, plus 21 directory-scoped `CLAUDE.md` files that
 * do not all load at once.
 *
 * So the budget is now a function of *(harness, working directory)*:
 *
 *   - context files: this harness's files along the root → cwd path, plus its
 *     user-level global config
 *   - skills: this harness's namespace, plus harness-agnostic ones
 *   - MCP config: only for harnesses that read it
 *
 * Everything else. Nothing discovered ever disappears — it is either counted or
 * it is listed, so the headline can always be reconciled against the tree.
 */

/**
 * How a skill's startup cost is modelled.
 *
 * Anthropic documents *what* is loaded ("only its name and description occupy
 * context") but not the exact serialisation used to inject it. We reconstruct a
 * minimal YAML rendering. That is a model, not an observation, so it is stated
 * in the report rather than presented as ground truth. The error is bounded and
 * small — a handful of tokens of framing per skill — but it is real, and the
 * README says so.
 */
export function renderDiscoverySurface(name: string, description: string): string {
  return `name: ${name}\ndescription: ${description}`;
}

/**
 * Is `fileDir` on the path from the repository root to `cwd`?
 *
 * Directory-scoped context files compose along that chain: a `CLAUDE.md` in
 * `packages/api/` applies while you are working inside `packages/api`, and is
 * simply not loaded while you are in `packages/web`. Both paths are POSIX,
 * relative to the analysis root, with `''` meaning the root itself.
 */
export function isOnContextChain(fileDir: string, cwd: string): boolean {
  if (fileDir === '') return true;
  if (fileDir === cwd) return true;
  return cwd.startsWith(`${fileDir}/`);
}

function directoryOf(relPath: string): string {
  const index = relPath.lastIndexOf('/');
  return index === -1 ? '' : relPath.slice(0, index);
}

export interface BudgetInput {
  readonly artifacts: readonly DiscoveredArtifact[];
  readonly skills: readonly SkillRecord[];
  readonly target: ModelTarget;
  readonly harness: HarnessDefinition;
  /** Working directory relative to the analysis root, POSIX, `''` for root. */
  readonly cwdRelative: string;
  readonly harnessDetected: boolean;
  readonly harnessAlternatives: readonly HarnessId[];
  /**
   * Measured tool-schema cost per MCP server, from `--mcp-probe`. When absent,
   * the cost is reported as unmeasured rather than estimated.
   */
  readonly mcpMeasurements?: readonly McpMeasurement[];
  readonly readFile: (path: string) => string;
}

interface ExclusionBucket {
  tokens: number;
  artifacts: number;
  examples: string[];
}

export function analyzeBudget(input: BudgetInput): BudgetReport {
  const { artifacts, skills, target, harness, cwdRelative, readFile } = input;
  const method = target.tokenizerIsProxy ? 'cl100k_base-proxy' : 'cl100k_base';

  const lines: BudgetLine[] = [];
  const unmeasured: UnmeasuredCost[] = [];
  const alwaysOn: TokenCount[] = [];
  const conditional: TokenCount[] = [];

  const exclusions = new Map<string, ExclusionBucket>();
  const exclude = (reason: string, tokens: number, relPath: string): void => {
    const bucket = exclusions.get(reason) ?? { tokens: 0, artifacts: 0, examples: [] };
    bucket.tokens += tokens;
    bucket.artifacts += 1;
    if (bucket.examples.length < 3) bucket.examples.push(relPath);
    exclusions.set(reason, bucket);
  };

  const belongsToHarness = (namespace: string): boolean =>
    namespace === harness.namespaceDir || namespace === AGNOSTIC_NAMESPACE;

  // --- context files ---------------------------------------------------------
  for (const artifact of artifacts) {
    if (artifact.kind !== 'context_file' && artifact.kind !== 'cursor_rule') continue;

    const tokens = countFor(readFile(artifact.path), target);
    const basename = artifact.relPath.split('/').pop() ?? '';

    // A different harness's context file. Real cost for a user of that harness,
    // zero cost for this one.
    if (artifact.harness !== harness.id) {
      exclude(
        `context files for other harnesses (not read by ${harness.label})`,
        tokens.value,
        artifact.relPath,
      );
      continue;
    }

    if (artifact.scope === 'global') {
      lines.push({
        relPath: artifact.relPath,
        kind: artifact.kind,
        portion: 'full file (user-level, loads in every session)',
        tokens,
      });
      alwaysOn.push(tokens);
      continue;
    }

    // Cursor's `.cursor/rules/*.mdc` are activated by their own frontmatter
    // globs rather than by directory position, so the chain rule does not
    // apply to them; they are counted wherever they are found.
    const onChain =
      artifact.kind === 'cursor_rule' ||
      isOnContextChain(directoryOf(artifact.relPath), cwdRelative);

    if (!onChain) {
      exclude(
        `directory-scoped context files outside the current path (${cwdRelative || 'repository root'})`,
        tokens.value,
        artifact.relPath,
      );
      continue;
    }

    lines.push({
      relPath: artifact.relPath,
      kind: artifact.kind,
      portion:
        basename === '' || directoryOf(artifact.relPath) === ''
          ? 'full file'
          : `full file (scoped to ${directoryOf(artifact.relPath)}/)`,
      tokens,
    });
    alwaysOn.push(tokens);
  }

  // --- MCP configuration -----------------------------------------------------
  for (const artifact of artifacts) {
    if (artifact.kind !== 'mcp_config') continue;

    if (!harness.readsMcpConfig) {
      exclude(`MCP configuration (not read by ${harness.label})`, 0, artifact.relPath);
      continue;
    }

    // An MCP config is NOT loaded into the context window. What occupies
    // context is the JSON schema of each tool the server advertises, obtained
    // at runtime via tools/list. Counting the config file's own bytes as
    // always-on tokens — as a naive implementation would — measures the
    // wrong thing and inflates the headline.
    const parsed = parseMcpConfig(readFile(artifact.path));
    if (!parsed.ok) {
      unmeasured.push({
        source: artifact.relPath,
        reason: `MCP config could not be parsed (${parsed.message}); tool schema cost unknown`,
      });
      continue;
    }

    if (parsed.value.hasInlineToolSchemas) {
      const tokens = countFor(parsed.value.inlineSchemaJson, target);
      lines.push({
        relPath: artifact.relPath,
        kind: artifact.kind,
        portion: 'inline tool schemas',
        tokens,
      });
      alwaysOn.push(tokens);
    }

    if (parsed.value.serverNames.length === 0) continue;

    const measurements = input.mcpMeasurements ?? [];
    if (measurements.length === 0) {
      unmeasured.push({
        source: artifact.relPath,
        reason:
          `${parsed.value.serverNames.length} MCP server(s) declared ` +
          `(${parsed.value.serverNames.join(', ')}). Their tool schemas load into every ` +
          'session but are served at runtime, not stored in this file. Run with --mcp-probe ' +
          'to start the servers and measure them.',
      });
      continue;
    }

    // Measured: these are real always-on tokens, counted from the schemas the
    // servers actually advertised.
    for (const measurement of measurements) {
      if (measurement.error !== undefined) {
        unmeasured.push({
          source: `${artifact.relPath} → ${measurement.server}`,
          reason: `could not be probed: ${measurement.error}`,
        });
        continue;
      }
      const tokens: TokenCount = { value: measurement.tokens, method };
      lines.push({
        relPath: `${artifact.relPath} → ${measurement.server}`,
        kind: 'mcp_config',
        portion: `${measurement.toolCount} tool schema(s), measured via tools/list`,
        tokens,
      });
      alwaysOn.push(tokens);
    }
  }

  // --- skills and subagent definitions ---------------------------------------
  for (const record of skills) {
    if (!belongsToHarness(record.artifact.namespace)) {
      exclude(
        `skills for other harnesses (not loaded by ${harness.label})`,
        record.discoveryCost.value,
        record.artifact.relPath,
      );
      continue;
    }

    lines.push({
      relPath: record.artifact.relPath,
      kind: record.artifact.kind,
      portion: 'frontmatter (name + description)',
      tokens: record.discoveryCost,
    });
    alwaysOn.push(record.discoveryCost);
    conditional.push(record.bodyCost);
  }

  lines.sort((a, b) => {
    if (b.tokens.value !== a.tokens.value) return b.tokens.value - a.tokens.value;
    // Tie-break on path so equal-cost lines never reorder between runs.
    return a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0;
  });

  const excluded: ExcludedCost[] = [...exclusions.entries()]
    .map(([reason, bucket]) => ({
      reason,
      tokens: bucket.tokens,
      artifacts: bucket.artifacts,
      examples: bucket.examples,
    }))
    .sort((a, b) => b.tokens - a.tokens || (a.reason < b.reason ? -1 : 1));

  return {
    total: addTokens(alwaysOn, method),
    conditionalTotal: addTokens(conditional, method),
    lines,
    excluded,
    unmeasured,
    mcp: input.mcpMeasurements ?? [],
    harness: harness.id,
    harnessDetected: input.harnessDetected,
    harnessAlternatives: input.harnessAlternatives,
    cwdRelative,
  };
}
