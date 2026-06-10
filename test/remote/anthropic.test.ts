/**
 * Tests for Anthropic Messages API protocol adapters
 * (src/remote/adapters/anthropic-messages.ts).
 *
 * Covers: anthropicMessagesExpandAdapter (/v1/messages with
 * x-api-key + anthropic-version headers, system prompt as top-level
 * field, content-block text extraction, passthrough on missing API key,
 * fallback on circuit breaker open), anthropicMessagesGenerateAdapter
 * (max_tokens enforcement, temperature passthrough, null return on
 * error/circuit-breaker-open, multi-block concatenation).
 */
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import * as http from "http";
import type { AddressInfo } from "net";
import { anthropicMessagesExpandAdapter, anthropicMessagesGenerateAdapter } from "../../src/remote/adapters/anthropic-messages.js";
import { CircuitBreaker } from "../../src/remote/circuit-breaker.js";
import { silentLogger } from "../../src/remote/log.js";
import type { EndpointConfig } from "../../src/remote/types.js";
import { startMockServer, readBody, jsonRes, testCfg, spyLogger } from "../helpers/http-mock.js";


// =============================================================================
// Anthropic Messages adapter: expand + generate
// =============================================================================

describe('anthropicMessagesExpandAdapter', () => {
  function makeCtx(url: string): Parameters<typeof anthropicMessagesExpandAdapter.expandQuery>[0] {
    return {
      cfg: { baseUrl: url, model: 'claude-3-opus', apiKey: 'sk-ant-test' },
      breaker: new CircuitBreaker(),
      log: silentLogger,
      readTimeoutMs: 5000,
    };
  }

  test('sends request to /messages with correct Anthropic protocol shape', async () => {
    let receivedBody: any = null;
    let receivedHeaders: any = null;
    const server = startMockServer(async (req, res) => {
      receivedBody = await readBody(req);
      receivedHeaders = req.headers;
      jsonRes(res, 200, {
        id: 'msg_001',
        type: 'message',
        role: 'assistant',
        content: [
          { type: 'text', text: 'lex: topic search\nvec: semantic topic\nhyde: A document about topics' },
        ],
        model: 'claude-3-opus-20240229',
        stop_reason: 'end_turn',
        usage: { input_tokens: 50, output_tokens: 30 },
      });
    });

    const result = await anthropicMessagesExpandAdapter.expandQuery(
      makeCtx(server.url), 'topic', {},
    );

    // Verify Anthropic-specific request shape
    expect(receivedBody.model).toBe('claude-3-opus');
    expect(receivedBody.max_tokens).toBe(600);
    expect(receivedBody.system).toBeTruthy();
    expect(receivedBody.system).toContain('search query expansion');
    expect(receivedBody.messages).toHaveLength(1);
    expect(receivedBody.messages[0].role).toBe('user');
    expect(receivedBody.messages[0].content).toContain('topic');

    // Verify Anthropic auth header (NOT Authorization: Bearer)
    expect(receivedHeaders['x-api-key']).toBe('sk-ant-test');
    expect(receivedHeaders['anthropic-version']).toBe('2023-06-01');
    // Should NOT have Authorization header
    expect(receivedHeaders['authorization']).toBeUndefined();

    // Verify parsed result
    expect(result).toHaveLength(3);
    expect(result[0]!.type).toBe('lex');
    await server.close();
  });

  test('returns passthrough when no API key', async () => {
    const log = spyLogger();
    const ctx = makeCtx('http://localhost:1');
    ctx.cfg.apiKey = '';
    ctx.log = log;

    const result = await anthropicMessagesExpandAdapter.expandQuery(ctx, 'test', {});
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

    const result = await anthropicMessagesExpandAdapter.expandQuery(ctx, 'test', {});
    expect(result).toHaveLength(3);
    expect(log.calls.some((c) => c.msg.includes('circuit breaker is open'))).toBe(true);
  });

  test('falls back on malformed response', async () => {
    const log = spyLogger();
    const server = startMockServer((_req, res) => {
      jsonRes(res, 200, {
        id: 'msg',
        content: [{ type: 'text', text: 'not valid format at all' }],
      });
    });

    const ctx = makeCtx(server.url);
    ctx.log = log;
    const result = await anthropicMessagesExpandAdapter.expandQuery(ctx, 'topic', {});

    expect(result).toHaveLength(3);
    expect(log.calls.some((c) => c.msg.includes('could not parse'))).toBe(true);
    await server.close();
  });

  test('falls back on empty content array', async () => {
    const server = startMockServer((_req, res) => {
      jsonRes(res, 200, {
        id: 'msg',
        content: [],
        model: 'claude',
      });
    });

    const ctx = makeCtx(server.url);
    const result = await anthropicMessagesExpandAdapter.expandQuery(ctx, 'query', {});
    expect(result).toHaveLength(3); // fallback
    await server.close();
  });

  test('falls back on network error', async () => {
    const log = spyLogger();
    const ctx = makeCtx('http://localhost:1');
    ctx.log = log;
    ctx.readTimeoutMs = 100;

    const result = await anthropicMessagesExpandAdapter.expandQuery(ctx, 'query', {});
    expect(result).toHaveLength(3);
    expect(log.calls.some((c) => c.level === 'error')).toBe(true);
  });

  test('includes intent in user prompt when provided', async () => {
    let receivedBody: any = null;
    const server = startMockServer(async (req, res) => {
      receivedBody = await readBody(req);
      jsonRes(res, 200, {
        content: [
          { type: 'text', text: 'lex: dog search\nvec: dog query\nhyde: A document about dogs' },
        ],
      });
    });

    const ctx = makeCtx(server.url);
    await anthropicMessagesExpandAdapter.expandQuery(ctx, 'dog', { intent: 'information-seeking' });

    expect(receivedBody.messages[0].content).toContain('information-seeking');
    await server.close();
  });
});

