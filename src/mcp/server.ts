/**
 * QMD MCP Server - Model Context Protocol server for QMD
 *
 * Exposes QMD search and document retrieval as MCP tools and resources.
 * Documents are accessible via qmd:// URIs.
 *
 * Supports two transports:
 * - **stdio** (default): single-process mode for local AI agent orchestration.
 * - **Streamable HTTP** (activated via `--http`): JSON-over-HTTP with session
 *   management, a `/health` endpoint, and a REST-based `/query` shortcut for
 *   clients that don't speak the full MCP protocol.
 *
 * Follows MCP spec 2025-06-18 for proper response types.
 *
 * @module
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebStandardStreamableHTTPServerTransport }
  from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { existsSync } from "fs";
import {
  createStore,
  extractSnippet,
  addLineNumbers,
  getDefaultDbPath,
  type ExpandedQuery,
} from "../index.js";
import { getConfigPath } from "../collections.js";
import { enableProductionMode } from "../store.js";
import { createMcpServer } from "./tools.js";

// =============================================================================
// Transport: stdio (default)
// =============================================================================

export type McpStartupOptions = {
  dbPath?: string;
};

/**
 * Start the MCP server over stdio transport.
 *
 * Use this for local AI agent/IDE integration (Claude Desktop, Cursor, etc.).
 * Creates the store from the default database path or an explicit `dbPath`,
 * builds the MCP server with all QMD tools/resources via `createMcpServer`,
 * and connects via `StdioServerTransport`.
 *
 * The server runs until the parent process closes stdin or the process is
 * terminated. No cleanup handler is required — the process exit handles it.
 *
 * @param options.dbPath - Override for the SQLite database path (default: auto-detected).
 * Side effects: flips `enableProductionMode()`, opens the SQLite DB, registers
 * MCP tools/resources via createMcpServer.
 */
