/**
 * Tests for the vLLM Score API reranking adapter
 * (src/remote/adapters/vllm-score.ts).
 *
 * Covers: /score endpoint with /v1/score fallback,
 * response normalization (data[].score mapping),
 * endpoint path caching, circuit breaker gating with uniform scores,
 * and empty-document handling.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import * as http from "http";
import type { AddressInfo } from "net";
import { vllmScoreAdapter } from "../../src/remote/adapters/vllm-score.js";
import { CircuitBreaker } from "../../src/remote/circuit-breaker.js";
import { silentLogger } from "../../src/remote/log.js";
import type { EndpointConfig } from "../../src/remote/types.js";
import { startMockServer, readBody, jsonRes, testCfg, spyLogger } from "../helpers/http-mock.js";


describe('vllmScoreAdapter', () => {
  function makeCtx(url: string): Parameters<typeof vllmScoreAdapter.rerank>[0] {
    return {
      cfg: { baseUrl: url, model: 'BAAI/bge-reranker-v2-m3', apiKey: '', format: 'vllm_score' },
      breaker: new CircuitBreaker(),
      log: silentLogger,
      readTimeoutMs: 5000,
    };
  }

  const docs = [
    { file: 'a.md', text: 'first document' },
    { file: 'b.md', text: 'second document' },
  ];

  test('posts to /score and normalizes data[] scores', async () => {
    let requestedPath = '';
    let receivedBody: any = null;
    const server = startMockServer(async (req, res) => {
      requestedPath = req.url ?? '';
      receivedBody = await readBody(req);
      jsonRes(res, 200, {
        model: 'BAAI/bge-reranker-v2-m3',
        data: [
          { index: 0, score: 0.22 },
          { index: 1, score: 0.91 },
        ],
      });
    });

    const result = await vllmScoreAdapter.rerank(
      makeCtx(server.url),
      'query',
      docs,
      {},
    );

    expect(requestedPath).toBe('/score');
    expect(receivedBody.queries).toBe('query');
    expect(receivedBody.documents).toEqual(['first document', 'second document']);
    expect(result.results[0]!.file).toBe('b.md');
    expect(result.results[0]!.score).toBe(0.91);
    await server.close();
  });

  test('falls back endpoint path from /score to /v1/score', async () => {
    const requestedPaths: string[] = [];
    const server = startMockServer((_req, res) => {
      requestedPaths.push(_req.url ?? '');
      if (_req.url === '/score') {
        jsonRes(res, 404, { error: 'not found' });
        return;
      }
      jsonRes(res, 200, {
        data: [{ index: 0, score: 0.77 }],
      });
    });

    const result = await vllmScoreAdapter.rerank(
      makeCtx(server.url),
      'query',
      docs,
      {},
    );

    expect(result.results[0]!.score).toBe(0.77);
    expect(requestedPaths).toEqual(['/score', '/v1/score']);
    await server.close();
  });

  test('returns uniform fallback when score response is malformed', async () => {
    const breaker = new CircuitBreaker(1);
    const log = spyLogger();
    const server = startMockServer((_req, res) => {
      jsonRes(res, 200, { data: [{ foo: 'bad-shape' }] });
    });
    const ctx = makeCtx(server.url);
    ctx.breaker = breaker;
    ctx.log = log;

    const result = await vllmScoreAdapter.rerank(ctx, 'query', docs, {});
    expect(result.results.every((r) => r.score === 1.0)).toBe(true);
    expect(breaker.getState()).toBe('open');
    expect(log.calls.some((c) => c.level === 'error')).toBe(true);
    await server.close();
  });
});

// =============================================================================
// openai_chat_completions adapter: expand + generate
// =============================================================================

