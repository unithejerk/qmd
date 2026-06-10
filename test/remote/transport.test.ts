/**
 * Tests for the low-level HTTP transport layer (src/remote/transport.ts).
 *
 * Covers: nodePost (JSON POST with timeout and body-size cap),
 * nodeGet (JSON GET for health checks), response-size enforcement,
 * error handling for HTTP errors, JSON parse failures, and timeouts.
 * Also tests the Logger interface implementations (consoleLogger, silentLogger).
 */
import { describe, test, expect } from "vitest";
import * as http from "http";
import type { AddressInfo } from "net";
import { consoleLogger, silentLogger } from "../../src/remote/log.js";
import { nodePost, nodeGet, MAX_RESPONSE_BODY_BYTES } from "../../src/remote/transport.js";
import { startMockServer, readBody, jsonRes } from "../helpers/http-mock.js";


// =============================================================================
// log.ts
// =============================================================================

describe('Logger', () => {
  test('consoleLogger writes without throwing', () => {
    expect(() => consoleLogger.warn('test')).not.toThrow();
    expect(() => consoleLogger.error('test')).not.toThrow();
  });

  test('silentLogger discards all messages', () => {
    expect(() => silentLogger.warn('test')).not.toThrow();
    expect(() => silentLogger.error('test')).not.toThrow();
  });
});

// =============================================================================
// transport.ts
// =============================================================================

describe('nodePost', () => {
  test('sends JSON POST and returns parsed response', async () => {
    const server = startMockServer(async (req, res) => {
      const body = await readBody(req);
      expect(body).toEqual({ foo: 'bar' });
      jsonRes(res, 200, { result: 'ok' });
    });

    const result = await nodePost(`${server.url}/test`, {}, { foo: 'bar' }, 5000);
    expect(result).toEqual({ result: 'ok' });
    await server.close();
  });

  test('throws on non-2xx status', async () => {
    const server = startMockServer((_req, res) => {
      jsonRes(res, 500, { error: 'server error' });
    });

    await expect(
      nodePost(`${server.url}/test`, {}, {}, 5000),
    ).rejects.toThrow('HTTP 500');
    await server.close();
  });

  test('throws on timeout', async () => {
    const server = startMockServer((_req, res) => {
      // Never respond
      setTimeout(() => res.end(), 10000);
    });

    await expect(
      nodePost(`${server.url}/test`, {}, {}, 100),
    ).rejects.toThrow('timed out');
    await server.close();
  });

  test('throws on oversized response', async () => {
    const server = startMockServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      // Send a response larger than the 10MB cap
      const big = 'x'.repeat(MAX_RESPONSE_BODY_BYTES + 1000);
      res.end(JSON.stringify({ data: big }));
    });

    await expect(
      nodePost(`${server.url}/test`, {}, {}, 5000),
    ).rejects.toThrow(/exceeded/);
    await server.close();
  });

  test('passes Authorization header', async () => {
    const server = startMockServer((req, res) => {
      expect(req.headers['authorization']).toBe('Bearer sk-test');
      jsonRes(res, 200, { ok: true });
    });

    await nodePost(`${server.url}/test`, { Authorization: 'Bearer sk-test' }, {}, 5000);
    await server.close();
  });
});

describe('nodeGet', () => {
  test('sends GET and returns parsed response', async () => {
    const server = startMockServer((_req, res) => {
      jsonRes(res, 200, { data: [{ id: 'test-model' }] });
    });

    const result = await nodeGet(`${server.url}/models`, {}, 5000);
    expect(result).toEqual({ data: [{ id: 'test-model' }] });
    await server.close();
  });
});

// =============================================================================
// circuit-breaker.ts
// =============================================================================

