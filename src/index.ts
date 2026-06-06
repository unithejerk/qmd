/**
 * QMD SDK - Public library entry point for programmatic access to QMD
 * search, indexing, and collection management.
 *
 * The primary export is `createStore()`, which wraps the internal SQLite store
 * with write-through YAML config sync and automatic LlamaCpp lifecycle. All
 * SDK types (QMDStore, SearchOptions, StoreOptions, etc.) are exported for
 * consumers writing TypeScript.
 *
 * Usage:
 * ```typescript
 * import { createStore } from '@tobilu/qmd'
 *
 * const store = await createStore({
 *   dbPath: './my-index.sqlite',
 *   config: {
 *     collections: {
 *       docs: { path: '/path/to/docs', pattern: '**\/*.md' }
 *     }
 *   }
 * })
 *
 * const results = await store.search({ query: "how does auth work?" })
 * await store.close()
 * ```
 *
 * @module
 */

import {
  createStore as createStoreInternal,
  hybridQuery,
  structuredSearch,
  extractSnippet,
  addLineNumbers,
  DEFAULT_MULTI_GET_MAX_BYTES,
  reindexCollection,
  generateEmbeddings,
  listCollections as storeListCollections,
  syncConfigToDb,
  getStoreCollections,
  getStoreCollection,
  getStoreGlobalContext,
  getStoreContexts,
  upsertStoreCollection,
  deleteStoreCollection,
  renameStoreCollection,
  updateStoreContext,
  removeStoreContext,
  setStoreGlobalContext,
  vacuumDatabase,
  cleanupOrphanedContent,
  cleanupOrphanedVectors,
  deleteLLMCache,
  deleteInactiveDocuments,
  clearAllEmbeddings,
  type Store as InternalStore,
  type DocumentResult,
  type DocumentNotFound,
  type SearchResult,
  type HybridQueryResult,
  type HybridQueryOptions,
  type HybridQueryExplain,
  type ExpandedQuery,
  type StructuredSearchOptions,
  type MultiGetResult,
  type IndexStatus,
  type IndexHealthInfo,
  type SearchHooks,
  type ReindexProgress,
  type ReindexResult,
  type EmbedProgress,
  type EmbedResult,
  type ChunkStrategy,
} from "./store.js";
import {
  LlamaCpp,
  type LLM,
} from "./llm.js";
import {
  setConfigSource,
  loadConfig,
  addCollection as collectionsAddCollection,
  removeCollection as collectionsRemoveCollection,
  renameCollection as collectionsRenameCollection,
  addContext as collectionsAddContext,
  removeContext as collectionsRemoveContext,
  setGlobalContext as collectionsSetGlobalContext,
  type Collection,
  type CollectionConfig,
  type NamedCollection,
  type ContextMap,
} from "./collections.js";

// Re-export types for SDK consumers
export type {
  DocumentResult,
  DocumentNotFound,
  SearchResult,
  HybridQueryResult,
  HybridQueryOptions,
  HybridQueryExplain,
  ExpandedQuery,
  StructuredSearchOptions,
  MultiGetResult,
  IndexStatus,
  IndexHealthInfo,
  SearchHooks,
  ReindexProgress,
  ReindexResult,
  EmbedProgress,
  EmbedResult,
  Collection,
  CollectionConfig,
  NamedCollection,
  ContextMap,
};

// Re-export the internal Store type for advanced consumers
export type { InternalStore };

// Re-export utility functions and types used by frontends
export { extractSnippet, addLineNumbers, DEFAULT_MULTI_GET_MAX_BYTES };
export type { ChunkStrategy } from "./store.js";

// Re-export getDefaultDbPath for CLI/MCP that need the default database location
export { getDefaultDbPath } from "./store.js";

// Re-export Maintenance class for CLI housekeeping operations
export { Maintenance } from "./maintenance.js";

/**
 * Progress info emitted during update() for each file processed.
 */
export type UpdateProgress = {
  collection: string;
  file: string;
  current: number;
  total: number;
};

/**
 * Aggregated result from update() across all collections.
 */
export type UpdateResult = {
  collections: number;
  indexed: number;
  updated: number;
  unchanged: number;
  removed: number;
  needsEmbedding: number;
};

/**
 * Options for the unified search() method.
 */
