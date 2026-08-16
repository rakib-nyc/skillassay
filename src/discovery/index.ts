import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_IGNORED_DIRS,
  MAX_FILE_BYTES,
  MAX_WALK_DEPTH,
  HARNESSES,
  globalConfigPaths,
  homeDirectory,
} from '../config.js';
import type { ArtifactError, ArtifactKind, DiscoveredArtifact, HarnessId } from '../types.js';

export interface DiscoveryOptions {
  /**
   * Also discover user-level config (`~/.claude/CLAUDE.md` and friends).
   *
   * Defaults to false so that library calls and the test suite stay
   * machine-independent — a developer with a global CLAUDE.md would otherwise
   * see different numbers from CI. The CLI turns it on, because for a real user
   * that file genuinely is always-on cost, and prints where it came from.
   */
  readonly includeGlobal?: boolean;
  /** Overrides the home directory. Exists so global discovery is testable. */
  readonly homeDir?: string;
  /**
   * Additional path fragments to skip, matched against the POSIX relative path.
   * Used by the self-audit to exclude `test/fixtures`, which contains
   * deliberately broken files that would otherwise be reported as real problems.
   */
  readonly exclude?: readonly string[];
  readonly ignoredDirs?: readonly string[];
}

export interface DiscoveryResult {
  readonly artifacts: readonly DiscoveredArtifact[];
  readonly errors: readonly ArtifactError[];
  readonly filesScanned: number;
}

interface Classification {
  readonly kind: ArtifactKind;
  readonly harness: HarnessId;
}

/**
 * Directories that begin with a dot but are not harness roots.
 *
 * A skill under `.codex/skills/` is loaded by Codex and one under
 * `.gemini/skills/` by Gemini CLI; they never share a routing surface.
 */
const NON_HARNESS_DOT_DIRS = new Set([
  '.git', '.github', '.gitlab', '.vscode', '.idea', '.husky', '.circleci',
  '.devcontainer', '.config', '.cache', '.yarn', '.pnpm', '.changeset',
]);

/**
 * Which harness root, if any, a path lives under.
 *
 * Matches *any* dot-prefixed directory rather than a fixed list. The list
 * approach missed `.hermes/skills/…` in the validation corpus and silently
 * counted 2,000 tokens of a third-party harness's skills against Claude Code's
 * budget. New harnesses appear faster than a hardcoded list can be maintained,
 * and the failure mode of missing one is an inflated headline — the exact error
 * this module exists to prevent.
 *
 * Unknown harness roots are excluded from every named harness's budget, which
 * errs toward under-counting rather than over-counting.
 */
function namespaceOf(relPath: string): string {
  for (const segment of relPath.split('/')) {
    if (segment.startsWith('.') && segment.length > 1 && !NON_HARNESS_DOT_DIRS.has(segment)) {
      return segment;
    }
  }
  return 'default';
}

/** POSIX-normalised relative path, so output is identical on Windows and Unix. */
function toPosix(relative: string): string {
  return relative.split(path.sep).join('/');
}

function classify(basename: string, relPath: string): Classification | null {
  switch (basename) {
    case 'CLAUDE.md':
    case 'CLAUDE.local.md':
      return { kind: 'context_file', harness: 'claude' };
    case 'AGENTS.md':
      return { kind: 'context_file', harness: 'codex' };
    case 'GEMINI.md':
      return { kind: 'context_file', harness: 'gemini' };
    case '.cursorrules':
      return { kind: 'cursor_rule', harness: 'cursor' };
    case 'SKILL.md':
      return { kind: 'skill', harness: 'claude' };
    case '.mcp.json':
    case 'claude_desktop_config.json':
      return { kind: 'mcp_config', harness: 'claude' };
    default:
      break;
  }

  if (relPath.includes('.cursor/rules/') && basename.endsWith('.mdc')) {
    return { kind: 'cursor_rule', harness: 'cursor' };
  }

  // Subagent definitions load their own frontmatter into the routing surface,
  // so they belong in the always-on budget alongside skills.
  if (relPath.includes('.claude/agents/') && basename.endsWith('.md')) {
    return { kind: 'agent_definition', harness: 'claude' };
  }

  return null;
}

/**
 * Walk a tree and classify agent artifacts.
 *
 * Determinism is a hard requirement: directory entries are
 * sorted before recursion, and the final list is sorted by relative path. Node's
 * `readdirSync` order is filesystem-dependent, so relying on it would make the
 * permutation-invariance guarantee accidental rather than enforced.
 */
