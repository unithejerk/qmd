/**
 * Tests for OpenAI legacy Completions protocol adapters
 * (src/remote/adapters/openai-completions.ts).
 *
 * Covers: openaiCompletionsExpandAdapter (prompt-based expansion,
 * variant parsing, fallback), openaiCompletionsGenerateAdapter
 * (text extraction from choices[0].text, error handling).
 */
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import * as http from "http";
import type { AddressInfo } from "net";
import { openaiCompletionsExpandAdapter, openaiCompletionsGenerateAdapter } from "../../src/remote/adapters/openai-completions.js";
import { CircuitBreaker } from "../../src/remote/circuit-breaker.js";
import { silentLogger } from "../../src/remote/log.js";
import type { EndpointConfig } from "../../src/remote/types.js";
import { startMockServer, readBody, jsonRes, testCfg, spyLogger } from "../helpers/http-mock.js";


// =============================================================================
// openai_completions adapter: expand + generate
// =============================================================================

describe('openaiCompletionsExpandAdapter', () => {
  function makeCtx(url: string): Parameters<typeof openaiCompletionsExpandAdapter.expandQuery>[0] {
    return {
      cfg: { baseUrl: url, model: 'm', apiKey: 'sk-test' },
      breaker: new CircuitBreaker(),
      log: silentLogger,
      readTimeoutMs: 5000,
    };
  }

  test('sends combined prompt to /completions endpoint', async () => {
    let receivedBody: any = null;
    const server = startMockServer(async (req, res) => {
      receivedBody = await readBody(req);
      jsonRes(res, 200, {
        choices: [{ text: 'lex: search kw\nvec: search vec\nhyde: search hyde', index: 0 }],
        model: 'm',
      });
    });

    const result = await openaiCompletionsExpandAdapter.expandQuery(
      makeCtx(server.url), 'search', {},
    );

    // Completions endpoint: single prompt string, no messages array
    expect(typeof receivedBody.prompt).toBe('string');
    expect(receivedBody.prompt).toContain('search query expansion');
    expect(receivedBody.prompt).toContain('search');
    expect(result).toHaveLength(3);
    await server.close();
  });

  test('returns passthrough when no API key', async () => {
    const ctx = makeCtx('http://localhost:1');
    ctx.cfg.apiKey = '';
    const result = await openaiCompletionsExpandAdapter.expandQuery(ctx, 'test', {});
    expect(result).toEqual([{ type: 'lex', text: 'test' }]);
  });

  test('falls back when circuit breaker is open', async () => {
    const breaker = new CircuitBreaker(1);
    breaker.onFailure();
    const ctx = makeCtx('http://localhost:1');
    ctx.breaker = breaker;

    const result = await openaiCompletionsExpandAdapter.expandQuery(ctx, 'test', {});
    expect(result).toHaveLength(3);
  });

  test('falls back on malformed response', async () => {
    const log = spyLogger();
    const server = startMockServer((_req, res) => {
      jsonRes(res, 200, { choices: [{ text: 'not formatted at all', index: 0 }] });
    });

    const ctx = makeCtx(server.url);
    ctx.log = log;
    const result = await openaiCompletionsExpandAdapter.expandQuery(ctx, 'topic', {});

    expect(result).toHaveLength(3);
    expect(log.calls.some((c) => c.msg.includes('could not parse'))).toBe(true);
    await server.close();
  });
});

describe('openaiCompletionsGenerateAdapter', () => {
  function makeCtx(url: string): Parameters<typeof openaiCompletionsGenerateAdapter.generate>[0] {
    return {
      cfg: { baseUrl: url, model: 'm', apiKey: 'sk-test' },
      breaker: new CircuitBreaker(),
      log: silentLogger,
      readTimeoutMs: 5000,
    };
  }

  test('extracts text from choices[0].text', async () => {
    const server = startMockServer((_req, res) => {
      jsonRes(res, 200, {
        choices: [{ text: 'Completions output', index: 0 }],
        model: 'gpt-3.5-turbo-instruct',
      });
    });

    const result = await openaiCompletionsGenerateAdapter.generate(
      makeCtx(server.url), 'prompt',
    );

    expect(result!.text).toBe('Completions output');
    expect(result!.model).toBe('gpt-3.5-turbo-instruct');
    await server.close();
  });

  test('sends prompt as a plain string', async () => {
    let receivedBody: any = null;
    const server = startMockServer(async (req, res) => {
      receivedBody = await readBody(req);
      jsonRes(res, 200, {
        choices: [{ text: 'ok', index: 0 }],
        model: 'm',
      });
    });

    await openaiCompletionsGenerateAdapter.generate(
      makeCtx(server.url), 'my plain prompt', { maxTokens: 50 },
    );

    expect(receivedBody.prompt).toBe('my plain prompt');
    expect(receivedBody.max_tokens).toBe(50);
    await server.close();
  });

  test('returns null on error', async () => {
    const log = spyLogger();
    const ctx = makeCtx('http://localhost:1');
    ctx.log = log;
    ctx.readTimeoutMs = 100;

    const result = await openaiCompletionsGenerateAdapter.generate(ctx, 'prompt');
    expect(result).toBeNull();
    expect(log.calls.some((c) => c.level === 'error')).toBe(true);
  });
});

// =============================================================================
// openai_responses adapter: expand + generate
// =============================================================================

