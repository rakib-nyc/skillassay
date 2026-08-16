#!/usr/bin/env node
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
import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { analyze } from './analyze/index.js';
import { auditRegistry } from './registry/index.js';
import { renderTerminal, renderJson, generatePatch, compareToBaseline, VERSION } from './report/index.js';
import { SEVERITY_RANK } from './report/compare.js';
import { getRule, RULES } from './rules/index.js';
import { renderRegistryMarkdown } from './registry/render.js';
import readline from 'node:readline/promises';
import { MODEL_TARGETS, HARNESSES } from './config.js';
import { discoverArtifacts } from './discovery/index.js';
import { parseMcpConfig, normaliseSource } from './parse/index.js';
import { probeAll } from './mcp/probe.js';
import { countTokens } from './tokenize/index.js';
import type { McpMeasurement, Severity } from './types.js';

/**
 * CLI.
 *
 * Note what is absent: there is no `--deep` and no `--empirical`. Both are
 * sometimes expected, and neither is implemented. Defining a flag that
 * prints a plausible-looking result would be the exact failure the integrity rules exist to
 * prevent, so they are simply not here, and README.md says so plainly.
 */

const program = new Command();

program
  .name('assay')
  .description(
    'skillassay — portfolio-level analyzer for AI agent skill libraries and context files.\n' +
      'Measures always-on context cost, skill routing ambiguity, and instruction conflicts.',
  )
  .version(VERSION);

