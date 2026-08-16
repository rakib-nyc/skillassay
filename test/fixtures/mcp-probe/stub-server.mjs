#!/usr/bin/env node
/**
 * A minimal, real MCP stdio server used to test `--mcp-probe`.
 *
 * It speaks the actual protocol — initialize, initialized, tools/list — so the
 * prober is exercised end to end rather than against a mock of itself. Two
 * tools with deliberately verbose schemas, so the measured token cost is
 * clearly non-trivial.
 */
const TOOLS = [
  {
    name: 'query_warehouse',
    description:
      'Run a read-only SQL query against the analytics warehouse and return rows as JSON. ' +
      'Supports CTEs, window functions and parameter binding.',
    inputSchema: {
      type: 'object',
      properties: {
        sql: { type: 'string', description: 'The SQL statement to execute. Must be read-only.' },
        parameters: { type: 'array', items: { type: 'string' }, description: 'Bound parameters.' },
        maxRows: { type: 'integer', description: 'Row cap.', default: 1000 },
      },
      required: ['sql'],
    },
  },
  {
    name: 'describe_table',
    description: 'Return the column names, types, nullability and comments for a warehouse table.',
    inputSchema: {
      type: 'object',
      properties: {
        schema: { type: 'string', description: 'Schema name.' },
        table: { type: 'string', description: 'Table name.' },
      },
      required: ['schema', 'table'],
    },
  },
];

let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let newline = buffer.indexOf('\n');
  while (newline !== -1) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    newline = buffer.indexOf('\n');
    if (!line) continue;

    let message;
    try { message = JSON.parse(line); } catch { continue; }

    if (message.method === 'initialize') {
      respond(message.id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'stub-warehouse', version: '1.0.0' },
      });
    } else if (message.method === 'tools/list') {
      respond(message.id, { tools: TOOLS });
    }
  }
});

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}
