/**
 * llm/types.ts - Pure type definitions for the LLM abstraction layer
 *
 * Contains all interfaces, types, and type aliases shared across the LLM
 * sub-modules. No runtime code, no imports from other llm/ modules — safe
 * to import from any consumer without creating circular dependencies.
 *
 * Defines the contracts for:
 * - The LLM interface (the core abstraction every backend implements)
 * - ILLMSession (scoped session lifecycle)
 * - Result types (EmbeddingResult, GenerateResult, RerankResult)
 * - Options types (EmbedOptions, GenerateOptions, etc.)
 * - Config types (LlamaCppConfig, LlamaGpuMode)
 */

/**
 * A single token with its log probability from the model's output distribution.
 * Used for per-token confidence scoring in generation results.
 */
export type TokenLogProb = {
  /** The decoded token text */
  token: string;
  /** Log probability of this token (negative number, closer to 0 = more likely) */
  logprob: number;
};

/**
 * Result of a single embedding operation.
 * Contains the dense vector and the model that produced it.
 */
export type EmbeddingResult = {
  /** The embedding vector as a flat float array (typically 768 or 1024 dimensions) */
  embedding: number[];
  /** The model URI or name that produced this embedding */
  model: string;
};

/**
 * Result of a text generation operation.
 * Contains the generated text and completion metadata.
 */
export type GenerateResult = {
  /** The generated response text */
  text: string;
  /** The model URI or name that generated this text */
  model: string;
  /** Optional per-token log probabilities for confidence scoring */
  logprobs?: TokenLogProb[];
  /** Whether generation completed within the token budget (always true in current impl) */
  done: boolean;
};

/**
 * A single document's relevance score from a rerank operation.
 * Associates a file path with its relevance score and original index position.
 */
export type RerankDocumentResult = {
  /** The file path of the reranked document */
  file: string;
  /** Relevance score (higher = more relevant, typically 0-1 range) */
  score: number;
  /** Original position in the input documents array (for caller-side sort stability) */
  index: number;
};

/**
 * The full result of a batch rerank operation.
 * Contains an ordered array of scored documents and the model used.
 */
export type RerankResult = {
  /** Results sorted by descending relevance score */
  results: RerankDocumentResult[];
  /** The model URI or name used for reranking */
  model: string;
};

/**
 * Describes whether a model is available for use.
 *
 * For HuggingFace URIs ("hf:org/repo"), `exists` is always true since
 * the file will be downloaded on demand. For local paths, `exists` is
 * based on a filesystem check and `path` is set when the file is found.
 */
export type ModelInfo = {
  /** The model URI or name */
  name: string;
  /** Whether the model is available (always true for HF URIs) */
  exists: boolean;
  /** Local filesystem path, present only when the GGUF file exists on disk */
  path?: string;
};

/**
 * Options for embedding operations.
 */
export type EmbedOptions = {
  /** Override model URI stamped on the result (does not change which
   *  model computes the embedding) */
  model?: string;
  /** Hint that the text is a query (vs a document); used by some backends
   *  for query-side vs corpus-side embedding strategies */
  isQuery?: boolean;
  /** Optional title paired with the text (used by nomic-style formatters) */
  title?: string;
};

/**
 * Options for text generation.
 */
export type GenerateOptions = {
  /** Override model URI (backend-dependent whether a different model is loaded) */
  model?: string;
  /** Maximum tokens to generate (default 150) */
  maxTokens?: number;
  /** Sampling temperature (default 0.7). Avoid 0 — causes repetition loops */
  temperature?: number;
};

/**
 * Options for reranking operations.
 */
export type RerankOptions = {
  /** Override model URI stamped on the result */
  model?: string;
};

/**
 * Options for creating an LLM session via withLLMSession() or
 * withLLMSessionForLlm().
 */
export type LLMSessionOptions = {
  /** Max session duration in ms (default: 10 minutes, 0 to disable) */
  maxDuration?: number;
  /** External AbortSignal that releases the session early */
  signal?: AbortSignal;
  /** Debug name for logging and error messages */
  name?: string;
};

