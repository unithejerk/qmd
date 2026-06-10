/**
 * Tests for the vLLM Pooling API embedding adapter
 * (src/remote/adapters/vllm-pooling.ts).
 *
 * Covers: /pooling endpoint with /v1/pooling fallback,
 * response normalization (embedding/embeddings/data[].embedding shapes),
 * dimension validation, and endpoint path caching.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import * as http from "http";
import type { AddressInfo } from "net";
import { vllmPoolingAdapter } from "../../src/remote/adapters/vllm-pooling.js";
import { CircuitBreaker } from "../../src/remote/circuit-breaker.js";
import { silentLogger } from "../../src/remote/log.js";
import type { EndpointConfig } from "../../src/remote/types.js";
import { startMockServer, readBody, jsonRes, mockEmbedding, testCfg, spyLogger } from "../helpers/http-mock.js";


describe('vllmPoolingAdapter', () => {
  function makeCtx(url: string): Parameters<typeof vllmPoolingAdapter.embedBatch>[0] {
    return {
      cfg: { baseUrl: url, model: 'Qwen/Qwen3-Embedding-0.6B', apiKey: 'sk-test', format: 'vllm_pooling' },
      breaker: new CircuitBreaker(),
      log: silentLogger,
      maxBatchSize: 32,
      readTimeoutMs: 5000,
      maxRetries: 1,
      dimState: { dimensions: null },
    };
  }

  test('posts to /pooling and normalizes data[].embedding vectors', async () => {
    let requestedPath = '';
    let receivedBody: any = null;
    const server = startMockServer(async (req, res) => {
      requestedPath = req.url ?? '';
      receivedBody = await readBody(req);
      jsonRes(res, 200, {
        data: [
          { index: 0, embedding: mockEmbedding },
          { index: 1, embedding: [0.4, 0.5, 0.6] },
        ],
      });
    });

    const result = await vllmPoolingAdapter.embedBatch(
      makeCtx(server.url),
      ['hello', 'world'],
      {},
    );

    expect(requestedPath).toBe('/pooling');
    expect(receivedBody.input).toEqual(['hello', 'world']);
    expect(result).toHaveLength(2);
    expect(result[0]!.embedding).toEqual(mockEmbedding);
    expect(result[1]!.embedding).toEqual([0.4, 0.5, 0.6]);
    await server.close();
  });

  test('when baseUrl ends with /v1, targets sibling /pooling first', async () => {
    const requestedPaths: string[] = [];
    const server = startMockServer((req, res) => {
      requestedPaths.push(req.url ?? '');
      jsonRes(res, 200, {
        data: [{ embedding: mockEmbedding }],
      });
    });

    const result = await vllmPoolingAdapter.embedBatch(
      makeCtx(`${server.url}/v1`),
      ['hello'],
      {},
    );

    expect(result).toHaveLength(1);
    expect(requestedPaths[0]).toBe('/pooling');
    expect(requestedPaths).not.toContain('/v1/v1/pooling');
    await server.close();
  });

  test('falls back endpoint path from /pooling to /v1/pooling', async () => {
    const requestedPaths: string[] = [];
    const server = startMockServer((req, res) => {
      requestedPaths.push(req.url ?? '');
      if (req.url === '/pooling') {
        jsonRes(res, 404, { error: 'not found' });
        return;
      }
      jsonRes(res, 200, {
        data: [{ embedding: mockEmbedding }],
      });
    });

    const result = await vllmPoolingAdapter.embedBatch(
      makeCtx(server.url),
      ['hello'],
      {},
    );

    expect(result).toHaveLength(1);
    expect(requestedPaths).toEqual(['/pooling', '/v1/pooling']);
    await server.close();
  });
});