export async function startMcpServer(options: McpStartupOptions = {}): Promise<void> {
  // Opt into production mode when the MCP server is actually started, not
  // when this module is merely imported for its exports. Importing the module
  // at the top level flipped the global production flag and broke test
  // isolation for downstream suites that expect the default (development)
  // database path behaviour.
  enableProductionMode();
  const configPath = getConfigPath();
  const store = await createStore({
    dbPath: options.dbPath ?? getDefaultDbPath(),
    ...(existsSync(configPath) ? { configPath } : {}),
  });
  const server = await createMcpServer(store);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// =============================================================================
// Transport: Streamable HTTP
// =============================================================================

export type HttpServerHandle = {
  httpServer: import("http").Server;
  port: number;
  stop: () => Promise<void>;
};

/**
 * Start MCP server over Streamable HTTP (JSON responses, no SSE).
 *
 * Use this when stdio transport is not suitable (e.g. multi-client access,
 * containerized deployments, or REST API consumers).
 *
 * Binds to localhost only. Creates per-session MCP server+transport pairs
 * (required by the MCP spec) sharing a single stateless SQLite store.
 *
 * REST shortcuts:
 * - `POST /query` or `POST /search` — structured search without MCP handshake.
 * - `GET /health` — liveness probe returning `{ status, uptime }`.
 * - `POST /mcp` — full MCP protocol endpoint.
 *
 * Registers SIGTERM/SIGINT handlers for graceful shutdown (drains all
 * sessions, closes the store, then exits).
 *
 * @param port - Desired HTTP port. If 0, an ephemeral port is assigned
 *   (read the actual port from the returned `HttpServerHandle`).
 * @param options.dbPath - Override for the SQLite database path.
 * @param options.quiet - Suppress request logging to stderr.
 * @returns An `HttpServerHandle` with the running server, actual port, and
 *   a `stop()` function for programmatic shutdown.
 * Side effects: flips `enableProductionMode()`, opens the SQLite DB, starts
 * an HTTP listener, registers signal handlers.
 */
export async function startMcpHttpServer(
  port: number,
  options: ({ quiet?: boolean } & McpStartupOptions) = {},
): Promise<HttpServerHandle> {
  // See startMcpServer() for the rationale — flip production mode here so the
  // HTTP transport resolves the real database path, without leaking state into
  // callers that only import this module for its exports (e.g. tests).
  enableProductionMode();
  const configPath = getConfigPath();
  const store = await createStore({
    dbPath: options.dbPath ?? getDefaultDbPath(),
    ...(existsSync(configPath) ? { configPath } : {}),
  });

  // Pre-fetch default collection names for REST endpoint
  const defaultCollectionNames = await store.getDefaultCollectionNames();

  // Session map: each client gets its own McpServer + Transport pair (MCP spec requirement).
  // The store is shared — it's stateless SQLite, safe for concurrent access.
  const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();

  async function createSession(): Promise<WebStandardStreamableHTTPServerTransport> {
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (sessionId: string) => {
        sessions.set(sessionId, transport);
        log(`${ts()} New session ${sessionId} (${sessions.size} active)`);
      },
    });
    const server = await createMcpServer(store);
    await server.connect(transport);

    transport.onclose = () => {
      if (transport.sessionId) {
        sessions.delete(transport.sessionId);
      }
    };

    return transport;
  }

  const startTime = Date.now();
  const quiet = options?.quiet ?? false;

  /** Format timestamp for request logging */
  function ts(): string {
    return new Date().toISOString().slice(11, 23); // HH:mm:ss.SSS
  }

  type JsonRpcLikeBody = {
    method?: unknown;
    params?: {
      name?: unknown;
      arguments?: Record<string, unknown>;
    };
  };
  type RestSearchInput = {
    type?: unknown;
    query?: unknown;
  };

  /** Extract a human-readable label from a JSON-RPC body */
  function describeRequest(body: JsonRpcLikeBody): string {
    const method = typeof body.method === "string" ? body.method : "unknown";
    if (method === "tools/call") {
      const tool = body.params?.name ?? "?";
      const args = body.params?.arguments;
      // Show query string if present, truncated
      if (args?.query) {
        const q = String(args.query).slice(0, 80);
        return `tools/call ${tool} "${q}"`;
      }
      if (args?.path) return `tools/call ${tool} ${args.path}`;
      if (args?.pattern) return `tools/call ${tool} ${args.pattern}`;
      return `tools/call ${tool}`;
    }
    return method;
  }

  function log(msg: string): void {
    if (!quiet) console.error(msg);
  }

  // Helper to collect request body
  async function collectBody(req: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString();
  }

  const httpServer = createServer(async (nodeReq: IncomingMessage, nodeRes: ServerResponse) => {
    const reqStart = Date.now();
    const pathname = nodeReq.url || "/";

    try {
      if (pathname === "/health" && nodeReq.method === "GET") {
        const body = JSON.stringify({ status: "ok", uptime: Math.floor((Date.now() - startTime) / 1000) });
        nodeRes.writeHead(200, { "Content-Type": "application/json" });
        nodeRes.end(body);
        log(`${ts()} GET /health (${Date.now() - reqStart}ms)`);
        return;
      }

      // REST endpoint: POST /search — structured search without MCP protocol
      // REST endpoint: POST /query (alias: /search) — structured search without MCP protocol
      if ((pathname === "/query" || pathname === "/search") && nodeReq.method === "POST") {
        const rawBody = await collectBody(nodeReq);
        const params = JSON.parse(rawBody) as Record<string, unknown>;

        // Validate required fields
        if (!params.searches || !Array.isArray(params.searches)) {
          nodeRes.writeHead(400, { "Content-Type": "application/json" });
          nodeRes.end(JSON.stringify({ error: "Missing required field: searches (array)" }));
          return;
        }

        // Map to internal format
        const searches = params.searches as RestSearchInput[];
        const queries: ExpandedQuery[] = searches.map((s) => ({
          type: s.type as 'lex' | 'vec' | 'hyde',
          query: String(s.query || ""),
        }));

        // Use default collections if none specified
        const effectiveCollections = Array.isArray(params.collections) ? params.collections.map(String) : defaultCollectionNames;

        const results = await store.search({
          queries,
          collections: effectiveCollections.length > 0 ? effectiveCollections : undefined,
          limit: typeof params.limit === "number" ? params.limit : 10,
          minScore: typeof params.minScore === "number" ? params.minScore : 0,
          candidateLimit: typeof params.candidateLimit === "number" ? params.candidateLimit : undefined,
          intent: typeof params.intent === "string" ? params.intent : undefined,
          rerank: typeof params.rerank === "boolean" ? params.rerank : undefined,
        });

        // Use first lex or vec query for snippet extraction
        const primaryQuery = searches.find((s) => s.type === 'lex')?.query
          || searches.find((s) => s.type === 'vec')?.query
          || searches[0]?.query || "";

        const formatted = results.map(r => {
          const { line, snippet } = extractSnippet(r.body, String(primaryQuery), 300, r.bestChunkPos, r.bestChunk.length, typeof params.intent === "string" ? params.intent : undefined);
          return {
            docid: `#${r.docid}`,
            file: r.file,
            title: r.title,
            score: Math.round(r.score * 100) / 100,
            context: r.context,
            line,
            snippet: addLineNumbers(snippet, line),
          };
        });

        nodeRes.writeHead(200, { "Content-Type": "application/json" });
        nodeRes.end(JSON.stringify({ results: formatted }));
        log(`${ts()} POST /query ${params.searches.length} queries (${Date.now() - reqStart}ms)`);
        return;
      }

      if (pathname === "/mcp" && nodeReq.method === "POST") {
        const rawBody = await collectBody(nodeReq);
        const body = JSON.parse(rawBody);
        const label = describeRequest(body);
        const url = `http://localhost:${port}${pathname}`;
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(nodeReq.headers)) {
          if (typeof v === "string") headers[k] = v;
        }

        // Route to existing session or create new one on initialize
        const sessionId = headers["mcp-session-id"];
        let transport: WebStandardStreamableHTTPServerTransport;

        if (sessionId) {
          const existing = sessions.get(sessionId);
          if (!existing) {
            nodeRes.writeHead(404, { "Content-Type": "application/json" });
            nodeRes.end(JSON.stringify({
              jsonrpc: "2.0",
              error: { code: -32001, message: "Session not found" },
              id: body?.id ?? null,
            }));
            return;
          }
          transport = existing;
        } else if (isInitializeRequest(body)) {
          transport = await createSession();
        } else {
          nodeRes.writeHead(400, { "Content-Type": "application/json" });
          nodeRes.end(JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32000, message: "Bad Request: Missing session ID" },
            id: body?.id ?? null,
          }));
          return;
        }

        const request = new Request(url, { method: "POST", headers, body: rawBody });
        const response = await transport.handleRequest(request, { parsedBody: body });

        nodeRes.writeHead(response.status, Object.fromEntries(response.headers));
        nodeRes.end(Buffer.from(await response.arrayBuffer()));
        log(`${ts()} POST /mcp ${label} (${Date.now() - reqStart}ms)`);
        return;
      }

      if (pathname === "/mcp") {
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(nodeReq.headers)) {
          if (typeof v === "string") headers[k] = v;
        }

        // GET/DELETE must have a valid session
        const sessionId = headers["mcp-session-id"];
        if (!sessionId) {
          nodeRes.writeHead(400, { "Content-Type": "application/json" });
          nodeRes.end(JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32000, message: "Bad Request: Missing session ID" },
            id: null,
          }));
          return;
        }
        const transport = sessions.get(sessionId);
        if (!transport) {
          nodeRes.writeHead(404, { "Content-Type": "application/json" });
          nodeRes.end(JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32001, message: "Session not found" },
            id: null,
          }));
          return;
        }

        const url = `http://localhost:${port}${pathname}`;
        const rawBody = nodeReq.method !== "GET" && nodeReq.method !== "HEAD" ? await collectBody(nodeReq) : undefined;
        const request = new Request(url, { method: nodeReq.method || "GET", headers, ...(rawBody ? { body: rawBody } : {}) });
        const response = await transport.handleRequest(request);
        nodeRes.writeHead(response.status, Object.fromEntries(response.headers));
        nodeRes.end(Buffer.from(await response.arrayBuffer()));
        return;
      }

      nodeRes.writeHead(404);
      nodeRes.end("Not Found");
    } catch (err) {
      console.error("HTTP handler error:", err);
      nodeRes.writeHead(500);
      nodeRes.end("Internal Server Error");
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.on("error", reject);
    httpServer.listen(port, "localhost", () => resolve());
  });

  const actualPort = (httpServer.address() as import("net").AddressInfo).port;

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    for (const transport of sessions.values()) {
      await transport.close();
    }
    sessions.clear();
    httpServer.close();
    await store.close();
  };

  process.on("SIGTERM", async () => {
    console.error("Shutting down (SIGTERM)...");
    await stop();
    process.exit(0);
  });
  process.on("SIGINT", async () => {
    console.error("Shutting down (SIGINT)...");
    await stop();
    process.exit(0);
  });

  log(`QMD MCP server listening on http://localhost:${actualPort}/mcp`);
  return { httpServer, port: actualPort, stop };
}

// Run if this is the main module
if (fileURLToPath(import.meta.url) === process.argv[1] || process.argv[1]?.endsWith("/server.ts") || process.argv[1]?.endsWith("/server.js")) {
  startMcpServer().catch(console.error);
}
