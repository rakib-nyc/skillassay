import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { discoverArtifacts } from '../discovery/index.js';
import { parseSkill } from '../parse/skill.js';
import { normaliseSource } from '../parse/frontmatter.js';
import { canonicalName, contentWords, splitDescription } from '../text/normalize.js';
import { TfIdfIndex } from '../text/similarity.js';
import { scoreTriggerPair, TRIGGER_OVERLAP_THRESHOLD } from '../analyze/ambiguity.js';
import { countFor } from '../tokenize/index.js';
import { renderDiscoverySurface } from '../analyze/budget.js';
import { resolveTarget } from '../config.js';

/**
 * Corpus-level audit .
 *
 * This runs the same parser and the same similarity code as the single-repo
 * path — there is no separate "registry mode" implementation that could drift
 * from what the CLI actually does to a user's files.
 *
 * Its purpose is to make the tool's own claims checkable: it independently
 * measures the name-duplication rate that Ling et al. report as 46.3%, and
 * publishes whatever number falls out, including when that disagrees.
 */

export interface DuplicateCluster {
  readonly canonical: string;
  readonly count: number;
  readonly names: readonly string[];
  readonly paths: readonly string[];
}

export interface RegistryAudit {
  readonly root: string;
  readonly sources: readonly { name: string; skillFiles: number }[];
  readonly totalSkillFiles: number;
  readonly parsed: number;
  readonly failed: number;
  readonly failuresByCode: Readonly<Record<string, number>>;
  readonly parseSuccessRate: number;

  readonly discoveryTokens: Distribution;
  readonly bodyTokens: Distribution;

  readonly duplicateClusters: readonly DuplicateCluster[];
  /** Share of skill FILES whose canonical name occurs more than once. */
  readonly duplicateShare: number;
  /**
   * The same figure after collapsing exact copies — identical canonical name
   * AND identical body — within each source repository.
   *
   * This is the number to compare against published marketplace figures. A
   * marketplace lists a skill once; a repository frequently vendors the same
   * skill into `.claude/`, `.codex/` and `.gemini/`, and counting those three
   * files as three duplicates measures packaging, not ecosystem redundancy.
   */
  readonly distinctSkills: number;
  readonly deduplicatedDuplicateShare: number;

  readonly withoutTrigger: number;
  readonly withoutTriggerShare: number;

  readonly collisionPairs: number;
  readonly topColliders: readonly { name: string; collisions: number }[];

  readonly durationMs: number;
}

export interface Distribution {
  readonly n: number;
  readonly min: number;
  readonly p50: number;
  readonly p90: number;
  readonly p99: number;
  readonly max: number;
  readonly mean: number;
}

function distribution(values: number[]): Distribution {
  if (values.length === 0) {
    return { n: 0, min: 0, p50: 0, p90: 0, p99: 0, max: 0, mean: 0 };
  }
  const sorted = [...values].sort((a, b) => a - b);
  // Nearest-rank percentile. Stated explicitly because percentile conventions
  // differ, and a reader reproducing these numbers needs to know which one.
  const at = (q: number): number => {
    const rank = Math.max(1, Math.ceil(q * sorted.length));
    return sorted[rank - 1] ?? 0;
  };
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    n: sorted.length,
    min: sorted[0] ?? 0,
    p50: at(0.5),
    p90: at(0.9),
    p99: at(0.99),
    max: sorted[sorted.length - 1] ?? 0,
    mean: Math.round((sum / sorted.length) * 10) / 10,
  };
}

