/**
 * QMD Store - Core data access and retrieval functions
 *
 * This module is the top-level store factory for QMD. It provides:
 * - {@link createStore} to instantiate a {@link Store} bound to a SQLite database
 * - Re-exports of all search, retrieval, embedding, caching, and cleanup functions
 *   from the `src/store/` submodules
 * - The {@link generateEmbeddings} wrapper that bridges the Store-based API to the
 *   decomposed embedding pipeline
 * - The {@link maybeAdoptLegacyEmbeddingFingerprint} migration for pre-fingerprint
 *   vector embeddings
 *
 * Usage:
 *   const store = createStore("/path/to/db.sqlite");
 *   // or use default path:
 *   const store = createStore();
 *
 * The returned {@link Store} object exposes methods for indexing, search (FTS, vector,
 * hybrid), query expansion, reranking, document retrieval, context management, virtual
 * paths, and database maintenance. All methods delegate to the decomposed submodules
 * (`src/store/retrieval.ts`, `src/store/query-engine.ts`, `src/store/embedding-pipeline.ts`,
 * etc.) and are already bound to the database connection.
 *
 * @module store
 */

import { openDatabase } from "./db.js";
import type { Database } from "./db.js";
import {
  formatDocForEmbedding,
  type LLM,
  withLLMSessionForLlm,
  DEFAULT_EMBED_MODEL_URI,
  DEFAULT_RERANK_MODEL_URI,
  DEFAULT_GENERATE_MODEL_URI,
  type ILLMSession,
} from "./llm.js";
import {
  CHUNK_SIZE_TOKENS,
  CHUNK_OVERLAP_TOKENS,
  CHUNK_SIZE_CHARS,
  CHUNK_OVERLAP_CHARS,
  CHUNK_WINDOW_TOKENS,
  CHUNK_WINDOW_CHARS,
  scanBreakPoints,
  findCodeFences,
  isInsideCodeFence,
  findBestCutoff,
  mergeBreakPoints,
  chunkDocumentWithBreakPoints,
  type ChunkStrategy,
  type BreakPoint,
  type CodeFenceRegion,
} from "./store/chunking.js";
import {
  chunkDocument,
  chunkDocumentAsync,
  chunkDocumentByTokens,
} from "./store/chunking-async.js";
import {
  clearCache,
  getCacheKey,
  getCachedResult,
  setCachedResult,
} from "./store/cache.js";
import {
  cleanupOrphanedContent,
  cleanupOrphanedVectors,
  deleteInactiveDocuments,
  deleteLLMCache,
  getIndexHealth,
  vacuumDatabase,
  type IndexHealthInfo,
} from "./store/cleanup.js";
import {
  homedir,
  isAbsolutePath,
  normalizePathSeparators,
  getRelativePathFromPrefix,
  resolve,
  enableProductionMode,
  _resetProductionModeForTesting,
  getDefaultDbPath,
  getPwd,
  getRealPath,
} from "./store/path-utils.js";
import {
  buildInheritedContext,
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
  syncConfigToDb,
} from "./store/config-sync.js";
import {
  verifySqliteVecLoaded,
  initializeDatabase,
  normalizeCjkForFTS,
  isSqliteVecAvailableState,
} from "./store/db-init.js";
import {
  getEmbeddingFingerprint,
  ensureVecTable as ensureVecTableInternal,
  getHashesForEmbedding,
  clearAllEmbeddings,
  insertEmbedding,
  getHashesNeedingEmbedding,
  withLazyContentVectorMigration,
  generateEmbeddings as generateEmbeddingsInternal,
  getStoreLlm,
  type EmbedFailure,
  type EmbedProgress,
  type EmbedResult,
  type EmbedOptions,
} from "./store/embedding-pipeline.js";
import {
  hashContent,
  extractTitle,
  insertContent,
  insertDocument,
  findActiveDocument,
  findOrMigrateLegacyDocument,
  updateDocumentTitle,
  updateDocument,
  deactivateDocument,
  getActiveDocumentPaths,
  UNKNOWN_SOURCE_MTIME_MS,
  UNKNOWN_SOURCE_SIZE,
} from "./store/document-ops.js";
import {
  searchFTS, searchVec, findDocument, getDocumentBody, findDocuments,
  findDocumentByDocid, findSimilarFiles, matchFilesByGlob,
  getContextForFile, getContextForPath, createContextResolver,
  getCollectionByName, listCollections, removeCollection, renameCollection,
  getAllCollections, getCollectionsWithoutContext, getTopLevelPathsWithoutContext,
  insertContext, deleteContext, deleteGlobalContexts, listPathContexts,
  getStatus, extractIntentTerms, extractSnippet, addLineNumbers, getDocid,
  loadSearchDocumentsByFilepaths, handelize, normalizeDocid, isDocid,
  parseVirtualPath, buildVirtualPath, isVirtualPath, resolveVirtualPath, toVirtualPath,
  normalizeVirtualPath, sanitizeFTS5Term, validateSemanticQuery, validateLexQuery,
  emojiToHex,
  INTENT_WEIGHT_SNIPPET, INTENT_WEIGHT_CHUNK,
  type DocumentResult, type SearchResult, type SearchResultOptions,
  type RankedResult, type RRFContributionTrace, type RRFScoreTrace,
  type HybridQueryExplain, type DocumentNotFound, type MultiGetResult,
  type CollectionInfo, type IndexStatus, type VirtualPath, type SnippetResult,
} from "./store/retrieval.js";
import {
  expandQuery, rerank, reciprocalRankFusion, buildRrfTrace,
  hybridQuery, vectorSearchQuery, structuredSearch,
  getHybridRrfWeights,
  STRONG_SIGNAL_MIN_SCORE, STRONG_SIGNAL_MIN_GAP, RERANK_CANDIDATE_LIMIT,
  type ExpandedQuery, type SearchHooks, type HybridQueryOptions,
  type HybridQueryResult, type VectorSearchOptions, type VectorSearchResult,
  type StructuredSearchOptions, type RankedListMeta,
} from "./store/query-engine.js";

