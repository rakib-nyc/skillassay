import os from 'node:os';
import path from 'node:path';
import type { HarnessId, ModelTarget } from './types.js';

/**
 * What each harness actually loads.
 *
 * This table exists because a budget that summed every
 * artifact it could find, which on a real monorepo reported 123,567 always-on
 * tokens where the defensible figure for a Claude Code user was 20,704 — a 6×
 * overstatement, and structurally the same error the progressive-disclosure model calls
 * disqualifying (summing things that never co-load).
 *
 * A harness only ever loads: its own context files along the path from the
 * repository root to the working directory, its own global config, and skills
 * under its own directory (plus harness-agnostic ones).
 */
export interface HarnessDefinition {
  readonly id: HarnessId;
  readonly label: string;
  /** Directory that scopes skills to this harness, e.g. `.claude`. */
  readonly namespaceDir: string;
  /** Context file basenames this harness reads. */
  readonly contextFiles: readonly string[];
  /**
   * User-level config paths, relative to the home directory. These load in
   * every session regardless of which repository you are in, so omitting them
   * under-reports the always-on cost for essentially every real user.
   */
  readonly globalPaths: readonly string[];
  /** True when this harness consumes `.mcp.json`-style MCP configuration. */
  readonly readsMcpConfig: boolean;
}

export const HARNESSES: Readonly<Record<HarnessId, HarnessDefinition>> = {
  claude: {
    id: 'claude',
    label: 'Claude Code',
    namespaceDir: '.claude',
    contextFiles: ['CLAUDE.md', 'CLAUDE.local.md'],
    globalPaths: ['.claude/CLAUDE.md', '.claude/CLAUDE.local.md'],
    readsMcpConfig: true,
  },
  codex: {
    id: 'codex',
    label: 'Codex',
    namespaceDir: '.codex',
    contextFiles: ['AGENTS.md'],
    globalPaths: ['.codex/AGENTS.md'],
    readsMcpConfig: false,
  },
  gemini: {
    id: 'gemini',
    label: 'Gemini CLI',
    namespaceDir: '.gemini',
    contextFiles: ['GEMINI.md'],
    globalPaths: ['.gemini/GEMINI.md'],
    readsMcpConfig: false,
  },
  cursor: {
    id: 'cursor',
    label: 'Cursor',
    namespaceDir: '.cursor',
    contextFiles: ['.cursorrules'],
    // Cursor keeps user-level rules in application settings rather than a file
    // on disk, so there is nothing here to read. Stated rather than left blank.
    globalPaths: [],
    readsMcpConfig: false,
  },
};

export const DEFAULT_HARNESS: HarnessId = 'claude';

/**
 * Pick the harness a repository is actually configured for.
 *
 * Defaulting to Claude Code was wrong on real repositories. a Codex-configured repository
 * ships `AGENTS.md` and `.agents/skills/**` and no Claude artifacts at all, so
 * the default reported **0 always-on tokens** while simultaneously printing 17
 * findings about `AGENTS.md` — a number and a finding list that contradicted
 * each other.
 *
 * Scoring is dominated by the **root** context file, because that is the single
 * strongest declaration of which harness a repository is set up for. Nested
 * context files count for much less, and skills least of all.
 *
 * Counting skills equally with context files was wrong and a regression check
 * caught it: a large multi-harness repository has 21 `CLAUDE.md` files and ~790
 * skills vendored across `.codex/` and `.gemini/`, so skill volume outvoted the
 * context files and the repository was analysed as Codex. Findings on its
 * `CLAUDE.md` files silently vanished.
 *
 * Ties go to the declared default so behaviour stays predictable, and the report
 * always states which harness was chosen and whether it was detected.
 */
export interface HarnessDetection {
  readonly harness: HarnessDefinition;
  readonly detected: boolean;
  /** Other harnesses also configured at the repository root, if any. */
  readonly alternatives: readonly HarnessId[];
}