program
  .argument('[path]', 'directory to analyze', '.')
  .option('--json', 'emit machine-readable JSON')
  .option('--verbose', 'show every budget line and full rule citations')
  .option('--target <id>', `model target: ${Object.keys(MODEL_TARGETS).join(' | ')}`, 'claude-sonnet')
  .option(
    '--harness <id>',
    `whose always-on budget to compute: ${Object.keys(HARNESSES).join(' | ')} ` +
      '(default: detected from the repository)',
  )
  .option(
    '--cwd <path>',
    'working directory inside the analysed path; decides which directory-scoped ' +
      'context files compose (default: the analysed path itself)',
  )
  .option('--no-global', 'skip user-level config such as ~/.claude/CLAUDE.md')
  .option('--fix', 'print a unified diff of the suggested deletions (never applies it)')
  .option(
    '--experimental-ambiguity',
    'enable trigger-overlap detection (measured 62% precision — off by default)',
  )
  .option('--exclude <path...>', 'relative paths to skip')
  .option('--fail-on <severity>', 'exit 1 at or above this severity: error | warn | info | never', 'warn')
  .option(
    '--top <n>',
    'show at most N findings, highest severity first. Keeps output bounded when ' +
      'an agent is reading it; the total is always reported.',
  )
  .option('--no-color', 'disable ANSI colour')
  .option(
    '--mcp-probe',
    'start the MCP servers declared in .mcp.json and measure their tool schemas ' +
      '(EXECUTES those commands; off by default)',
  )
  .option('--yes', 'skip the confirmation prompt for --mcp-probe')
  .option('--baseline <file>', 'write the current run to <file> as a baseline')
  .option('--compare <file>', 'compare this run against a baseline file')
  .option('--explain <ruleId>', 'print a rule, its sources, and its limitations')
  .option('--registry', 'audit a multi-skill corpus instead of a single project')
  .option('--markdown', 'with --registry, emit the REGISTRY_AUDIT.md document')
  .action(async (targetPath: string, options: Record<string, unknown>) => {
    // --explain does not need a filesystem scan.
    if (typeof options['explain'] === 'string') {
      process.stdout.write(explain(options['explain']));
      process.exit(0);
    }

    /*
     * A single `SKILL.md` is a valid target, not just a directory.
     *
     * That is the atomic operation for an agent authoring a skill: check this
     * file. The root is set two levels up so the skill's own directory name is
     * still visible, which the name/directory conformance rule needs.
     */
    let root = path.resolve(targetPath);
    let only: string | undefined;
    if (fs.existsSync(root) && fs.statSync(root).isFile()) {
      const fileName = path.basename(root);
      const skillDir = path.dirname(root);
      root = path.dirname(skillDir);
      only = `${path.basename(skillDir)}/${fileName}`;
    }

    if (options['registry'] === true) {
      const audit = auditRegistry(root, options['target'] as string | undefined);
      if (options['json'] === true) {
        process.stdout.write(`${JSON.stringify(audit, null, 2)}\n`);
      } else {
        process.stdout.write(renderRegistryMarkdown(audit));
      }
      process.exit(0);
    }

    /*
     * MCP probing runs before analysis because it is the one step that leaves
     * the process: it starts the servers named in .mcp.json and asks each for
     * its tool list. Every command is printed first and confirmed, because
     * running a config file's commands is a real action, not a read.
     */
    let mcpMeasurements: McpMeasurement[] | undefined;
    if (options['mcpProbe'] === true) {
      mcpMeasurements = await runMcpProbe(root, options['yes'] === true);
    }

    const excludeOption = options['exclude'];
    const result = analyze(root, {
      targetId: options['target'] as string,
      // Left undefined when the flag is absent so the harness is detected from
      // the repository rather than assumed to be Claude Code.
      ...(typeof options['harness'] === 'string' ? { harnessId: options['harness'] } : {}),
      experimentalAmbiguity: options['experimentalAmbiguity'] === true,
      ...(only === undefined ? {} : { only }),
      ...(mcpMeasurements === undefined ? {} : { mcpMeasurements }),
      // Commander sets `global: false` when --no-global is passed. User-level
      // config is real always-on cost, so it is on by default here even though
      // the library default is off (which keeps tests machine-independent).
      includeGlobal: options['global'] !== false,
      ...(typeof options['cwd'] === 'string' ? { cwd: options['cwd'] } : {}),
      ...(Array.isArray(excludeOption) ? { exclude: excludeOption as string[] } : {}),
    });

    if (options['fix'] === true) {
      process.stdout.write(generatePatch(result));
      process.exit(0);
    }

    const json = renderJson(result);

    if (typeof options['baseline'] === 'string') {
      fs.writeFileSync(options['baseline'], `${json}\n`, 'utf8');
      process.stderr.write(`Baseline written to ${options['baseline']}\n`);
    }

    if (typeof options['compare'] === 'string') {
      const baselineJson = fs.readFileSync(options['compare'], 'utf8');
      const comparison = compareToBaseline(result, baselineJson);
      process.stdout.write(renderComparison(comparison));
      process.exit(comparison.newFindings.length > 0 ? 1 : 0);
    }

    if (options['json'] === true) {
      process.stdout.write(`${json}\n`);
    } else {
      process.stdout.write(
        `${renderTerminal(result, {
          color: options['color'] !== false && process.stdout.isTTY === true,
          verbose: options['verbose'] === true,
          ...(typeof options['top'] === 'string' ? { top: Number(options['top']) } : {}),
        })}\n`,
      );
    }

    process.exit(exitCode(result.findings.map((f) => f.severity), options['failOn'] as string));
  });

/**
 * Start every declared MCP server and measure the tool schemas it advertises.
 *
 * This is the only code path in the tool that executes anything from a config
 * file, so it announces exactly what it will run and asks first. In a
 * non-interactive shell it refuses without `--yes` rather than assuming consent.
 */