// =============================================================================
// Configuration
// =============================================================================

export const DEFAULT_EMBED_MODEL = DEFAULT_EMBED_MODEL_URI;
export const DEFAULT_RERANK_MODEL = DEFAULT_RERANK_MODEL_URI;
export const DEFAULT_QUERY_MODEL = DEFAULT_GENERATE_MODEL_URI;

export const DEFAULT_GLOB = "**/*.md";
export const DEFAULT_MULTI_GET_MAX_BYTES = 10 * 1024; // 10KB
export const DEFAULT_EMBED_MAX_DOCS_PER_BATCH = 64;
export const DEFAULT_EMBED_MAX_BATCH_BYTES = 64 * 1024 * 1024; // 64MB

// Chunking constants and helpers are defined in src/store/chunking.ts.
export {
  CHUNK_SIZE_TOKENS,
  CHUNK_OVERLAP_TOKENS,
  CHUNK_SIZE_CHARS,
  CHUNK_OVERLAP_CHARS,
  CHUNK_WINDOW_TOKENS,
  CHUNK_WINDOW_CHARS,
  scanBreakPoints,
  findCodeFences,
  isInsideCodeFence,
  findBestCutoff,
  mergeBreakPoints,
  chunkDocumentWithBreakPoints,
  type ChunkStrategy,
  type BreakPoint,
  type CodeFenceRegion,
};

// Async chunking functions (token-count-based, AST-aware) are defined in src/store/chunking-async.ts.
export {
  chunkDocument,
  chunkDocumentAsync,
  chunkDocumentByTokens,
};

