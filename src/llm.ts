/**
 * llm.ts - LLM abstraction layer for QMD using node-llama-cpp
 *
 * Provides embeddings, text generation, and reranking using local GGUF models.
 */

import {
  isQwen3EmbeddingModel as isQwen3EmbeddingModelInternal,
  isRemoteModel as isRemoteModelInternal,
  formatQueryForEmbeddingWithModel,
  formatDocForEmbeddingWithModel,
} from "./llm/formatting.js";
import {
  resolveEmbedModel,
  resolveGenerateModel,
  resolveRerankModel,
  DEFAULT_MODEL_CACHE_DIR as MODEL_CACHE_DIR,
  pullModels as pullModelsImpl,
} from "./llm/model-cache.js";
import type { PullResult } from "./llm/model-cache.js";
import type { LlamaGpuMode, LlamaCppConfig } from "./llm/types.js";

// =============================================================================
// Embedding Formatting Functions
// =============================================================================

/**
 * Detect if a model URI uses the Qwen3-Embedding format.
 * Qwen3-Embedding uses a different prompting style than nomic/embeddinggemma.
 */
export function isQwen3EmbeddingModel(modelUri: string): boolean {
  return isQwen3EmbeddingModelInternal(modelUri);
}

/**
 * Detect if a model URI refers to a remote API model (not a local GGUF model).
 * Remote models handle their own prompt formatting, so no prefixes should be added.
 * Returns true for model names that don't start with "hf:" and don't end in ".gguf".
 */
export function isRemoteModel(modelUri: string): boolean {
  return isRemoteModelInternal(modelUri);
}

/**
 * Format a query for embedding.
 * Uses nomic-style task prefix format for embeddinggemma (default).
 * Uses Qwen3-Embedding instruct format when a Qwen embedding model is active.
 * Remote models receive raw text — they handle their own formatting.
 */
export function formatQueryForEmbedding(query: string, modelUri?: string): string {
  const uri = modelUri ?? resolveEmbedModel();
  return formatQueryForEmbeddingWithModel(query, uri);
}

/**
 * Format a document for embedding.
 * Uses nomic-style format with title and text fields (default).
 * Qwen3-Embedding encodes documents as raw text without special prefixes.
 * Remote models receive raw text — they handle their own formatting.
 */
export function formatDocForEmbedding(text: string, title?: string, modelUri?: string): string {
  const uri = modelUri ?? resolveEmbedModel();
  return formatDocForEmbeddingWithModel(text, title, uri);
}

// =============================================================================
// Re-exports from types.ts
// =============================================================================

export type {
  TokenLogProb,
  EmbeddingResult,
  GenerateResult,
  RerankDocumentResult,
  RerankResult,
  ModelInfo,
  EmbedOptions,
  GenerateOptions,
  RerankOptions,
  LLMSessionOptions,
  ILLMSession,
  QueryType,
  Queryable,
  RerankDocument,
  LLM,
  LlamaCppConfig,
  LlamaGpuMode,
} from "./llm/types.js";

// =============================================================================
// Re-exports from model-cache.ts
// =============================================================================

export {
  DEFAULT_EMBED_MODEL_URI,
  DEFAULT_RERANK_MODEL_URI,
  DEFAULT_GENERATE_MODEL_URI,
  LFM2_GENERATE_MODEL,
  LFM2_INSTRUCT_MODEL,
  DEFAULT_MODEL_CACHE_DIR,
  type ModelResolutionConfig,
  resolveEmbedModel,
  resolveGenerateModel,
  resolveRerankModel,
  resolveModels,
  type PullResult,
  type GgufFileInspection,
  inspectGgufFile,
  validateGgufFile,
} from "./llm/model-cache.js";

// pullModels wrapper -- model-cache version requires a node-llama-cpp loader callback
export async function pullModels(
  models: string[],
  options: { refresh?: boolean; cacheDir?: string } = {}
): Promise<PullResult[]> {
  const { loadNodeLlamaCpp } = await import("./llm/llama-cpp.js");
  return pullModelsImpl(models, loadNodeLlamaCpp, options);
}

// =============================================================================
// Re-exports from llama-cpp.ts
// =============================================================================

export {
  LlamaCpp,
  resolveLlamaGpuMode,
  resolveSafeParallelism,
  resolveParallelismOverride,
  setNodeLlamaCppModuleForTest,
  withNativeStdoutRedirectedToStderr,
} from "./llm/llama-cpp.js";

// =============================================================================
// Re-exports from session.ts
// =============================================================================

export {
  SessionReleasedError,
  withLLMSession,
  withLLMSessionForLlm,
  canUnloadLLM,
} from "./llm/session.js";

// =============================================================================
// Re-exports from llm/singleton
// =============================================================================

export {
  getDefaultLlamaCpp,
  isDarwinMetalMitigationActive,
  installDarwinExitGuard,
  isDarwinExitGuardInstalled,
  NoopLlamaCpp,
  isRemoteConfigured,
  setDefaultLlamaCpp,
  hasDefaultLlamaCpp,
  disposeDefaultLlamaCpp,
} from "./llm/singleton.js";
