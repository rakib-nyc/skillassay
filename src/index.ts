/*
 * Copyright 2026 Muhammad Rakibul Islam
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 */
/** Library entry point. The CLI in cli.ts is a thin wrapper over these. */

export { analyze, type AnalyzeOptions } from './analyze/index.js';
export { discoverArtifacts, type DiscoveryOptions, type DiscoveryResult } from './discovery/index.js';
export { parseSkill, parseFrontmatter, parseMcpConfig, normaliseSource } from './parse/index.js';
export { countTokens, countFor, describeMethod } from './tokenize/index.js';
export { analyzeBudget, renderDiscoverySurface } from './analyze/budget.js';
export {
  analyzeAmbiguity,
  scoreTriggerPair,
  TRIGGER_OVERLAP_THRESHOLD,
  type PairScore,
} from './analyze/ambiguity.js';
export { analyzeConflicts } from './analyze/conflict.js';
export { analyzeRedundancy } from './analyze/redundancy.js';
export { auditRegistry, type RegistryAudit } from './registry/index.js';
export { renderRegistryMarkdown } from './registry/render.js';
export { renderTerminal, renderJson, generatePatch, compareToBaseline } from './report/index.js';
export { RULES, getRule, ruleIds, type Rule, type Citation } from './rules/index.js';
export { MODEL_TARGETS, resolveTarget, DEFAULT_TARGET_ID } from './config.js';
export { splitDescription, canonicalName, contentWords } from './text/normalize.js';
export { TfIdfIndex, levenshtein, jaroWinkler, jaccard, charNgramJaccard } from './text/similarity.js';
export type * from './types.js';