export {
  homedir,
  isAbsolutePath,
  normalizePathSeparators,
  getRelativePathFromPrefix,
  resolve,
  enableProductionMode,
  _resetProductionModeForTesting,
  getDefaultDbPath,
  getPwd,
  getRealPath,
};

export {
  buildInheritedContext,
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
  syncConfigToDb,
};

export { verifySqliteVecLoaded };

// Re-export embedding fingerprint from the embedding pipeline module
export { getEmbeddingFingerprint };

/**
 * Resolve the active LLM instance for a store.
 *
 * Prefers the LLM attached to the store instance (set at creation time or
 * configured externally) and falls back to the global singleton LLM if the
 * store carries none. The global singleton is created on first access and
 * cached for the process lifetime.
 *
 * @param store - The store whose optional `llm` property to prefer
 * @returns An {@link LLM} instance ready for embedding, generation, or reranking
 */
function getLlm(store: Store): LLM {
  return getStoreLlm(store.llm);
}

/**
 * Check whether the sqlite-vec extension is loaded and available.
 *
 * This is a read-only query into the module-level availability flag that is
 * set during database initialization. It does not perform any I/O.
 *
 * @returns `true` if sqlite-vec was successfully loaded, `false` otherwise
 *
 * @throws Never — this is a synchronous, no-I/O check
 *
 * **Side effects:** None
 */
export function isSqliteVecAvailable(): boolean {
  return isSqliteVecAvailableState();
}


// =============================================================================
// Store Factory
// =============================================================================

/**
 * A store instance bound to a single SQLite database.
 *
 * Created via {@link createStore}. All methods are already wired to the
 * underlying database connection and are ready for immediate use.
 *
 * Method groups:
 * - **Search:** FTS (`searchFTS`), vector (`searchVec`)
 * - **Query expansion & reranking:** `expandQuery`, `rerank`
 * - **Document retrieval:** `findDocument`, `getDocumentBody`, `findDocuments`
 * - **Fuzzy/docid:** `findSimilarFiles`, `matchFilesByGlob`, `findDocumentByDocid`
 * - **Indexing:** `insertContent`, `insertDocument`, `updateDocument`, ...
 * - **Vector/embedding:** `getHashesForEmbedding`, `clearAllEmbeddings`, `insertEmbedding`
 * - **Context:** `getContextForFile`, `getContextForPath`, `getCollectionByName`, ...
 * - **Virtual paths:** `parseVirtualPath`, `buildVirtualPath`, `resolveVirtualPath`, ...
 * - **Index health:** `getStatus`, `getIndexHealth`, `getHashesNeedingEmbedding`
 * - **Caching:** `getCacheKey`, `getCachedResult`, `setCachedResult`, `clearCache`
 * - **Maintenance:** `deleteLLMCache`, `deleteInactiveDocuments`, `cleanupOrphanedContent`,
 *   `cleanupOrphanedVectors`, `vacuumDatabase`
 */
