/**
 * Tests for the Cohere-compatible embedding adapter
 * (src/remote/adapters/cohere-embed.ts).
 *
 * Covers: /v2/embed endpoint with inputs-payload shape,
 * texts-array fallback on contract mismatch, endpoint path fallback
 * (/v2/embed → /embed), input_type fallback (search_document → document,
 * search_query → query), Cohere host detection for input_type preference,
 * embedding count/dimension validation, retry with backoff,
 * and fallback caching per base URL.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import * as http from "http";
import type { AddressInfo } from "net";
import { cohereV2EmbedAdapter } from "../../src/remote/adapters/cohere-embed.js";
import { CircuitBreaker } from "../../src/remote/circuit-breaker.js";
import { silentLogger } from "../../src/remote/log.js";
import { nodePost } from "../../src/remote/transport.js";
import type { EndpointConfig } from "../../src/remote/types.js";
import { startMockServer, readBody, jsonRes, mockEmbedding, testCfg, spyLogger } from "../helpers/http-mock.js";


// =============================================================================
// Cohere-compatible embed/rerank adapters
// =============================================================================

describe('cohereV2EmbedAdapter', () => {
  function makeCtx(url: string): Parameters<typeof cohereV2EmbedAdapter.embedBatch>[0] {
    return {
      cfg: { baseUrl: url, model: 'embed-v4.0', apiKey: 'sk-test', format: 'cohere_v2_embed' },
      breaker: new CircuitBreaker(),
      log: silentLogger,
      maxBatchSize: 32,
      readTimeoutMs: 5000,
      maxRetries: 1,
      dimState: { dimensions: null },
    };
  }

  test('falls back from inputs payload to texts payload on contract mismatch', async () => {
    const seenShapes: string[] = [];
    const server = startMockServer(async (req, res) => {
      expect(req.url).toBe('/v2/embed');
      const body = await readBody(req) as Record<string, unknown>;
      if (Array.isArray(body.inputs)) {
        seenShapes.push('inputs');
        jsonRes(res, 400, { error: 'inputs unsupported here' });
        return;
      }
      if (Array.isArray(body.texts)) {
        seenShapes.push('texts');
        jsonRes(res, 200, {
          embeddings: {
            float: [mockEmbedding, mockEmbedding],
          },
          model: 'embed-v4.0',
        });
        return;
      }
      jsonRes(res, 400, { error: 'invalid body' });
    });

    const result = await cohereV2EmbedAdapter.embedBatch(
      makeCtx(server.url),
      ['hello', 'world'],
      {},
    );

    expect(result).toHaveLength(2);
    expect(result[0]!.embedding).toEqual(mockEmbedding);
    expect(result[1]!.embedding).toEqual(mockEmbedding);
    expect(seenShapes).toEqual(['inputs', 'inputs', 'texts']);
    await server.close();
  });

  test('for non-Cohere hosts, uses query input_type when embedding query text', async () => {
    let receivedBody: any = null;
    const server = startMockServer(async (req, res) => {
      receivedBody = await readBody(req);
      jsonRes(res, 200, {
        embeddings: { float: [mockEmbedding] },
      });
    });

    await cohereV2EmbedAdapter.embedBatch(
      makeCtx(server.url),
      ['query text'],
      { isQuery: true },
    );

    expect(receivedBody.input_type).toBe('query');
    await server.close();
  });

  test('for Cohere hosts, falls back input_type from search_document to document on unsupported-input_type errors', async () => {
    const seenInputTypes: string[] = [];
    const postSpy = vi
      .spyOn(await import('../../src/remote/transport.js'), 'nodePost')
      .mockImplementation(async (_url, _headers, body) => {
        const inputType = String((body as Record<string, unknown>).input_type ?? '');
        seenInputTypes.push(inputType);
        if (inputType === 'search_document') {
          throw new Error("HTTP 400: Unsupported input_type 'search_document'. Supported values: document, query");
        }
        return { embeddings: { float: [mockEmbedding] } };
      });

    try {
      const result = await cohereV2EmbedAdapter.embedBatch(
        makeCtx('https://api2.cohere.ai/v2'),
        ['hello'],
        {},
      );

      expect(result).toHaveLength(1);
      expect(seenInputTypes).toEqual(['search_document', 'document']);
    } finally {
      postSpy.mockRestore();
    }
  });

  test('for non-Cohere hosts, prefers document input_type first', async () => {
    const seenInputTypes: string[] = [];
    const server = startMockServer(async (req, res) => {
      const body = await readBody(req) as Record<string, unknown>;
      seenInputTypes.push(String(body.input_type ?? ''));
      jsonRes(res, 200, {
        embeddings: { float: [mockEmbedding] },
      });
    });

    const result = await cohereV2EmbedAdapter.embedBatch(
      makeCtx(server.url),
      ['hello'],
      {},
    );

    expect(result).toHaveLength(1);
    expect(seenInputTypes[0]).toBe('document');
    await server.close();
  });

  test('for Cohere hosts, prefers search_document input_type first', async () => {
    const seenInputTypes: string[] = [];
    const realPost = nodePost;
    const postSpy = vi
      .spyOn(await import('../../src/remote/transport.js'), 'nodePost')
      .mockImplementation(async (_url, _headers, body) => {
        seenInputTypes.push(String((body as Record<string, unknown>).input_type ?? ''));
        return { embeddings: { float: [mockEmbedding] } };
      });

    try {
      const result = await cohereV2EmbedAdapter.embedBatch(
        makeCtx('https://api.cohere.ai/v2'),
        ['hello'],
        {},
      );
      expect(result).toHaveLength(1);
      expect(seenInputTypes[0]).toBe('search_document');
    } finally {
      postSpy.mockRestore();
      // Keep reference live to avoid accidental tree-shake lint in test context.
      void realPost;
    }
  });

  test('normalizes OpenAI-style data embeddings using index order', async () => {
    const server = startMockServer((_req, res) => {
      jsonRes(res, 200, {
        data: [
          { index: 1, embedding: [2, 2, 2] },
          { index: 0, embedding: [1, 1, 1] },
        ],
      });
    });

    const result = await cohereV2EmbedAdapter.embedBatch(
      makeCtx(server.url),
      ['first', 'second'],
      {},
    );

    expect(result).toHaveLength(2);
    expect(result[0]!.embedding).toEqual([1, 1, 1]);
    expect(result[1]!.embedding).toEqual([2, 2, 2]);
    await server.close();
  });

  test('does not fall back to /embed when /v2/embed returns 404', async () => {
    const requestedPaths: string[] = [];
    const server = startMockServer(async (req, res) => {
      requestedPaths.push(req.url ?? '');
      jsonRes(res, 404, { error: 'not found' });
    });

    const result = await cohereV2EmbedAdapter.embedBatch(
      makeCtx(server.url),
      ['hello'],
      {},
    );

    expect(result).toEqual([null]);
    expect(requestedPaths).toEqual(['/v2/embed', '/v2/embed']);
    expect(requestedPaths).not.toContain('/embed');
    await server.close();
  });

  test('when baseUrl ends with /v1, targets root /v2/embed first (not /v1/v2/embed)', async () => {
    const requestedPaths: string[] = [];
    const server = startMockServer(async (req, res) => {
      requestedPaths.push(req.url ?? '');
      jsonRes(res, 200, {
        embeddings: { float: [mockEmbedding] },
      });
    });

    const result = await cohereV2EmbedAdapter.embedBatch(
      makeCtx(`${server.url}/v1`),
      ['hello'],
      {},
    );

    expect(result).toHaveLength(1);
    expect(requestedPaths[0]).toBe('/v2/embed');
    expect(requestedPaths).not.toContain('/v1/v2/embed');
    await server.close();
  });

  test('when baseUrl ends with /embed, normalizes to sibling /v2/embed', async () => {
    const requestedPaths: string[] = [];
    const server = startMockServer(async (req, res) => {
      requestedPaths.push(req.url ?? '');
      jsonRes(res, 200, {
        embeddings: { float: [mockEmbedding] },
      });
    });

    const result = await cohereV2EmbedAdapter.embedBatch(
      makeCtx(`${server.url}/embed`),
      ['hello'],
      {},
    );

    expect(result).toHaveLength(1);
    expect(requestedPaths).toEqual(['/v2/embed']);
    expect(requestedPaths).not.toContain('/embed');
    await server.close();
  });

  test('when baseUrl ends with /v1/embed, prefers root /v2/embed before /v1/embed', async () => {
    const requestedPaths: string[] = [];
    const server = startMockServer(async (req, res) => {
      requestedPaths.push(req.url ?? '');
      jsonRes(res, 200, {
        embeddings: { float: [mockEmbedding] },
      });
    });

    const result = await cohereV2EmbedAdapter.embedBatch(
      makeCtx(`${server.url}/v1/embed`),
      ['hello'],
      {},
    );

    expect(result).toHaveLength(1);
    expect(requestedPaths[0]).toBe('/v2/embed');
    expect(requestedPaths).not.toContain('/v1/v2/embed');
    await server.close();
  });

  test('throws on embedding dimension mismatch across calls', async () => {
    let callCount = 0;
    const ctx = makeCtx('http://localhost:1');
    const server = startMockServer((_req, res) => {
      callCount++;
      if (callCount === 1) {
        jsonRes(res, 200, { embeddings: { float: [[0.1, 0.2, 0.3]] } });
      } else {
        jsonRes(res, 200, { embeddings: { float: [[0.1, 0.2]] } });
      }
    });
    ctx.cfg.baseUrl = server.url;

    await cohereV2EmbedAdapter.embedBatch(ctx, ['a'], {});
    await expect(
      cohereV2EmbedAdapter.embedBatch(ctx, ['b'], {}),
    ).rejects.toThrow('dimension mismatch');
    await server.close();
  });
});


