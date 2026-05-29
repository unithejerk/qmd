/**
 * config.ts — Environment variable and YAML config resolution for remote endpoints.
 *
 * Resolves endpoint configuration from three sources in priority order:
 * 1. Environment variables (QMD_{ENDPOINT}_BASE_URL, QMD_{ENDPOINT}_MODEL, QMD_{ENDPOINT}_API_KEY)
 * 2. YAML models config (embed_api_url, expand_api_model, etc.)
 * 3. Hardcoded defaults (OpenRouter for expand/rerank/generate, localhost:11434 for embed)
 *
 * ## Design principle
 *
 * Local-first: ALL endpoints default to empty (local LlamaCpp) unless
 * explicitly configured via env vars or YAML. No remote URLs are assumed.
 *
 * @module remote/config
 */

import type { ModelsConfig } from '../collections.js';
import type { EndpointConfig, RemoteLLMConfig } from './types.js';

/** Default OpenRouter API base URL. Used when no expand/rerank URL is configured. */
export const OPENROUTER_DEFAULT_URL = 'https://openrouter.ai/api/v1';

// =============================================================================
// resolveEndpoint
// =============================================================================

/**
 * Build an EndpointConfig from environment variables with defaults.
 *
 * Follows the pattern:
 *   baseUrl = QMD_{SUFFIX}_BASE_URL || urlDefault
 *   model   = QMD_{SUFFIX}_MODEL || modelDefault
 *   apiKey  = QMD_{SUFFIX}_API_KEY || OPENAI_API_KEY
 *
 * @param _name        - Human-readable endpoint name (for logging, currently unused)
 * @param envSuffix    - Uppercase env var suffix (e.g. "EMBED", "RERANK")
 * @param modelDefault - Fallback model name if no env var is set
 * @param urlDefault   - Fallback base URL if no env var is set
 * @returns Resolved EndpointConfig
 */
export function resolveEndpoint(
  _name: string,
  envSuffix: string,
  modelDefault: string,
  urlDefault: string,
): EndpointConfig {
  const baseUrl =
    (process.env[`QMD_${envSuffix}_BASE_URL`] || urlDefault).replace(/\/+$/, '');
  const model = process.env[`QMD_${envSuffix}_MODEL`] || modelDefault;
  const apiKey = (
    process.env[`QMD_${envSuffix}_API_KEY`] ||
    process.env.OPENAI_API_KEY ||
    ''
  ).trim();
  return { baseUrl, model, apiKey };
}

// =============================================================================
// remoteConfigFromEnv
// =============================================================================

/**
 * Resolve a full RemoteLLMConfig from environment variables and optional
 * YAML models config.
 *
 * ## Priority chain (per endpoint)
 *
 * 1. Environment variables (QMD_{ENDPOINT}_BASE_URL, QMD_{ENDPOINT}_MODEL, QMD_{ENDPOINT}_API_KEY)
 * 2. YAML models config (embed_api_url, expand_api_model, etc.)
 * 3. OPENAI_* fallback (only for embed endpoint: OPENAI_BASE_URL, OPENAI_API_KEY)
 * 4. Local-first default: empty baseUrl → falls back to local LlamaCpp
 *
 * @param models - Optional YAML models config from loadConfig()
 * @returns Resolved RemoteLLMConfig with all four endpoints populated
 */
export function remoteConfigFromEnv(models?: ModelsConfig): RemoteLLMConfig {
  // --- Embed ---
  const embed: EndpointConfig = {
    baseUrl: (
      process.env.QMD_EMBED_BASE_URL ||
      models?.embed_api_url ||
      process.env.OPENAI_BASE_URL ||
      ''
    ).replace(/\/+$/, ''),
    model: process.env.QMD_EMBED_MODEL || models?.embed_api_model || '',
    apiKey: (
      process.env.QMD_EMBED_API_KEY ||
      models?.embed_api_key ||
      process.env.OPENAI_API_KEY ||
      ''
    ).trim(),
  };

  // --- Expand ---
  const expand: EndpointConfig = {
    baseUrl: (
      process.env.QMD_EXPAND_BASE_URL ||
      models?.expand_api_url ||
      ''
    ).replace(/\/+$/, ''),
    model: process.env.QMD_EXPAND_MODEL || models?.expand_api_model || '',
    apiKey: (
      process.env.QMD_EXPAND_API_KEY ||
      models?.expand_api_key ||
      process.env.OPENAI_API_KEY ||
      ''
    ).trim(),
  };

  // --- Rerank ---
  const rerank: EndpointConfig = {
    baseUrl: (
      process.env.QMD_RERANK_BASE_URL ||
      models?.rerank_api_url ||
      ''
    ).replace(/\/+$/, ''),
    model: process.env.QMD_RERANK_MODEL || models?.rerank_api_model || '',
    apiKey: (
      process.env.QMD_RERANK_API_KEY ||
      models?.rerank_api_key ||
      process.env.OPENAI_API_KEY ||
      ''
    ).trim(),
  };

  // --- Generate ---
  const generate: EndpointConfig = {
    baseUrl: (
      process.env.QMD_GENERATE_BASE_URL ||
      models?.generate_api_url ||
      ''
    ).replace(/\/+$/, ''),
    model: process.env.QMD_GENERATE_MODEL || models?.generate_api_model || '',
    apiKey: (
      process.env.QMD_GENERATE_API_KEY ||
      models?.generate_api_key ||
      process.env.OPENAI_API_KEY ||
      ''
    ).trim(),
  };

  return { embed, expand, rerank, generate };
}