export type Store = {
  /** The raw SQLite database handle. Prefer the typed methods on this object. */
  db: Database;
  /** Absolute path to the SQLite database file this store is bound to */
  dbPath: string;
  /**
   * Optional LLM instance that overrides the global singleton for this store.
   * When set, embedding, generation, and reranking use this instance instead of
   * the auto-detected default.
   */
  llm?: LLM;
  close: () => void;
  ensureVecTable: (dimensions: number) => void;

  // Index health
  getHashesNeedingEmbedding: (model?: string) => number;
  getIndexHealth: (model?: string) => IndexHealthInfo;
  getStatus: (model?: string) => IndexStatus;

  // Caching
  getCacheKey: typeof getCacheKey;
  getCachedResult: (cacheKey: string) => string | null;
  setCachedResult: (cacheKey: string, result: string) => void;
  clearCache: () => void;

  // Cleanup and maintenance
  deleteLLMCache: () => number;
  deleteInactiveDocuments: () => number;
  cleanupOrphanedContent: () => number;
  cleanupOrphanedVectors: () => number;
  vacuumDatabase: () => void;

  // Context
  getContextForFile: (filepath: string) => string | null;
  getContextForPath: (collectionName: string, path: string) => string | null;
  getCollectionByName: (name: string) => { name: string; pwd: string; glob_pattern: string } | null;
  getCollectionsWithoutContext: () => { name: string; pwd: string; doc_count: number }[];
  getTopLevelPathsWithoutContext: (collectionName: string) => string[];

  // Virtual paths
  parseVirtualPath: typeof parseVirtualPath;
  buildVirtualPath: typeof buildVirtualPath;
  isVirtualPath: typeof isVirtualPath;
  resolveVirtualPath: (virtualPath: string) => string | null;
  toVirtualPath: (absolutePath: string) => string | null;

  // Search
  searchFTS: (query: string, limit?: number, collectionName?: string, options?: SearchResultOptions) => SearchResult[];
  searchVec: (query: string, model: string, limit?: number, collectionName?: string, session?: ILLMSession, precomputedEmbedding?: number[], llm?: LLM, options?: SearchResultOptions) => Promise<SearchResult[]>;

  // Query expansion & reranking
  expandQuery: (query: string, model?: string, intent?: string) => Promise<ExpandedQuery[]>;
  rerank: (query: string, documents: { file: string; text: string }[], model?: string, intent?: string) => Promise<{ file: string; score: number }[]>;

  // Document retrieval
  findDocument: (filename: string, options?: { includeBody?: boolean }) => DocumentResult | DocumentNotFound;
  getDocumentBody: (doc: DocumentResult | { filepath: string }, fromLine?: number, maxLines?: number) => string | null;
  findDocuments: (pattern: string, options?: { includeBody?: boolean; maxBytes?: number }) => { docs: MultiGetResult[]; errors: string[] };

  // Fuzzy matching and docid lookup
  findSimilarFiles: (query: string, maxDistance?: number, limit?: number) => string[];
  matchFilesByGlob: (pattern: string) => { filepath: string; displayPath: string; bodyLength: number }[];
  findDocumentByDocid: (docid: string) => { filepath: string; hash: string } | null;

  // Document indexing operations
  insertContent: (hash: string, content: string, createdAt: string) => void;
  insertDocument: (collectionName: string, path: string, title: string, hash: string, createdAt: string, modifiedAt: string) => void;
  findActiveDocument: (collectionName: string, path: string) => { id: number; hash: string; title: string } | null;
  findOrMigrateLegacyDocument: (collectionName: string, path: string) => { id: number; hash: string; title: string } | null;
  updateDocumentTitle: (documentId: number, title: string, modifiedAt: string) => void;
  updateDocument: (documentId: number, title: string, hash: string, modifiedAt: string) => void;
  deactivateDocument: (collectionName: string, path: string) => void;
  getActiveDocumentPaths: (collectionName: string) => string[];

  // Vector/embedding operations
  getHashesForEmbedding: () => { hash: string; body: string; path: string }[];
  clearAllEmbeddings: () => void;
  insertEmbedding: (hash: string, seq: number, pos: number, embedding: Float32Array, model: string, embeddedAt: string, totalChunks?: number, fingerprint?: string) => void;
};

// Reindex functions are in src/store/reindex.ts
export { type ReindexProgress, type ReindexResult, reindexCollection } from "./store/reindex.js";

// Embedding pipeline types and functions are in src/store/embedding-pipeline.ts
export { type EmbedFailure, type EmbedProgress, type EmbedResult, type EmbedOptions };

