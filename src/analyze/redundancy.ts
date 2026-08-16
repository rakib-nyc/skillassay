import fs from 'node:fs';
import path from 'node:path';
import { countFor } from '../tokenize/index.js';
import type { DiscoveredArtifact, Finding, HarnessId, ModelTarget } from '../types.js';

/**
 * Redundancy rules — the ETH Zurich ablation applied.
 *
 * The paper's own conclusion is the rule: "Human-written context files should
 * only include instructions required for coding agents that are not already
 * present in the README." Everything here detects a specific way a context file
 * restates something the agent can already obtain, and every finding carries the
 * measured token cost of the text it proposes deleting, so the before/after
 * projection is arithmetic rather than a claim.
 */

/**
 * Advice that would apply unchanged to any repository in any language.
 *
 * Kept as exact phrases rather than keyword matching. "Write clean code" is
 * empty; "clean up the build cache before releasing" is not, and a keyword
 * matcher on "clean" cannot tell them apart.
 */
const GENERIC_ADVICE: readonly string[] = [
  'write clean code',
  'write clean, readable code',
  'follow best practices',
  'follow industry best practices',
  'use best practices',
  'adhere to best practices',
  'use meaningful variable names',
  'use descriptive variable names',
  'keep it simple',
  'keep the code simple',
  'write modular code',
  'write maintainable code',
  'write readable code',
  "don't repeat yourself",
  'do not repeat yourself',
  'dry principle',
  'follow the dry principle',
  'write self-documenting code',
  'avoid code duplication',
  'use proper error handling',
  'handle errors appropriately',
  'write comprehensive tests',
  'test your code',
  'add appropriate comments',
  'comment your code',
  'follow solid principles',
  'use consistent naming conventions',
  // Added after recall measurement against real context files. The list is a
  // list: RED-GENERIC's recall is bounded by it, and README.md says so.
  'provide clear error messages',
  'provide helpful error messages',
  'write descriptive commit messages',
  'keep functions small',
  'keep functions short',
  'avoid magic numbers',
  'validate all input',
  'validate user input',
  'prefer composition over inheritance',
  'fail fast',
];

/** Phrases that mark a sentence as a claim about the project's stack. */
const STACK_CLAIM_MARKERS: readonly RegExp[] = [
  /\bwe use\b/i,
  /\bwe're using\b/i,
  /\bwe are using\b/i,
  /\bthis project uses\b/i,
  /\bthe project uses\b/i,
  /\bproject uses\b/i,
  /\bstack includes\b/i,
  /\btech stack:/i,
  /\bbuilt with\b/i,
  /\bpowered by\b/i,
  /\bwritten in\b/i,
  /\bthis repo(?:sitory)? uses\b/i,
];

/** Style instructions a formatter enforces mechanically. */
const LINTER_ENFORCED: readonly RegExp[] = [
  /\b(?:prefer|use|always use)\s+(?:single|double)\s+quotes\b/i,
  /\bindent(?:ation)?\s+with\b/i,
  /\buse\s+\d+\s+spaces?\s+for\s+indent/i,
  /\buse\s+tabs\s+for\s+indent/i,
  /\bno\s+trailing\s+whitespace\b/i,
  /\b(?:always\s+)?(?:use|add)\s+semicolons\b/i,
  /\b(?:omit|no)\s+semicolons\b/i,
  /\bmax(?:imum)?\s+line\s+length\b/i,
  /\bline\s+length\s+(?:of\s+)?\d+/i,
  /\btrailing\s+commas?\b/i,
];

const LINTER_CONFIG_FILES: readonly string[] = [
  '.eslintrc', '.eslintrc.json', '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.yml',
  'eslint.config.js', 'eslint.config.mjs', 'eslint.config.ts',
  '.prettierrc', '.prettierrc.json', '.prettierrc.js', 'prettier.config.js',
  'ruff.toml', '.ruff.toml', 'setup.cfg', '.flake8',
  'rustfmt.toml', '.rustfmt.toml',
  '.editorconfig', 'biome.json', '.clang-format',
];