export function detectHarness(
  artifacts: readonly {
    kind: string;
    harness: HarnessId;
    namespace: string;
    relPath: string;
    scope?: string;
  }[],
): HarnessDetection {
  const rootContext = new Set<HarnessId>();
  const skillCounts = new Map<HarnessId, number>();

  for (const artifact of artifacts) {
    if (artifact.kind === 'context_file' || artifact.kind === 'cursor_rule') {
      // Only a PROJECT-scope file at the repository root counts as the marker;
      // a global ~/.claude/CLAUDE.md says nothing about this repository.
      if (artifact.scope !== 'global' && !artifact.relPath.includes('/')) {
        rootContext.add(artifact.harness);
      }
      continue;
    }
    for (const harness of Object.values(HARNESSES)) {
      if (artifact.namespace === harness.namespaceDir) {
        skillCounts.set(harness.id, (skillCounts.get(harness.id) ?? 0) + 1);
      }
    }
  }

  const order = Object.values(HARNESSES).map((h) => h.id);

  // One root context file is an unambiguous declaration.
  if (rootContext.size === 1) {
    const only = [...rootContext][0] as HarnessId;
    return { harness: HARNESSES[only], detected: true, alternatives: [] };
  }

  /*
   * Several harnesses configured at the root: there is no single right answer,
   * so do not invent one from volume. Counting skills to break the tie picked
   * Gemini for a large multi-harness repository — a repository with a root
   * CLAUDE.md that merely also ships 390 Gemini ports — and silently dropped
   * every finding on its Claude context files.
   *
   * Prefer the declared default when it is among them, report the others as
   * alternatives, and let the user pass --harness.
   */
  if (rootContext.size > 1) {
    const chosen = rootContext.has(DEFAULT_HARNESS)
      ? DEFAULT_HARNESS
      : (order.find((id) => rootContext.has(id)) as HarnessId);
    return {
      harness: HARNESSES[chosen],
      detected: true,
      alternatives: order.filter((id) => rootContext.has(id) && id !== chosen),
    };
  }

  // No root context file at all: fall back to where the skills live.
  let best: HarnessId | null = null;
  let bestScore = 0;
  for (const id of order) {
    const score = skillCounts.get(id) ?? 0;
    if (score > bestScore) {
      bestScore = score;
      best = id;
    }
  }
  if (best === null) {
    return { harness: HARNESSES[DEFAULT_HARNESS], detected: false, alternatives: [] };
  }
  return { harness: HARNESSES[best], detected: true, alternatives: [] };
}

export function resolveHarness(id: string | undefined): HarnessDefinition {
  const key = (id ?? DEFAULT_HARNESS) as HarnessId;
  const harness = HARNESSES[key];
  if (!harness) {
    throw new Error(
      `Unknown --harness "${key}". Known harnesses: ${Object.keys(HARNESSES).join(', ')}`,
    );
  }
  return harness;
}

/**
 * Namespace assigned to skills that sit outside any harness-specific directory
 * (a bare `skills/` folder, say). These are counted for whichever harness is
 * selected, because nothing in the path says otherwise.
 */
export const AGNOSTIC_NAMESPACE = 'default';

export function homeDirectory(): string {
  return os.homedir();
}

export function globalConfigPaths(harness: HarnessDefinition, home: string): string[] {
  return harness.globalPaths.map((relative) => path.join(home, relative));
}

/**
 * Context windows are the vendor-published figures for the default (non-beta)
 * configuration of each model. They are inputs to a percentage, so if a vendor
 * changes one, this constant is the single place to correct it.
 */
export const MODEL_TARGETS: Readonly<Record<string, ModelTarget>> = {
  'claude-sonnet': {
    id: 'claude-sonnet',
    label: 'Claude Sonnet (200K context)',
    contextWindow: 200_000,
    tokenizerIsProxy: true,
  },
  'claude-opus': {
    id: 'claude-opus',
    label: 'Claude Opus (200K context)',
    contextWindow: 200_000,
    tokenizerIsProxy: true,
  },
  'gpt-4o': {
    id: 'gpt-4o',
    label: 'GPT-4o (128K context)',
    contextWindow: 128_000,
    // cl100k_base is not GPT-4o's encoding (that is o200k_base), but it is an
    // OpenAI-family BPE. Still a proxy; still labelled as one.
    tokenizerIsProxy: true,
  },
};

export const DEFAULT_TARGET_ID = 'claude-sonnet';

export function resolveTarget(id: string | undefined): ModelTarget {
  const key = id ?? DEFAULT_TARGET_ID;
  const target = MODEL_TARGETS[key];
  if (!target) {
    const known = Object.keys(MODEL_TARGETS).join(', ');
    throw new Error(`Unknown --target "${key}". Known targets: ${known}`);
  }
  return target;
}

/**
 * Directories never walked. Kept deliberately short: anything broader risks
 * hiding a real artifact from the budget, and an under-reported budget is the
 * failure mode this tool exists to prevent.
 */
export const DEFAULT_IGNORED_DIRS: readonly string[] = [
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '.venv',
  'venv',
  '__pycache__',
  'vendor',
  'target',
];

/** Files larger than this are recorded as errors rather than read into memory. */
export const MAX_FILE_BYTES = 5 * 1024 * 1024;

/** Guards against symlink cycles and pathological trees. */
export const MAX_WALK_DEPTH = 25;
