/**
 * End-to-end integration tests for RemoteLLM with specific protocol formats.
 *
 * Covers: OpenAI formats (chat completions, completions, responses
 * for expand + generate), Anthropic Messages format (expand +
 * generate with correct headers and payload shape), Cohere/vLLM/
 * Ollama formats (cohere_v2_embed, ollama_embed, vllm_pooling for embed;
 * ollama_chat, ollama_generate for expand/generate; cohere_v2_rerank,
 * vllm_score for rerank). Each test constructs a RemoteLLM with explicit
 * per-endpoint format configs and verifies correct adapter routing and
 * wire-protocol compliance against mock HTTP servers.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import * as http from "http";
import type { AddressInfo } from "net";
import { RemoteLLM } from "../../src/remote/remote-llm.js";
import type { EndpointConfig, RemoteLLMConfig } from "../../src/remote/types.js";
import { startMockServer, readBody, jsonRes, mockEmbedding, spyLogger } from "../helpers/http-mock.js";
import { silentLogger } from "../../src/remote/log.js";
import { anthropicMessagesExpandAdapter, anthropicMessagesGenerateAdapter } from "../../src/remote/adapters/anthropic-messages.js";
import { CircuitBreaker } from "../../src/remote/circuit-breaker.js";


// =============================================================================
// RemoteLLM integration with explicit format selection
// =============================================================================

describe('RemoteLLM with OpenAI formats', () => {
  test('RemoteLLM expandQuery uses chat completions format via new adapter', async () => {
    let requestedPath = '';
    const server = startMockServer((req, res) => {
      requestedPath = req.url ?? '';
      jsonRes(res, 200, {
        choices: [{ message: { content: 'lex: test kw\nvec: test vec\nhyde: test hyde' } }],
        model: 'm',
      });
    });

    const llm = new RemoteLLM({
      expand: { baseUrl: server.url, model: 'm', apiKey: 'sk', format: 'openai_chat_completions' },
    }, silentLogger);

    const result = await llm.expandQuery('test');
    expect(result).toHaveLength(3);
    expect(requestedPath).toBe('/chat/completions');
    await llm.dispose();
    await server.close();
  });

  test('RemoteLLM generate uses completions format via new adapter', async () => {
    let requestedPath = '';
    let receivedBody: any = null;
    const server = startMockServer(async (req, res) => {
      requestedPath = req.url ?? '';
      receivedBody = await readBody(req);
      jsonRes(res, 200, {
        choices: [{ text: 'completions output', index: 0 }],
        model: 'gpt-3.5',
      });
    });

    const llm = new RemoteLLM({
      generate: { baseUrl: server.url, model: 'm', apiKey: 'sk', format: 'openai_completions' },
    }, silentLogger);

    const result = await llm.generate('prompt text');
    expect(result!.text).toBe('completions output');
    expect(requestedPath).toBe('/completions');
    expect(receivedBody.prompt).toBe('prompt text');
    await llm.dispose();
    await server.close();
  });

  test('RemoteLLM generate uses responses format via new adapter', async () => {
    let requestedPath = '';
    const server = startMockServer((req, res) => {
      requestedPath = req.url ?? '';
      jsonRes(res, 200, {
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'responses output' }] }],
        model: 'gpt-4o',
      });
    });

    const llm = new RemoteLLM({
      generate: { baseUrl: server.url, model: 'm', apiKey: 'sk', format: 'openai_responses' },
    }, silentLogger);

    const result = await llm.generate('prompt');
    expect(result!.text).toBe('responses output');
    expect(requestedPath).toBe('/responses');
    await llm.dispose();
    await server.close();
  });

  test('auto format still uses legacy and hits /chat/completions', async () => {
    let requestedPath = '';
    const server = startMockServer((req, res) => {
      requestedPath = req.url ?? '';
      jsonRes(res, 200, {
        choices: [{ message: { content: 'answer' } }],
        model: 'm',
      });
    });

    const llm = new RemoteLLM({
      generate: { baseUrl: server.url, model: 'm', apiKey: 'sk', format: 'auto' },
    }, silentLogger);

    const result = await llm.generate('test');
    expect(result!.text).toBe('answer');
    expect(requestedPath).toBe('/chat/completions'); // legacy also uses chat completions
    await llm.dispose();
    await server.close();
  });
});

// =============================================================================
// RemoteLLM integration with Cohere-compatible formats
// =============================================================================

describe('RemoteLLM with Cohere formats', () => {
  test('RemoteLLM embedBatch uses cohere_v2_embed adapter and /v2/embed path', async () => {
    let requestedPath = '';
    let receivedBody: any = null;
    const server = startMockServer(async (req, res) => {
      requestedPath = req.url ?? '';
      receivedBody = await readBody(req);
      jsonRes(res, 200, {
        embeddings: {
          float: [mockEmbedding],
        },
      });
    });

    const llm = new RemoteLLM({
      embed: { baseUrl: server.url, model: 'embed-v4.0', apiKey: 'sk', format: 'cohere_v2_embed' },
    }, silentLogger);

    const result = await llm.embedBatch(['hello']);
    expect(result[0]!.embedding).toEqual(mockEmbedding);
    expect(requestedPath).toBe('/v2/embed');
    expect(receivedBody.input_type).toBe('document'); // non-Cohere host defaults to 'document'

    await llm.dispose();
    await server.close();
  });


  test('RemoteLLM embedBatch uses ollama_embed adapter and /api/embed path', async () => {
    let requestedPath = '';
    let receivedBody: any = null;
    const server = startMockServer(async (req, res) => {
      requestedPath = req.url ?? '';
      receivedBody = await readBody(req);
      jsonRes(res, 200, {
        model: 'embeddinggemma',
        embeddings: [mockEmbedding],
      });
    });

    const llm = new RemoteLLM({
      embed: { baseUrl: server.url, model: 'embeddinggemma', apiKey: '', format: 'ollama_embed' },
    }, silentLogger);

    const result = await llm.embedBatch(['hello']);
    expect(result[0]!.embedding).toEqual(mockEmbedding);
    expect(requestedPath).toBe('/api/embed');
    expect(receivedBody.input).toEqual(['hello']);

    await llm.dispose();
    await server.close();
  });

  test('RemoteLLM expandQuery uses ollama_chat adapter and /api/chat path', async () => {
    let requestedPath = '';
    let receivedBody: any = null;
    const server = startMockServer(async (req, res) => {
      requestedPath = req.url ?? '';
      receivedBody = await readBody(req);
      jsonRes(res, 200, {
        model: 'llama3.2',
        message: {
          role: 'assistant',
          content: 'lex: hello world\nvec: hello semantic\nhyde: A note about hello world',
        },
        done: true,
      });
    });

    const llm = new RemoteLLM({
      expand: { baseUrl: server.url, model: 'llama3.2', apiKey: '', format: 'ollama_chat' },
    }, silentLogger);

    const result = await llm.expandQuery('hello world');
    expect(result.length).toBeGreaterThan(0);
    expect(requestedPath).toBe('/api/chat');
    expect(receivedBody.stream).toBe(false);

    await llm.dispose();
    await server.close();
  });

  test('RemoteLLM generate uses ollama_generate adapter and /api/generate path', async () => {
    let requestedPath = '';
    let receivedBody: any = null;
    const server = startMockServer(async (req, res) => {
      requestedPath = req.url ?? '';
      receivedBody = await readBody(req);
      jsonRes(res, 200, {
        model: 'llama3.2',
        response: 'generated text',
        done: true,
      });
    });

    const llm = new RemoteLLM({
      generate: { baseUrl: server.url, model: 'llama3.2', apiKey: '', format: 'ollama_generate' },
    }, silentLogger);

    const result = await llm.generate('hello', { maxTokens: 16, temperature: 0.4 });
    expect(result!.text).toBe('generated text');
    expect(result!.done).toBe(true);
    expect(requestedPath).toBe('/api/generate');
    expect(receivedBody.options.num_predict).toBe(16);
    expect(receivedBody.options.temperature).toBe(0.4);

    await llm.dispose();
    await server.close();
  });
  test('RemoteLLM rerank uses cohere_v2_rerank adapter with endpoint fallback', async () => {
    const requestedPaths: string[] = [];
    const server = startMockServer((_req, res) => {
      requestedPaths.push(_req.url ?? '');
      if (_req.url === '/rerank') {
        jsonRes(res, 404, { error: 'not found' });
        return;
      }
      jsonRes(res, 200, {
        results: [{ index: 0, relevance_score: 0.91 }],
      });
    });

    const llm = new RemoteLLM({
      rerank: { baseUrl: server.url, model: 'rerank-v3.5', apiKey: 'sk', format: 'cohere_v2_rerank' },
    }, silentLogger);

    const result = await llm.rerank('q', [{ file: 'a.md', text: 'doc' }]);
    expect(result.results[0]!.score).toBe(0.91);
    expect(requestedPaths).toEqual(['/rerank', '/v1/rerank']);

    await llm.dispose();
    await server.close();
  });

  test('RemoteLLM rerank uses vllm_score adapter and /score endpoint', async () => {
    let requestedPath = '';
    let receivedBody: any = null;
    const server = startMockServer(async (req, res) => {
      requestedPath = req.url ?? '';
      receivedBody = await readBody(req);
      jsonRes(res, 200, {
        model: 'BAAI/bge-reranker-v2-m3',
        data: [{ index: 0, score: 0.93 }],
      });
    });

    const llm = new RemoteLLM({
      rerank: {
        baseUrl: server.url,
        model: 'BAAI/bge-reranker-v2-m3',
        apiKey: '',
        format: 'vllm_score',
      },
    }, silentLogger);

    const result = await llm.rerank('q', [{ file: 'a.md', text: 'doc' }]);
    expect(result.results[0]!.score).toBe(0.93);
    expect(requestedPath).toBe('/score');
    expect(receivedBody.queries).toBe('q');
    expect(receivedBody.documents).toEqual(['doc']);

    await llm.dispose();
    await server.close();
  });
});

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

describe('RemoteLLM with anthropic_messages format', () => {
  test('RemoteLLM expandQuery hits /messages with Anthropic protocol', async () => {
    let requestedPath = '';
    let receivedHeaders: any = null;
    const server = startMockServer((req, res) => {
      requestedPath = req.url ?? '';
      receivedHeaders = req.headers;
      jsonRes(res, 200, {
        content: [
          { type: 'text', text: 'lex: test kw\nvec: test vec\nhyde: test hyde' },
        ],
      });
    });

    const llm = new RemoteLLM({
      expand: { baseUrl: server.url, model: 'claude', apiKey: 'sk-ant', format: 'anthropic_messages' },
    }, silentLogger);

    const result = await llm.expandQuery('test');
    expect(result).toHaveLength(3);
    expect(requestedPath).toBe('/messages');
    expect(receivedHeaders['x-api-key']).toBe('sk-ant');
    expect(receivedHeaders['anthropic-version']).toBe('2023-06-01');
    await llm.dispose();
    await server.close();
  });

  test('RemoteLLM generate hits /messages with Anthropic protocol', async () => {
    let requestedPath = '';
    let receivedHeaders: any = null;
    const server = startMockServer((req, res) => {
      requestedPath = req.url ?? '';
      receivedHeaders = req.headers;
      jsonRes(res, 200, {
        content: [{ type: 'text', text: 'claude answer' }],
        model: 'claude-3',
      });
    });

    const llm = new RemoteLLM({
      generate: { baseUrl: server.url, model: 'claude', apiKey: 'sk-ant', format: 'anthropic_messages' },
    }, silentLogger);

    const result = await llm.generate('test prompt');
    expect(result!.text).toBe('claude answer');
    expect(requestedPath).toBe('/messages');
    expect(receivedHeaders['x-api-key']).toBe('sk-ant');
    await llm.dispose();
    await server.close();
  });
});