export interface SearchOptions {
  /** Simple query string — will be auto-expanded via LLM */
  query?: string;
  /** Pre-expanded queries (from expandQuery) — skips auto-expansion */
  queries?: ExpandedQuery[];
  /** Domain intent hint — steers expansion and reranking */
  intent?: string;
  /** Rerank results using LLM (default: true) */
  rerank?: boolean;
  /** Filter to a specific collection */
  collection?: string;
  /** Filter to specific collections */
  collections?: string[];
  /** Max results (default: 10) */
  limit?: number;
  /** Max candidates to rerank (default: 40) */
  candidateLimit?: number;
  /** Minimum score threshold */
  minScore?: number;
  /** Include explain traces */
  explain?: boolean;
  /** Chunk strategy: "auto" (default, uses AST for code files) or "regex" (legacy) */
  chunkStrategy?: ChunkStrategy;
}

/**
 * Options for searchLex() — BM25 keyword search.
 */
export interface LexSearchOptions {
  /** Maximum number of results to return */
  limit?: number;
  /** Restrict search to a specific collection name */
  collection?: string;
}

/**
 * Options for searchVector() — vector similarity search.
 */
export interface VectorSearchOptions {
  /** Maximum number of results to return */
  limit?: number;
  /** Restrict search to a specific collection name */
  collection?: string;
}

/**
 * Options for expandQuery() — manual query expansion.
 */
export interface ExpandQueryOptions {
  /** Domain context to steer the LLM's query expansion */
  intent?: string;
}

/**
 * Options for creating a QMD store.
 *
 * Provide `dbPath` and optionally `configPath` (YAML file) or `config` (inline).
 * If neither configPath nor config is provided, the store reads from existing
 * DB state (useful for reopening a previously-configured store).
 */
export interface StoreOptions {
  /** Path to the SQLite database file */
  dbPath: string;
  /** Path to a YAML config file (mutually exclusive with `config`) */
  configPath?: string;
  /** Inline collection config (mutually exclusive with `configPath`) */
  config?: CollectionConfig;
  /**
   * Optional pre-constructed LLM instance.
   * When provided, skips creating the default LlamaCpp.
   * Useful for RemoteLLM or custom implementations.
   */
  llm?: LLM;
}

/**
 * The QMD SDK store — provides search, retrieval, collection management,
 * context management, and indexing operations.
 *
 * All methods are async. The store manages its own LlamaCpp instance
 * (lazy-loaded, auto-unloaded after inactivity) — no global singletons.
 */
export interface QMDStore {
  /** The underlying internal store (for advanced use) */
  readonly internal: InternalStore;
  /** Path to the SQLite database */
  readonly dbPath: string;

  // ── Search ──────────────────────────────────────────────────────────

  /**
   * Full search: query expansion + multi-signal retrieval + LLM reranking.
   *
   * Accepts either a plain `query` string (auto-expanded via LLM) or
   * pre-built `queries` array for manual control. Searches across all
   * collections by default; filter with `collection` or `collections`.
   *
   * @param options.query - Plain-text query string (auto-expanded via LLM).
   * @param options.queries - Pre-expanded typed queries (skips auto-expansion).
   * @param options.intent - Domain context to disambiguate the query.
   * @param options.rerank - Whether to rerank results with LLM (default true).
   * @param options.collection - Single collection name to restrict search.
   * @param options.collections - Multiple collection names (OR match).
   * @param options.limit - Max results to return (default 10).
   * @param options.candidateLimit - Max candidates to rerank (default 40).
   * @param options.minScore - Minimum relevance score threshold.
   * @param options.explain - Include retrieval score traces in results.
   * @param options.chunkStrategy - "auto" (AST-aware) or "regex" (default "auto").
   * @returns Ranked results with scores, snippets, and per-result context.
   */
  search(options: SearchOptions): Promise<HybridQueryResult[]>;

  /**
   * BM25 keyword search (fast, no LLM).
   *
   * Runs a raw FTS5 query against the SQLite full-text index. Supports
   * quoted phrases, negation, and prefix matching via FTS5 syntax.
   *
   * @param query - Keyword query string (FTS5 syntax: "phrase", -negation).
   * @param options.limit - Max results (default: configured or 10).
   * @param options.collection - Restrict to a single collection.
   * @returns Flat search results with file path, title, body, and BM25 score.
   */
  searchLex(query: string, options?: LexSearchOptions): Promise<SearchResult[]>;

