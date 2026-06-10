/**
 * Tests for remote query expansion (src/remote/expand.ts).
 *
 * Covers: parseExpandResponse (lex/vec/hyde line parsing, markdown-stripping,
 * term-overlap validation, minimum-length enforcement), expandFallback
 * (passthrough query generation when expansion is unavailable),
 * expandQuery (full pipeline: API key check → circuit breaker gating →
 * POST /v1/chat/completions → parse → fallback on failure).
 */
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import * as http from "http";
import type { AddressInfo } from "net";
import { expandQuery, parseExpandResponse, expandFallback } from "../../src/remote/expand.js";
import { CircuitBreaker } from "../../src/remote/circuit-breaker.js";
import { silentLogger } from "../../src/remote/log.js";
import type { EndpointConfig } from "../../src/remote/types.js";
import { startMockServer, readBody, jsonRes, testCfg, spyLogger } from "../helpers/http-mock.js";


// =============================================================================
// expand.ts
// =============================================================================

describe('parseExpandResponse', () => {
  test('parses lex, vec, hyde lines', () => {
    const content = 'lex: keyword search\nvec: semantic paraphrase of search\nhyde: A document about search techniques';
    const result = parseExpandResponse(content, 'search', true);
    expect(result).toHaveLength(3);
    expect(result[0]!.type).toBe('lex');
    expect(result[1]!.type).toBe('vec');
    expect(result[2]!.type).toBe('hyde');
  });

  test('strips markdown formatting', () => {
    // Each variant must contain a term from originalQuery.
    // Use "search" as the overlapping term in all three lines.
    const content = 'lex: **bold search**\nvec: "search paraphrase"\nhyde: **search hyde**';
    const result = parseExpandResponse(content, 'search', true);
    expect(result).toHaveLength(3);
    expect(result[0]!.text).toBe('bold search');
    expect(result[1]!.text).toBe('search paraphrase');
    expect(result[2]!.text).toBe('search hyde');
  });

  test('filters out lines without query term overlap', () => {
    const content = 'lex: completely different\nvec: about search thing\nhyde: unrelated text';
    const result = parseExpandResponse(content, 'search', true);
    // "completely different" has no overlap with "search"
    // "about search thing" does
    expect(result).toHaveLength(1);
    expect(result[0]!.text).toContain('search');
  });

  test('returns empty array for unparseable content', () => {
    const result = parseExpandResponse('just some random text\nno colons here', 'query', true);
    expect(result).toEqual([]);
  });

  test('excludes lex when includeLexical is false', () => {
    // All three lines contain "query" so all pass term-overlap check
    const content = 'lex: query keywords\nvec: query paraphrase\nhyde: query excerpt';
    const result = parseExpandResponse(content, 'query', false);
    expect(result).toHaveLength(2);
    expect(result.every((q) => q.type !== 'lex')).toBe(true);
  });

  test('rejects very short texts (>3 chars required)', () => {
    const content = 'lex: ab\nvec: longer text here about search';
    const result = parseExpandResponse(content, 'search', true);
    expect(result).toHaveLength(1); // only vec passes
  });
});

describe('expandFallback', () => {
  test('returns lex, vec, hyde based on raw query', () => {
    const result = expandFallback('my query', true);
    expect(result).toHaveLength(3);
    expect(result.find((q) => q.type === 'hyde')!.text).toContain('my query');
  });

  test('excludes lex when includeLexical is false', () => {
    const result = expandFallback('query', false);
    expect(result.every((q) => q.type !== 'lex')).toBe(true);
    expect(result).toHaveLength(2);
  });
});

describe('expandQuery', () => {
  test('returns passthrough when no API key', async () => {
    const log = spyLogger();
    const cfg: EndpointConfig = { baseUrl: 'http://localhost:1', model: 'm', apiKey: '' };
    const breaker = new CircuitBreaker();
    const result = await expandQuery(cfg, breaker, 'test query', 5000, {}, log);

    expect(result).toEqual([{ type: 'lex', text: 'test query' }]);
    expect(log.calls.some((c) => c.msg.includes('no API key'))).toBe(true);
  });

  test('calls chat completions and parses response', async () => {
    const server = startMockServer(async (req, res) => {
      jsonRes(res, 200, {
        choices: [{
          message: {
            // All variants contain "topic" so all pass term-overlap validation
            content: 'lex: topic keywords\nvec: semantic topic meaning\nhyde: A document discussing the topic',
          },
        }],
        model: 'test-model',
      });
    });

    const cfg: EndpointConfig = { baseUrl: server.url, model: 'm', apiKey: 'sk-test' };
    const breaker = new CircuitBreaker();
    const result = await expandQuery(cfg, breaker, 'topic', 5000, {}, silentLogger);

    expect(result).toHaveLength(3);
    expect(result[0]!.type).toBe('lex');
    await server.close();
  });

  test('falls back when LLM returns unparseable content', async () => {
    const log = spyLogger();
    const server = startMockServer((_req, res) => {
      jsonRes(res, 200, {
        choices: [{ message: { content: 'not in the expected format at all' } }],
        model: 'test',
      });
    });

    const cfg: EndpointConfig = { baseUrl: server.url, model: 'm', apiKey: 'sk-test' };
    const breaker = new CircuitBreaker();
    const result = await expandQuery(cfg, breaker, 'query topic', 5000, {}, log);

    // Should fall back to expandFallback
    expect(result).toHaveLength(3);
    expect(log.calls.some((c) => c.msg.includes('could not parse'))).toBe(true);
    await server.close();
  });

  test('circuit breaker open returns fallback', async () => {
    const log = spyLogger();
    const breaker = new CircuitBreaker(1);
    breaker.onFailure(); // open
    const cfg: EndpointConfig = { baseUrl: 'http://localhost:1', model: 'm', apiKey: 'sk-test' };
    const result = await expandQuery(cfg, breaker, 'test', 5000, {}, log);

    expect(result).toHaveLength(3); // fallback
    expect(log.calls.some((c) => c.msg.includes('circuit breaker is open'))).toBe(true);
  });
});

// =============================================================================
// rerank.ts
// =============================================================================