/**
 * Headings that introduce a repository overview section.
 *
 * The second pattern was added after recall measurement: `## Navigation Map`
 * and `### Skill Map` both introduce catalogues of the repository's own
 * folders, and the first pattern matched neither.
 */
const STRUCTURE_HEADINGS: readonly RegExp[] = [
  /^#{1,6}\s+.*\b(?:project|repo|repository|monorepo|workspace|directory|folder|codebase|package|source|file)\s+(?:structure|layout|organi[sz]ation|tree|overview|hierarchy)\b/i,
  /^#{1,6}\s+.*\b(?:navigation|skill|file|code|module|directory|folder|repo|repository|project|package)\s+map\b/i,
];

function isStructureHeading(line: string): boolean {
  return STRUCTURE_HEADINGS.some((pattern) => pattern.test(line));
}

/**
 * Placeholder syntax marking a line as a *template* rather than a description.
 *
 * `{skill-name}/   # kebab-case directory name` is telling the author what to
 * create, not describing what exists, so the agent cannot "just look at the
 * tree" instead. Recall measurement surfaced these as false positives of the
 * directory-listing rule.
 */
const TEMPLATE_PLACEHOLDER = /\{[a-z0-9_-]+\}|<[a-z0-9_-]+>|\$\{?[A-Z_]{2,}\}?/i;

/** A line whose entire content is a directory path, e.g. `.github/workflows/`. */
const BARE_PATH_LINE = /^\s*`?[\w.@-][\w.@/-]*\/`?\s*$/;

/**
 * Line ranges belonging to fenced blocks that contain placeholder syntax.
 *
 * Template detection has to be block-scoped, not line-scoped. A layout template
 * is a fenced block as a whole:
 *
 *     skills/               # Claude Code skill definitions
 *       <skill-name>/
 *         SKILL.md          # Required: metadata + instructions
 *
 * Only one line carries a placeholder, but every line is prescriptive — the
 * agent cannot rediscover "SKILL.md is required" by listing a directory. Judging
 * line by line flagged `skills/` and `SKILL.md` while sparing `<skill-name>/`,
 * which is precisely backwards.
 */
function templateBlockLines(lines: readonly string[]): Set<number> {
  const inTemplate = new Set<number>();
  let fenceStart = -1;

  lines.forEach((line, index) => {
    if (!CODE_FENCE.test(line)) return;
    if (fenceStart === -1) {
      fenceStart = index;
      return;
    }
    const body = lines.slice(fenceStart + 1, index);
    if (body.some((l) => TEMPLATE_PLACEHOLDER.test(l))) {
      for (let n = fenceStart; n <= index; n++) inTemplate.add(n);
    }
    fenceStart = -1;
  });

  return inTemplate;
}

/*
 * Tree and path-listing detection.
 *
 * A naive pattern would match `/^[\s]*(?:[├└│─|`+\\]+\s*)+/`, which was
 * wrong in a way that only showed up on real data: the character class contains
 * a backtick and a pipe, so it matched every ``` code fence and every markdown
 * table row in the corpus. Reviewing 28 sampled findings, 26 were fences,
 * tables, or ASCII org charts — a ~93% false-positive rate for this rule.
 *
 * The fix is a conjunction rather than a looser character class: a line must
 * carry a real tree connector AND something that actually looks like a path.
 * An org chart has connectors but no paths; a table row has pipes but no
 * connectors; a fence has backticks and neither.
 */

/** Box-drawing or ASCII tree connectors. Note: no backtick, no bare pipe. */
const TREE_CONNECTOR = /(?:├──|└──|├─|└─|│\s{2,}|^\s*\|--|^\s*\\--|^\s*\+--)/;

/** A filesystem-ish token: a slash-separated path or a dotted filename. */
const PATH_TOKEN = /[\w@.-]+\/|\.\w{1,6}\b/;

/** A markdown table row, which is never a directory listing. */
const TABLE_ROW = /^\s*\|.*\|\s*$/;

