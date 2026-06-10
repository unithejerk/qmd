/**
 * Tests for the adapter registry and format→adapter resolution
 * (src/remote/adapters/registry.ts).
 *
 * Covers: resolveAdapterBundle for all four roles (embed, expand, rerank,
 * generate), format→adapter mapping correctness, auto format defaulting
 * to legacy adapters, and explicit format selection for each protocol
 * (openai_chat_completions, cohere_v2_embed, ollama_embed, vllm_pooling,
 * anthropic_messages, etc.).
 */
import { describe, test, expect } from "vitest";
import { resolveAdapterBundle } from "../../src/remote/adapters/registry.js";
import type { EndpointConfig } from "../../src/remote/types.js";


// =============================================================================
// Adapter registry: format → adapter mapping
// =============================================================================

describe('resolveAdapterBundle', () => {
  function ecfg(overrides?: Partial<EndpointConfig>): EndpointConfig {
    return {
      baseUrl: 'http://localhost:1',
      model: 'm',
      apiKey: 'sk',
      format: 'auto',
      ...overrides,
    };
  }

  test('auto format resolves to legacy adapters', () => {
    const bundle = resolveAdapterBundle({
      embed: ecfg({ format: 'auto' }),
      expand: ecfg({ format: 'auto' }),
      rerank: ecfg({ format: 'auto' }),
      generate: ecfg({ format: 'auto' }),
    });
    expect(bundle.expand.id).toBe('legacy/openai-chat-expand');
    expect(bundle.generate.id).toBe('legacy/openai-chat-generate');
  });

  test('openai_chat_completions resolves to chat adapter', () => {
    const bundle = resolveAdapterBundle({
      embed: ecfg(),
      expand: ecfg({ format: 'openai_chat_completions' }),
      rerank: ecfg(),
      generate: ecfg({ format: 'openai_chat_completions' }),
    });
    expect(bundle.expand.id).toBe('openai/chat-completions-expand');
    expect(bundle.generate.id).toBe('openai/chat-completions-generate');
  });

  test('openai_completions resolves to completions adapter', () => {
    const bundle = resolveAdapterBundle({
      embed: ecfg(),
      expand: ecfg({ format: 'openai_completions' }),
      rerank: ecfg(),
      generate: ecfg({ format: 'openai_completions' }),
    });
    expect(bundle.expand.id).toBe('openai/completions-expand');
    expect(bundle.generate.id).toBe('openai/completions-generate');
  });

  test('openai_responses resolves to responses adapter', () => {
    const bundle = resolveAdapterBundle({
      embed: ecfg(),
      expand: ecfg({ format: 'openai_responses' }),
      rerank: ecfg(),
      generate: ecfg({ format: 'openai_responses' }),
    });
    expect(bundle.expand.id).toBe('openai/responses-expand');
    expect(bundle.generate.id).toBe('openai/responses-generate');
  });

  test('anthropic_messages resolves to Anthropic Messages adapter', () => {
    const bundle = resolveAdapterBundle({
      embed: ecfg(),
      expand: ecfg({ format: 'anthropic_messages' }),
      rerank: ecfg(),
      generate: ecfg({ format: 'anthropic_messages' }),
    });
    expect(bundle.expand.id).toBe('anthropic/messages-expand');
    expect(bundle.generate.id).toBe('anthropic/messages-generate');
  });

  test('falls back to legacy on unrecognized format', () => {
    // Missing format defaults to auto → legacy
    const bundle = resolveAdapterBundle({
      embed: ecfg({ format: undefined }),
      expand: ecfg({ format: undefined }),
      rerank: ecfg({ format: undefined }),
      generate: ecfg({ format: undefined }),
    });
    expect(bundle.expand.id).toBe('legacy/openai-chat-expand');
    expect(bundle.generate.id).toBe('legacy/openai-chat-generate');
  });

  test('cohere formats resolve to cohere embed/rerank adapters', () => {
    const bundle = resolveAdapterBundle({
      embed: ecfg({ format: 'cohere_v2_embed' }),
      expand: ecfg({ format: 'openai_chat_completions' }),
      rerank: ecfg({ format: 'cohere_v2_rerank' }),
      generate: ecfg({ format: 'openai_chat_completions' }),
    });
    expect(bundle.embed.id).toBe('cohere/v2-embed');
    expect(bundle.rerank.id).toBe('cohere/rerank');
  });

  test('ollama_embed resolves to Ollama embed adapter', () => {
    const bundle = resolveAdapterBundle({
      embed: ecfg({ format: 'ollama_embed' }),
      expand: ecfg({ format: 'auto' }),
      rerank: ecfg({ format: 'auto' }),
      generate: ecfg({ format: 'auto' }),
    });
    expect(bundle.embed.id).toBe('ollama/embed');
  });

  test('ollama_chat resolves to Ollama chat adapters', () => {
    const bundle = resolveAdapterBundle({
      embed: ecfg({ format: 'auto' }),
      expand: ecfg({ format: 'ollama_chat' }),
      rerank: ecfg({ format: 'auto' }),
      generate: ecfg({ format: 'ollama_chat' }),
    });
    expect(bundle.expand.id).toBe('ollama/chat-expand');
    expect(bundle.generate.id).toBe('ollama/chat-generate');
  });

  test('ollama_generate resolves to Ollama generate adapters', () => {
    const bundle = resolveAdapterBundle({
      embed: ecfg({ format: 'auto' }),
      expand: ecfg({ format: 'ollama_generate' }),
      rerank: ecfg({ format: 'auto' }),
      generate: ecfg({ format: 'ollama_generate' }),
    });
    expect(bundle.expand.id).toBe('ollama/generate-expand');
    expect(bundle.generate.id).toBe('ollama/generate-generate');
  });

  test('vllm_score resolves to vLLM score adapter', () => {
    const bundle = resolveAdapterBundle({
      embed: ecfg({ format: 'auto' }),
      expand: ecfg({ format: 'auto' }),
      rerank: ecfg({ format: 'vllm_score' }),
      generate: ecfg({ format: 'auto' }),
    });
    expect(bundle.rerank.id).toBe('vllm/score');
  });

  test('vllm_pooling resolves to vLLM pooling adapter', () => {
    const bundle = resolveAdapterBundle({
      embed: ecfg({ format: 'vllm_pooling' }),
      expand: ecfg({ format: 'auto' }),
      rerank: ecfg({ format: 'auto' }),
      generate: ecfg({ format: 'auto' }),
    });
    expect(bundle.embed.id).toBe('vllm/pooling');
  });
});

// =============================================================================
// Cohere-compatible embed/rerank adapters
// =============================================================================