export function discoverArtifacts(root: string, options: DiscoveryOptions = {}): DiscoveryResult {
  const absoluteRoot = path.resolve(root);
  const ignored = new Set(options.ignoredDirs ?? DEFAULT_IGNORED_DIRS);
  const exclude = options.exclude ?? [];

  const artifacts: DiscoveredArtifact[] = [];
  const errors: ArtifactError[] = [];
  let filesScanned = 0;

  if (!fs.existsSync(absoluteRoot)) {
    throw new Error(`Path does not exist: ${absoluteRoot}`);
  }

  const rootStat = fs.statSync(absoluteRoot);
  if (!rootStat.isDirectory()) {
    throw new Error(`Path is not a directory: ${absoluteRoot}`);
  }

  // Real paths of directories already entered. This is what makes symlink
  // cycles terminate instead of recursing until the stack dies.
  const visited = new Set<string>();

  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_WALK_DEPTH) return;

    let realDir: string;
    try {
      realDir = fs.realpathSync(dir);
    } catch {
      // Broken symlink at the directory itself; nothing to walk.
      return;
    }
    if (visited.has(realDir)) return;
    visited.add(realDir);

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      errors.push({
        path: dir,
        relPath: toPosix(path.relative(absoluteRoot, dir)),
        kind: 'context_file',
        code: 'unreadable_directory',
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const relPath = toPosix(path.relative(absoluteRoot, full));

      if (exclude.some((fragment) => relPath === fragment || relPath.startsWith(`${fragment}/`))) {
        continue;
      }

      // Resolve symlinks explicitly rather than trusting the dirent type.
      let isDirectory = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        try {
          const stat = fs.statSync(full);
          isDirectory = stat.isDirectory();
          isFile = stat.isFile();
        } catch {
          // Dangling symlink. Skip silently: it is not an agent artifact, and
          // reporting every broken link in a repo would be noise.
          continue;
        }
      }

      if (isDirectory) {
        if (!ignored.has(entry.name)) walk(full, depth + 1);
        continue;
      }

      if (!isFile) continue;
      filesScanned++;

      const classification = classify(entry.name, relPath);
      if (!classification) continue;

      let bytes: number;
      try {
        bytes = fs.statSync(full).size;
      } catch (error) {
        errors.push({
          path: full,
          relPath,
          kind: classification.kind,
          code: 'unreadable_file',
          message: error instanceof Error ? error.message : String(error),
        });
        continue;
      }

      if (bytes > MAX_FILE_BYTES) {
        errors.push({
          path: full,
          relPath,
          kind: classification.kind,
          code: 'file_too_large',
          message: `File is ${bytes} bytes, above the ${MAX_FILE_BYTES}-byte limit; not analyzed`,
        });
        continue;
      }

      artifacts.push({
        path: full,
        relPath,
        kind: classification.kind,
        harness: classification.harness,
        namespace: namespaceOf(relPath),
        scope: 'project',
        bytes,
      });
    }
  };

  walk(absoluteRoot, 0);

  if (options.includeGlobal === true) {
    const home = options.homeDir ?? homeDirectory();
    for (const harness of Object.values(HARNESSES)) {
      for (const candidate of globalConfigPaths(harness, home)) {
        let stat: fs.Stats;
        try {
          stat = fs.statSync(candidate);
        } catch {
          // Absent global config is the normal case, not an error.
          continue;
        }
        if (!stat.isFile()) continue;
        if (stat.size > MAX_FILE_BYTES) {
          errors.push({
            path: candidate,
            relPath: `~/${path.relative(home, candidate).split(path.sep).join('/')}`,
            kind: 'context_file',
            code: 'file_too_large',
            message: `Global config is ${stat.size} bytes, above the limit; not analyzed`,
          });
          continue;
        }
        artifacts.push({
          path: candidate,
          // Rendered as `~/…` so reports never leak the user's home path.
          relPath: `~/${path.relative(home, candidate).split(path.sep).join('/')}`,
          kind: 'context_file',
          harness: harness.id,
          namespace: harness.namespaceDir,
          scope: 'global',
          bytes: stat.size,
        });
      }
    }
  }

  artifacts.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  errors.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));

  return { artifacts, errors, filesScanned };
}