/**
 * Generate vector embeddings for documents that are missing embeddings.
 *
 * This is a thin wrapper that bridges the Store-based API to the decomposed
 * embedding pipeline in `src/store/embedding-pipeline.ts`. It queries the
 * database for hashes that lack embeddings under the configured model,
 * chunks document bodies, sends them through the LLM embedding endpoint,
 * and persists the vectors via `insertEmbedding`.
 *
 * @param store - The store instance (used for its `db`, `ensureVecTable`, and optional `llm`)
 * @param options - Embedding options including model, concurrency, retry, and progress callbacks
 * @returns An {@link EmbedResult} with counts of documents and chunks processed, plus any failures
 *
 * **Side effects:** Writes to the `content_vectors` table and may create/update the
 * vector index table via `ensureVecTable`. Reads from `content` and `documents` tables.
 */
export async function generateEmbeddings(
  store: Store,
  options?: EmbedOptions
): Promise<EmbedResult> {
  return generateEmbeddingsInternal(
    store.db,
    (dim) => store.ensureVecTable(dim),
    extractTitle,
    chunkDocumentByTokens,
    { ...options, llm: store.llm },
  );
}

/**
 * Create a new store instance bound to a SQLite database.
 *
 * Call once at application startup. The returned {@link Store} has all methods
 * pre-bound to the database connection and is the entry point for all indexing,
 * search, and maintenance operations.
 *
 * If no path is provided, uses the default path returned by
 * {@link getDefaultDbPath} (typically `~/.cache/qmd/index.sqlite`).
 *
 * @param dbPath - Absolute path to the SQLite database file. If omitted, the
 *   platform-appropriate default (XDG-compliant cache directory) is used.
 * @returns A fully initialized {@link Store} instance with all methods bound to the db
 *
 * **Side effects:**
 * - Opens (or creates) the SQLite database at the given path
 * - Runs schema initialization (`CREATE TABLE IF NOT EXISTS` for all core tables)
 * - Attempts to load the sqlite-vec extension (logs a warning on failure)
 * - The returned `.close()` method must be called to release the database handle
 */
