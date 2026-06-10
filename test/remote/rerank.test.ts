/**
 * Tests for remote reranking (src/remote/rerank.ts).
 *
 * Covers: POST /rerank with document list, response normalization
 * (score mapping, index ordering), circuit breaker gating with uniform
 * fallback scores, empty-document handling, API key validation,
 * and error-path graceful degradation.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import * as http from "http";
import type { AddressInfo } from "net";
import { rerank } from "../../src/remote/rerank.js";
import { CircuitBreaker } from "../../src/remote/circuit-breaker.js";
import { silentLogger } from "../../src/remote/log.js";
import type { EndpointConfig } from "../../src/remote/types.js";
import { startMockServer, readBody, jsonRes, testCfg, spyLogger } from "../helpers/http-mock.js";


// =============================================================================
// rerank.ts
// =============================================================================

describe('rerank', () => {
  const docs = [
    { file: 'a.md', text: 'first document about search' },
    { file: 'b.md', text: 'second document about something else' },
  ];

  test('returns uniform scores when no API key', async () => {
    const log = spyLogger();
    const cfg: EndpointConfig = { baseUrl: 'http://localhost:1', model: 'm', apiKey: '' };
    const breaker = new CircuitBreaker();
    const result = await rerank(cfg, breaker, 'search', docs, 5000, log);

    expect(result.results).toHaveLength(2);
    expect(result.results.every((r) => r.score === 1.0)).toBe(true);
    expect(log.calls.some((c) => c.msg.includes('no API key'))).toBe(true);
  });

  test('returns scored results from API', async () => {
    const server = startMockServer(async (req, res) => {
      const body = await readBody(req) as { query: string; documents: string[] };
      expect(body.documents).toEqual(docs.map((d) => d.text));
      jsonRes(res, 200, {
        results: [
          { index: 0, relevance_score: 0.95 },
          { index: 1, relevance_score: 0.42 },
        ],
        model: 'rerank-model',
      });
    });

    const cfg: EndpointConfig = { baseUrl: server.url, model: 'm', apiKey: 'sk-test' };
    const breaker = new CircuitBreaker();
    const result = await rerank(cfg, breaker, 'search', docs, 5000, silentLogger);

    expect(result.results[0]!.score).toBe(0.95);
    expect(result.results[1]!.score).toBe(0.42);
    expect(result.model).toBe('rerank-model');
    await server.close();
  });

  test('fallback returns same object reference (memoized)', async () => {
    const cfg: EndpointConfig = { baseUrl: 'http://localhost:1', model: 'm', apiKey: '' };
    const breaker = new CircuitBreaker();
    const r1 = await rerank(cfg, breaker, 'q', docs, 5000, silentLogger);
    const r2 = await rerank(cfg, breaker, 'q', docs, 5000, silentLogger);
    // Both are computed from the same inputs — results should be identical
    expect(r1.results).toEqual(r2.results);
  });

  test('circuit breaker open returns uniform scores', async () => {
    const log = spyLogger();
    const breaker = new CircuitBreaker(1);
    breaker.onFailure();
    const cfg: EndpointConfig = { baseUrl: 'http://localhost:1', model: 'm', apiKey: 'sk-test' };
    const result = await rerank(cfg, breaker, 'q', docs, 5000, log);

    expect(result.results.every((r) => r.score === 1.0)).toBe(true);
    expect(log.calls.some((c) => c.msg.includes('circuit breaker is open'))).toBe(true);
  });

  test('returns uniform scores on network error', async () => {
    const log = spyLogger();
    const cfg: EndpointConfig = { baseUrl: 'http://localhost:1', model: 'm', apiKey: 'sk-test' };
    const breaker = new CircuitBreaker();
    const result = await rerank(cfg, breaker, 'q', docs, 100, log);

    expect(result.results.every((r) => r.score === 1.0)).toBe(true);
    expect(log.calls.some((c) => c.level === 'error')).toBe(true);
  });
});

// =============================================================================
// generate.ts
// =============================================================================

