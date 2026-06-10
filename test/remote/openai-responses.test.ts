/**
 * Tests for OpenAI Responses API protocol adapters
 * (src/remote/adapters/openai-responses.ts).
 *
 * Covers: openaiResponsesExpandAdapter (output_text extraction,
 * variant parsing, fallback), openaiResponsesGenerateAdapter
 * (output block normalization, model override, error handling).
 */
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import * as http from "http";
import type { AddressInfo } from "net";
import { openaiResponsesExpandAdapter, openaiResponsesGenerateAdapter } from "../../src/remote/adapters/openai-responses.js";
import { CircuitBreaker } from "../../src/remote/circuit-breaker.js";
import { silentLogger } from "../../src/remote/log.js";
import type { EndpointConfig } from "../../src/remote/types.js";
import { startMockServer, readBody, jsonRes, testCfg, spyLogger } from "../helpers/http-mock.js";


// =============================================================================
// openai_responses adapter: expand + generate
// =============================================================================

describe('openaiResponsesExpandAdapter', () => {
  function makeCtx(url: string): Parameters<typeof openaiResponsesExpandAdapter.expandQuery>[0] {
    return {
      cfg: { baseUrl: url, model: 'm', apiKey: 'sk-test' },
      breaker: new CircuitBreaker(),
      log: silentLogger,
      readTimeoutMs: 5000,
    };
  }

  test('sends request to /responses with instructions + input', async () => {
    let receivedBody: any = null;
    const server = startMockServer(async (req, res) => {
      receivedBody = await readBody(req);
      jsonRes(res, 200, {
        output: [
          {
            type: 'message',
            content: [
              {
                type: 'output_text',
                // All contain "search" — pass term-overlap
                text: 'lex: search kw\nvec: search vec\nhyde: search hyde',
              },
            ],
          },
        ],
        model: 'gpt-4o',
      });
    });

    const result = await openaiResponsesExpandAdapter.expandQuery(
      makeCtx(server.url), 'search', {},
    );

    expect(typeof receivedBody.instructions).toBe('string');
    expect(typeof receivedBody.input).toBe('string');
    expect(receivedBody.max_output_tokens).toBe(600);
    expect(result).toHaveLength(3);
    await server.close();
  });

  test('returns passthrough when no API key', async () => {
    const ctx = makeCtx('http://localhost:1');
    ctx.cfg.apiKey = '';
    const result = await openaiResponsesExpandAdapter.expandQuery(ctx, 'test', {});
    expect(result).toEqual([{ type: 'lex', text: 'test' }]);
  });

  test('falls back on network error', async () => {
    const log = spyLogger();
    const ctx = makeCtx('http://localhost:1');
    ctx.log = log;
    ctx.readTimeoutMs = 100;

    const result = await openaiResponsesExpandAdapter.expandQuery(ctx, 'query', {});
    expect(result).toHaveLength(3);
    expect(log.calls.some((c) => c.level === 'error')).toBe(true);
  });

  test('falls back on empty output', async () => {
    const server = startMockServer((_req, res) => {
      jsonRes(res, 200, { output: [], model: 'm' });
    });

    const ctx = makeCtx(server.url);
    const result = await openaiResponsesExpandAdapter.expandQuery(ctx, 'query', {});
    expect(result).toHaveLength(3);
    await server.close();
  });
});

describe('openaiResponsesGenerateAdapter', () => {
  function makeCtx(url: string): Parameters<typeof openaiResponsesGenerateAdapter.generate>[0] {
    return {
      cfg: { baseUrl: url, model: 'm', apiKey: 'sk-test' },
      breaker: new CircuitBreaker(),
      log: silentLogger,
      readTimeoutMs: 5000,
    };
  }

  test('extracts text from output_text blocks', async () => {
    const server = startMockServer((_req, res) => {
      jsonRes(res, 200, {
        output: [
          {
            type: 'message',
            content: [{ type: 'output_text', text: 'Response API output' }],
          },
        ],
        model: 'gpt-4o',
      });
    });

    const result = await openaiResponsesGenerateAdapter.generate(
      makeCtx(server.url), 'prompt',
    );

    expect(result!.text).toBe('Response API output');
    expect(result!.model).toBe('gpt-4o');
    await server.close();
  });

  test('sends input as string and uses max_output_tokens', async () => {
    let receivedBody: any = null;
    const server = startMockServer(async (req, res) => {
      receivedBody = await readBody(req);
      jsonRes(res, 200, {
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }],
        model: 'm',
      });
    });

    await openaiResponsesGenerateAdapter.generate(
      makeCtx(server.url), 'my prompt', { maxTokens: 256, temperature: 0.5 },
    );

    expect(receivedBody.input).toBe('my prompt');
    expect(receivedBody.max_output_tokens).toBe(256);
    expect(receivedBody.temperature).toBe(0.5);
    await server.close();
  });

  test('returns null on circuit breaker open', async () => {
    const breaker = new CircuitBreaker(1);
    breaker.onFailure();
    const ctx = makeCtx('http://localhost:1');
    ctx.breaker = breaker;

    const result = await openaiResponsesGenerateAdapter.generate(ctx, 'prompt');
    expect(result).toBeNull();
  });

  test('returns null on network error', async () => {
    const log = spyLogger();
    const ctx = makeCtx('http://localhost:1');
    ctx.log = log;
    ctx.readTimeoutMs = 100;

    const result = await openaiResponsesGenerateAdapter.generate(ctx, 'prompt');
    expect(result).toBeNull();
    expect(log.calls.some((c) => c.level === 'error')).toBe(true);
  });
});

// =============================================================================
// RemoteLLM integration with explicit format selection
// =============================================================================