describe('anthropicMessagesGenerateAdapter', () => {
  function makeCtx(url: string): Parameters<typeof anthropicMessagesGenerateAdapter.generate>[0] {
    return {
      cfg: { baseUrl: url, model: 'claude-3-haiku', apiKey: 'sk-ant-test' },
      breaker: new CircuitBreaker(),
      log: silentLogger,
      readTimeoutMs: 5000,
    };
  }

  test('extracts text from content blocks in Anthropic response', async () => {
    const server = startMockServer((_req, res) => {
      jsonRes(res, 200, {
        id: 'msg_002',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'This is a generated response from Claude' }],
        model: 'claude-3-haiku-20240307',
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 15 },
      });
    });

    const result = await anthropicMessagesGenerateAdapter.generate(
      makeCtx(server.url), 'prompt',
    );

    expect(result!.text).toBe('This is a generated response from Claude');
    expect(result!.model).toBe('claude-3-haiku-20240307');
    expect(result!.done).toBe(true);
    await server.close();
  });

  test('sends Anthropic-formatted request with correct headers', async () => {
    let receivedBody: any = null;
    let receivedHeaders: any = null;
    const server = startMockServer(async (req, res) => {
      receivedBody = await readBody(req);
      receivedHeaders = req.headers;
      jsonRes(res, 200, {
        content: [{ type: 'text', text: 'ok' }],
        model: 'claude-3-haiku',
      });
    });

    await anthropicMessagesGenerateAdapter.generate(
      makeCtx(server.url), 'test prompt', { maxTokens: 512, temperature: 0.5 },
    );

    // Verify Anthropic-specific shape
    expect(receivedBody.model).toBe('claude-3-haiku');
    expect(receivedBody.max_tokens).toBe(512);
    expect(receivedBody.temperature).toBe(0.5);
    expect(receivedBody.messages).toHaveLength(1);
    expect(receivedBody.messages[0].role).toBe('user');
    expect(receivedBody.messages[0].content).toBe('test prompt');
    // generate adapters should NOT include system prompt
    expect(receivedBody.system).toBeUndefined();

    // Auth headers
    expect(receivedHeaders['x-api-key']).toBe('sk-ant-test');
    expect(receivedHeaders['anthropic-version']).toBe('2023-06-01');
    await server.close();
  });

  test('returns null on circuit breaker open', async () => {
    const log = spyLogger();
    const breaker = new CircuitBreaker(1);
    breaker.onFailure();
    const ctx = makeCtx('http://localhost:1');
    ctx.breaker = breaker;
    ctx.log = log;

    const result = await anthropicMessagesGenerateAdapter.generate(ctx, 'prompt');
    expect(result).toBeNull();
    expect(log.calls.some((c) => c.msg.includes('circuit breaker is open'))).toBe(true);
  });

  test('returns null on network error', async () => {
    const log = spyLogger();
    const ctx = makeCtx('http://localhost:1');
    ctx.log = log;
    ctx.readTimeoutMs = 100;

    const result = await anthropicMessagesGenerateAdapter.generate(ctx, 'prompt');
    expect(result).toBeNull();
    expect(log.calls.some((c) => c.level === 'error')).toBe(true);
  });

  test('returns empty text for response with no text content blocks', async () => {
    const server = startMockServer((_req, res) => {
      jsonRes(res, 200, {
        content: [
          { type: 'tool_use', id: 'tool_1', name: 'get_weather', input: {} },
        ],
        model: 'claude',
      });
    });

    const result = await anthropicMessagesGenerateAdapter.generate(
      makeCtx(server.url), 'prompt',
    );

    expect(result!.text).toBe('');
    expect(result!.done).toBe(true);
    await server.close();
  });

  test('concatenates multiple text blocks in response', async () => {
    const server = startMockServer((_req, res) => {
      jsonRes(res, 200, {
        content: [
          { type: 'text', text: 'Part A. ' },
          { type: 'text', text: 'Part B.' },
        ],
        model: 'claude',
      });
    });

    const result = await anthropicMessagesGenerateAdapter.generate(
      makeCtx(server.url), 'prompt',
    );

    expect(result!.text).toBe('Part A.\nPart B.');
    await server.close();
  });
});

// =============================================================================
// RemoteLLM integration with anthropic_messages format
// =============================================================================

