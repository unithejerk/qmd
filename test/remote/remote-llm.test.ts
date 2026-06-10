/**
 * Integration tests for the RemoteLLM class (src/remote/remote-llm.ts).
 *
 * Covers: constructor config resolution (explicit per-endpoint → flat legacy →
 * env → defaults), backward-compat flat config mapping to embed,
 * per-endpoint circuit breaker isolation, LLM interface compliance
 * (embed, embedBatch, expandQuery, rerank, generate, modelExists, probe),
 * and dispose (no-op for HTTP).
 */
import { describe, test, expect, vi } from "vitest";
import * as http from "http";
import type { AddressInfo } from "net";
import { RemoteLLM } from "../../src/remote/remote-llm.js";
import { silentLogger } from "../../src/remote/log.js";
import type { EndpointConfig, RemoteLLMConfig } from "../../src/remote/types.js";
import { startMockServer, readBody, jsonRes, mockEmbedding } from "../helpers/http-mock.js";


// =============================================================================
// remote-llm.ts — integration
// =============================================================================

describe('RemoteLLM', () => {
  test('constructs with defaults', () => {
    const llm = new RemoteLLM();
    expect(llm.embedModelName).toBeTruthy();
    expect(llm.generateModelName).toBeTruthy();
    expect(llm.rerankModelName).toBeTruthy();
  });

  test('embed returns vector for single text', async () => {
    const server = startMockServer(async (req, res) => {
      const body = await readBody(req) as { input: string[] };
      jsonRes(res, 200, {
        data: body.input.map((_, i) => ({ embedding: mockEmbedding, index: i })),
      });
    });

    const llm = new RemoteLLM({ embed: { baseUrl: server.url, model: 'm' } }, silentLogger);
    const result = await llm.embed('hello');
    expect(result!.embedding).toEqual(mockEmbedding);
    await llm.dispose();
    await server.close();
  });

  test('expandQuery delegates to expand module', async () => {
    const server = startMockServer((_req, res) => {
      jsonRes(res, 200, {
        choices: [{
          message: { content: 'lex: test kw\nvec: test vec\nhyde: test hyde' },
        }],
      });
    });

    const llm = new RemoteLLM(
      { expand: { baseUrl: server.url, model: 'm', apiKey: 'sk' } },
      silentLogger,
    );
    const result = await llm.expandQuery('test');
    expect(result).toHaveLength(3);
    await llm.dispose();
    await server.close();
  });

  test('rerank delegates to rerank module', async () => {
    const server = startMockServer((_req, res) => {
      jsonRes(res, 200, {
        results: [{ index: 0, relevance_score: 0.99 }],
        model: 'm',
      });
    });

    const llm = new RemoteLLM(
      { rerank: { baseUrl: server.url, model: 'm', apiKey: 'sk' } },
      silentLogger,
    );
    const result = await llm.rerank('q', [{ file: 'a.md', text: 'doc' }]);
    expect(result.results[0]!.score).toBe(0.99);
    await llm.dispose();
    await server.close();
  });

  test('generate delegates to generate module', async () => {
    const server = startMockServer((_req, res) => {
      jsonRes(res, 200, {
        choices: [{ message: { content: 'answer' } }],
        model: 'm',
      });
    });

    const llm = new RemoteLLM(
      { generate: { baseUrl: server.url, model: 'm', apiKey: 'sk' } },
      silentLogger,
    );
    const result = await llm.generate('prompt');
    expect(result!.text).toBe('answer');
    await llm.dispose();
    await server.close();
  });

  test('probe calls embed and returns dimensions', async () => {
    const server = startMockServer((_req, res) => {
      jsonRes(res, 200, {
        data: [{ embedding: [1, 2, 3], index: 0 }],
      });
    });

    const llm = new RemoteLLM({ embed: { baseUrl: server.url, model: 'm' } }, silentLogger);
    const result = await llm.probe();
    expect(result.ok).toBe(true);
    expect(result.dimensions).toBe(3);
    await llm.dispose();
    await server.close();
  });

  test('modelExists delegates to probe module', async () => {
    const server = startMockServer((_req, res) => {
      jsonRes(res, 200, { data: [{ id: 'test-model' }] });
    });

    const llm = new RemoteLLM({ embed: { baseUrl: `${server.url}/v1`, model: 'm' } }, silentLogger);
    const result = await llm.modelExists('test-model');
    expect(result.exists).toBe(true);
    await llm.dispose();
    await server.close();
  });

  test('dispose is a no-op (does not throw)', async () => {
    const llm = new RemoteLLM({}, silentLogger);
    await expect(llm.dispose()).resolves.toBeUndefined();
  });

  test('backward-compat flat config maps to embed', () => {
    const llm = new RemoteLLM({
      baseUrl: 'http://old:8000/v1',
      embedModel: 'old-model',
      apiKey: 'sk-old',
    }, silentLogger);
    expect(llm.embedCfg.baseUrl).toBe('http://old:8000/v1');
    expect(llm.embedModelName).toBe('old-model');
  });
});

// =============================================================================
// Shared normalization helpers
// =============================================================================

