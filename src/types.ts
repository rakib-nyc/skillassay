/**
 * Shared data model for skillassay.
 *
 * Two invariants run through every type in this file, and they exist because the
 * tool's only asset is measurement integrity :
 *
 *  1. Every token count carries the method that produced it (`TokenCount.method`).
 *     There is no way to move a number through this codebase without its provenance.
 *  2. Failures are values, not exceptions to be swallowed. `ParseOutcome` forces
 *     every caller to decide what to do with a file it could not read, and the
 *     report surfaces the count. A skipped file never silently becomes a zero.
 */

export type Severity = 'error' | 'warn' | 'info';

export const SEVERITY_ORDER: Record<Severity, number> = { error: 0, warn: 1, info: 2 };

/**
 * How a token figure was produced. Rendered verbatim in the report so a reader
 * can never mistake a proxy count for an exact one.
 */
export type TokenMethod =
  /** Exact BPE count from the cl100k_base encoding (js-tiktoken). */
  | 'cl100k_base'
  /**
   * cl100k_base used as a stand-in for a non-OpenAI model's tokenizer. Anthropic
   * does not publish an offline tokenizer for current Claude models, so counts
   * for Claude targets are proxies and are labelled as such everywhere.
   */
  | 'cl100k_base-proxy';

export interface TokenCount {
  readonly value: number;
  readonly method: TokenMethod;
}

/** A point in a source artifact. `line` is 1-indexed; absent when whole-file. */
export interface SourceLocation {
  readonly path: string;
  readonly line?: number;
}

export type HarnessId = 'claude' | 'codex' | 'cursor' | 'gemini';

export type ArtifactKind =
  | 'context_file'
  | 'skill'
  | 'cursor_rule'
  | 'mcp_config'
  | 'agent_definition';

export interface DiscoveredArtifact {
  /** Absolute path on disk. */
  readonly path: string;
  /** Path relative to the analysis root, POSIX-separated. Stable across machines. */
  readonly relPath: string;
  readonly kind: ArtifactKind;
  readonly harness: HarnessId;
  /**
   * The harness-specific root this artifact lives under (`.claude`, `.codex`,
   * `.gemini`, …), or `default` when it is not inside one.
   *
   * Skills in different namespaces are never loaded into the same session, so
   * they cannot compete for routing or contradict each other in practice. Many
   * public skill packs ship the same skill once per harness, and comparing
   * across namespaces reported every one of those as a duplicate.
   */
  readonly namespace: string;
  /**
   * `project` for artifacts under the analysed root, `global` for user-level
   * config in the home directory. Global config loads in every session
   * regardless of repository, so it belongs in the always-on budget — and
   * omitting it, as a naive implementation would, under-reports the headline for
   * essentially every real user.
   */
  readonly scope: 'project' | 'global';
  readonly bytes: number;
}

/** A file that discovery found but analysis could not use, with the reason why. */
export interface ArtifactError {
  readonly path: string;
  readonly relPath: string;
  readonly kind: ArtifactKind;
  /** Machine-readable reason, e.g. `no_frontmatter`, `malformed_yaml`. */
  readonly code: string;
  readonly message: string;
}

export interface ParsedSkill {
  readonly name: string;
  /** True when `name` was taken from the directory because frontmatter omitted it. */
  readonly nameInferred: boolean;
  readonly description: string;
  /** Frontmatter keys other than name/description, in file order. */
  readonly extraKeys: readonly string[];
  readonly body: string;
  readonly rawFrontmatter: string;
}

export type ParseOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: string; readonly message: string };

/** A skill that parsed successfully, paired with the artifact it came from. */
export interface SkillRecord {
  readonly artifact: DiscoveredArtifact;
  readonly skill: ParsedSkill;
  /** Tokens Claude loads at startup for this skill (name + description only). */
  readonly discoveryCost: TokenCount;
  /** Tokens the body costs *if and when* the skill is triggered. Not always-on. */
  readonly bodyCost: TokenCount;
  /**
   * The "when to use" clause parsed out of the description, if the description
   * states one. `null` means no trigger clause was found — which is itself a
   * finding, not an excuse to fall back to comparing whole descriptions.
   */
  readonly triggerSurface: string | null;
  /** The description with any trigger clause removed: what the skill *does*. */
  readonly capabilitySurface: string;
}