/**
 * Scoped LLM session with lifecycle guarantees.
 *
 * Wraps an underlying LLM instance with reference counting, abort signals,
 * and automatic max-duration enforcement. Sessions are created via
 * withLLMSession() or withLLMSessionForLlm() and are automatically
 * released when the callback completes.
 *
 * All operations check isValid before proceeding and throw
 * SessionReleasedError if the session has been released or aborted.
 * The session's AbortSignal is linked to both the release callback and
 * any external AbortSignal passed via LLMSessionOptions.
 */
export interface ILLMSession {
  /** Compute a vector embedding for text */
  embed(text: string, options?: EmbedOptions): Promise<EmbeddingResult | null>;
  /** Compute vector embeddings for multiple texts */
  embedBatch(texts: string[], options?: EmbedOptions): Promise<(EmbeddingResult | null)[]>;
  /** Expand a query into multiple search variations */
  expandQuery(query: string, options?: { context?: string; includeLexical?: boolean; intent?: string }): Promise<Queryable[]>;
  /** Rerank documents by relevance */
  rerank(query: string, documents: RerankDocument[], options?: RerankOptions): Promise<RerankResult>;
  /** Whether this session is still valid (not released or aborted) */
  readonly isValid: boolean;
  /** Abort signal for this session (aborts on release or maxDuration) */
  readonly signal: AbortSignal;
}

/**
 * The search backend a query expansion is targeted at.
 *   - "lex": lexical / BM25 full-text search
 *   - "vec": vector similarity search
 *   - "hyde": hypothetical document embedding (HyDE — generate a plausible
 *     document snippet, then embed that for retrieval)
 */
export type QueryType = 'lex' | 'vec' | 'hyde';

/**
 * A single expanded search query paired with its target backend type.
 * Produced by expandQuery() and consumed by the search engine to fan out
 * across multiple retrieval strategies.
 */
export type Queryable = {
  /** The search backend this query targets */
  type: QueryType;
  /** The query text (may be a modified/expanded version of the original) */
  text: string;
};

/**
 * A document to be reranked against a query.
 * Contains the file path and text content; title is optional.
 */
export type RerankDocument = {
  /** Source file path (used for display and result mapping) */
  file: string;
  /** Document text content (what gets scored against the query) */
  text: string;
  /** Optional document title */
  title?: string;
};

/**
 * Core LLM abstraction interface — implemented by every backend.
 *
 * Defines the contract for embedding, text generation, query expansion,
 * and reranking. Three implementations exist:
 *   - LlamaCpp (src/llm/llama-cpp.ts): local GGUF models via node-llama-cpp
 *   - RemoteLLM: remote API endpoints (OpenAI-compatible, etc.)
 *   - NoopLlamaCpp (src/llm/singleton.ts): stub returned when remote is
 *     configured, preventing accidental native builds
 *
 * Each backend manages its own model lifecycle and resource cleanup via dispose().
 */
export interface LLM {
  /**
   * Embedding model identifier.
   * URI string used by the store to select the correct format function
   * and passed to searchVec and other vector operations.
   */
  readonly embedModelName: string;

  /**
   * Generation model identifier (optional).
   * Used as a fallback when query expansion requires a different model
   * than the default embedding model.
   */
  readonly generateModelName?: string;

  /**
   * Reranking model identifier (optional).
   * Used as a fallback when reranking requires a specific model.
   */
  readonly rerankModelName?: string;

  /**
   * Compute a vector embedding for a single text string.
   *
   * @param text - The text to embed
   * @param options.model - Override model URI for the result metadata
   * @returns Embedding vector and model name, or null on error
   */
  embed(text: string, options?: EmbedOptions): Promise<EmbeddingResult | null>;

