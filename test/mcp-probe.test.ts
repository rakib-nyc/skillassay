import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { analyze } from '../src/analyze/index.js';
import { probeAll, probeServer, serverSpecs } from '../src/mcp/probe.js';
import { parseMcpConfig, normaliseSource } from '../src/parse/index.js';
import { countTokens } from '../src/tokenize/index.js';
import type { McpMeasurement } from '../src/types.js';

/**
 * `--mcp-probe`.
 *
 * MCP tool schemas are plausibly the largest always-on cost for a heavy user,
 * and they cannot be read from `.mcp.json` — that file says how to *launch* a
 * server; the schemas come back at runtime from `tools/list`. Declining to
 * measure them is honest but leaves the headline incomplete.
 *
 * These tests run against `test/fixtures/mcp-probe/stub-server.mjs`, a real MCP
 * stdio server that speaks the actual protocol, so the prober is exercised
 * end to end rather than against a mock of itself.
 */

const FIXTURE = path.resolve(import.meta.dirname, 'fixtures', 'mcp-probe');

function loadConfig() {
  const source = normaliseSource(fs.readFileSync(path.join(FIXTURE, '.mcp.json'), 'utf8'));
  const parsed = parseMcpConfig(source);
  if (!parsed.ok) throw new Error(parsed.message);
  return { parsed: parsed.value, raw: JSON.parse(source) as unknown };
}

describe('serverSpecs', () => {
  it('extracts stdio servers and sets remote ones aside', () => {
    const { raw } = loadConfig();
    const { specs, skipped } = serverSpecs(raw);

    expect(specs.map((s) => s.name).sort()).toEqual(['broken', 'warehouse']);
    // A URL-based server would mean a network call the user did not ask for.
    expect(skipped).toEqual(['remote']);
  });
});

describe('probeServer against a real stdio MCP server', () => {
  it('completes the handshake and returns the advertised tools', async () => {
    const result = await probeServer(
      { name: 'warehouse', command: 'node', args: ['stub-server.mjs'], env: {} },
      { cwd: FIXTURE, timeoutMs: 10_000 },
    );

    expect(result.error).toBeUndefined();
    expect(result.toolCount).toBe(2);
    expect(result.schemaJson).toContain('query_warehouse');
    expect(result.schemaJson).toContain('describe_table');
    // The measurement that matters: a real, non-trivial token cost.
    expect(countTokens(result.schemaJson, 'cl100k_base').value).toBeGreaterThan(100);
  }, 20_000);

  it('reports a server that cannot start rather than counting it as zero', async () => {
    const result = await probeServer(
      { name: 'broken', command: 'definitely-not-a-real-binary-xyz', args: [], env: {} },
      { cwd: FIXTURE, timeoutMs: 5_000 },
    );

    // A failed probe must never silently become "0 tokens" — that would make a
    // heavy MCP setup look free.
    expect(result.error).toBeDefined();
    expect(result.toolCount).toBe(0);
  }, 15_000);

  it('times out on a server that never answers, instead of hanging', async () => {
    const result = await probeServer(
      // `cat` holds stdin open forever and answers nothing.
      { name: 'silent', command: 'cat', args: [], env: {} },
      { cwd: FIXTURE, timeoutMs: 1_500 },
    );

    expect(result.error).toMatch(/timed out/);
  }, 15_000);

  it('accounts for every declared server, including unprobeable ones', async () => {
    const { parsed, raw } = loadConfig();
    const results = await probeAll(parsed, raw, { cwd: FIXTURE, timeoutMs: 8_000 });

    // Three declared, three accounted for. A server that vanished between the
    // config and the report would be an invisible hole in the budget.
    expect(results.map((r) => r.server).sort()).toEqual(['broken', 'remote', 'warehouse']);
    expect(results.find((r) => r.server === 'warehouse')?.toolCount).toBe(2);
    expect(results.find((r) => r.server === 'remote')?.error).toMatch(/not a stdio server/);
  }, 30_000);
});

describe('budget integration', () => {
  it('reports MCP cost as unmeasured when the probe has not run', () => {
    const result = analyze(FIXTURE);
    const mcpUnmeasured = result.budget.unmeasured.find((u) => u.source.includes('.mcp.json'));

    expect(mcpUnmeasured).toBeDefined();
    expect(mcpUnmeasured?.reason).toContain('served at runtime');
    // Crucially: no invented figure.
    expect(result.budget.lines.some((l) => l.kind === 'mcp_config')).toBe(false);
  });

  it('counts measured schemas as always-on tokens once probed', async () => {
    const { parsed, raw } = loadConfig();
    const probed = await probeAll(parsed, raw, { cwd: FIXTURE, timeoutMs: 10_000 });
    const measurements: McpMeasurement[] = probed.map((r) => ({
      server: r.server,
      toolCount: r.toolCount,
      tokens: r.schemaJson === '' ? 0 : countTokens(r.schemaJson, 'cl100k_base').value,
      ...(r.error === undefined ? {} : { error: r.error }),
    }));

    const before = analyze(FIXTURE);
    const after = analyze(FIXTURE, { mcpMeasurements: measurements });

    const warehouseLine = after.budget.lines.find((l) => l.relPath.includes('warehouse'));
    expect(warehouseLine).toBeDefined();
    expect(warehouseLine?.portion).toContain('measured via tools/list');
    expect(after.budget.total.value).toBeGreaterThan(before.budget.total.value);

    // Tool schemas dwarf the context file in this fixture, which is the whole
    // reason leaving them unmeasured understated the headline.
    const contextTokens = after.budget.lines
      .filter((l) => l.kind === 'context_file')
      .reduce((s, l) => s + l.tokens.value, 0);
    expect(warehouseLine?.tokens.value).toBeGreaterThan(contextTokens);
  }, 30_000);

  it('keeps servers that failed to probe in the unmeasured list', async () => {
    const measurements: McpMeasurement[] = [
      { server: 'warehouse', toolCount: 2, tokens: 172 },
      { server: 'broken', toolCount: 0, tokens: 0, error: 'could not start: ENOENT' },
    ];
    const result = analyze(FIXTURE, { mcpMeasurements: measurements });

    expect(result.budget.unmeasured.some((u) => u.source.includes('broken'))).toBe(true);
    // And its zero must not be summed as though it were a measurement.
    expect(result.budget.lines.some((l) => l.relPath.includes('broken'))).toBe(false);
  });
});