export function auditRegistry(root: string, targetId?: string): RegistryAudit {
  const startedAt = Date.now();
  const target = resolveTarget(targetId);
  const absoluteRoot = path.resolve(root);

  const discovery = discoverArtifacts(absoluteRoot);
  const skillArtifacts = discovery.artifacts.filter((a) => a.kind === 'skill');

  const sourceCounts = new Map<string, number>();
  for (const artifact of skillArtifacts) {
    // First path segment identifies the source repository in a multi-repo corpus.
    const source = artifact.relPath.split('/')[0] ?? '.';
    sourceCounts.set(source, (sourceCounts.get(source) ?? 0) + 1);
  }

  const failuresByCode: Record<string, number> = {};
  const discoveryTokens: number[] = [];
  const bodyTokens: number[] = [];
  const parsedSkills: {
    name: string;
    canonical: string;
    relPath: string;
    trigger: string | null;
    bodyHash: string;
  }[] = [];

  for (const artifact of skillArtifacts) {
    let source: string;
    try {
      source = normaliseSource(fs.readFileSync(artifact.path, 'utf8'));
    } catch {
      failuresByCode['unreadable_file'] = (failuresByCode['unreadable_file'] ?? 0) + 1;
      continue;
    }

    const parsed = parseSkill(source, {
      fallbackName: path.basename(path.dirname(artifact.path)),
    });
    if (!parsed.ok) {
      failuresByCode[parsed.code] = (failuresByCode[parsed.code] ?? 0) + 1;
      continue;
    }

    const skill = parsed.value;
    discoveryTokens.push(
      countFor(renderDiscoverySurface(skill.name, skill.description), target).value,
    );
    bodyTokens.push(countFor(skill.body, target).value);
    parsedSkills.push({
      name: skill.name,
      canonical: canonicalName(skill.name),
      relPath: artifact.relPath,
      trigger: splitDescription(skill.description).trigger,
      bodyHash: createHash('sha256').update(skill.body).digest('hex'),
    });
  }

  // --- name-based duplication (the Ling et al. reproduction) -----------------
  const byCanonical = new Map<string, typeof parsedSkills>();
  for (const skill of parsedSkills) {
    if (skill.canonical.length === 0) continue;
    const bucket = byCanonical.get(skill.canonical);
    if (bucket) bucket.push(skill);
    else byCanonical.set(skill.canonical, [skill]);
  }

  const duplicateClusters: DuplicateCluster[] = [...byCanonical.entries()]
    .filter(([, bucket]) => bucket.length > 1)
    .map(([canonical, bucket]) => ({
      canonical,
      count: bucket.length,
      names: [...new Set(bucket.map((s) => s.name))].sort(),
      paths: bucket.map((s) => s.relPath).sort(),
    }))
    .sort((a, b) => b.count - a.count || (a.canonical < b.canonical ? -1 : 1));

  const duplicatedSkillCount = duplicateClusters.reduce((sum, c) => sum + c.count, 0);

  // --- deduplicated view -----------------------------------------------------
  // Collapse exact copies (same canonical name + same body hash) within a
  // source repo, then recount. See the field docs on `distinctSkills`.
  const seenExact = new Set<string>();
  const distinct: typeof parsedSkills = [];
  for (const skill of parsedSkills) {
    const source = skill.relPath.split('/')[0] ?? '.';
    const key = `${source}\u0000${skill.canonical}\u0000${skill.bodyHash}`;
    if (seenExact.has(key)) continue;
    seenExact.add(key);
    distinct.push(skill);
  }
  const distinctByCanonical = new Map<string, number>();
  for (const skill of distinct) {
    if (skill.canonical.length === 0) continue;
    distinctByCanonical.set(skill.canonical, (distinctByCanonical.get(skill.canonical) ?? 0) + 1);
  }
  const distinctDuplicated = [...distinctByCanonical.values()]
    .filter((n) => n > 1)
    .reduce((a, b) => a + b, 0);

  // --- trigger overlap across the corpus -------------------------------------
  const withTrigger = parsedSkills.filter((s) => s.trigger !== null);
  const terms = withTrigger.map((s) => contentWords(s.trigger ?? ''));
  const tfidf = new TfIdfIndex(terms);

  const postings = new Map<string, number[]>();
  terms.forEach((list, i) => {
    for (const term of new Set(list)) {
      const bucket = postings.get(term);
      if (bucket) bucket.push(i);
      else postings.set(term, [i]);
    }
  });

  const collisionCounts = new Map<number, number>();
  let collisionPairs = 0;
  const seen = new Set<string>();

  for (const bucket of postings.values()) {
    // Terms shared by a huge number of skills generate quadratic work for no
    // information. Skip them: any genuinely colliding pair also shares a rarer
    // term, so this bounds runtime without losing pairs in practice.
    if (bucket.length > 400) continue;
    for (let a = 0; a < bucket.length; a++) {
      for (let b = a + 1; b < bucket.length; b++) {
        const i = bucket[a];
        const j = bucket[b];
        if (i === undefined || j === undefined) continue;
        const key = `${i}:${j}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const ti = terms[i];
        const tj = terms[j];
        if (!ti || !tj) continue;

        if (scoreTriggerPair(ti, tj, tfidf).combined >= TRIGGER_OVERLAP_THRESHOLD) {
          collisionPairs++;
          collisionCounts.set(i, (collisionCounts.get(i) ?? 0) + 1);
          collisionCounts.set(j, (collisionCounts.get(j) ?? 0) + 1);
        }
      }
    }
  }

  // Collapse by skill name: the same skill vendored three times produced three
  // identical rows, which read as three separate problems.
  const collidersByName = new Map<string, number>();
  for (const [index, collisions] of collisionCounts) {
    const name = withTrigger[index]?.name ?? '(unknown)';
    collidersByName.set(name, Math.max(collidersByName.get(name) ?? 0, collisions));
  }
  const topColliders = [...collidersByName.entries()]
    .map(([name, collisions]) => ({ name, collisions }))
    .sort((a, b) => b.collisions - a.collisions || (a.name < b.name ? -1 : 1))
    .slice(0, 20);

  const withoutTrigger = parsedSkills.length - withTrigger.length;

  return {
    root: absoluteRoot,
    sources: [...sourceCounts.entries()]
      .map(([name, skillFiles]) => ({ name, skillFiles }))
      .sort((a, b) => b.skillFiles - a.skillFiles || (a.name < b.name ? -1 : 1)),
    totalSkillFiles: skillArtifacts.length,
    parsed: parsedSkills.length,
    failed: skillArtifacts.length - parsedSkills.length,
    failuresByCode,
    parseSuccessRate:
      skillArtifacts.length === 0 ? 1 : parsedSkills.length / skillArtifacts.length,
    discoveryTokens: distribution(discoveryTokens),
    bodyTokens: distribution(bodyTokens),
    duplicateClusters,
    duplicateShare: parsedSkills.length === 0 ? 0 : duplicatedSkillCount / parsedSkills.length,
    distinctSkills: distinct.length,
    deduplicatedDuplicateShare: distinct.length === 0 ? 0 : distinctDuplicated / distinct.length,
    withoutTrigger,
    withoutTriggerShare: parsedSkills.length === 0 ? 0 : withoutTrigger / parsedSkills.length,
    collisionPairs,
    topColliders,
    durationMs: Date.now() - startedAt,
  };
}
