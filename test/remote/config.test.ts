/**
 * Tests for remote endpoint configuration resolution (src/remote/config.ts).
 *
 * Covers: resolveEndpoint (env-var → default fallback chain),
 * remoteConfigFromEnv (full multi-endpoint config from env + YAML models),
 * resolveEndpointFormat (format string normalization, alias resolution,
 * per-endpoint allowlist validation). Validates local-first defaults:
 * all endpoints default to empty when no remote config is set.
 */
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { resolveEndpoint, remoteConfigFromEnv, OPENROUTER_DEFAULT_URL, resolveEndpointFormat } from "../../src/remote/config.js";
import type { EndpointConfig } from "../../src/remote/types.js";


// =============================================================================
// config.ts
// =============================================================================

describe('resolveEndpoint', () => {
  test('uses env vars when set', () => {
    process.env.QMD_TEST_MODEL = 'env-model';
    process.env.QMD_TEST_BASE_URL = 'http://env:1234/v1';
    const result = resolveEndpoint('test', 'TEST', 'default-model', 'http://default:8000/v1');
    expect(result.model).toBe('env-model');
    expect(result.baseUrl).toBe('http://env:1234/v1');
    delete process.env.QMD_TEST_MODEL;
    delete process.env.QMD_TEST_BASE_URL;
  });

  test('falls back to defaults when env vars are unset', () => {
    const result = resolveEndpoint('test', 'NONEXISTENT', 'default-model', 'http://default:8000/v1');
    expect(result.model).toBe('default-model');
    expect(result.baseUrl).toBe('http://default:8000/v1');
  });

  test('trims trailing slash from baseUrl', () => {
    process.env.QMD_TRIM_BASE_URL = 'http://example.com/v1/';
    const result = resolveEndpoint('trim', 'TRIM', 'model', 'http://default/v1');
    expect(result.baseUrl).toBe('http://example.com/v1');
    delete process.env.QMD_TRIM_BASE_URL;
  });
});