  /**
   * Compute vector embeddings for multiple texts.
   *
   * Results are returned in the same order as the input texts.
   * Per-item errors produce null entries rather than failing the batch.
   *
   * @param texts - Array of texts to embed
   * @param options.model - Override model URI for result metadata
   * @returns Array of results in input order (null for failures)
   */
  embedBatch(texts: string[], options?: EmbedOptions): Promise<(EmbeddingResult | null)[]>;

  /**
   * Generate text from a prompt.
   *
   * @param prompt - The input prompt
   * @param options.maxTokens - Maximum tokens to generate
   * @param options.temperature - Sampling temperature
   * @returns Generated text result, or null on error/unsupported
   */
  generate(prompt: string, options?: GenerateOptions): Promise<GenerateResult | null>;

  /**
   * Check whether a model URI is available for use.
   *
   * @param model - The model URI to check
   * @returns ModelInfo with existence status and optional local path
   */
  modelExists(model: string): Promise<ModelInfo>;

  /**
   * Expand a search query into multiple variations for different backends.
   *
   * Returns Queryable objects tagged by search type:
   *   - "lex": lexical/BM25 search query
   *   - "vec": vector similarity search query
   *   - "hyde": hypothetical document embedding query
   *
   * @param query - The raw user search query
   * @param options.context - Optional context to guide expansion
   * @param options.includeLexical - Include lexical expansions (default true)
   * @param options.intent - Optional query intent description
   * @returns Array of expanded queries
   */
  expandQuery(query: string, options?: { context?: string; includeLexical?: boolean; intent?: string }): Promise<Queryable[]>;

  /**
   * Rerank documents by relevance to a query.
   *
   * @param query - The query to evaluate relevance against
   * @param documents - Documents to rerank (file path + text content)
   * @param options.model - Override model URI for result metadata
   * @returns Results sorted by descending relevance score
   */
  rerank(query: string, documents: RerankDocument[], options?: RerankOptions): Promise<RerankResult>;

  /**
   * Release all native resources held by this backend.
   *
   * Must be safe to call multiple times (subsequent calls are no-ops).
   * After dispose(), the instance must not be used.
   */
  dispose(): Promise<void>;
}

/**
 * Configuration options for the LlamaCpp backend.
 *
 * All properties are optional — defaults are resolved from environment
 * variables or built-in constants (see resolveEmbedModel, resolveLlamaGpuMode,
 * etc.).
 */
export type LlamaCppConfig = {
  /** Embedding model URI override (default: resolved by resolveEmbedModel) */
  embedModel?: string;
  /** Generation model URI override (default: resolved by resolveGenerateModel) */
  generateModel?: string;
  /** Reranking model URI override (default: resolved by resolveRerankModel) */
  rerankModel?: string;
  /** Model file cache directory (default: ~/.cache/qmd/models) */
  modelCacheDir?: string;
  /**
   * Context size used for query expansion generation contexts.
   * Default: 2048. Can also be set via QMD_EXPAND_CONTEXT_SIZE.
   */
  expandContextSize?: number;
  /**
   * Inactivity timeout in ms before unloading contexts (default: 5 minutes, 0 to disable).
   *
   * Per node-llama-cpp lifecycle guidance, we prefer keeping models loaded and only disposing
   * contexts when idle, since contexts (and their sequences) are the heavy per-session objects.
   * @see https://node-llama-cpp.withcat.ai/guide/objects-lifecycle
   */
  inactivityTimeoutMs?: number;
  /**
   * Whether to dispose models on inactivity (default: false).
   *
   * Keeping models loaded avoids repeated VRAM thrash; set to true only if you need aggressive
   * memory reclaim.
   */
  disposeModelsOnInactivity?: boolean;
};

/**
 * GPU backend mode for llama.cpp.
 *   - "auto": let node-llama-cpp auto-detect (default)
 *   - "metal": Apple Silicon GPU acceleration
 *   - "vulkan": Vulkan GPU acceleration
 *   - "cuda": NVIDIA CUDA GPU acceleration
 *   - false: CPU only (no GPU offloading)
 */
export type LlamaGpuMode = "auto" | "metal" | "vulkan" | "cuda" | false;