export function createStore(dbPath?: string): Store {
  const resolvedPath = dbPath || getDefaultDbPath();
  const db = openDatabase(resolvedPath);
  initializeDatabase(db);

  const store: Store = {
    db,
    dbPath: resolvedPath,
    close: () => db.close(),
    ensureVecTable: (dimensions: number) => ensureVecTableInternal(db, dimensions),

    // Index health
    getHashesNeedingEmbedding: (model?: string) => getHashesNeedingEmbedding(db, undefined, model ?? store.llm?.embedModelName ?? DEFAULT_EMBED_MODEL),
    getIndexHealth: (model?: string) => getIndexHealth(db, model ?? store.llm?.embedModelName ?? DEFAULT_EMBED_MODEL),
    getStatus: (model?: string) => getStatus(db, model ?? store.llm?.embedModelName ?? DEFAULT_EMBED_MODEL),

    // Caching
    getCacheKey,
    getCachedResult: (cacheKey: string) => getCachedResult(db, cacheKey),
    setCachedResult: (cacheKey: string, result: string) => setCachedResult(db, cacheKey, result),
    clearCache: () => clearCache(db),

    // Cleanup and maintenance
    deleteLLMCache: () => deleteLLMCache(db),
    deleteInactiveDocuments: () => deleteInactiveDocuments(db),
    cleanupOrphanedContent: () => cleanupOrphanedContent(db),
    cleanupOrphanedVectors: () => cleanupOrphanedVectors(db),
    vacuumDatabase: () => vacuumDatabase(db),

    // Context
    getContextForFile: (filepath: string) => getContextForFile(db, filepath),
    getContextForPath: (collectionName: string, path: string) => getContextForPath(db, collectionName, path),
    getCollectionByName: (name: string) => getCollectionByName(db, name),
    getCollectionsWithoutContext: () => getCollectionsWithoutContext(db),
    getTopLevelPathsWithoutContext: (collectionName: string) => getTopLevelPathsWithoutContext(db, collectionName),

    // Virtual paths
    parseVirtualPath,
    buildVirtualPath,
    isVirtualPath,
    resolveVirtualPath: (virtualPath: string) => resolveVirtualPath(db, virtualPath),
    toVirtualPath: (absolutePath: string) => toVirtualPath(db, absolutePath),

    // Search
    searchFTS: (query: string, limit?: number, collectionName?: string, options?: SearchResultOptions) => searchFTS(db, query, limit, collectionName, options),
    searchVec: (query: string, model: string, limit?: number, collectionName?: string, session?: ILLMSession, precomputedEmbedding?: number[], llm?: LLM, options?: SearchResultOptions) => searchVec(db, query, model, limit, collectionName, session, precomputedEmbedding, llm, options),

    // Query expansion & reranking
    expandQuery: (query: string, model?: string, intent?: string) => expandQuery(query, model ?? store.llm?.generateModelName ?? DEFAULT_QUERY_MODEL, db, intent, store.llm),
    rerank: (query: string, documents: { file: string; text: string }[], model?: string, intent?: string) => rerank(query, documents, model ?? store.llm?.rerankModelName ?? DEFAULT_RERANK_MODEL, db, intent, store.llm),

    // Document retrieval
    findDocument: (filename: string, options?: { includeBody?: boolean }) => findDocument(db, filename, options),
    getDocumentBody: (doc: DocumentResult | { filepath: string }, fromLine?: number, maxLines?: number) => getDocumentBody(db, doc, fromLine, maxLines),
    findDocuments: (pattern: string, options?: { includeBody?: boolean; maxBytes?: number }) => findDocuments(db, pattern, options),

    // Fuzzy matching and docid lookup
    findSimilarFiles: (query: string, maxDistance?: number, limit?: number) => findSimilarFiles(db, query, maxDistance, limit),
    matchFilesByGlob: (pattern: string) => matchFilesByGlob(db, pattern),
    findDocumentByDocid: (docid: string) => findDocumentByDocid(db, docid),

    // Document indexing operations
    insertContent: (hash: string, content: string, createdAt: string) => insertContent(db, hash, content, createdAt),
    insertDocument: (collectionName: string, path: string, title: string, hash: string, createdAt: string, modifiedAt: string) => insertDocument(db, collectionName, path, title, hash, createdAt, modifiedAt),
    findActiveDocument: (collectionName: string, path: string) => findActiveDocument(db, collectionName, path),
    findOrMigrateLegacyDocument: (collectionName: string, path: string) => findOrMigrateLegacyDocument(db, collectionName, path),
    updateDocumentTitle: (documentId: number, title: string, modifiedAt: string) => updateDocumentTitle(db, documentId, title, modifiedAt),
    updateDocument: (documentId: number, title: string, hash: string, modifiedAt: string) => updateDocument(db, documentId, title, hash, modifiedAt),
    deactivateDocument: (collectionName: string, path: string) => deactivateDocument(db, collectionName, path),
    getActiveDocumentPaths: (collectionName: string) => getActiveDocumentPaths(db, collectionName),

    // Vector/embedding operations
    getHashesForEmbedding: () => getHashesForEmbedding(db),
    clearAllEmbeddings: () => clearAllEmbeddings(db),
    insertEmbedding: (hash: string, seq: number, pos: number, embedding: Float32Array, model: string, embeddedAt: string, totalChunks?: number, fingerprint?: string) => insertEmbedding(db, hash, seq, pos, embedding, model, embeddedAt, totalChunks, fingerprint),
  };

  return store;
}

// =============================================================================
// Core Document Type
// =============================================================================

/**
 * Result of attempting to adopt a legacy (pre-fingerprint) embedding to the
 * current embedding fingerprint.
 */
export type LegacyFingerprintAdoptionResult = {
  /** Whether a fingerprint check was attempted (false if no legacy embeddings exist) */
  checked: boolean;
  /** Number of embedding rows whose fingerprint was updated (0 if none) */
  adopted: number;
  /** Human-readable explanation of the outcome (skipped, adopted, or why adoption failed) */
  reason: string;
};

