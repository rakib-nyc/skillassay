import type { ParseOutcome } from '../types.js';

export interface McpConfig {
  readonly serverNames: readonly string[];
  /**
   * True when the file inlines tool definitions (some harnesses allow this).
   * When false — the normal case — tool schemas live on the server and cannot
   * be counted without launching it.
   */
  readonly hasInlineToolSchemas: boolean;
  readonly inlineSchemaJson: string;
}

/**
 * Parse an MCP configuration file.
 *
 * Anecdotal reports describe 90+ tool definitions exceeding 50,000 tokens of
 * JSON schema. The rule here is to measure that, not assume it.
 *
 * Measuring it is not possible from this file. `.mcp.json` declares how to
 * *launch* each server (`command`, `args`, `env`); the tool schemas are returned
 * by the server at runtime in response to `tools/list`. A static analyzer cannot
 * know them without executing third-party binaries, which the offline-by-default
 * guarantee forbids.
 *
 * So this parser extracts what the file genuinely contains — the server list —
 * and the budget reports the schema cost as an explicit *unmeasured* item naming
 * each server. Printing a plausible per-server estimate here would be precisely
 * the fabricated number the integrity rules exist to prevent.
 */
export function parseMcpConfig(source: string): ParseOutcome<McpConfig> {
  let data: unknown;
  try {
    data = JSON.parse(source);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, code: 'malformed_json', message: `Invalid JSON: ${message}` };
  }

  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, code: 'mcp_not_object', message: 'MCP config must be a JSON object' };
  }

  const record = data as Record<string, unknown>;
  const servers = record['mcpServers'] ?? record['servers'];

  if (servers === undefined) {
    return {
      ok: false,
      code: 'mcp_no_servers',
      message: 'MCP config has no `mcpServers` or `servers` key',
    };
  }

  if (servers === null || typeof servers !== 'object' || Array.isArray(servers)) {
    return {
      ok: false,
      code: 'mcp_servers_not_object',
      message: '`mcpServers` must be an object keyed by server name',
    };
  }

  const serverRecord = servers as Record<string, unknown>;
  // Sorted so discovery order can never leak into output.
  const serverNames = Object.keys(serverRecord).sort();

  const inlineSchemas: unknown[] = [];
  for (const name of serverNames) {
    const server = serverRecord[name];
    if (server !== null && typeof server === 'object' && !Array.isArray(server)) {
      const tools = (server as Record<string, unknown>)['tools'];
      if (Array.isArray(tools)) inlineSchemas.push(...tools);
    }
  }

  return {
    ok: true,
    value: {
      serverNames,
      hasInlineToolSchemas: inlineSchemas.length > 0,
      inlineSchemaJson: inlineSchemas.length > 0 ? JSON.stringify(inlineSchemas) : '',
    },
  };
}