describe('remoteConfigFromEnv', () => {
  // Save/restore env vars that may be set in the test environment
  const saveEnv = (key: string) => ({ key, val: process.env[key] });
  const restoreEnv = (...saved: Array<{ key: string; val: string | undefined }>) => {
    for (const { key, val } of saved) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  };

  test('returns empty baseUrls when nothing is configured (local-first)', () => {
    const saved = [
      saveEnv('QMD_EMBED_BASE_URL'), saveEnv('QMD_EMBED_MODEL'),
      saveEnv('QMD_EXPAND_BASE_URL'), saveEnv('QMD_EXPAND_MODEL'),
      saveEnv('QMD_RERANK_BASE_URL'), saveEnv('QMD_RERANK_MODEL'),
      saveEnv('QMD_GENERATE_BASE_URL'), saveEnv('QMD_GENERATE_MODEL'),
      saveEnv('OPENAI_BASE_URL'), saveEnv('OPENAI_API_KEY'),
    ];
    for (const { key } of saved) delete process.env[key];

    const config = remoteConfigFromEnv();
    expect(config.embed!.baseUrl).toBe('');
    expect(config.expand!.baseUrl).toBe('');
    expect(config.rerank!.baseUrl).toBe('');
    expect(config.generate!.baseUrl).toBe('');

    restoreEnv(...saved);
  });

  test('picks up YAML config for all endpoints', () => {
    const saved = [
      saveEnv('QMD_EMBED_BASE_URL'), saveEnv('QMD_EMBED_MODEL'),
      saveEnv('QMD_EXPAND_BASE_URL'), saveEnv('QMD_EXPAND_MODEL'),
      saveEnv('QMD_RERANK_BASE_URL'), saveEnv('QMD_RERANK_MODEL'),
      saveEnv('QMD_GENERATE_BASE_URL'), saveEnv('QMD_GENERATE_MODEL'),
      saveEnv('OPENAI_BASE_URL'), saveEnv('OPENAI_API_KEY'),
    ];
    for (const { key } of saved) delete process.env[key];

    const config = remoteConfigFromEnv({
      embed_api_url: 'http://embed:8000/v1',
      embed_api_format: 'cohere_v2_embed',
      embed_api_model: 'embed-model',
      expand_api_url: 'http://expand:8000/v1',
      expand_api_format: 'openai_chat_completions',
      expand_api_model: 'expand-model',
      rerank_api_url: 'http://rerank:8000/v1',
      rerank_api_format: 'cohere_v1_rerank',
      rerank_api_model: 'rerank-model',
      generate_api_url: 'http://generate:8000/v1',
      generate_api_format: 'anthropic_messages',
      generate_api_model: 'gen-model',
    });
    expect(config.embed!.baseUrl).toBe('http://embed:8000/v1');
    expect(config.embed!.model).toBe('embed-model');
    expect(config.embed!.format).toBe('cohere_v2_embed');
    expect(config.expand!.baseUrl).toBe('http://expand:8000/v1');
    expect(config.expand!.format).toBe('openai_chat_completions');
    expect(config.rerank!.baseUrl).toBe('http://rerank:8000/v1');
    expect(config.rerank!.format).toBe('cohere_v1_rerank');
    expect(config.generate!.baseUrl).toBe('http://generate:8000/v1');
    expect(config.generate!.format).toBe('anthropic_messages');

    restoreEnv(...saved);
  });

  test('OPENAI_BASE_URL fallback for embed endpoint', () => {
    const saved = [saveEnv('QMD_EMBED_BASE_URL')];
    delete process.env.QMD_EMBED_BASE_URL;
    process.env.OPENAI_BASE_URL = 'http://openai:8000/v1';
    const config = remoteConfigFromEnv();
    expect(config.embed!.baseUrl).toBe('http://openai:8000/v1');
    delete process.env.OPENAI_BASE_URL;
    restoreEnv(...saved);
  });

  test('defaults endpoint formats to auto', () => {
    const saved = [
      saveEnv('QMD_EMBED_API_FORMAT'),
      saveEnv('QMD_EXPAND_API_FORMAT'),
      saveEnv('QMD_RERANK_API_FORMAT'),
      saveEnv('QMD_GENERATE_API_FORMAT'),
    ];
    for (const { key } of saved) delete process.env[key];

    const config = remoteConfigFromEnv();
    expect(config.embed!.format).toBe('auto');
    expect(config.expand!.format).toBe('auto');
    expect(config.rerank!.format).toBe('auto');
    expect(config.generate!.format).toBe('auto');

    restoreEnv(...saved);
  });

  test('supports short format aliases from env', () => {
    const saved = [saveEnv('QMD_EMBED_API_FORMAT'), saveEnv('QMD_RERANK_API_FORMAT')];
    process.env.QMD_EMBED_API_FORMAT = 'openai_v1';
    process.env.QMD_RERANK_API_FORMAT = 'cohere_rerank';

    const config = remoteConfigFromEnv();
    expect(config.embed!.format).toBe('openai_v1_embeddings');
    expect(config.rerank!.format).toBe('cohere_v2_rerank');

    restoreEnv(...saved);
  });

  test('throws on invalid endpoint format', () => {
    const saved = [saveEnv('QMD_EMBED_API_FORMAT')];
    process.env.QMD_EMBED_API_FORMAT = 'totally_invalid_format';
    expect(() => remoteConfigFromEnv()).toThrow(/Invalid embed API format/);
    restoreEnv(...saved);
  });

  test('throws when format is unsupported for endpoint role', () => {
    const saved = [saveEnv('QMD_EMBED_API_FORMAT')];
    process.env.QMD_EMBED_API_FORMAT = 'anthropic_messages';
    expect(() => remoteConfigFromEnv()).toThrow(/Allowed formats for embed/);
    restoreEnv(...saved);
  });
});

describe('resolveEndpointFormat', () => {
  test('returns auto when no env/yaml format is set', () => {
    expect(resolveEndpointFormat('embed', 'EMBED')).toBe('auto');
  });

  test('normalizes dash/space variants', () => {
    expect(resolveEndpointFormat('expand', 'EXPAND', 'openai-chat')).toBe('openai_chat_completions');
  });

  test('accepts ollama_chat and ollama_generate for expand/generate roles', () => {
    expect(resolveEndpointFormat('expand', 'EXPAND', 'ollama_chat')).toBe('ollama_chat');
    expect(resolveEndpointFormat('generate', 'GENERATE', 'ollama_generate')).toBe('ollama_generate');
  });
});

// =============================================================================
// embed.ts
// =============================================================================

