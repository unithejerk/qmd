/**
 * MCP HTTP transport -- Streamable HTTP server with session management.
 *
 * Re-exports from server.ts to avoid code duplication.
 *
 * @deprecated Import directly from "../server.js" instead.
 */
export {
  type HttpServerHandle,
  type McpStartupOptions,
  startMcpHttpServer,
} from "../server.js";