/**
 * Adopt legacy vector embeddings stored before the embedding fingerprint was introduced
 * (i.e. `embed_fingerprint = ''`).
 *
 * This migration verifies that the current LLM embedding model produces the same vectors
 * as the legacy model by embedding a sample chunk and comparing it via the sqlite-vec
 * index. If the sample matches within a tight cosine-distance threshold of 0.0001, all
 * legacy rows for the given model are bulk-updated with the current fingerprint so they
 * are no longer considered stale.
 *
 * Call this after store creation and before a full re-embed to avoid re-embedding every
 * document when the fingerprint changed for reasons other than a model swap (e.g. a
 * format change that doesn't affect output).
 *
 * @param store - The store instance whose database will be checked and updated
 * @param model - The embedding model identifier (defaults to DEFAULT_EMBED_MODEL)
 * @returns Description of what was found and what action was taken
 *
 * **Side effects:**
 *   - Reads `content_vectors` and `vectors_vec` tables
 *   - Embeds one sample chunk via the LLM (I/O and computation)
 *   - May write to `content_vectors.embed_fingerprint` (UPDATE query)
 *   - Does nothing if `vectors_vec` table is missing
 */
export async function maybeAdoptLegacyEmbeddingFingerprint(store: Store, model: string = DEFAULT_EMBED_MODEL): Promise<LegacyFingerprintAdoptionResult> {
  const db = store.db;
  const fingerprint = getEmbeddingFingerprint(model);
  const legacyCount = withLazyContentVectorMigration(db, () => {
    const row = db.prepare(`SELECT COUNT(DISTINCT hash) AS count FROM content_vectors WHERE model = ? AND embed_fingerprint = ''`).get(model) as { count: number };
    return row.count;
  });
  if (legacyCount === 0) {
    return { checked: false, adopted: 0, reason: "no legacy empty-fingerprint embeddings" };
  }

  const sample = withLazyContentVectorMigration(db, () => db.prepare(`
    SELECT cv.hash, cv.seq, cv.pos, cv.total_chunks, c.doc AS body, MIN(d.path) AS path
    FROM content_vectors cv
    JOIN documents d ON d.hash = cv.hash AND d.active = 1
    JOIN content c ON c.hash = cv.hash
    WHERE cv.model = ? AND cv.embed_fingerprint = ''
    GROUP BY cv.hash, cv.seq, cv.pos, cv.total_chunks, c.doc
    ORDER BY cv.hash, cv.seq
    LIMIT 1
  `).get(model) as { hash: string; seq: number; pos: number; total_chunks: number; body: string; path: string } | undefined);

  if (!sample) {
    return { checked: false, adopted: 0, reason: `${legacyCount} legacy docs have no active sample` };
  }

  const tableExists = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='vectors_vec'`).get();
  if (!tableExists) {
    return { checked: false, adopted: 0, reason: "vectors_vec table is missing" };
  }

  const expectedHashSeq = `${sample.hash}_${sample.seq}`;
  const title = extractTitle(sample.body, sample.path);
  const llm = getLlm(store);

  return await withLLMSessionForLlm(llm, async (session) => {
    const chunks = await chunkDocumentByTokens(sample.body, undefined, undefined, undefined, sample.path, undefined, session.signal);
    const chunk = chunks[sample.seq];
    if (!chunk) {
      return { checked: true, adopted: 0, reason: `sample chunk ${expectedHashSeq} no longer exists` };
    }

    const result = await session.embed(formatDocForEmbedding(chunk.text, title, model), { model });
    if (!result) {
      return { checked: true, adopted: 0, reason: "failed to embed legacy sample" };
    }

    const nearest = db.prepare(`
      SELECT hash_seq, distance
      FROM vectors_vec
      WHERE embedding MATCH ? AND k = 1
    `).get(new Float32Array(result.embedding)) as { hash_seq: string; distance: number } | undefined;

    if (!nearest) {
      return { checked: true, adopted: 0, reason: "legacy sample vector not found" };
    }

    const threshold = 0.0001;
    if (nearest.hash_seq !== expectedHashSeq || nearest.distance > threshold) {
      return { checked: true, adopted: 0, reason: `legacy sample differs from current fingerprint (nearest ${nearest.hash_seq}, distance ${nearest.distance.toFixed(6)})` };
    }

    const update = withLazyContentVectorMigration(db, () => db.prepare(`UPDATE content_vectors SET embed_fingerprint = ? WHERE model = ? AND embed_fingerprint = ''`).run(fingerprint, model));
    return { checked: true, adopted: update.changes, reason: `sample ${expectedHashSeq} matched current fingerprint at distance ${nearest.distance.toFixed(6)}` };
  });
}

// Re-export cleanup and health functions from the extracted module
export {
  cleanupOrphanedContent,
  cleanupOrphanedVectors,
  deleteInactiveDocuments,
  deleteLLMCache,
  getIndexHealth,
  vacuumDatabase,
  type IndexHealthInfo,
};

// Re-export getHashesNeedingEmbedding from embedding-pipeline
export { getHashesNeedingEmbedding };

// Re-export embedding DB ops from embedding-pipeline module
export { getHashesForEmbedding, clearAllEmbeddings, insertEmbedding };

// Re-export cache functions from the extracted module
export {
  clearCache,
  getCacheKey,
  getCachedResult,
  setCachedResult,
};

export {
  hashContent,
  extractTitle,
  insertContent,
  insertDocument,
  findActiveDocument,
  findOrMigrateLegacyDocument,
  updateDocumentTitle,
  updateDocument,
  deactivateDocument,
  getActiveDocumentPaths,
};

// =============================================================================
export { formatQueryForEmbedding, formatDocForEmbedding } from "./llm.js";

// Retrieval primitives
export {
  type VirtualPath, normalizeVirtualPath, parseVirtualPath, buildVirtualPath,
  isVirtualPath, resolveVirtualPath, toVirtualPath,
  type DocumentResult, type SearchResult, type SearchResultOptions,
  type RankedResult, type RRFContributionTrace, type RRFScoreTrace,
  type HybridQueryExplain, type DocumentNotFound, type MultiGetResult,
  type CollectionInfo, type IndexStatus,
  getDocid, handelize, emojiToHex, normalizeDocid, isDocid,
  findDocumentByDocid, findSimilarFiles, matchFilesByGlob,
  sanitizeFTS5Term, validateSemanticQuery, validateLexQuery,
  searchFTS, searchVec,
  findDocument, getDocumentBody, findDocuments,
  getContextForPath, getContextForFile, createContextResolver,
  getCollectionByName, listCollections, removeCollection, renameCollection,
  getAllCollections, getCollectionsWithoutContext, getTopLevelPathsWithoutContext,
  insertContext, deleteContext, deleteGlobalContexts, listPathContexts,
  getStatus, type SnippetResult, type HydratedSearchDocument,
  INTENT_WEIGHT_SNIPPET, INTENT_WEIGHT_CHUNK,
  extractIntentTerms, extractSnippet,
  addLineNumbers, loadSearchDocumentsByFilepaths,
} from "./store/retrieval.js";

// Query engine
export {
  expandQuery, rerank, reciprocalRankFusion, buildRrfTrace,
  hybridQuery, vectorSearchQuery, structuredSearch,
  getHybridRrfWeights,
  STRONG_SIGNAL_MIN_SCORE, STRONG_SIGNAL_MIN_GAP, RERANK_CANDIDATE_LIMIT,
  type ExpandedQuery, type SearchHooks, type HybridQueryOptions,
  type HybridQueryResult, type VectorSearchOptions, type VectorSearchResult,
  type StructuredSearchOptions, type RankedListMeta, type StoreQueryApi,
} from "./store/query-engine.js";
