/**
 * Tests for Ollama chat/generate text adapters
 * (src/remote/adapters/ollama-text.ts).
 *
 * Covers: ollamaChatExpandAdapter (/api/chat with stream:false,
 * variant parsing), ollamaGenerateExpandAdapter (/api/generate,
 * fallback on malformed output), ollamaChatGenerateAdapter
 * (assistant message extraction), ollamaGenerateGenerateAdapter
 * (response text extraction and runtime option passthrough).
 */
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import * as http from "http";
import type { AddressInfo } from "net";
import { ollamaChatExpandAdapter, ollamaChatGenerateAdapter, ollamaGenerateExpandAdapter, ollamaGenerateGenerateAdapter } from "../../src/remote/adapters/ollama-text.js";
import { CircuitBreaker } from "../../src/remote/circuit-breaker.js";
import { silentLogger } from "../../src/remote/log.js";
import type { EndpointConfig } from "../../src/remote/types.js";
import { startMockServer, readBody, jsonRes, testCfg, spyLogger } from "../helpers/http-mock.js";


describe('ollama chat/generate adapters', () => {
  const expandCtx = (url: string) => ({
    cfg: { baseUrl: url, model: 'llama3.2', apiKey: '', format: 'ollama_chat' as const },
    breaker: new CircuitBreaker(),
    log: silentLogger,
    readTimeoutMs: 5000,
  });

  const generateCtx = (url: string) => ({
    cfg: { baseUrl: url, model: 'llama3.2', apiKey: '', format: 'ollama_chat' as const },
    breaker: new CircuitBreaker(),
    log: silentLogger,
    readTimeoutMs: 5000,
  });

  test('ollamaChatExpandAdapter posts to /api/chat with stream:false and parses variants', async () => {
    let requestedPath = '';
    let receivedBody: any = null;
    const server = startMockServer(async (req, res) => {
      requestedPath = req.url ?? '';
      receivedBody = await readBody(req);
      jsonRes(res, 200, {
        model: 'llama3.2',
        message: {
          role: 'assistant',
          content: 'lex: sky color\nvec: why sky appears blue\nhyde: A note about why sky appears blue',
        },
        done: true,
      });
    });

    const result = await ollamaChatExpandAdapter.expandQuery(
      expandCtx(server.url),
      'sky blue',
      {},
    );

    expect(requestedPath).toBe('/api/chat');
    expect(receivedBody.stream).toBe(false);
    expect(receivedBody.messages[0].role).toBe('system');
    expect(receivedBody.messages[1].role).toBe('user');
    expect(result.length).toBeGreaterThan(0);
    await server.close();
  });

  test('ollamaGenerateExpandAdapter posts to /api/generate and falls back on malformed output', async () => {
    let requestedPath = '';
    let receivedBody: any = null;
    const server = startMockServer(async (req, res) => {
      requestedPath = req.url ?? '';
      receivedBody = await readBody(req);
      jsonRes(res, 200, {
        model: 'llama3.2',
        response: 'not parseable',
        done: true,
      });
    });

    const result = await ollamaGenerateExpandAdapter.expandQuery(
      { ...expandCtx(server.url), cfg: { baseUrl: server.url, model: 'llama3.2', apiKey: '', format: 'ollama_generate' } },
      'sky blue',
      {},
    );

    expect(requestedPath).toBe('/api/generate');
    expect(receivedBody.stream).toBe(false);
    expect(typeof receivedBody.system).toBe('string');
    expect(result).toHaveLength(3); // expandFallback
    await server.close();
  });

  test('ollamaChatGenerateAdapter returns assistant message and passes runtime options', async () => {
    let requestedPath = '';
    let receivedBody: any = null;
    const server = startMockServer(async (req, res) => {
      requestedPath = req.url ?? '';
      receivedBody = await readBody(req);
      jsonRes(res, 200, {
        model: 'llama3.2',
        message: { role: 'assistant', content: 'hello from chat' },
        done: true,
      });
    });

    const result = await ollamaChatGenerateAdapter.generate(
      generateCtx(server.url),
      'hello',
      { maxTokens: 42, temperature: 0.3 },
    );

    expect(requestedPath).toBe('/api/chat');
    expect(receivedBody.options.num_predict).toBe(42);
    expect(receivedBody.options.temperature).toBe(0.3);
    expect(result!.text).toBe('hello from chat');
    expect(result!.done).toBe(true);
    await server.close();
  });

  test('ollamaGenerateGenerateAdapter returns response text and hits /api/generate', async () => {
    let requestedPath = '';
    const server = startMockServer((_req, res) => {
      requestedPath = _req.url ?? '';
      jsonRes(res, 200, {
        model: 'llama3.2',
        response: 'hello from generate',
        done: true,
      });
    });

    const result = await ollamaGenerateGenerateAdapter.generate(
      { ...generateCtx(server.url), cfg: { baseUrl: server.url, model: 'llama3.2', apiKey: '', format: 'ollama_generate' } },
      'hello',
      {},
    );

    expect(requestedPath).toBe('/api/generate');
    expect(result!.text).toBe('hello from generate');
    expect(result!.done).toBe(true);
    await server.close();
  });
});

