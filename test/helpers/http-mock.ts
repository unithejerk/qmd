/**
 * Test helper — mock HTTP server for remote adapter tests.
 */
import * as http from "http";
import type { AddressInfo } from "net";
import type { Logger } from "../src/remote/log.js";
import type { EndpointConfig } from "../src/remote/types.js";

/** Start a mock HTTP server on a random port. */
export function startMockServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): { url: string; close: () => Promise<void> } {
  const server = http.createServer(handler);
  server.listen(0);
  const addr = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((err) => err ? reject(err) : resolve());
    }),
  };
}

/** Read full request body as JSON. */
export function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8")));
    });
  });
}

/** Write JSON response. */
export function jsonRes(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

/** Standard mock embedding — returns 3-dimensional vectors. */
export const mockEmbedding = [0.1, 0.2, 0.3];

/** Test endpoint config pointing to localhost. */
export function testCfg(url: string, model = "test-model", apiKey?: string): EndpointConfig {
  return { baseUrl: url, model, apiKey };
}

/** Create a spy logger that records all calls. */
export function spyLogger(): Logger & { calls: Array<{ level: string; msg: string }> } {
  const calls: Array<{ level: string; msg: string }> = [];
  return {
    debug: (msg) => { calls.push({ level: "debug", msg }); },
    info: (msg) => { calls.push({ level: "info", msg }); },
    warn: (msg) => { calls.push({ level: "warn", msg }); },
    error: (msg) => { calls.push({ level: "error", msg }); },
    calls,
  };
}