  /**
   * Vector similarity search via embedding model (no BM25, no reranking).
   *
   * Embeds the query using the configured embed model and finds the nearest
   * neighbors by cosine similarity. Pure semantic search — independent of
   * keyword overlap.
   *
   * @param query - Natural language query string.
   * @param options.limit - Max results (default: configured or 10).
   * @param options.collection - Restrict to a single collection.
   * @returns Search results with file path, title, body, and similarity score.
   */
  searchVector(query: string, options?: VectorSearchOptions): Promise<SearchResult[]>;

  /**
   * Expand a plain query into typed sub-searches (lex/vec/hyde) using the LLM.
   *
   * Useful when you want to inspect or modify the expansion before passing
   * the result to `search({ queries })`. Skips expansion if the LLM is not
   * available.
   *
   * @param query - The raw user query string to expand.
   * @param options.intent - Optional domain context to steer expansion.
   * @returns An array of typed queries (lex, vec, hyde) for use with `search()`.
   */
  expandQuery(query: string, options?: ExpandQueryOptions): Promise<ExpandedQuery[]>;

  // ── Document Retrieval ──────────────────────────────────────────────

  /**
   * Get a single document by path or docid (#abc123).
   *
   * Resolves both filesystem paths (absolute, relative, ~-prefixed) and
   * qmd:// URIs. Also accepts short docids (first 6 hash chars, with or
   * without leading #). On miss, returns a DocumentNotFound with similar
   * file suggestions.
   *
   * @param pathOrDocid - File path, qmd:// URI, or docid (#abc123).
   * @param options.includeBody - Whether to include the full document body
   *   in the result (default: false — only metadata is returned).
   * @returns Document metadata + optional body, or a not-found result with
   *   similar file suggestions.
   */
  get(pathOrDocid: string, options?: { includeBody?: boolean }): Promise<DocumentResult | DocumentNotFound>;

  /**
   * Get the raw body content of a document, optionally sliced by line range.
   *
   * Use this when you already have a DocumentResult and only need the body
   * text (e.g., for feeding into an LLM). Returns `null` if the document
   * cannot be found.
   *
   * @param pathOrDocid - File path, qmd:// URI, or docid (#abc123).
   * @param opts.fromLine - Start at this 1-indexed line number.
   * @param opts.maxLines - Maximum number of lines to return.
   * @returns The document body text, or `null` if not found.
   */
  getDocumentBody(pathOrDocid: string, opts?: { fromLine?: number; maxLines?: number }): Promise<string | null>;

  /**
   * Get multiple documents by glob pattern or comma-separated list.
   *
   * Accepts:
   * - Glob patterns (e.g., `journals/2025-05*.md`)
   * - Comma-separated lists of paths or docids
   *
   * Files exceeding `maxBytes` are returned as skipped entries with a reason
   * string, rather than being silently omitted.
   *
   * @param pattern - Glob pattern or comma-separated path/docid list.
   * @param options.includeBody - Whether to fetch the full document body.
   * @param options.maxBytes - Skip files larger than this (default 10240).
   * @returns Object with `docs` (results, possibly skipped) and `errors`
   *   (per-file error messages for unmatched items).
   */
  multiGet(pattern: string, options?: { includeBody?: boolean; maxBytes?: number }): Promise<{ docs: MultiGetResult[]; errors: string[] }>;

  // ── Collection Management ───────────────────────────────────────────

  /**
   * Add or update a collection in the store.
   *
   * Writes to the SQLite store and, if a YAML or inline config was provided
   * at store creation, also writes through to that config.
   *
   * @param name - Unique collection name (used in qmd:// URIs).
   * @param opts.path - Absolute filesystem path to index.
   * @param opts.pattern - Glob pattern for file matching (default **\/*.md).
   * @param opts.ignore - Glob patterns to exclude from indexing.
   */
  addCollection(name: string, opts: { path: string; pattern?: string; ignore?: string[] }): Promise<void>;

  /**
   * Remove a collection and its indexed documents from the store.
   *
   * Also renames the collection in YAML/inline config if one was provided.
   *
   * @param name - The collection name to remove.
   * @returns `true` if the collection was found and removed.
   */
  removeCollection(name: string): Promise<boolean>;

  /**
   * Rename a collection. Updates all virtual paths (qmd://old/ -> qmd://new/).
   *
   * Also renames in YAML/inline config if one was provided.
   *
   * @param oldName - Current collection name.
   * @param newName - New collection name.
   * @returns `true` if the collection was found and renamed.
   */
  renameCollection(oldName: string, newName: string): Promise<boolean>;

