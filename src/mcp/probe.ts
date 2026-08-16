import { spawn } from 'node:child_process';
import type { McpConfig } from '../parse/mcp.js';

/**
 * Measuring MCP tool-schema cost by asking the servers.
 *
 * Anecdotal reports describe 90+ tool definitions exceeding 50,000 tokens of
 * JSON schema. The rule here is to measure that, not assume it.
 *
 * The static path cannot: `.mcp.json` says how to *launch* a server, and the
 * tool schemas are returned at runtime from `tools/list`. So the budget reports
 * them as unmeasured — honest, but it means the tool declines to measure the
 * item most likely to dominate the number it exists to compute.
 *
 * This module closes that gap the only way it can be closed: by starting the
 * servers and asking. That executes third-party binaries, so it is strictly
 * opt-in (`--mcp-probe`), it prints every command before running it, and it
 * requires confirmation unless `--yes` is passed. Nothing here runs on the
 * default path, and the offline guarantee is unaffected when the flag is absent.
 */

export interface McpProbeResult {
  readonly server: string;
  readonly command: string;
  /** Concatenated JSON of every tool definition the server advertises. */
  readonly schemaJson: string;
  readonly toolCount: number;
  /** Populated when the server could not be probed. Never silently ignored. */
  readonly error?: string;
  readonly durationMs: number;
}

export interface ServerSpec {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

/**
 * Extract launch specs from a parsed MCP config.
 *
 * Only stdio servers are probeable. A server declared with a `url` is remote,
 * and reaching out to it is a network call the user did not ask for, so those
 * are reported as unprobeable rather than contacted.
 */
export function serverSpecs(config: unknown): { specs: ServerSpec[]; skipped: string[] } {
  const specs: ServerSpec[] = [];
  const skipped: string[] = [];

  if (config === null || typeof config !== 'object') return { specs, skipped };
  const record = config as Record<string, unknown>;
  const servers = (record['mcpServers'] ?? record['servers']) as
    | Record<string, unknown>
    | undefined;
  if (!servers || typeof servers !== 'object') return { specs, skipped };

  for (const name of Object.keys(servers).sort()) {
    const entry = servers[name];
    if (entry === null || typeof entry !== 'object') continue;
    const server = entry as Record<string, unknown>;

    const command = server['command'];
    if (typeof command !== 'string' || command.length === 0) {
      skipped.push(name);
      continue;
    }

    const rawArgs = server['args'];
    const args = Array.isArray(rawArgs) ? rawArgs.filter((a): a is string => typeof a === 'string') : [];

    const rawEnv = server['env'];
    const env: Record<string, string> = {};
    if (rawEnv && typeof rawEnv === 'object' && !Array.isArray(rawEnv)) {
      for (const [key, value] of Object.entries(rawEnv as Record<string, unknown>)) {
        if (typeof value === 'string') env[key] = value;
      }
    }

    specs.push({ name, command, args, env });
  }

  return { specs, skipped };
}

export interface ProbeOptions {
  readonly cwd: string;
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const PROTOCOL_VERSION = '2024-11-05';

/**
 * Speak just enough MCP over stdio to enumerate a server's tools.
 *
 * The handshake is fixed by the protocol: `initialize`, then an `initialized`
 * notification, then `tools/list`. Responses are newline-delimited JSON-RPC on
 * stdout; anything the server writes to stderr is ignored, since servers
 * commonly log there.
 */
export async function probeServer(
  spec: ServerSpec,
  options: ProbeOptions,
): Promise<McpProbeResult> {
  const startedAt = Date.now();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const commandLine = [spec.command, ...spec.args].join(' ');

  const fail = (error: string): McpProbeResult => ({
    server: spec.name,
    command: commandLine,
    schemaJson: '',
    toolCount: 0,
    error,
    durationMs: Date.now() - startedAt,
  });

  return new Promise<McpProbeResult>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(spec.command, [...spec.args], {
        cwd: options.cwd,
        env: { ...process.env, ...spec.env },
        stdio: ['pipe', 'pipe', 'pipe'],
        /*
         * On Windows the commands people put in .mcp.json (`npx`, `npm`, `uvx`)
         * resolve to `.cmd` shims, which cannot be spawned directly — Node
         * fails with EINVAL. `shell: true` is required there and is not used
         * anywhere else, so argument quoting stays out of the picture on POSIX.
         */
        shell: process.platform === 'win32',
      });
    } catch (error) {
      resolve(fail(`could not start: ${error instanceof Error ? error.message : String(error)}`));
      return;
    }

