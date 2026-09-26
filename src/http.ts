import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Config } from './config.js';
import { assertSafeHttpBinding } from './config.js';
import type { Logger } from './logger.js';
import { createServer } from './server.js';
import type { ToolDeps } from './tools/deps.js';
import { SERVER_NAME, SERVER_VERSION } from './version.js';

export interface HttpHandle {
  readonly url: string;
  readonly port: number;
  close(): Promise<void>;
}

interface Session {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  lastSeen: number;
}

/**
 * Starts the Streamable HTTP transport.
 *
 * Two session modes are supported because they suit different deployments:
 *
 * - `stateless` (default): a fresh transport and server instance per request, no
 *   session affinity. This is what makes the server trivially safe behind a load
 *   balancer and restartable at any moment without dropping an agent's session.
 * - `stateful`: sessions are tracked by `Mcp-Session-Id`, which allows resumable
 *   streams but pins a client to one process and keeps memory per connection.
 *
 * Since this server never sends unsolicited server-to-client messages, stateless
 * is both simpler and strictly sufficient for the intended deployment.
 */
export async function startHttpServer(config: Config, deps: ToolDeps, logger: Logger): Promise<HttpHandle> {
  assertSafeHttpBinding(config, (message) => logger.warn(message));

  const sessions = new Map<string, Session>();
  const log = logger.child({ component: 'http' });

  const httpServer = createHttpServer((req, res) => {
    void handleRequest(req, res).catch((error: unknown) => {
      log.error('unhandled http error', { message: error instanceof Error ? error.message : String(error) });
      if (!res.headersSent) {
        sendJson(res, 500, { error: 'internal_error' });
      } else {
        res.end();
      }
    });
  });

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    applyCorsHeaders(req, res, config);

    // Preflight must succeed before any auth so browsers can complete the handshake.
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }

    if (path === '/healthz' || path === '/health') {
      // The collector's state belongs in the health payload: a stalled watcher is
      // invisible otherwise, and the data it produces would silently go stale.
      const watches = deps.watches.list();
      sendJson(res, 200, {
        status: 'ok',
        name: SERVER_NAME,
        version: SERVER_VERSION,
        transport: 'http',
        sessionMode: config.http.sessionMode,
        uptimeSeconds: Math.round(process.uptime()),
        watcher: {
          enabled: config.watch.enabled,
          available: deps.watches.unavailableReason === null && config.watch.enabled,
          unavailableReason: deps.watches.unavailableReason,
          intervalSeconds: deps.watches.intervalSeconds,
          watchCount: watches.length,
          failingWatches: watches.filter((entry) => !entry.healthy).map((entry) => entry.definition.id),
        },
      });
      return;
    }

    if (path === '/' && req.method === 'GET') {
      sendJson(res, 200, {
        name: SERVER_NAME,
        version: SERVER_VERSION,
        protocol: 'mcp',
        endpoint: config.http.path,
        health: '/healthz',
      });
      return;
    }

    if (path !== config.http.path) {
      sendJson(res, 404, { error: 'not_found', message: `No route for ${path}. MCP endpoint is ${config.http.path}.` });
      return;
    }

    if (!isAuthorized(req, config)) {
      log.warn('rejected unauthorized request', { ip: req.socket.remoteAddress, method: req.method });
      res.setHeader('WWW-Authenticate', 'Bearer realm="mcp"');
      sendJson(res, 401, {
        error: 'unauthorized',
        message: 'Provide a valid bearer token in the Authorization header.',
      });
      return;
    }

    const declaredLength = Number(req.headers['content-length'] ?? '0');
    if (Number.isFinite(declaredLength) && declaredLength > config.http.maxBodyBytes) {
      sendJson(res, 413, {
        error: 'payload_too_large',
        message: `Request body exceeds the ${config.http.maxBodyBytes} byte limit.`,
      });
      return;
    }

    if (config.http.sessionMode === 'stateless') {
      await handleStateless(req, res);
    } else {
      await handleStateful(req, res);
    }
  }

  async function handleStateless(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // A GET here would request a standalone SSE stream, which only makes sense
    // with a session to attach it to.
    if (req.method === 'GET' || req.method === 'DELETE') {
      sendJson(res, 405, {
        error: 'method_not_allowed',
        message: `The server runs in stateless mode; use POST ${config.http.path}.`,
      });
      return;
    }
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'method_not_allowed', message: 'Use POST.' });
      return;
    }

    const server = createServer(deps);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: config.http.jsonResponse,
    });

    // Tear down per-request state once the response has been flushed, otherwise a
    // long-lived process leaks a server object per call.
    res.on('close', () => {
      void transport.close().catch(() => undefined);
      void server.close().catch(() => undefined);
    });

    await server.connect(transport);
    await transport.handleRequest(req, res);
  }

  async function handleStateful(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const sessionId = req.headers['mcp-session-id'];
    const existing = typeof sessionId === 'string' ? sessions.get(sessionId) : undefined;

    if (existing !== undefined) {
      existing.lastSeen = Date.now();
      await existing.transport.handleRequest(req, res);
      return;
    }

    if (req.method === 'DELETE') {
      sendJson(res, 404, { error: 'session_not_found', message: 'No such session.' });
      return;
    }

    // No (valid) session yet: only an initialise request may open one.
    if (req.method !== 'POST') {
      sendJson(res, 400, {
        error: 'bad_request',
        message: 'Missing or invalid Mcp-Session-Id header. Send an initialize POST to start a session.',
      });
      return;
    }

    const server = createServer(deps);
    let createdSessionId: string | undefined;
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: config.http.jsonResponse,
      onsessioninitialized: (id) => {
        createdSessionId = id;
        sessions.set(id, { server, transport, lastSeen: Date.now() });
        log.info('session opened', { sessionId: id, total: sessions.size });
      },
    });

    transport.onclose = () => {
      const id = transport.sessionId ?? createdSessionId;
      if (id !== undefined) {
        sessions.delete(id);
        log.info('session closed', { sessionId: id, total: sessions.size });
      }
      void server.close().catch(() => undefined);
    };

    await server.connect(transport);
    await transport.handleRequest(req, res);
  }

  const cleanupTimer = setInterval(() => {
    const cutoff = Date.now() - 30 * 60 * 1000;
    for (const [id, session] of sessions) {
      if (session.lastSeen < cutoff) {
        log.info('evicting idle session', { sessionId: id });
        sessions.delete(id);
        void session.transport.close().catch(() => undefined);
      }
    }
  }, 60_000);
  cleanupTimer.unref();

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(config.http.port, config.http.host, () => {
      httpServer.removeListener('error', reject);
      resolve();
    });
  });

  const address = httpServer.address();
  const port = typeof address === 'object' && address !== null ? address.port : config.http.port;
  const url = `http://${config.http.host}:${port}${config.http.path}`;

  return {
    url,
    port,
    async close() {
      clearInterval(cleanupTimer);
      for (const session of sessions.values()) {
        await session.transport.close().catch(() => undefined);
      }
      sessions.clear();
      await closeHttpServer(httpServer);
    },
  };
}

function isAuthorized(req: IncomingMessage, config: Config): boolean {
  const expected = config.http.authToken;
  if (expected === undefined) return true;

  const header = req.headers.authorization;
  if (typeof header !== 'string') return false;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (match === null) return false;

  return constantTimeEquals(match[1]!.trim(), expected);
}

/**
 * Constant-time comparison so an attacker cannot recover the token byte by byte
 * from response timing.
 */
function constantTimeEquals(candidate: string, expected: string): boolean {
  const a = Buffer.from(candidate, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) {
    // Still perform a comparison of equal-length buffers to keep timing flat.
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

function applyCorsHeaders(req: IncomingMessage, res: ServerResponse, config: Config): void {
  const allowed = config.http.allowedOrigins;
  if (allowed === undefined) return;

  const origin = req.headers.origin;
  if (allowed.includes('*')) {
    res.setHeader('Access-Control-Allow-Origin', '*');
  } else if (typeof origin === 'string' && allowed.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  } else {
    return;
  }

  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version');
  res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id, Mcp-Protocol-Version');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

function closeHttpServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    // Sockets kept alive by an idle agent would otherwise block shutdown.
    server.closeAllConnections?.();
  });
}
