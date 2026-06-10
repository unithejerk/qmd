/**
 * Tests for the Cohere-compatible reranking adapter
 * (src/remote/adapters/cohere-rerank.ts).
 *
 * Covers: POST /rerank with /v1/rerank and /v2/rerank fallback,
 * score normalization, model override via options,
 * circuit breaker gating with uniform fallback,
 * and graceful degradation on malformed responses.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import * as http from "http";
import type { AddressInfo } from "net";
import { cohereRerankAdapter } from "../../src/remote/adapters/cohere-rerank.js";
import { CircuitBreaker } from "../../src/remote/circuit-breaker.js";
import { silentLogger } from "../../src/remote/log.js";
import type { EndpointConfig } from "../../src/remote/types.js";
import { startMockServer, readBody, jsonRes, testCfg, spyLogger } from "../helpers/http-mock.js";


describe('cohereRerankAdapter', () => {
  function makeCtx(url: string): Parameters<typeof cohereRerankAdapter.rerank>[0] {
    return {
      cfg: { baseUrl: url, model: 'rerank-v3.5', apiKey: 'sk-test', format: 'cohere_v2_rerank' },
      breaker: new CircuitBreaker(),
      log: silentLogger,
      readTimeoutMs: 5000,
    };
  }

  const docs = [
    { file: 'a.md', text: 'first document' },
    { file: 'b.md', text: 'second document' },
  ];

  test('tries /rerank then /v1/rerank when provider only supports v1 path', async () => {
    const requestedPaths: string[] = [];
    const server = startMockServer(async (req, res) => {
      requestedPaths.push(req.url ?? '');
      if (req.url === '/rerank') {
        jsonRes(res, 404, { error: 'not found' });
        return;
      }
      jsonRes(res, 200, {
        results: [{ index: 1, relevance_score: 0.88 }],
      });
    });

    const result = await cohereRerankAdapter.rerank(
      makeCtx(server.url),
      'query',
      docs,
      {},
    );

    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.file).toBe('b.md');
    expect(requestedPaths).toEqual(['/rerank', '/v1/rerank']);
    await server.close();
  });

  test('when baseUrl ends with /rerank, fallback targets sibling /v1/rerank', async () => {
    const requestedPaths: string[] = [];
    const server = startMockServer(async (req, res) => {
      requestedPaths.push(req.url ?? '');
      if (req.url === '/rerank') {
        jsonRes(res, 404, { error: 'not found' });
        return;
      }
      jsonRes(res, 200, {
        results: [{ index: 0, relevance_score: 0.88 }],
      });
    });

    const result = await cohereRerankAdapter.rerank(
      makeCtx(`${server.url}/rerank`),
      'query',
      docs,
      {},
    );

    expect(result.results).toHaveLength(1);
    expect(requestedPaths).toEqual(['/rerank', '/v1/rerank']);
    await server.close();
  });

  test('uses options.model override in request body', async () => {
    let receivedBody: any = null;
    const server = startMockServer(async (_req, res) => {
      receivedBody = await readBody(_req);
      jsonRes(res, 200, {
        results: [{ index: 0, relevance_score: 0.99 }],
      });
    });

    await cohereRerankAdapter.rerank(
      makeCtx(server.url),
      'query',
      docs,
      { model: 'rerank-override' },
    );

    expect(receivedBody.model).toBe('rerank-override');
    await server.close();
  });

  test('returns uniform fallback when API key is missing', async () => {
    const log = spyLogger();
    const ctx = makeCtx('http://localhost:1');
    ctx.cfg.apiKey = '';
    ctx.log = log;

    const result = await cohereRerankAdapter.rerank(ctx, 'query', docs, {});
    expect(result.results.every((r) => r.score === 1.0)).toBe(true);
    expect(log.calls.some((c) => c.msg.includes('no API key'))).toBe(true);
  });

  test('treats malformed 200 response as failure and returns uniform fallback', async () => {
    const log = spyLogger();
    const breaker = new CircuitBreaker(1);
    const server = startMockServer((_req, res) => {
      jsonRes(res, 200, { results: [{ foo: 'bad-shape' }] });
    });

    const ctx = makeCtx(server.url);
    ctx.log = log;
    ctx.breaker = breaker;

    const result = await cohereRerankAdapter.rerank(ctx, 'query', docs, {});
    expect(result.results.every((r) => r.score === 1.0)).toBe(true);
    expect(breaker.getState()).toBe('open');
    expect(log.calls.some((c) => c.level === 'error')).toBe(true);
    await server.close();
  });
});