    let settled = false;
    let buffer = '';

    const finish = (result: McpProbeResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGTERM');
      // A server that ignores SIGTERM must not keep the process alive.
      const hardKill = setTimeout(() => child.kill('SIGKILL'), 2000);
      hardKill.unref?.();
      resolve(result);
    };

    const timer = setTimeout(
      () => finish(fail(`timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );

    child.on('error', (error) => finish(fail(`could not start: ${error.message}`)));
    child.on('exit', (code) => {
      if (!settled) finish(fail(`exited with code ${code ?? 'unknown'} before listing tools`));
    });

    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let newline = buffer.indexOf('\n');

      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
        if (line.length === 0) continue;

        let message: Record<string, unknown>;
        try {
          message = JSON.parse(line) as Record<string, unknown>;
        } catch {
          // Servers sometimes print banners on stdout. Not fatal; keep reading.
          continue;
        }

        /*
         * Only responses carry an `id` without a `method`. A message with a
         * `method` is a request or notification — including our own, echoed
         * back by a server that mirrors stdin. Matching on `id` alone made an
         * echoing process look like a successful handshake advertising zero
         * tools, which would have reported a real server as costing nothing.
         */
        if (typeof message['method'] === 'string') continue;
        if (message['result'] === undefined && message['error'] === undefined) continue;

        if (message['id'] === 1) {
          send(child, { jsonrpc: '2.0', method: 'notifications/initialized' });
          send(child, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
          continue;
        }

        if (message['id'] === 2) {
          const error = message['error'];
          if (error !== undefined) {
            finish(fail(`tools/list failed: ${JSON.stringify(error).slice(0, 200)}`));
            return;
          }
          const result = message['result'] as { tools?: unknown } | undefined;
          const tools = Array.isArray(result?.tools) ? result.tools : [];
          finish({
            server: spec.name,
            command: commandLine,
            schemaJson: JSON.stringify(tools),
            toolCount: tools.length,
            durationMs: Date.now() - startedAt,
          });
          return;
        }
      }
    });

    send(child, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'skillassay', version: '0.1.0' },
      },
    });
  });
}

function send(child: ReturnType<typeof spawn>, message: unknown): void {
  try {
    child.stdin?.write(`${JSON.stringify(message)}\n`);
  } catch {
    // The exit/error handlers already resolve the probe; a failed write here
    // would otherwise be reported twice.
  }
}

export async function probeAll(
  config: McpConfig,
  rawConfig: unknown,
  options: ProbeOptions,
): Promise<McpProbeResult[]> {
  const { specs, skipped } = serverSpecs(rawConfig);
  const results: McpProbeResult[] = [];

  // Sequential, not parallel: servers can be resource-heavy, and a deterministic
  // order keeps the report stable.
  for (const spec of specs) {
    results.push(await probeServer(spec, options));
  }

  for (const name of skipped) {
    results.push({
      server: name,
      command: '(no stdio command)',
      schemaJson: '',
      toolCount: 0,
      error: 'not a stdio server (remote or URL-based); not contacted',
      durationMs: 0,
    });
  }

  // Any server declared in the config but absent from the results would be a
  // silent omission from the budget, so account for every name.
  for (const name of config.serverNames) {
    if (!results.some((r) => r.server === name)) {
      results.push({
        server: name,
        command: '(unparseable entry)',
        schemaJson: '',
        toolCount: 0,
        error: 'server entry could not be interpreted',
        durationMs: 0,
      });
    }
  }

  return results.sort((a, b) => (a.server < b.server ? -1 : a.server > b.server ? 1 : 0));
}
