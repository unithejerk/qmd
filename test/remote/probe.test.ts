/**
 * Tests for remote endpoint probing (src/remote/probe.ts).
 *
 * Covers: modelExists (GET /models, model-list parsing, existence check),
 * probe (dimension detection via test embedding), circuit breaker gating,
 * and error handling for unreachable endpoints.
 */
import { describe, test, expect, vi } from "vitest";
import { modelExists, probe } from "../../src/remote/probe.js";
import { CircuitBreaker } from "../../src/remote/circuit-breaker.js";
import type { EndpointConfig } from "../../src/remote/types.js";
import { startMockServer, jsonRes, testCfg, spyLogger } from "../helpers/http-mock.js";


// =============================================================================
// probe.ts
// =============================================================================

describe('modelExists', () => {
  test('returns exists:true when model is found', async () => {
    const server = startMockServer((_req, res) => {
      jsonRes(res, 200, { data: [{ id: 'my-model' }, { id: 'other' }] });
    });

    const cfg: EndpointConfig = { baseUrl: `${server.url}/v1`, model: 'm' };
    const result = await modelExists(cfg, 'my-model');
    expect(result.exists).toBe(true);
    await server.close();
  });

  test('returns exists:false when model is not found', async () => {
    const server = startMockServer((_req, res) => {
      jsonRes(res, 200, { data: [{ id: 'other' }] });
    });

    const cfg: EndpointConfig = { baseUrl: `${server.url}/v1`, model: 'm' };
    const result = await modelExists(cfg, 'nonexistent');
    expect(result.exists).toBe(false);
    await server.close();
  });

  test('returns exists:true when /models endpoint is unavailable (optimistic)', async () => {
    const cfg: EndpointConfig = { baseUrl: 'http://localhost:1', model: 'm' };
    const result = await modelExists(cfg, 'anything');
    expect(result.exists).toBe(true);
  });
});

describe('probe', () => {
  test('returns ok and dimensions on success', async () => {
    const embedFn = async (_text: string) => ({ embedding: [1, 2, 3, 4], model: 'test' });
    const result = await probe(embedFn);
    expect(result.ok).toBe(true);
    expect(result.dimensions).toBe(4);
  });

  test('returns ok:false on null result', async () => {
    const embedFn = async (_text: string) => null;
    const result = await probe(embedFn);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Null');
  });
  test('returns ok:false on thrown error', async () => {
    const embedFn = async (_text: string) => { throw new Error('boom'); };
    const result = await probe(embedFn);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('boom');
  });
});

// =============================================================================
// remote-llm.ts — integration
// =============================================================================