/** A fenced-code delimiter. */
const CODE_FENCE = /^\s*(?:```|~~~)/;

function isTreeLine(line: string): boolean {
  if (TABLE_ROW.test(line) || CODE_FENCE.test(line)) return false;
  // Templates prescribe; listings describe. Only listings are rediscoverable.
  if (TEMPLATE_PLACEHOLDER.test(line)) return false;
  if (BARE_PATH_LINE.test(line)) return true;
  return TREE_CONNECTOR.test(line) && PATH_TOKEN.test(line);
}

/**
 * A bullet enumerating a **directory**, e.g. "- `src/routes/` — HTTP handlers".
 *
 * Restricted to directory references (trailing `/`) on purpose. Testing against
 * real application repositories — rather than the skill libraries the corpus is
 * made of — showed that bullets naming a *specific file* with its role are a
 * different thing entirely:
 *
 *     ### Adding a new partner to CI
 *     When adding a new partner package, update these files:
 *     - `.github/dependabot.yml` – Add dependency update entry
 *     - `.github/workflows/pr_lint.yml` – Add to allowed scopes
 *
 * That is a task-to-file checklist. The paths are discoverable; the mapping from
 * *intent* to *which of two hundred workflow files to edit* is not, and it is
 * exactly the non-obvious content the ETH Zurich study says context files are
 * for. Flagging it would delete the most valuable section in the file.
 *
 * A repository overview enumerates directories. A pointer names a file and says
 * what to do with it.
 */
const PATH_BULLET = /^\s*[-*+]\s+`?\/?[\w.@-]+(?:\/[\w.@-]+)*\/`?\s*(?:[-—:]|$)/;

/**
 * Extract the path-looking token a line is describing.
 *
 * Used to ground the rule in the filesystem: see `pathExists`.
 */
function extractPathToken(line: string): string | null {
  const cleaned = line
    // Drop tree-drawing characters, list markers and trailing comments.
    .replace(/[├└│─]/g, ' ')
    .replace(/^\s*[-*+]\s+/, '')
    .replace(/\s+#.*$/, '')
    .replace(/`/g, '')
    .trim();
  const match = /^\/?([\w.@-][\w.@/-]*)/.exec(cleaned);
  return match?.[1] ?? null;
}

/**
 * Resolve every path-listing line in a file to a full repository path.
 *
 * Tree lines are relative to their parent, not to the repository root:
 *
 *     .github/workflows/
 *     ├── test.yml          # Run tests on PR
 *
 * `test.yml` means `.github/workflows/test.yml`. Checking it against the root
 * finds nothing and silently drops the line, so nesting has to be tracked.
 */
interface ResolvedPath {
  readonly token: string;
  readonly fullPath: string;
  readonly isDirectoryRef: boolean;
  readonly fromTree: boolean;
  /**
   * True when this line belongs to a tree whose *root* does not exist.
   *
   * A tree rooted at `skill-name/` or `skill/` is a generic illustration of the
   * layout every skill should have — the root is a metasyntactic stand-in, not a
   * directory anyone expected to find. Reporting its children as "stale" would
   * be wrong in a confident-sounding way.
   *
   * Contrast a tree rooted at `.github/workflows/`, which does exist: there the
   * root is real and a missing child genuinely is a stale reference.
   */
  readonly illustrative: boolean;
}

function resolvePathLines(
  lines: readonly string[],
  exists: (fullPath: string) => boolean,
): Map<number, ResolvedPath> {
  const resolved = new Map<number, ResolvedPath>();
  const stack: { indent: number; path: string }[] = [];
  let runIsIllustrative = false;

  lines.forEach((line, index) => {
    const isTree = TREE_CONNECTOR.test(line);
    const isBare = BARE_PATH_LINE.test(line);
    const isBullet = PATH_BULLET.test(line);
    if (!isTree && !isBare && !isBullet) {
      // A blank line or prose ends the current tree run.
      if (line.trim().length === 0) {
        stack.length = 0;
        runIsIllustrative = false;
      }
      return;
    }

    const token = extractPathToken(line);
    if (token === null || token.length === 0) return;

    // Indentation with connectors flattened to spaces, so depth is comparable.
    const flattened = line.replace(/[├└│─]/g, ' ');
    const indent = flattened.length - flattened.trimStart().length;

    let fullPath = token;
    if (isTree || isBare) {
      while (stack.length > 0 && (stack[stack.length - 1]?.indent ?? 0) >= indent) stack.pop();
      const parent = stack[stack.length - 1];
      fullPath = parent ? `${parent.path.replace(/\/$/, '')}/${token}` : token;
      // The first entry of a run establishes whether the whole tree is real.
      if (stack.length === 0) runIsIllustrative = !exists(fullPath.replace(/\/$/, ''));
      if (token.endsWith('/')) stack.push({ indent, path: fullPath });
    } else {
      stack.length = 0;
      runIsIllustrative = false;
    }

    resolved.set(index, {
      token,
      fullPath: fullPath.replace(/\/$/, ''),
      isDirectoryRef: token.endsWith('/'),
      fromTree: isTree || isBare,
      illustrative: (isTree || isBare) && runIsIllustrative,
    });
  });

  return resolved;
}

