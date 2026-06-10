/**
 * Tests for OpenAI Chat Completions protocol adapters
 * (src/remote/adapters/openai-chat.ts).
 *
 * Covers: openaiChatCompletionsExpandAdapter (system+user messages,
 * lex/vec/hyde parsing from chat response, fallback on parse failure),
 * openaiChatCompletionsGenerateAdapter (message extraction,
 * plain-string + content-block shapes, model override, error handling).
 */
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import * as http from "http";
import type { AddressInfo } from "net";
import { openaiChatCompletionsExpandAdapter, openaiChatCompletionsGenerateAdapter } from "../../src/remote/adapters/openai-chat.js";
import { CircuitBreaker } from "../../src/remote/circuit-breaker.js";
import { silentLogger } from "../../src/remote/log.js";
import type { EndpointConfig } from "../../src/remote/types.js";
import { startMockServer, readBody, jsonRes, testCfg, spyLogger } from "../helpers/http-mock.js";


// =============================================================================
// openai_chat_completions adapter: expand + generate
// =============================================================================

describe('openaiChatCompletionsExpandAdapter', () => {
  function makeCtx(url: string): Parameters<typeof openaiChatCompletionsExpandAdapter.expandQuery>[0] {
    return {
      cfg: { baseUrl: url, model: 'm', apiKey: 'sk-test' },
      breaker: new CircuitBreaker(),
      log: silentLogger,
      readTimeoutMs: 5000,
    };
  }

  test('expandQuery sends chat completions request and parses response', async () => {
    let receivedBody: any = null;
    const server = startMockServer(async (req, res) => {
      receivedBody = await readBody(req);
      jsonRes(res, 200, {
        choices: [{
          message: {
            // All variants contain "topic" so all pass term-overlap validation
            content: 'lex: topic keywords\nvec: topic paraphrase\nhyde: A document about topic',
          },
        }],
      });
    });

    const result = await openaiChatCompletionsExpandAdapter.expandQuery(
      makeCtx(server.url), 'topic', {},
    );

    expect(receivedBody.messages).toHaveLength(2);
    expect(receivedBody.messages[0].role).toBe('system');
    expect(receivedBody.messages[1].role).toBe('user');
    expect(receivedBody.messages[1].content).toContain('topic');
    expect(result).toHaveLength(3);
    expect(result[0]!.type).toBe('lex');
    await server.close();
  });

  test('returns passthrough when no API key', async () => {
    const log = spyLogger();
    const ctx = makeCtx('http://localhost:1');
    ctx.cfg.apiKey = '';
    ctx.log = log;

    const result = await openaiChatCompletionsExpandAdapter.expandQuery(ctx, 'test', {});
    expect(result).toEqual([{ type: 'lex', text: 'test' }]);
    expect(log.calls.some((c) => c.msg.includes('no API key'))).toBe(true);
  });

  test('falls back when circuit breaker is open', async () => {
    const log = spyLogger();
    const breaker = new CircuitBreaker(1);
    breaker.onFailure();
    const ctx = makeCtx('http://localhost:1');
    ctx.breaker = breaker;
    ctx.log = log;

    const result = await openaiChatCompletionsExpandAdapter.expandQuery(ctx, 'test', {});
    expect(result).toHaveLength(3);
    expect(log.calls.some((c) => c.msg.includes('circuit breaker is open'))).toBe(true);
  });

  test('falls back on malformed response', async () => {
    const log = spyLogger();
    const server = startMockServer((_req, res) => {
      jsonRes(res, 200, {
        choices: [{ message: { content: 'unparseable garbage' } }],
      });
    });

    const ctx = makeCtx(server.url);
    ctx.log = log;
    const result = await openaiChatCompletionsExpandAdapter.expandQuery(ctx, 'topic', {});

    expect(result).toHaveLength(3);
    expect(log.calls.some((c) => c.msg.includes('could not parse'))).toBe(true);
    await server.close();
  });

  test('falls back on empty response content', async () => {
    const server = startMockServer((_req, res) => {
      jsonRes(res, 200, { choices: [{ message: { content: '' } }] });
    });

    const ctx = makeCtx(server.url);
    const result = await openaiChatCompletionsExpandAdapter.expandQuery(ctx, 'query', {});
    expect(result).toHaveLength(3); // fallback
    await server.close();
  });

  test('falls back on network error', async () => {
    const log = spyLogger();
    const ctx = makeCtx('http://localhost:1');
    ctx.log = log;
    ctx.readTimeoutMs = 100;

    const result = await openaiChatCompletionsExpandAdapter.expandQuery(ctx, 'query', {});
    expect(result).toHaveLength(3);
    expect(log.calls.some((c) => c.level === 'error')).toBe(true);
  });

  test('includes intent in user prompt when provided', async () => {
    let receivedBody: any = null;
    const server = startMockServer(async (req, res) => {
      receivedBody = await readBody(req);
      jsonRes(res, 200, {
        choices: [{
          // All contain "dog" so pass term-overlap
          message: { content: 'lex: dog search\nvec: dog query\nhyde: A document about dogs' },
        }],
      });
    });

    const ctx = makeCtx(server.url);
    await openaiChatCompletionsExpandAdapter.expandQuery(ctx, 'dog', { intent: 'information-seeking' });

    expect(receivedBody.messages[1].content).toContain('information-seeking');
    await server.close();
  });
});