  /**
   * List all collections with document stats.
   *
   * @returns Array of collection descriptors including file counts and
   *   last-modified timestamps. `includeByDefault` indicates whether the
   *   collection participates in unqualified searches.
   */
  listCollections(): Promise<{ name: string; pwd: string; glob_pattern: string; doc_count: number; active_count: number; last_modified: string | null; includeByDefault: boolean }[]>;

  /**
   * Get names of collections that are included by default in unqualified queries.
   *
   * @returns Array of collection names where `includeByDefault` is true.
   */
  getDefaultCollectionNames(): Promise<string[]>;

  // ── Context Management ──────────────────────────────────────────────

  /**
   * Add human-written context for a path within a collection.
   *
   * Context is injected into search results for matching documents,
   * helping LLMs interpret file contents without reading them in full.
   *
   * @param collectionName - The collection name.
   * @param pathPrefix - Path prefix within the collection (empty string or
   *   "/" for collection root context).
   * @param contextText - Descriptive text about the files at this path.
   * @returns `true` if added successfully.
   */
  addContext(collectionName: string, pathPrefix: string, contextText: string): Promise<boolean>;

  /**
   * Remove context from a collection path.
   *
   * @param collectionName - The collection name.
   * @param pathPrefix - Path prefix to remove context for.
   * @returns `true` if context was found and removed.
   */
  removeContext(collectionName: string, pathPrefix: string): Promise<boolean>;

  /**
   * Set or clear global context (applies to all collections).
   *
   * @param context - The context text, or `undefined` to clear global context.
   */
  setGlobalContext(context: string | undefined): Promise<void>;

  /**
   * Get the global context string.
   *
   * @returns The global context text, or `undefined` if not set.
   */
  getGlobalContext(): Promise<string | undefined>;

  /**
   * List all contexts across all collections.
   *
   * @returns Array of context entries with collection name, path prefix,
   *   and context text.
   */
  listContexts(): Promise<Array<{ collection: string; path: string; context: string }>>;

  // ── Indexing ────────────────────────────────────────────────────────

  /**
   * Re-index all (or specified) collections by scanning the filesystem.
   *
   * Scans each collection's path for matching files, detects new, updated,
   * unchanged, and removed documents, and updates the SQLite index. Clears
   * the Ollama model cache before starting.
   *
   * @param options.collections - Restrict to specific collection names.
   * @param options.onProgress - Callback invoked per-file with progress info.
   * @returns Aggregated counts across all processed collections.
   */
  update(options?: {
    collections?: string[];
    onProgress?: (info: UpdateProgress) => void;
  }): Promise<UpdateResult>;

  /**
   * Generate vector embeddings for documents that need them.
   *
   * Chunks document bodies (respecting AST boundaries for code files),
   * embeds each chunk using the configured model, and stores vectors in
   * the sqlite-vec index. Only processes hashes that don't already have
   * embeddings, unless `force` is true.
   *
   * @param options.force - Re-embed all documents even if already embedded.
   * @param options.model - Override the embedding model name.
   * @param options.collection - Restrict to a single collection.
   * @param options.maxDocsPerBatch - Cap docs per embedding batch.
   * @param options.maxBatchBytes - Cap UTF-8 bytes per embedding batch.
   * @param options.chunkStrategy - "auto" (AST-aware for code) or "regex".
   * @param options.onProgress - Progress callback with byte/chunk counts.
   * @returns Embed result with counts of chunks/documents processed.
   */
  embed(options?: {
    force?: boolean;
    model?: string;
    /** Restrict embedding to documents in one collection. */
    collection?: string;
    maxDocsPerBatch?: number;
    maxBatchBytes?: number;
    chunkStrategy?: ChunkStrategy;
    onProgress?: (info: EmbedProgress) => void;
  }): Promise<EmbedResult>;

  // ── Index Health ────────────────────────────────────────────────────

  /**
   * Get index status: document counts, collection list, embedding state,
   * and vector index presence.
   *
   * @returns An IndexStatus object with totals, per-collection breakdown,
   *   and health indicators.
   */
  getStatus(): Promise<IndexStatus>;

  /**
   * Get index health information, including a list of documents whose
   * content hashes have changed since their last embedding.
   *
   * @returns Health info with stale-embedding warnings and repair suggestions.
   */
  getIndexHealth(): Promise<IndexHealthInfo>;