async function runMcpProbe(root: string, assumeYes: boolean): Promise<McpMeasurement[]> {
  const configs = discoverArtifacts(root).artifacts.filter((a) => a.kind === 'mcp_config');
  if (configs.length === 0) {
    process.stderr.write('--mcp-probe: no .mcp.json found; nothing to probe.\n');
    return [];
  }

  const measurements: McpMeasurement[] = [];

  for (const artifact of configs) {
    const source = normaliseSource(fs.readFileSync(artifact.path, 'utf8'));
    const parsed = parseMcpConfig(source);
    if (!parsed.ok) {
      process.stderr.write(`--mcp-probe: ${artifact.relPath}: ${parsed.message}\n`);
      continue;
    }

    let raw: unknown;
    try {
      raw = JSON.parse(source);
    } catch {
      continue;
    }

    process.stderr.write(
      `\n--mcp-probe will run these commands from ${artifact.relPath}:\n` +
        parsed.value.serverNames.map((n) => `    ${n}\n`).join('') +
        '\nThese are third-party programs declared in that file.\n',
    );

    if (!assumeYes) {
      if (!process.stdin.isTTY) {
        process.stderr.write(
          'Refusing to run them without confirmation. Re-run with --yes to proceed.\n',
        );
        return [];
      }
      const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
      const answer = (await rl.question('Start them? [y/N] ')).trim().toLowerCase();
      rl.close();
      if (answer !== 'y' && answer !== 'yes') {
        process.stderr.write('Skipped.\n');
        return [];
      }
    }

    const cwd = path.dirname(artifact.path);
    for (const result of await probeAll(parsed.value, raw, { cwd })) {
      measurements.push({
        server: result.server,
        toolCount: result.toolCount,
        tokens: result.schemaJson === '' ? 0 : countTokens(result.schemaJson, 'cl100k_base').value,
        ...(result.error === undefined ? {} : { error: result.error }),
      });
    }
  }

  return measurements;
}

function exitCode(severities: readonly Severity[], failOn: string): number {
  if (failOn === 'never') return 0;
  const threshold = SEVERITY_RANK[failOn as Severity];
  if (threshold === undefined) {
    process.stderr.write(`Unknown --fail-on value "${failOn}". Use error, warn, info, or never.\n`);
    return 2;
  }
  return severities.some((s) => SEVERITY_RANK[s] >= threshold) ? 1 : 0;
}

function explain(ruleId: string): string {
  const normalised = ruleId.toUpperCase();
  const known = RULES.map((r) => r.id);

  if (!known.includes(normalised)) {
    return (
      `Unknown rule "${ruleId}".\n\nRegistered rules:\n` +
      RULES.map((r) => `  ${r.id.padEnd(20)} ${r.title}`).join('\n') +
      '\n'
    );
  }

  const rule = getRule(normalised);
  const out: string[] = [];
  out.push('');
  out.push(`  ${rule.id}  —  ${rule.title}`);
  out.push(`  ${'─'.repeat(66)}`);
  out.push(`  Default severity: ${rule.defaultSeverity}`);
  out.push('');
  out.push('  Why this is a finding');
  for (const line of wrap(rule.rationale, 64)) out.push(`    ${line}`);
  out.push('');
  out.push('  Sources');
  for (const citation of rule.citations) {
    out.push(`    ${citation.ref}`);
    out.push(`    ${citation.url}`);
    for (const line of wrap(`“${citation.quote}”`, 62)) out.push(`      ${line}`);
    out.push('');
  }
  out.push('  What this rule does NOT establish');
  for (const line of wrap(rule.limitation, 64)) out.push(`    ${line}`);
  out.push('');
  return out.join('\n');
}

function renderComparison(comparison: ReturnType<typeof compareToBaseline>): string {
  const out: string[] = [''];
  const sign = comparison.tokenDelta >= 0 ? '+' : '';
  out.push(
    `  Always-on tokens: ${comparison.baselineTokens} → ${comparison.currentTokens} ` +
      `(${sign}${comparison.tokenDelta})`,
  );
  out.push(
    `  ${comparison.newFindings.length} new · ${comparison.resolvedFindings.length} resolved · ` +
      `${comparison.unchangedCount} unchanged`,
  );
  out.push('');
  for (const finding of comparison.newFindings) out.push(`  + [${finding.ruleId}] ${finding.summary}`);
  for (const finding of comparison.resolvedFindings) out.push(`  - [${finding.ruleId}] ${finding.summary}`);
  out.push('');
  return out.join('\n');
}

function wrap(text: string, width: number): string[] {
  const words = text.replace(/\s+/g, ' ').trim().split(' ');
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    if (current.length === 0) current = word;
    else if (current.length + 1 + word.length <= width) current += ` ${word}`;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines;
}

program.parse();
