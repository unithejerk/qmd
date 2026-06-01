/**
 * QMD Store - Core data access and retrieval functions
 *
 * This module provides all database operations, search functions, and document
 * retrieval for QMD. It returns raw data structures that can be formatted by
 * CLI or MCP consumers.
 *
 * Usage:
 *   const store = createStore("/path/to/db.sqlite");
 *   // or use default path:
 *   const store = createStore();
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
 * Get the active LLM instance for a store — prefers the store instance and
 * falls back to the global singleton.
 */
function getLlm(store: Store): LLM {
  return getStoreLlm(store.llm);
}

export function isSqliteVecAvailable(): boolean {
  return isSqliteVecAvailableState();
}


// =============================================================================
// Store Factory
// =============================================================================

export type Store = {
  db: Database;
  dbPath: string;
  /** Optional LLM instance for this store (overrides the global singleton) */
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
 * Generate vector embeddings for documents that need them.
 * Thin wrapper that bridges the Store-based API to the decomposed embedding pipeline.
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
 * Create a new store instance with the given database path.
 * If no path is provided, uses the default path (~/.cache/qmd/index.sqlite).
 *
 * @param dbPath - Path to the SQLite database file
 * @returns Store instance with all methods bound to the database
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
 * Unified document result type with all metadata.
 * Body is optional - use getDocumentBody() to load it separately if needed.
 */
export type LegacyFingerprintAdoptionResult = {
  checked: boolean;
  adopted: number;
  reason: string;
};

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