/**
 * Does this line describe a path that actually exists in the repository?
 *
 * This is the test that separates a *description* from a *template*, and it is
 * checkable rather than heuristic. `.github/workflows/` exists, so documenting
 * it duplicates something the agent can list. `skill-name/` and `{skill-name}/`
 * do not exist — they are placeholders in a layout specification, and deleting
 * them destroys information rather than recovering it.
 *
 * It also disposes of install-command bullets such as
 * `- \`a real repository@golang-security\` → \`npx skills add …\``, which
 * look path-shaped but name a package, not a directory.
 *
 * Resolved against both the context file's own directory and the analysis root,
 * because context files describe paths relative to either.
 */
/**
 * Paths the repository deliberately does not track.
 *
 * A context file may legitimately document a directory that is absent from a
 * clone. The largest false-positive class for the missing-path rule was a
 * section literally headed "Maintainer-Local Folders (gitignored)" whose prose
 * said the folders "exist on the maintainer's disk but are excluded from the
 * public GitHub tree". Reporting those as broken references is wrong, and
 * `.gitignore` states the fact mechanically.
 *
 * A deliberately partial implementation of gitignore semantics: it handles
 * literal paths, directory entries and simple `*` globs, and ignores negation
 * and nested ignore files. Every gap makes the rule *more* silent, never more
 * confident, which is the safe direction for a suppression list.
 */
function readIgnorePatterns(root: string): RegExp[] {
  const patterns: RegExp[] = [];
  try {
    const file = path.join(root, '.gitignore');
    if (!fs.existsSync(file)) return patterns;
    for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
      const line = raw.trim();
      if (line.length === 0 || line.startsWith('#') || line.startsWith('!')) continue;
      const body = line.replace(/^\//, '').replace(/\/$/, '');
      if (body.length === 0) continue;
      const escaped = body
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*/g, '\u0000')
        .replace(/\*/g, '[^/]*')
        .replace(/\u0000/g, '.*');
      // Match the path itself or anything beneath it, at any depth.
      patterns.push(new RegExp(`(^|/)${escaped}(/|$)`));
    }
  } catch {
    // No ignore information available. The rule simply stays as silent as it
    // would have been without the file.
  }
  return patterns;
}

function isIgnored(fullPath: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(fullPath));
}

function pathExists(fullPath: string, root: string, contextFileDir: string): boolean {
  if (fullPath.length === 0) return false;
  /*
   * Deliberately NOT falling back to "strip the leading segment".
   *
   * Trees are sometimes rooted at the repository's own name (`that project/`),
   * which anchoring cannot resolve. Stripping the first segment fixes that and
   * breaks something worse: `skill-name/scripts` then resolves via a top-level
   * `scripts/`, so an illustrative template gets reported as a real directory
   * listing. Trees rooted at the repository name are still caught by the
   * section heading above them, which is the safer of the two paths.
   */
  const candidates = [path.join(root, contextFileDir, fullPath), path.join(root, fullPath)];
  return candidates.some((candidate) => {
    try {
      return fs.existsSync(candidate);
    } catch {
      // An unreadable path is not evidence that the line describes something
      // real, so it is treated as not-real: the rule stays silent.
      return false;
    }
  });
}

interface ManifestFacts {
  readonly dependencies: ReadonlySet<string>;
  readonly hasLinterConfig: boolean;
  readonly linterConfigName: string | null;
}