/**
 * A single measured problem. The citation is NOT stored here — it is looked up
 * from the rule registry by `ruleId`, which makes "every rule has a source"
 * a structural property rather than a convention someone has to remember.
 */
export interface Finding {
  readonly ruleId: string;
  readonly severity: Severity;
  readonly locations: readonly SourceLocation[];
  /** One line, no trailing period. Shown as the headline of the finding. */
  readonly summary: string;
  /** The exact text or measured values the finding rests on. */
  readonly evidence: Readonly<Record<string, string | number>>;
  /** Concrete action. Deletion recommendations start with "Delete". */
  readonly suggestion: string;
  /**
   * Tokens removed from the always-on budget if the suggestion is applied.
   * 0 when the finding is about routing quality rather than cost.
   */
  readonly alwaysOnSavings: number;
  /**
   * The exact line range `--fix` would remove, when the suggestion is a
   * deletion. Present only for findings whose fix is mechanical; routing
   * findings require a human rewrite and deliberately carry no range, so the
   * patch generator can never guess at one.
   */
  readonly deletion?: DeletionRange;
}

/** Inclusive, 1-indexed line range in a single file. */
export interface DeletionRange {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
}

export interface BudgetLine {
  readonly relPath: string;
  readonly kind: ArtifactKind;
  /** e.g. `frontmatter` for skills, `full file` for context files. */
  readonly portion: string;
  readonly tokens: TokenCount;
}

export interface BudgetReport {
  readonly total: TokenCount;
  readonly lines: readonly BudgetLine[];
  /** Cost that only materialises when a skill triggers. Reported separately. */
  readonly conditionalTotal: TokenCount;
  /**
   * Artifacts found but deliberately NOT counted in `total`, each with the
   * reason. Nothing discovered ever disappears: it is either counted or it
   * appears here, so a reader can always reconcile the headline against the
   * file tree.
   */
  readonly excluded: readonly ExcludedCost[];
  /** Per-server MCP tool-schema measurements, when --mcp-probe was used. */
  readonly mcp: readonly McpMeasurement[];
  /** The harness the headline number is computed for. */
  readonly harness: HarnessId;
  /** True when the harness was inferred from the repository rather than requested. */
  readonly harnessDetected: boolean;
  /** Other harnesses also configured at the repository root. */
  readonly harnessAlternatives: readonly HarnessId[];
  /** Working directory used to resolve the context-file chain, relative to root. */
  readonly cwdRelative: string;
  /**
   * Things known to consume always-on context that this tool cannot measure
   * statically. Surfaced in the report so the headline number is never mistaken
   * for the whole picture.
   */
  readonly unmeasured: readonly UnmeasuredCost[];
}

/** Result of starting an MCP server and asking it for its tools. */
export interface McpMeasurement {
  readonly server: string;
  readonly toolCount: number;
  readonly tokens: number;
  readonly error?: string;
}

export interface ExcludedCost {
  readonly reason: string;
  readonly tokens: number;
  readonly artifacts: number;
  readonly examples: readonly string[];
}

export interface UnmeasuredCost {
  readonly source: string;
  readonly reason: string;
}

export interface ModelTarget {
  readonly id: string;
  readonly label: string;
  readonly contextWindow: number;
  /** True when cl100k_base is a proxy rather than this model's real tokenizer. */
  readonly tokenizerIsProxy: boolean;
}

export interface AnalysisResult {
  readonly root: string;
  /**
   * Whether every analysed skill satisfies the hard specification constraints.
   *
   * Exposed as one boolean because it is the first question an agent needs
   * answered and the only one with a yes/no answer: a skill that violates the
   * format is not registered by compliant clients at all, so every other
   * finding about it is moot until this is true.
   */
  readonly conformance: {
    readonly willLoad: boolean;
    readonly blockingFindings: number;
  };
  readonly target: ModelTarget;
  readonly artifacts: readonly DiscoveredArtifact[];
  readonly skills: readonly SkillRecord[];
  readonly errors: readonly ArtifactError[];
  readonly budget: BudgetReport;
  readonly findings: readonly Finding[];
  readonly stats: {
    readonly filesScanned: number;
    readonly skillsParsed: number;
    readonly skillsFailed: number;
    readonly pairsCompared: number;
    readonly durationMs: number;
  };
}
