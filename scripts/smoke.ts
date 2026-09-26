/**
 * Live smoke test against the real Open-Meteo API.
 *
 * This is deliberately separate from `npm test`: the unit and integration suites
 * run hermetically against a local mock, while this script proves the deployed
 * server can actually reach the internet. Run it after a deploy, or on the VPS
 * itself, to confirm egress, DNS and TLS all work from that host.
 *
 * Usage:
 *   npm run smoke                     # stdio transport, in-process
 *   npm run smoke -- --url http://127.0.0.1:3000/mcp --token secret
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

interface Check {
  tool: string;
  args: Record<string, unknown>;
}

const CHECKS: Check[] = [
  { tool: 'geocode_location', args: { name: 'Moscow', count: 3 } },
  { tool: 'get_current_weather', args: { location: 'Moscow' } },
  { tool: 'get_weather_forecast', args: { location: 'Moscow', days: 3 } },
  { tool: 'get_air_quality', args: { location: 'Moscow' } },
  // Read-only, so the smoke test never registers or deletes a watch: it only
  // confirms the collector is reachable and reports its interval.
  { tool: 'list_weather_watches', args: {} },
  // Also read-only: it reports which summaries exist and where they are stored,
  // without saving or exporting anything.
  { tool: 'list_weather_summaries', args: {} },
];

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

/** Env prefixes that must reach the spawned server. */
const FORWARDED_ENV = /^(LOG_LEVEL|MCP_|OPEN_METEO_|WATCH_|SUMMARY_)/;

/**
 * The MCP SDK's `getDefaultEnvironment()` deliberately scrubs the ambient
 * environment down to a safe allowlist, so any server-specific variable passed
 * on the command line (LOG_LEVEL, OPEN_METEO_TIMEOUT_MS, ...) would silently be
 * dropped. Forward the ones this server documents.
 */
function childEnvironment(): Record<string, string> {
  const env: Record<string, string> = { ...getDefaultEnvironment() };
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && FORWARDED_ENV.test(key)) env[key] = value;
  }
  return env;
}

async function main(): Promise<void> {
  const url = argValue('--url');
  const token = argValue('--token') ?? process.env['MCP_AUTH_TOKEN'];
  const client = new Client({ name: 'smoke-test', version: '1.0.0' }, { capabilities: {} });

  if (url !== undefined) {
    const transport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: token !== undefined ? { headers: { authorization: `Bearer ${token}` } } : {},
    });
    await client.connect(transport);
    console.log(`Connected over Streamable HTTP to ${url}\n`);
  } else {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['dist/index.js', '--transport', 'stdio'],
      env: childEnvironment(),
      stderr: 'inherit',
    });
    await client.connect(transport);
    console.log('Connected over stdio (spawned dist/index.js)\n');
  }

  const { tools } = await client.listTools();
  console.log(`Tools advertised (${tools.length}): ${tools.map((t) => t.name).join(', ')}\n`);

  let failures = 0;
  for (const check of CHECKS) {
    const started = Date.now();
    let result: CallToolResult;
    try {
      result = (await client.callTool({ name: check.tool, arguments: check.args })) as CallToolResult;
    } catch (error) {
      failures += 1;
      console.log(`FAIL  ${check.tool} — transport error: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }

    const elapsed = Date.now() - started;
    const text = result.content.find((b) => b.type === 'text');
    const preview = text !== undefined && text.type === 'text' ? text.text.split('\n').slice(0, 3).join('\n') : '';

    if (result.isError === true) {
      failures += 1;
      console.log(`FAIL  ${check.tool} (${elapsed} ms)\n${preview}\n`);
    } else {
      const structured = result.structuredContent !== undefined ? 'structured content present' : 'NO structured content';
      console.log(`ok    ${check.tool} (${elapsed} ms) — ${structured}\n${preview}\n`);
    }
  }

  await client.close();

  if (failures > 0) {
    console.error(`${failures} of ${CHECKS.length} live checks failed.`);
    process.exitCode = 1;
  } else {
    console.log(`All ${CHECKS.length} live checks passed.`);
  }
}

main().catch((error: unknown) => {
  console.error(`smoke test failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
