/**
 * Tests for remote tokenizer endpoints (src/remote/tokenizer.ts).
 *
 * Covers: /tokenize (text→token-IDs with /v1/tokenize fallback),
 * /detokenize (token-IDs→text with /v1/detokenize fallback),
 * remoteTokenizerAvailable (probing endpoint accessibility),
 * and graceful fallback when tokenizer endpoints are unavailable.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import * as http from "http";
import type { AddressInfo } from "net";
import { remoteTokenize, remoteDetokenize, remoteTokenizerAvailable } from "../../src/remote/tokenizer.js";
import { startMockServer, readBody, jsonRes, testCfg } from "../helpers/http-mock.js";


describe('remote tokenizer endpoints', () => {
  test('for /v1 baseUrl, tokenization hits root /tokenize (not /v1/tokenize)', async () => {
    const paths: string[] = [];
    const server = startMockServer(async (req, res) => {
      paths.push(req.url || '');
      if (req.url === '/tokenize') {
        jsonRes(res, 200, { count: 3, max_model_len: 8192, tokens: [11, 22, 33] });
        return;
      }
      jsonRes(res, 404, { error: 'not found' });
    });

    const tokens = await remoteTokenize(
      { baseUrl: `${server.url}/v1`, model: 'test-embed-model' },
      'hello world',
    );

    expect(tokens).toEqual([11, 22, 33]);
    expect(paths[0]).toBe('/tokenize');
    await server.close();
  });

  test('tokenization falls back from /tokenize to /v1/tokenize when needed', async () => {
    const paths: string[] = [];
    const server = startMockServer(async (req, res) => {
      paths.push(req.url || '');
      if (req.url === '/tokenize') {
        jsonRes(res, 404, { error: 'not found' });
        return;
      }
      if (req.url === '/v1/tokenize') {
        jsonRes(res, 200, { count: 2, max_model_len: 8192, tokens: [1, 2] });
        return;
      }
      jsonRes(res, 404, { error: 'not found' });
    });

    const tokens = await remoteTokenize(
      { baseUrl: server.url, model: 'test-embed-model' },
      'fallback please',
    );

    expect(tokens).toEqual([1, 2]);
    expect(paths.slice(0, 2)).toEqual(['/tokenize', '/v1/tokenize']);
    await server.close();
  });

  test('detokenization posts to /detokenize and returns prompt text', async () => {
    const paths: string[] = [];
    const server = startMockServer(async (req, res) => {
      paths.push(req.url || '');
      if (req.url === '/detokenize') {
        const body = await readBody(req) as { tokens?: number[] };
        expect(body.tokens).toEqual([5, 6, 7]);
        jsonRes(res, 200, { prompt: 'decoded text' });
        return;
      }
      jsonRes(res, 404, { error: 'not found' });
    });

    const text = await remoteDetokenize(
      { baseUrl: `${server.url}/v1`, model: 'test-embed-model' },
      [5, 6, 7],
    );

    expect(text).toBe('decoded text');
    expect(paths[0]).toBe('/detokenize');
    await server.close();
  });

  test('remoteTokenizerAvailable returns false when endpoint is missing', async () => {
    const server = startMockServer((_req, res) => {
      jsonRes(res, 404, { error: 'not found' });
    });

    const ok = await remoteTokenizerAvailable({
      baseUrl: server.url,
      model: 'test-embed-model',
    });
    expect(ok).toBe(false);
    await server.close();
  });
});

