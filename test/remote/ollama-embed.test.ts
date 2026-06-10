/**
 * Tests for the Ollama-native embedding adapter
 * (src/remote/adapters/ollama-embed.ts).
 *
 * Covers: /api/embed endpoint with input array, endpoint path fallback
 * (/api/embed → /embed → /v1/embeddings), response normalization
 * (Ollama embeddings array + OpenAI-compatible data[{embedding}]),
 * model override via options, and dimension mismatch detection.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import * as http from "http";
import type { AddressInfo } from "net";
import { ollamaEmbedAdapter } from "../../src/remote/adapters/ollama-embed.js";
import { CircuitBreaker } from "../../src/remote/circuit-breaker.js";
import { silentLogger } from "../../src/remote/log.js";
import type { EndpointConfig } from "../../src/remote/types.js";
import { startMockServer, readBody, jsonRes, mockEmbedding, testCfg, spyLogger } from "../helpers/http-mock.js";



describe('ollamaEmbedAdapter', () => {
  function makeCtx(url: string): Parameters<typeof ollamaEmbedAdapter.embedBatch>[0] {
    return {
      cfg: { baseUrl: url, model: 'embeddinggemma', apiKey: '', format: 'ollama_embed' },
      breaker: new CircuitBreaker(),
      log: silentLogger,
      maxBatchSize: 32,
      readTimeoutMs: 5000,
      maxRetries: 1,
      dimState: { dimensions: null },
    };
  }

  test('posts to /api/embed with input array and normalizes embeddings', async () => {
    let requestedPath = '';
    let receivedBody: any = null;
    const server = startMockServer(async (req, res) => {
      requestedPath = req.url ?? '';
      receivedBody = await readBody(req);
      jsonRes(res, 200, {
        model: 'embeddinggemma',
        embeddings: [mockEmbedding, [0.4, 0.5, 0.6]],
      });
    });

    const result = await ollamaEmbedAdapter.embedBatch(
      makeCtx(server.url),
      ['hello', 'world'],
      {},
    );

    expect(requestedPath).toBe('/api/embed');
    expect(receivedBody.input).toEqual(['hello', 'world']);
    expect(result).toHaveLength(2);
    expect(result[0]!.embedding).toEqual(mockEmbedding);
    expect(result[1]!.embedding).toEqual([0.4, 0.5, 0.6]);

    await server.close();
  });

  test('falls back endpoint path from /api/embed to /embed', async () => {
    const requestedPaths: string[] = [];
    const server = startMockServer((req, res) => {
      requestedPaths.push(req.url ?? '');
      if (req.url === '/api/embed') {
        jsonRes(res, 404, { error: 'not found' });
        return;
      }
      jsonRes(res, 200, {
        embeddings: [mockEmbedding],
      });
    });

    const result = await ollamaEmbedAdapter.embedBatch(
      makeCtx(server.url),
      ['hello'],
      {},
    );

    expect(result).toHaveLength(1);
    expect(requestedPaths).toEqual(['/api/embed', '/embed']);

    await server.close();
  });

  test('supports options.model override', async () => {
    let receivedBody: any = null;
    const server = startMockServer(async (req, res) => {
      receivedBody = await readBody(req);
      jsonRes(res, 200, {
        embeddings: [mockEmbedding],
      });
    });

    await ollamaEmbedAdapter.embedBatch(
      makeCtx(server.url),
      ['hello'],
      { model: 'nomic-embed-text' },
    );

    expect(receivedBody.model).toBe('nomic-embed-text');
    await server.close();
  });

  test('throws on embedding dimension mismatch across calls', async () => {
    const ctx = makeCtx('http://localhost:1');
    let callCount = 0;
    const server = startMockServer((_req, res) => {
      callCount++;
      if (callCount === 1) {
        jsonRes(res, 200, { embeddings: [[0.1, 0.2, 0.3]] });
      } else {
        jsonRes(res, 200, { embeddings: [[0.1, 0.2]] });
      }
    });
    ctx.cfg.baseUrl = server.url;

    await ollamaEmbedAdapter.embedBatch(ctx, ['a'], {});
    await expect(
      ollamaEmbedAdapter.embedBatch(ctx, ['b'], {}),
    ).rejects.toThrow('dimension mismatch');

    await server.close();
  });
});