  // ── Lifecycle ───────────────────────────────────────────────────────

  /**
   * Close the store and release all resources.
   *
   * Disposes the LLM model instances, closes the SQLite database connection,
   * and resets the config source to its pre-open state.
   * Safe to call multiple times — subsequent calls are no-ops.
   */
  close(): Promise<void>;
}

/**
 * Create a QMD store for programmatic access to search and indexing.
 *
 * @example
 * ```typescript
 * // With a YAML config file
 * const store = await createStore({
 *   dbPath: './index.sqlite',
 *   configPath: './qmd.yml',
 * })
 *
 * // With inline config (no files needed besides the DB)
 * const store = await createStore({
 *   dbPath: './index.sqlite',
 *   config: {
 *     collections: {
 *       docs: { path: '/path/to/docs', pattern: '**\/*.md' }
 *     }
 *   }
 * })
 *
 * const results = await store.search({ query: "authentication flow" })
 * await store.close()
 * ```
 */
export async function createStore(options: StoreOptions): Promise<QMDStore> {
  if (!options.dbPath) {
    throw new Error("dbPath is required");
  }
  if (options.configPath && options.config) {
    throw new Error("Provide either configPath or config, not both");
  }

  // Create the internal store (opens DB, creates tables)
  const internal = createStoreInternal(options.dbPath);
  const db = internal.db;

  // Track whether we have a YAML config path for write-through
  const hasYamlConfig = !!options.configPath;

  // Sync config into SQLite store_collections
  let config: CollectionConfig | undefined;
  if (options.configPath) {
    // YAML mode: inject config source for write-through, sync to DB
    setConfigSource({ configPath: options.configPath });
    config = loadConfig();
    syncConfigToDb(db, config);
  } else if (options.config) {
    // Inline config mode: inject config source for mutations, sync to DB
    setConfigSource({ config: options.config });
    config = options.config;
    syncConfigToDb(db, config);
  }
  // else: DB-only mode — no external config, use existing store_collections

  // Use provided LLM or create default LlamaCpp
  const llm = options.llm ?? new LlamaCpp({
    embedModel: config?.models?.embed,
    generateModel: config?.models?.generate,
    rerankModel: config?.models?.rerank,
    inactivityTimeoutMs: 5 * 60 * 1000,
    disposeModelsOnInactivity: true,
  });
  internal.llm = llm;

  // Startup probe for remote LLMs — catch misconfiguration early
  if (typeof (llm as any).probe === 'function') {
    (llm as any).probe().then((result: { ok: boolean; dimensions: number; error?: string }) => {
      if (result.ok) {
        console.log(`Remote LLM probe OK (dimensions=${result.dimensions})`);
      } else {
        console.warn(`Remote LLM probe failed: ${result.error ?? 'unknown error'}`);
      }
    }).catch((err: unknown) => {
      console.warn(`Remote LLM probe error: ${err}`);
    });
  }

  const store: QMDStore = {
    internal,
    dbPath: internal.dbPath,

    // Search
    search: async (opts) => {
      if (!opts.query && !opts.queries) {
        throw new Error("search() requires either 'query' or 'queries'");
      }
      // Normalize collection/collections
      const collections = [
        ...(opts.collection ? [opts.collection] : []),
        ...(opts.collections ?? []),
      ];
      const skipRerank = opts.rerank === false;

      if (opts.queries) {
        // Pre-expanded queries — use structuredSearch
        return structuredSearch(internal, opts.queries, {
          collections: collections.length > 0 ? collections : undefined,
          limit: opts.limit,
          minScore: opts.minScore,
          explain: opts.explain,
          intent: opts.intent,
          candidateLimit: opts.candidateLimit,
          skipRerank,
          chunkStrategy: opts.chunkStrategy,
        });
      }

      // Simple query string — use hybridQuery (expand + search + rerank)
      return hybridQuery(internal, opts.query!, {
        collection: collections[0],
        limit: opts.limit,
        minScore: opts.minScore,
        explain: opts.explain,
        intent: opts.intent,
        candidateLimit: opts.candidateLimit,
        skipRerank,
        chunkStrategy: opts.chunkStrategy,
      });
    },
    searchLex: async (q, opts) => internal.searchFTS(q, opts?.limit, opts?.collection),
    searchVector: async (q, opts) => internal.searchVec(q, llm.embedModelName, opts?.limit, opts?.collection, undefined, undefined, llm),
    expandQuery: async (q, opts) => internal.expandQuery(q, undefined, opts?.intent),
    get: async (pathOrDocid, opts) => internal.findDocument(pathOrDocid, opts),
    getDocumentBody: async (pathOrDocid, opts) => {
      const result = internal.findDocument(pathOrDocid, { includeBody: false });
      if ("error" in result) return null;
      return internal.getDocumentBody(result, opts?.fromLine, opts?.maxLines);
    },
    multiGet: async (pattern, opts) => internal.findDocuments(pattern, opts),

    // Collection Management — write to SQLite + write-through to YAML/inline if configured
    addCollection: async (name, opts) => {
      upsertStoreCollection(db, name, { path: opts.path, pattern: opts.pattern, ignore: opts.ignore });
      if (hasYamlConfig || options.config) {
        collectionsAddCollection(name, opts.path, opts.pattern);
      }
    },
    removeCollection: async (name) => {
      const result = deleteStoreCollection(db, name);
      if (hasYamlConfig || options.config) {
        collectionsRemoveCollection(name);
      }
      return result;
    },
    renameCollection: async (oldName, newName) => {
      const result = renameStoreCollection(db, oldName, newName);
      if (hasYamlConfig || options.config) {
        collectionsRenameCollection(oldName, newName);
      }
      return result;
    },
    listCollections: async () => storeListCollections(db),
    getDefaultCollectionNames: async () => {
      const collections = storeListCollections(db);
      return collections.filter(c => c.includeByDefault).map(c => c.name);
    },

    // Context Management — write to SQLite + write-through to YAML/inline if configured
    addContext: async (collectionName, pathPrefix, contextText) => {
      const result = updateStoreContext(db, collectionName, pathPrefix, contextText);
      if (hasYamlConfig || options.config) {
        collectionsAddContext(collectionName, pathPrefix, contextText);
      }
      return result;
    },
    removeContext: async (collectionName, pathPrefix) => {
      const result = removeStoreContext(db, collectionName, pathPrefix);
      if (hasYamlConfig || options.config) {
        collectionsRemoveContext(collectionName, pathPrefix);
      }
      return result;
    },
    setGlobalContext: async (context) => {
      setStoreGlobalContext(db, context);
      if (hasYamlConfig || options.config) {
        collectionsSetGlobalContext(context);
      }
    },
    getGlobalContext: async () => getStoreGlobalContext(db),
    listContexts: async () => getStoreContexts(db),

    // Indexing — reads collections from SQLite
    update: async (updateOpts) => {
      const collections = getStoreCollections(db);
      const filtered = updateOpts?.collections
        ? collections.filter(c => updateOpts.collections!.includes(c.name))
        : collections;

      internal.clearCache();

      let totalIndexed = 0, totalUpdated = 0, totalUnchanged = 0, totalRemoved = 0;

      for (const col of filtered) {
        const result = await reindexCollection(internal, col.path, col.pattern || "**/*.md", col.name, {
          ignorePatterns: col.ignore,
          onProgress: updateOpts?.onProgress
            ? (info) => updateOpts.onProgress!({ collection: col.name, ...info })
            : undefined,
        });
        totalIndexed += result.indexed;
        totalUpdated += result.updated;
        totalUnchanged += result.unchanged;
        totalRemoved += result.removed;
      }

      return {
        collections: filtered.length,
        indexed: totalIndexed,
        updated: totalUpdated,
        unchanged: totalUnchanged,
        removed: totalRemoved,
        needsEmbedding: internal.getHashesNeedingEmbedding(),
      };
    },

    embed: async (embedOpts) => {
      return generateEmbeddings(internal, {
        force: embedOpts?.force,
        model: embedOpts?.model,
        collection: embedOpts?.collection,
        maxDocsPerBatch: embedOpts?.maxDocsPerBatch,
        maxBatchBytes: embedOpts?.maxBatchBytes,
        chunkStrategy: embedOpts?.chunkStrategy,
        onProgress: embedOpts?.onProgress,
      });
    },

    // Index Health
    getStatus: async () => internal.getStatus(),
    getIndexHealth: async () => internal.getIndexHealth(),

    // Lifecycle
    close: async () => {
      await llm.dispose();
      internal.close();
      if (hasYamlConfig || options.config) {
        setConfigSource(undefined); // Reset config source
      }
    },
  };

  return store;
}
