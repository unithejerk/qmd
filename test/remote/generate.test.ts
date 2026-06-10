/**
 * Tests for remote text generation (src/remote/generate.ts).
 *
 * Covers: POST /v1/chat/completions for text generation,
 * response text extraction, circuit breaker gating (returns null when open),
 * API key validation (returns null when missing), model override via options,
 * and error-path graceful degradation.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import * as http from "http";
import type { AddressInfo } from "net";
import { generate } from "../../src/remote/generate.js";
import { CircuitBreaker } from "../../src/remote/circuit-breaker.js";
import { silentLogger } from "../../src/remote/log.js";
import type { EndpointConfig } from "../../src/remote/types.js";
import { startMockServer, readBody, jsonRes, testCfg, spyLogger } from "../helpers/http-mock.js";


// =============================================================================
// generate.ts
// =============================================================================

describe('generate', () => {
  test('returns generated text', async () => {
    const server = startMockServer((_req, res) => {
      jsonRes(res, 200, {
        choices: [{ message: { content: 'Generated response' } }],
        model: 'gen-model',
      });
    });

    const cfg: EndpointConfig = { baseUrl: server.url, model: 'm', apiKey: 'sk-test' };
    const breaker = new CircuitBreaker();
    const result = await generate(cfg, breaker, 'prompt', 5000, silentLogger);

    expect(result!.text).toBe('Generated response');
    expect(result!.model).toBe('gen-model');
    expect(result!.done).toBe(true);
    await server.close();
  });

  test('returns null on error', async () => {
    const log = spyLogger();
    const cfg: EndpointConfig = { baseUrl: 'http://localhost:1', model: 'm', apiKey: 'sk-test' };
    const breaker = new CircuitBreaker();
    const result = await generate(cfg, breaker, 'prompt', 100, log);

    expect(result).toBeNull();
    expect(log.calls.some((c) => c.level === 'error')).toBe(true);
  });

  test('circuit breaker open returns null', async () => {
    const log = spyLogger();
    const breaker = new CircuitBreaker(1);
    breaker.onFailure();
    const cfg: EndpointConfig = { baseUrl: 'http://localhost:1', model: 'm', apiKey: 'sk-test' };
    const result = await generate(cfg, breaker, 'prompt', 5000, log);

    expect(result).toBeNull();
    expect(log.calls.some((c) => c.msg.includes('circuit breaker is open'))).toBe(true);
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

    const cfg: EndpointConfig = { baseUrl: server.url, model: 'm', apiKey: 'sk-test' };
    const breaker = new CircuitBreaker();
    await generate(cfg, breaker, 'test', 5000, silentLogger, { maxTokens: 42, temperature: 0.3 });

    expect(receivedBody.max_tokens).toBe(42);
    expect(receivedBody.temperature).toBe(0.3);
    await server.close();
  });
});

// =============================================================================
// probe.ts
// =============================================================================

