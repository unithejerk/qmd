/**
 * llm.ts - Barrel / re-export module for the LLM abstraction layer
 *
 * Collects and re-exports all public symbols from the llm/ sub-modules (types,
 * model-cache, formatting, llama-cpp, session, singleton) so consumers can
 * import everything from a single path.
 *
 * A few thin function wrappers are defined here to break circular dependencies
 * between sub-modules:
 *   - pullModels() — injects the node-llama-cpp loader callback that
 *     model-cache.ts needs but cannot import directly.
 *   - formatQueryForEmbedding() / formatDocForEmbedding() — delegate to
 *     formatting.ts after resolving the active model URI.
 *   - isQwen3EmbeddingModel() / isRemoteModel() — delegate to formatting.ts.
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
 *
 * Qwen3-Embedding uses a different prompting style (instruct format with
 * task instruction + query/doc) than the default nomic/embeddinggemma style
 * (task-prefixed or title/text JSON). The embedding store uses this to
 * select the correct format function.
 *
 * Detection rule: returns true when the URI contains "qwen" (case-insensitive)
 * AND contains "embed" (case-insensitive). Returns false for all other URIs
 * including local GGUF paths and "hf:" URIs for non-Qwen models.
 *
 * @param modelUri - The model URI to check (e.g. "hf:Qwen/Qwen3-Embedding-GGUF")
 * @returns true if the model is a Qwen3 embedding variant
 */
export function isQwen3EmbeddingModel(modelUri: string): boolean {
  return isQwen3EmbeddingModelInternal(modelUri);
}

/**
 * Detect if a model URI refers to a remote API model (not a local GGUF model).
 *
 * Remote models handle their own prompt formatting, so no local prefixes
 * (nomic-style task prefixes or Qwen3 instruct templates) should be added.
 * This check is used by formatQueryForEmbedding and formatDocForEmbedding
 * to skip formatting when true.
 *
 * Detection rule: a model is considered remote when it does NOT start with
 * "hf:" AND does NOT end with ".gguf". Both Hugging Face URIs
 * ("hf:org/repo") and local file paths ("/path/to/model.gguf") are treated
 * as local. Everything else (pure names, OpenAIs, etc.) is remote.
 *
 * @param modelUri - The model URI to check
 * @returns true if the model is remote (non-GGUF, non-HF)
 */
export function isRemoteModel(modelUri: string): boolean {
  return isRemoteModelInternal(modelUri);
}

/**
 * Format a query string for embedding.
 *
 * Applies a model-appropriate prompt template so the embedding model
 * can distinguish queries from documents. Behaviour depends on the
 * active embedding model:
 *   - Default (nomic/embeddinggemma): prepends "search_query: "
 *   - Qwen3-Embedding: wraps in an instruct-style template with
 *     task instruction and "Query: " prefix
 *   - Remote models: returns the raw query text unchanged (the
 *     remote endpoint handles its own formatting)
 *
 * @param query - The raw search query text
 * @param modelUri - Optional explicit model URI; defaults to resolveEmbedModel()
 * @returns Formatted query string suitable for the active embedding model
 */
export function formatQueryForEmbedding(query: string, modelUri?: string): string {
  const uri = modelUri ?? resolveEmbedModel();
  return formatQueryForEmbeddingWithModel(query, uri);
}

/**
 * Format a document chunk for embedding.
 *
 * Wraps document text in an embedding-friendly template so the model
 * can represent the document in vector space. Behaviour depends on the
 * active embedding model:
 *   - Default (nomic/embeddinggemma): formats as JSON-like
 *     "search_document: {\"title\": \"...\", \"text\": \"...\"}"
 *   - Qwen3-Embedding: returns the raw text without any prefix
 *   - Remote models: returns the raw text unchanged (remote endpoint
 *     handles its own formatting)
 *
 * @param text - The document text to format
 * @param title - Optional document title (only used by nomic-style formatters)
 * @param modelUri - Optional explicit model URI; defaults to resolveEmbedModel()
 * @returns Formatted document string suitable for the active embedding model
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

/**
 * Download and cache GGUF model files from Hugging Face.
 *
 * Wraps the model-cache implementation, injecting the node-llama-cpp
 * loader callback that resolveModelFile needs to download HF URIs.
 * This indirection exists because model-cache.ts cannot import
 * llama-cpp.ts (it would create a circular dependency through the
 * native module loader).
 *
 * @param models - Array of model URIs (e.g. "hf:unsloth/Qwen3-1.7B-GGUF")
 * @param options.refresh - Re-download even if already cached (default false)
 * @param options.cacheDir - Override the default model cache directory
 * @returns Array of PullResult objects with download status per model
 */
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