function readManifestFacts(root: string): ManifestFacts {
  const dependencies = new Set<string>();

  const addAll = (names: Iterable<string>) => {
    for (const name of names) {
      const clean = name.trim().toLowerCase();
      // Single characters and pure numbers produce absurd matches against prose.
      if (clean.length >= 2 && !/^\d+$/.test(clean)) dependencies.add(clean);
    }
  };

  // package.json
  try {
    const pkgPath = path.join(root, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as Record<string, unknown>;
      for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
        const section = pkg[field];
        if (section && typeof section === 'object' && !Array.isArray(section)) {
          addAll(Object.keys(section as Record<string, unknown>));
        }
      }
    }
  } catch {
    // A malformed package.json is the user's problem to fix, not a reason to
    // abort the whole analysis. It simply yields no dependency facts, which can
    // only cause this rule to under-report — never to invent a finding.
  }

  // pyproject.toml / requirements.txt / Cargo.toml / go.mod — line-scanned
  // rather than fully parsed. A dependency name is all this rule needs, and
  // pulling in TOML and go.mod parsers to get it is not a trade worth making.
  const scanLines = (file: string, pattern: RegExp) => {
    try {
      const full = path.join(root, file);
      if (!fs.existsSync(full)) return;
      for (const line of fs.readFileSync(full, 'utf8').split('\n')) {
        const m = pattern.exec(line);
        if (m?.[1]) addAll([m[1]]);
      }
    } catch {
      // Same rationale as above: absence of facts, never invented facts.
    }
  };

  scanLines('pyproject.toml', /^\s*"?([A-Za-z][\w.-]+)"?\s*(?:[><=~^]=?|\s*=\s*")/);
  scanLines('requirements.txt', /^\s*([A-Za-z][\w.-]+)/);
  scanLines('Cargo.toml', /^\s*([A-Za-z][\w-]+)\s*=/);
  scanLines('go.mod', /^\s*(?:require\s+)?([a-z][\w.\-/]+)\s+v\d/);

  let linterConfigName: string | null = null;
  for (const candidate of LINTER_CONFIG_FILES) {
    if (fs.existsSync(path.join(root, candidate))) {
      linterConfigName = candidate;
      break;
    }
  }

  return { dependencies, hasLinterConfig: linterConfigName !== null, linterConfigName };
}

export interface RedundancyInput {
  readonly artifacts: readonly DiscoveredArtifact[];
  readonly root: string;
  /**
   * Only analyse context files this harness actually reads.
   *
   * Without this the tool reported findings about files excluded from its own
   * budget: on a Codex-configured repository it printed 17 findings against `AGENTS.md`
   * while the headline said 0 always-on tokens, and the projection arrived at
   * "0 to -51 tokens (-Infinity%)". A finding must always be about something
   * the reported number includes.
   */
  readonly harnessId?: HarnessId;
  readonly target: ModelTarget;
  readonly readFile: (path: string) => string;
}

export function analyzeRedundancy(input: RedundancyInput): Finding[] {
  const { artifacts, root, target, readFile } = input;
  const facts = readManifestFacts(root);
  const ignorePatterns = readIgnorePatterns(root);
  const findings: Finding[] = [];

  const contextFiles = artifacts.filter(
    (a) =>
      (a.kind === 'context_file' || a.kind === 'cursor_rule') &&
      (input.harnessId === undefined || a.harness === input.harnessId),
  );

  for (const artifact of contextFiles) {
    const lines = readFile(artifact.path).split('\n');
    // Lines already claimed by a structure section, so a tree line inside one is
    // not also reported individually.
    const claimed = new Set<number>();
    const templateLines = templateBlockLines(lines);
    const artifactDir = artifact.relPath.includes('/')
      ? artifact.relPath.slice(0, artifact.relPath.lastIndexOf('/'))
      : '';
    const resolvedPaths = resolvePathLines(lines, (candidate) =>
      pathExists(candidate, root, artifactDir),
    );

    // --- repository overview sections ---------------------------------------
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line === undefined || !isStructureHeading(line)) continue;

      const headingLevel = (/^(#{1,6})/.exec(line)?.[1] ?? '#').length;
      let end = i + 1;
      while (end < lines.length) {
        const next = lines[end];
        if (next === undefined) break;
        const nextHeading = /^(#{1,6})\s/.exec(next);
        if (nextHeading && nextHeading[1] !== undefined && nextHeading[1].length <= headingLevel) break;
        end++;
      }

      const block = lines.slice(i, end).join('\n');

      /*
       * A section whose path content lives inside a template block prescribes a
       * layout rather than describing one. Deleting it would destroy
       * information the agent cannot rediscover ("SKILL.md is required",
       * "version must match"), so it is not redundant in the sense the ETH
       * Zurich result is about..
       */
      const pathLinesInSection = [];
      for (let k = i; k < end; k++) {
        const candidate = lines[k];
        if (candidate !== undefined && PATH_TOKEN.test(candidate)) pathLinesInSection.push(k);
      }
      const templatePathLines = pathLinesInSection.filter((k) => templateLines.has(k)).length;
      if (pathLinesInSection.length > 0 && templatePathLines * 2 >= pathLinesInSection.length) {
        i = end - 1;
        continue;
      }

      for (let k = i; k < end; k++) claimed.add(k);

      findings.push({
        ruleId: 'RED-REPO-OVERVIEW',
        severity: 'warn',
        locations: [{ path: artifact.relPath, line: i + 1 }],
        summary: `Repository overview section spanning ${end - i} lines`,
        evidence: {
          heading: line.trim(),
          lines: end - i,
        },
        suggestion:
          `Delete lines ${i + 1}-${end} of ${artifact.relPath}. The agent can read the tree ` +
          'directly, and this section costs tokens every session and goes stale silently.',
        alwaysOnSavings: countFor(block, target).value,
        deletion: { path: artifact.relPath, startLine: i + 1, endLine: end },
      });

      i = end - 1;
    }

    // --- line-level rules ----------------------------------------------------
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      if (raw === undefined) continue;
      const line = raw.toLowerCase();
      const trimmed = raw.trim();
      if (trimmed.length === 0) continue;

      const lineSavings = () => countFor(`${raw}\n`, target).value;

      // 1. Generic advice.
      const advice = GENERIC_ADVICE.find((phrase) => line.includes(phrase));
      if (advice !== undefined) {
        findings.push({
          ruleId: 'RED-GENERIC',
          severity: 'warn',
          locations: [{ path: artifact.relPath, line: i + 1 }],
          summary: `Generic advice that applies to any repository: "${advice}"`,
          evidence: { text: trimmed, matchedPhrase: advice },
          suggestion:
            `Delete line ${i + 1} of ${artifact.relPath}. It carries no repository-specific ` +
            'information, so it cannot be the non-standard practice a context file is for.',
          alwaysOnSavings: lineSavings(),
          deletion: { path: artifact.relPath, startLine: i + 1, endLine: i + 1 },
        });
        continue;
      }

      // 2. Stack claims already in a manifest.
      if (STACK_CLAIM_MARKERS.some((m) => m.test(raw)) && facts.dependencies.size > 0) {
        // Word-boundary match so "go" does not fire on "going".
        const words = new Set(
          line.split(/[^a-z0-9.@/-]+/).filter((w) => w.length > 0),
        );
        const matched = [...facts.dependencies].filter((dep) => words.has(dep)).sort();

        if (matched.length > 0) {
          findings.push({
            ruleId: 'RED-TECHSTACK',
            severity: 'warn',
            locations: [{ path: artifact.relPath, line: i + 1 }],
            summary: `Stack claim restates a declared dependency: ${matched.join(', ')}`,
            evidence: { text: trimmed, dependencies: matched.join(', ') },
            suggestion:
              `Delete line ${i + 1} of ${artifact.relPath}. ${matched.join(', ')} ` +
              `already ${matched.length === 1 ? 'appears' : 'appear'} in a manifest the ` +
              'agent can read.',
            alwaysOnSavings: lineSavings(),
            deletion: { path: artifact.relPath, startLine: i + 1, endLine: i + 1 },
          });
          continue;
        }
      }

      // 3. Style rules a configured linter already enforces.
      if (facts.hasLinterConfig && LINTER_ENFORCED.some((m) => m.test(raw))) {
        findings.push({
          ruleId: 'RED-LINTER',
          severity: 'warn',
          locations: [{ path: artifact.relPath, line: i + 1 }],
          summary: 'Style rule that a configured formatter already enforces',
          evidence: { text: trimmed, linterConfig: facts.linterConfigName ?? 'unknown' },
          suggestion:
            `Delete line ${i + 1} of ${artifact.relPath}. ${facts.linterConfigName} is ` +
            'present and enforces formatting mechanically, which prose cannot.',
          alwaysOnSavings: lineSavings(),
          deletion: { path: artifact.relPath, startLine: i + 1, endLine: i + 1 },
        });
        continue;
      }

      // 4. Path listings, grounded in the filesystem.
      const resolved = resolvedPaths.get(i);
      if (
        resolved !== undefined &&
        !claimed.has(i) &&
        !templateLines.has(i) &&
        !TEMPLATE_PLACEHOLDER.test(raw) &&
        (isTreeLine(raw) || PATH_BULLET.test(raw))
      ) {
        if (resolved.illustrative) {
          // A hypothetical layout, not a claim about this repository. Silent
          // for BOTH branches: an illustrative child may coincidentally share a
          // name with a real directory, and reporting it as documented-and-real
          // would be exactly backwards.
        } else if (pathExists(resolved.fullPath, root, artifactDir)) {
          // The path is real, so documenting it duplicates something the agent
          // can obtain by listing the directory.
          findings.push({
            ruleId: 'RED-REPO-OVERVIEW',
            severity: 'warn',
            locations: [{ path: artifact.relPath, line: i + 1 }],
            summary: `Documents \`${resolved.fullPath}\`, which the agent can list`,
            evidence: { text: trimmed, resolvedPath: resolved.fullPath, exists: 'yes' },
            suggestion:
              `Delete line ${i + 1} of ${artifact.relPath}. \`${resolved.fullPath}\` exists in ` +
              'the repository, so this restates something the agent can see for itself.',
            alwaysOnSavings: lineSavings(),
            deletion: { path: artifact.relPath, startLine: i + 1, endLine: i + 1 },
          });
        } else if (isIgnored(resolved.fullPath, ignorePatterns)) {
          // Documented on purpose and deliberately untracked. Silent.
        } else if (resolved.fromTree || resolved.isDirectoryRef) {
          /*
           * The path does not exist. This is a stale reference, not redundancy,
           * and it is worse: the ETH Zurich study measured that agents follow
           * context-file instructions faithfully, so a wrong path sends the
           * agent somewhere that is not there.
           *
           * Restricted to tree lines and explicit directory references
           * (trailing `/`) so that package names in install commands —
           * `a real repository`, which is path-shaped but is not a path —
           * are not reported as missing directories.
           */
          findings.push({
            ruleId: 'RED-STALE-PATH',
            /*
             * `info`, not `warn`. Measured precision on the validation corpus
             * is 3 of 6: half the findings were directories a tool creates at
             * runtime, which are absent for a perfectly good reason. A rule
             * that unreliable does not belong in the default exit code, but the
             * three real stale references it found are worth surfacing.
             */
            severity: 'info',
            locations: [{ path: artifact.relPath, line: i + 1 }],
            summary: `References \`${resolved.fullPath}\`, which is not present in the repository`,
            evidence: { text: trimmed, resolvedPath: resolved.fullPath, exists: 'no' },
            suggestion:
              `Check line ${i + 1} of ${artifact.relPath}. \`${resolved.fullPath}\` is not in ` +
              'the repository and is not gitignored, so either the reference is stale or the ' +
              'directory is created at runtime — this rule cannot tell those apart.',
            alwaysOnSavings: lineSavings(),
            deletion: { path: artifact.relPath, startLine: i + 1, endLine: i + 1 },
          });
        }
      }
    }
  }

  findings.sort((a, b) => {
    const pa = a.locations[0];
    const pb = b.locations[0];
    if (!pa || !pb) return 0;
    if (pa.path !== pb.path) return pa.path < pb.path ? -1 : 1;
    return (pa.line ?? 0) - (pb.line ?? 0);
  });

  return findings;
}