describe('openaiChatCompletionsGenerateAdapter', () => {
  function makeCtx(url: string): Parameters<typeof openaiChatCompletionsGenerateAdapter.generate>[0] {
    return {
      cfg: { baseUrl: url, model: 'm', apiKey: 'sk-test' },
      breaker: new CircuitBreaker(),
      log: silentLogger,
      readTimeoutMs: 5000,
    };
  }

  test('returns generated text from chat completions', async () => {
    const server = startMockServer((_req, res) => {
      jsonRes(res, 200, {
        choices: [{ message: { content: 'Generated response' } }],
        model: 'gen-model',
      });
    });

    const result = await openaiChatCompletionsGenerateAdapter.generate(
      makeCtx(server.url), 'prompt',
    );

    expect(result!.text).toBe('Generated response');
    expect(result!.model).toBe('gen-model');
    expect(result!.done).toBe(true);
    await server.close();
  });

  test('passes maxTokens and temperature from options', async () => {
    let receivedBody: any = null;
    const server = startMockServer(async (req, res) => {
      receivedBody = await readBody(req);
      jsonRes(res, 200, {
        choices: [{ message: { content: 'ok' } }],
        model: 'm',
      });
    });

    await openaiChatCompletionsGenerateAdapter.generate(
      makeCtx(server.url), 'test', { maxTokens: 42, temperature: 0.3 },
    );

    expect(receivedBody.max_tokens).toBe(42);
    expect(receivedBody.temperature).toBe(0.3);
    await server.close();
  });

  test('returns null on circuit breaker open', async () => {
    const log = spyLogger();
    const breaker = new CircuitBreaker(1);
    breaker.onFailure();
    const ctx = makeCtx('http://localhost:1');
    ctx.breaker = breaker;
    ctx.log = log;

    const result = await openaiChatCompletionsGenerateAdapter.generate(ctx, 'prompt');
    expect(result).toBeNull();
    expect(log.calls.some((c) => c.msg.includes('circuit breaker is open'))).toBe(true);
  });

  test('returns null on network error', async () => {
    const log = spyLogger();
    const ctx = makeCtx('http://localhost:1');
    ctx.log = log;
    ctx.readTimeoutMs = 100;

    const result = await openaiChatCompletionsGenerateAdapter.generate(ctx, 'prompt');
    expect(result).toBeNull();
    expect(log.calls.some((c) => c.level === 'error')).toBe(true);
  });

  test('returns empty text for empty content response', async () => {
    const server = startMockServer((_req, res) => {
      jsonRes(res, 200, {
        choices: [{ message: { content: '' } }],
        model: 'm',
      });
    });

    const result = await openaiChatCompletionsGenerateAdapter.generate(
      makeCtx(server.url), 'prompt',
    );

    expect(result!.text).toBe('');
    expect(result!.done).toBe(true);
    await server.close();
  });
});

// =============================================================================
// openai_completions adapter: expand + generate
// =============================================================================

