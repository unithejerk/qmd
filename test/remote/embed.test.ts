/**
 * Tests for the remote embedding pipeline (src/remote/embed.ts).
 *
 * Covers: embedBatch with batch splitting, retry with exponential backoff,
 * dimension validation (locks on first response, rejects mismatches),
 * model override via EmbedOptions, circuit breaker gating,
 * graceful degradation (returns nulls per-text after retries exhausted),
 * and response ordering preservation via index field.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import * as http from "http";
import type { AddressInfo } from "net";
import { embedBatch } from "../../src/remote/embed.js";
import { CircuitBreaker } from "../../src/remote/circuit-breaker.js";
import { silentLogger } from "../../src/remote/log.js";
import type { EndpointConfig } from "../../src/remote/types.js";
import { startMockServer, readBody, jsonRes, mockEmbedding, testCfg, spyLogger } from "../helpers/http-mock.js";


// =============================================================================
// embed.ts
// =============================================================================

describe('embedBatch', () => {
  const dimState = { dimensions: null as number | null };

  beforeEach(() => {
    dimState.dimensions = null;
  });

  test('returns embeddings for a batch of texts', async () => {
    const server = startMockServer(async (req, res) => {
      const body = await readBody(req) as { input: string[] };
      jsonRes(res, 200, {
        data: body.input.map((_, i) => ({ embedding: mockEmbedding, index: i })),
      });
    });

    const cfg = testCfg(server.url);
    const breaker = new CircuitBreaker();
    const results = await embedBatch(cfg, breaker, ['hello', 'world'], 10, 5000, dimState, 1, silentLogger);

    expect(results).toHaveLength(2);
    expect(results[0]!.embedding).toEqual(mockEmbedding);
    expect(results[0]!.model).toBe('test-model');
    expect(results[1]!.embedding).toEqual(mockEmbedding);
    expect(dimState.dimensions).toBe(3);
    await server.close();
  });

  test('sets dimension on first response and validates subsequent', async () => {
    let callCount = 0;
    const server = startMockServer((_req, res) => {
      callCount++;
      // Second call returns different dimensions
      const dim = callCount === 1 ? 3 : 5;
      jsonRes(res, 200, {
        data: [{ embedding: new Array(dim).fill(0.1), index: 0 }],
      });
    });

    const cfg = testCfg(server.url);
    const breaker = new CircuitBreaker();
    const ds = { dimensions: null as number | null };

    // First batch: sets dimension to 3
    await embedBatch(cfg, breaker, ['a'], 10, 5000, ds, 1, silentLogger);
    expect(ds.dimensions).toBe(3);

    // Second batch: dimension mismatch → should throw
    await expect(
      embedBatch(cfg, breaker, ['b'], 10, 5000, ds, 1, silentLogger),
    ).rejects.toThrow('dimension mismatch');
    await server.close();
  });

  test('returns empty array for empty input', async () => {
    const ds = { dimensions: null as number | null };
    const results = await embedBatch(
      testCfg('http://localhost:1'), new CircuitBreaker(), [], 10, 5000, ds, 1, silentLogger,
    );
    expect(results).toEqual([]);
  });

  test('circuit breaker open throws immediately', async () => {
    const breaker = new CircuitBreaker(1);
    breaker.onFailure(); // open
    const ds = { dimensions: null as number | null };

    await expect(
      embedBatch(testCfg('http://localhost:1'), breaker, ['text'], 10, 5000, ds, 1, silentLogger),
    ).rejects.toThrow(/circuit breaker is open/);
  });

  test('retries on failure and logs warnings', async () => {
    const log = spyLogger();
    let attempts = 0;
    const server = startMockServer((_req, res) => {
      attempts++;
      if (attempts < 2) {
        res.writeHead(503);
        res.end('unavailable');
      } else {
        jsonRes(res, 200, {
          data: [{ embedding: mockEmbedding, index: 0 }],
        });
      }
    });

    const cfg = testCfg(server.url);
    const breaker = new CircuitBreaker();
    const ds = { dimensions: null as number | null };
    const results = await embedBatch(cfg, breaker, ['retry-me'], 10, 5000, ds, 2, log);

    expect(attempts).toBe(2);
    expect(results).toHaveLength(1);
    expect(results[0]!.embedding).toEqual(mockEmbedding);
    expect(log.calls.filter((c) => c.level === 'warn')).toHaveLength(1);
    expect(log.calls[0]!.msg).toContain('retrying');
    await server.close();
  });

  test('returns nulls after all retries exhausted', async () => {
    const log = spyLogger();
    const server = startMockServer((_req, res) => {
      res.writeHead(500);
      res.end('fail');
    });

    const cfg = testCfg(server.url);
    const breaker = new CircuitBreaker();
    const ds = { dimensions: null as number | null };
    const results = await embedBatch(cfg, breaker, ['a', 'b'], 10, 5000, ds, 2, log);

    expect(results).toEqual([null, null]);
    expect(log.calls.filter((c) => c.level === 'error')).toHaveLength(1);
    await server.close();
  });

  test('splits large input into batches', async () => {
    const batchSizes: number[] = [];
    const server = startMockServer(async (req, res) => {
      const body = await readBody(req) as { input: string[] };
      batchSizes.push(body.input.length);
      jsonRes(res, 200, {
        data: body.input.map((_, i) => ({ embedding: mockEmbedding, index: i })),
      });
    });

    const cfg = testCfg(server.url);
    const breaker = new CircuitBreaker();
    const ds = { dimensions: null as number | null };
    const texts = ['a', 'b', 'c', 'd', 'e']; // 5 texts, batch size 2 → 3 batches
    const results = await embedBatch(cfg, breaker, texts, 2, 5000, ds, 1, silentLogger);

    expect(results).toHaveLength(5);
    expect(batchSizes).toEqual([2, 2, 1]);
    await server.close();
  });

  test('modelOverride via options', async () => {
    let receivedModel = '';
    const server = startMockServer(async (req, res) => {
      const body = await readBody(req) as { model: string; input: string[] };
      receivedModel = body.model;
      jsonRes(res, 200, {
        data: [{ embedding: mockEmbedding, index: 0 }],
      });
    });

    const cfg = testCfg(server.url);
    const breaker = new CircuitBreaker();
    const ds = { dimensions: null as number | null };
    await embedBatch(cfg, breaker, ['x'], 10, 5000, ds, 1, silentLogger, { model: 'override-model' });

    expect(receivedModel).toBe('override-model');
    await server.close();
  });
});

// =============================================================================
// expand.ts
// =============================================================================

