/**
 * Embedding pipeline — generate and manage vector embeddings for documents.
 *
 * This module handles the complete lifecycle of vector embeddings:
 * - **Fingerprint:** {@link getEmbeddingFingerprint} computes a content-hash of
 *   embedding parameters (model, prompt format, chunk sizes) for change detection.
 * - **Table management:** {@link ensureVecTable} creates or validates the sqlite-vec
 *   virtual table with dimension matching; detects and reports dimension mismatches.
 * - **Column migration:** {@link withLazyContentVectorMigration} wraps DB operations
 *   and auto-repairs the `content_vectors` table schema on "no such column" errors.
 * - **Embedding generation:** {@link generateEmbeddings} is the main entry point:
 *   discovers pending hashes, chunks documents, embeds in batches with retry logic
 *   and error-rate thresholds, and persists results.
 * - **CRUD:** {@link insertEmbedding}, {@link clearAllEmbeddings}, {@link getHashesForEmbedding},
 *   {@link getHashesNeedingEmbedding}, {@link getStoreLlm}.
 *
 * @module embedding-pipeline
 */

import { createHash } from "crypto";
import { readFileSync } from "node:fs";
import type { Database } from "../db.js";
import {
  CHUNK_SIZE_TOKENS,
  CHUNK_OVERLAP_TOKENS,
  CHUNK_SIZE_CHARS,
  CHUNK_OVERLAP_CHARS,
  CHUNK_WINDOW_TOKENS,
  CHUNK_WINDOW_CHARS,
  type ChunkStrategy,
} from "./chunking.js";
import {
  getDefaultLlamaCpp,
  formatQueryForEmbedding,
  formatDocForEmbedding,
  withLLMSessionForLlm,
  DEFAULT_EMBED_MODEL_URI,
  type LLM,
} from "../llm.js";
import {
  isSqliteVecAvailableState,
  createSqliteVecUnavailableError,
  getSqliteVecUnavailableReason,
  initializeDatabase,
} from "./db-init.js";

// =============================================================================
// Constants (embedding-pipeline scope)
// =============================================================================

const EMBED_FINGERPRINT_PROBE_QUERY = "__qmd_embedding_query_probe__";
const EMBED_FINGERPRINT_PROBE_TITLE = "__qmd_embedding_title_probe__";
const EMBED_FINGERPRINT_PROBE_DOC = "__qmd_embedding_document_probe__";

// =============================================================================
// Embedding fingerprint
// =============================================================================

/**
 * Compute a short fingerprint hash based on the embedding model identity,
 * prompt formatting, and chunking parameters.
 *
 * The fingerprint changes whenever any of these change, causing a full
 * re-embed on the next `generateEmbeddings` call. This allows QMD to
 * automatically detect when existing vectors are stale.
 *
 * Components included:
 * - Model URI
 * - Formatted query-probe embedding text
 * - Formatted document-probe embedding text (with title)
 * - Chunk size and overlap (in tokens)
 *
 * @param model - Embedding model identifier (defaults to `DEFAULT_EMBED_MODEL_URI`)
 * @returns A 6-character hex string serving as the stable fingerprint for the
 *   current embedding configuration
 */
export function getEmbeddingFingerprint(model: string = DEFAULT_EMBED_MODEL_URI): string {
  const significant = [
    `model:${model}`,
    `query:${formatQueryForEmbedding(EMBED_FINGERPRINT_PROBE_QUERY, model)}`,
    `doc:${formatDocForEmbedding(EMBED_FINGERPRINT_PROBE_DOC, EMBED_FINGERPRINT_PROBE_TITLE, model)}`,
    `chunk_tokens:${CHUNK_SIZE_TOKENS}`,
    `chunk_overlap_tokens:${CHUNK_OVERLAP_TOKENS}`,
  ].join("\n");
  return createHash("sha256").update(significant).digest("hex").slice(0, 6);
}

// =============================================================================
// Vector table management
// =============================================================================

/**
 * Create or validate the sqlite-vec virtual table (`vectors_vec`).
 *
 * Checks that the existing table has the correct dimensions, hash_seq column,
 * and cosine distance metric. If dimensions have changed, throws an error
 * directing the user to re-embed with `-f`. If the table is missing or has
 * the wrong schema, it is dropped and recreated.
 *
 * @param db - Database handle
 * @param dimensions - Number of dimensions the embedding model produces
 * @returns void
 *
 * @throws {Error} If sqlite-vec is not loaded (`isSqliteVecAvailableState()` is false)
 * @throws {Error} If the existing table has a different dimension count and the
 *   user must re-embed with `qmd embed -f`
 *
 * **Side effects:** May execute `CREATE VIRTUAL TABLE` or `DROP TABLE` on `vectors_vec`.
 */
export function ensureVecTable(db: Database, dimensions: number): void {
  if (!isSqliteVecAvailableState()) {
    throw createSqliteVecUnavailableError(
      getSqliteVecUnavailableReason() ?? "vector operations require a SQLite build with extension loading support"
    );
  }
  const tableInfo = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='vectors_vec'`).get() as { sql: string } | null;
  if (tableInfo) {
    const match = tableInfo.sql.match(/float\[(\d+)\]/);
    const hasHashSeq = tableInfo.sql.includes('hash_seq');
    const hasCosine = tableInfo.sql.includes('distance_metric=cosine');
    const existingDims = match?.[1] ? parseInt(match[1], 10) : null;
    if (existingDims === dimensions && hasHashSeq && hasCosine) return;
    if (existingDims !== null && existingDims !== dimensions) {
      throw new Error(
        `Embedding dimension mismatch: existing vectors are ${existingDims}d but the current model produces ${dimensions}d. ` +
        `Run 'qmd embed -f' to re-embed with the new model.`
      );
    }
    db.exec("DROP TABLE IF EXISTS vectors_vec");
  }
  db.exec(`CREATE VIRTUAL TABLE vectors_vec USING vec0(hash_seq TEXT PRIMARY KEY, embedding float[${dimensions}] distance_metric=cosine)`);
}

// =============================================================================
// Types
// =============================================================================

export type EmbedFailure = {
  path: string;
  hash: string;
  seq: number;
  attempts: number;
  reason: string;
};

export type EmbedProgress = {
  chunksEmbedded: number;
  totalChunks: number;
  bytesProcessed: number;
  totalBytes: number;
  /** Active failed chunks still awaiting a successful retry. */
  errors: number;
  failures?: EmbedFailure[];
};

export type EmbedResult = {
  docsProcessed: number;
  chunksEmbedded: number;
  /** Active failed chunks that did not recover after retries. */
  errors: number;
  failures?: EmbedFailure[];
  durationMs: number;
};

export type EmbedOptions = {
  force?: boolean;
  model?: string;
  /**
   * Restrict embedding to documents in a single collection.
   * When omitted, all pending documents across every collection are embedded.
   */
  collection?: string;
  maxDocsPerBatch?: number;
  maxBatchBytes?: number;
  chunkStrategy?: ChunkStrategy;
  onProgress?: (info: EmbedProgress) => void;
};

type PendingEmbeddingDoc = {
  hash: string;
  path: string;
  bytes: number;
};

type EmbeddingDoc = PendingEmbeddingDoc & {
  body: string;
};

type ChunkItem = {
  hash: string;
  path: string;
  title: string;
  text: string;
  seq: number;
  pos: number;
  tokens: number;
  bytes: number;
  expectedTotalChunks: number;
};

// =============================================================================
// Content vector table migration (column repair)
// =============================================================================

const CONTENT_VECTOR_DESIRED_COLUMNS: { name: string; definition: string }[] = [
  { name: "seq", definition: "INTEGER NOT NULL DEFAULT 0" },
  { name: "pos", definition: "INTEGER NOT NULL DEFAULT 0" },
  { name: "model", definition: "TEXT NOT NULL DEFAULT ''" },
  { name: "embed_fingerprint", definition: "TEXT NOT NULL DEFAULT ''" },
  { name: "total_chunks", definition: "INTEGER NOT NULL DEFAULT 1" },
  { name: "embedded_at", definition: "TEXT NOT NULL DEFAULT ''" },
];

function isContentVectorColumnError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (!/(no such column|has no column named)/i.test(message)) {
    return false;
  }
  return CONTENT_VECTOR_DESIRED_COLUMNS.some(col => message.includes(col.name));
}

function runContentVectorColumnRepairs(db: Database): void {
  for (const column of CONTENT_VECTOR_DESIRED_COLUMNS) {
    try {
      db.exec(`ALTER TABLE content_vectors ADD COLUMN ${column.name} ${column.definition}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("duplicate column name")) {
        throw error;
      }
    }
  }
}

/**
 * Wrap a database operation that may hit "no such column" errors on the
 * `content_vectors` table, automatically repairing missing columns on first
 * failure and retrying.
 *
 * This supports zero-downtime schema migration: when QMD is updated to a
 * version that added a new column (e.g. `embed_fingerprint`), existing
 * databases will fail the first time they query that column. This wrapper
 * catches that error, adds the missing column via `ALTER TABLE`, and retries
 * the operation.
 *
 * @param db - Database handle
 * @param operation - The operation to execute (typically a query against `content_vectors`)
 * @returns The return value of `operation`
 *
 * @throws {Error} If the error is not a column-missing error, or if the error
 *   persists after the column repair was attempted
 *
 * **Side effects:** May execute `ALTER TABLE content_vectors ADD COLUMN ...` for
 * each missing column defined in `CONTENT_VECTOR_DESIRED_COLUMNS`.
 */
export function withLazyContentVectorMigration<T>(db: Database, operation: () => T): T {
  let repaired = false;
  while (true) {
    try {
      return operation();
    } catch (error) {
      if (repaired || !isContentVectorColumnError(error)) {
        throw error;
      }
      runContentVectorColumnRepairs(db);
      repaired = true;
    }
  }
}

// =============================================================================
// Options helpers
// =============================================================================

function validatePositiveIntegerOption(name: string, value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function resolveEmbedOptions(options?: EmbedOptions): Required<Pick<EmbedOptions, "maxDocsPerBatch" | "maxBatchBytes">> {
  return {
    maxDocsPerBatch: validatePositiveIntegerOption("maxDocsPerBatch", options?.maxDocsPerBatch, 64),
    maxBatchBytes: validatePositiveIntegerOption("maxBatchBytes", options?.maxBatchBytes, 64 * 1024 * 1024),
  };
}

// =============================================================================
// Pending embedding discovery
// =============================================================================

function getPendingEmbeddingDocs(db: Database, collection: string | undefined, model: string = DEFAULT_EMBED_MODEL_URI): PendingEmbeddingDoc[] {
  const collectionFilter = collection ? `AND d.collection = ?` : ``;
  const fingerprint = getEmbeddingFingerprint(model);
  return withLazyContentVectorMigration(db, () => {
    const stmt = db.prepare(`
      SELECT d.hash, MIN(d.path) as path, length(CAST(c.doc AS BLOB)) as bytes
      FROM documents d
      JOIN content c ON d.hash = c.hash
      LEFT JOIN (
        SELECT hash, model, COUNT(*) AS chunk_count, MAX(total_chunks) AS expected_chunks
        FROM content_vectors
        WHERE model = ? AND embed_fingerprint = ?
        GROUP BY hash, model, embed_fingerprint
      ) v ON d.hash = v.hash
      WHERE d.active = 1
        AND (v.hash IS NULL OR v.chunk_count < v.expected_chunks)
        ${collectionFilter}
      GROUP BY d.hash
      ORDER BY MIN(d.path)
    `);
    return (collection ? stmt.all(model, fingerprint, collection) : stmt.all(model, fingerprint)) as PendingEmbeddingDoc[];
  });
}

// =============================================================================
// Batch building
// =============================================================================

function buildEmbeddingBatches(
  docs: PendingEmbeddingDoc[],
  maxDocsPerBatch: number,
  maxBatchBytes: number,
): PendingEmbeddingDoc[][] {
  const batches: PendingEmbeddingDoc[][] = [];
  let currentBatch: PendingEmbeddingDoc[] = [];
  let currentBytes = 0;

  for (const doc of docs) {
    const docBytes = Math.max(0, doc.bytes);
    const wouldExceedDocs = currentBatch.length >= maxDocsPerBatch;
    const wouldExceedBytes = currentBatch.length > 0 && (currentBytes + docBytes) > maxBatchBytes;

    if (wouldExceedDocs || wouldExceedBytes) {
      batches.push(currentBatch);
      currentBatch = [];
      currentBytes = 0;
    }

    currentBatch.push(doc);
    currentBytes += docBytes;
  }

  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }

  return batches;
}

function getEmbeddingDocsForBatch(db: Database, batch: PendingEmbeddingDoc[]): EmbeddingDoc[] {
  if (batch.length === 0) return [];

  const placeholders = batch.map(() => "?").join(",");
  const rows = db.prepare(`
    SELECT hash, doc as body
    FROM content
    WHERE hash IN (${placeholders})
  `).all(...batch.map(doc => doc.hash)) as { hash: string; body: string }[];
  const bodyByHash = new Map(rows.map(row => [row.hash, row.body]));

  return batch.map((doc) => ({
    ...doc,
    body: bodyByHash.get(doc.hash) ?? "",
  }));
}

// =============================================================================
// Embedding DB operations
// =============================================================================

/**
 * Get all unique content hashes that need embeddings (from active documents).
 */
export function getHashesForEmbedding(db: Database, model: string = DEFAULT_EMBED_MODEL_URI): { hash: string; body: string; path: string }[] {
  const fingerprint = getEmbeddingFingerprint(model);
  return withLazyContentVectorMigration(db, () => db.prepare(`
    SELECT d.hash, c.doc as body, MIN(d.path) as path
    FROM documents d
    JOIN content c ON d.hash = c.hash
    LEFT JOIN (
      SELECT hash, model, COUNT(*) AS chunk_count, MAX(total_chunks) AS expected_chunks
      FROM content_vectors
      WHERE model = ? AND embed_fingerprint = ?
      GROUP BY hash, model, embed_fingerprint
    ) v ON d.hash = v.hash
    WHERE d.active = 1
      AND (v.hash IS NULL OR v.chunk_count < v.expected_chunks)
    GROUP BY d.hash
  `).all(model, fingerprint) as { hash: string; body: string; path: string }[]);
}

/**
 * Clear vector embeddings for the entire index or for a single collection.
 *
 * When `collection` is omitted, all rows are deleted from `content_vectors`
 * and the `vectors_vec` virtual table is dropped entirely.
 *
 * When `collection` is specified, only embeddings whose hash belongs
 * exclusively to that collection are removed (shared hashes are preserved).
 * If the removal empties the `content_vectors` table entirely, `vectors_vec`
 * is also dropped.
 *
 * @param db - Database handle
 * @param collection - Optional collection name. If omitted, clears ALL embeddings globally.
 * @returns void
 *
 * **Side effects:**
 * - Deletes rows from `content_vectors` (may cascade to `vectors_vec`)
 * - Drops the `vectors_vec` virtual table when all vectors are removed
 * - Uses {@link withLazyContentVectorMigration} for column-repair safety
 */
export function clearAllEmbeddings(db: Database, collection?: string): void {
  if (!collection) {
    db.exec(`DELETE FROM content_vectors`);
    db.exec(`DROP TABLE IF EXISTS vectors_vec`);
    return;
  }

  const exclusiveHashesQuery = `
    SELECT DISTINCT d.hash
    FROM documents d
    WHERE d.collection = ? AND d.active = 1
      AND NOT EXISTS (
        SELECT 1 FROM documents d2
        WHERE d2.hash = d.hash
          AND d2.active = 1
          AND d2.collection != d.collection
      )
  `;

  const vecTableExists = db
    .prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='vectors_vec'`)
    .get();

  withLazyContentVectorMigration(db, () => {
    if (vecTableExists) {
      const hashSeqRows = db.prepare(`
        SELECT cv.hash, cv.seq
        FROM content_vectors cv
        WHERE cv.hash IN (${exclusiveHashesQuery})
      `).all(collection) as { hash: string; seq: number }[];

      const delVec = db.prepare(`DELETE FROM vectors_vec WHERE hash_seq = ?`);
      for (const row of hashSeqRows) {
        delVec.run(`${row.hash}_${row.seq}`);
      }
    }

    db.prepare(`
      DELETE FROM content_vectors
      WHERE hash IN (${exclusiveHashesQuery})
    `).run(collection);

    const remaining = db
      .prepare(`SELECT COUNT(*) AS n FROM content_vectors`)
      .get() as { n: number };
    if (remaining.n === 0) {
      db.exec(`DROP TABLE IF EXISTS vectors_vec`);
    }
  });
}

/**
 * Insert a single embedding into both `content_vectors` and `vectors_vec`.
 *
 * This function:
 * 1. Inserts or replaces the metadata row in `content_vectors` (hash, seq, pos,
 *    model, fingerprint, total_chunks, embedded_at)
 * 2. Deletes any existing `vectors_vec` entry with the same `hash_seq`
 *    (DELETE before INSERT, not REPLACE, because vec0 tables do not support
 *    INSERT OR REPLACE)
 * 3. Inserts the new embedding vector into `vectors_vec`
 *
 * The two-phase write (DELETE + INSERT) makes this safe for crash recovery:
 * if the process dies between steps, the old vector is gone but the missing
 * vector will be detected by the next embed pass (chunk count mismatch).
 *
 * @param db - Database handle
 * @param hash - Content hash of the parent document
 * @param seq - Chunk sequence number (0-indexed within the document)
 * @param pos - Character position of the chunk in the original document
 * @param embedding - The embedding vector as a Float32Array
 * @param model - Embedding model identifier
 * @param embeddedAt - ISO 8601 timestamp of when the embedding was created
 * @param totalChunks - Total number of chunks expected for this hash (default 1)
 * @param fingerprint - Current embedding fingerprint (defaults to {@link getEmbeddingFingerprint})
 * @returns void
 *
 * **Side effects:**
 * - Writes to `content_vectors` (INSERT OR REPLACE)
 * - Writes to `vectors_vec` (DELETE + INSERT)
 * - Uses {@link withLazyContentVectorMigration} for column-repair safety
 */
export function insertEmbedding(
  db: Database,
  hash: string,
  seq: number,
  pos: number,
  embedding: Float32Array,
  model: string,
  embeddedAt: string,
  totalChunks: number = 1,
  fingerprint: string = getEmbeddingFingerprint(model)
): void {
  const hashSeq = `${hash}_${seq}`;

  withLazyContentVectorMigration(db, () => {
    const insertContentVectorStmt = db.prepare(`INSERT OR REPLACE INTO content_vectors (hash, seq, pos, model, embed_fingerprint, total_chunks, embedded_at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    insertContentVectorStmt.run(hash, seq, pos, model, fingerprint, totalChunks, embeddedAt);

    const deleteVecStmt = db.prepare(`DELETE FROM vectors_vec WHERE hash_seq = ?`);
    const insertVecStmt = db.prepare(`INSERT INTO vectors_vec (hash_seq, embedding) VALUES (?, ?)`);
    deleteVecStmt.run(hashSeq);
    insertVecStmt.run(hashSeq, embedding);
  });
}

function removeIncompleteEmbeddings(db: Database, expectedChunksByHash: Map<string, number>, model: string): number {
  return withLazyContentVectorMigration(db, () => {
    let removed = 0;
    const rowsStmt = db.prepare(`SELECT seq FROM content_vectors WHERE hash = ? AND model = ?`);
    const deleteContentStmt = db.prepare(`DELETE FROM content_vectors WHERE hash = ? AND model = ?`);
    const deleteVecStmt = db.prepare(`DELETE FROM vectors_vec WHERE hash_seq = ?`);

    for (const [hash, expectedChunks] of expectedChunksByHash) {
      const rows = rowsStmt.all(hash, model) as { seq: number }[];
      if (rows.length === 0 || rows.length === expectedChunks) continue;

      for (const row of rows) {
        deleteVecStmt.run(`${hash}_${row.seq}`);
      }
      deleteContentStmt.run(hash, model);
      removed += rows.length;
    }

    return removed;
  });
}

/**
 * Count active documents that need embedding.
 */
export function getHashesNeedingEmbedding(db: Database, collection?: string, model: string = DEFAULT_EMBED_MODEL_URI): number {
  const collectionFilter = collection ? `AND d.collection = ?` : ``;
  const fingerprint = getEmbeddingFingerprint(model);
  return withLazyContentVectorMigration(db, () => {
    const stmt = db.prepare(`
      SELECT COUNT(DISTINCT d.hash) as count
      FROM documents d
      LEFT JOIN (
        SELECT hash, model, COUNT(*) AS chunk_count, MAX(total_chunks) AS expected_chunks
        FROM content_vectors
        WHERE model = ? AND embed_fingerprint = ?
        GROUP BY hash, model, embed_fingerprint
      ) v ON d.hash = v.hash
      WHERE d.active = 1
        AND (v.hash IS NULL OR v.chunk_count < v.expected_chunks)
        ${collectionFilter}
    `);
    const result = (collection ? stmt.get(model, fingerprint, collection) : stmt.get(model, fingerprint)) as { count: number };
    return result.count;
  });
}

// =============================================================================
// generateEmbeddings — main entry point
// =============================================================================

/**
 * Get the active LLM instance — prefers the provided instance and falls back
 * to the global singleton.
 */
export function getStoreLlm(llm?: LLM): LLM {
  return llm ?? getDefaultLlamaCpp();
}

/**
 * Read the embed session max duration from the environment, falling back to
 * the default 30-minute timeout.
 */
function resolveEmbedMaxDuration(): number {
  const DEFAULT_MS = 30 * 60 * 1000;
  const raw = process.env.QMD_EMBED_SESSION_MAX_DURATION_MS;
  if (raw === undefined || raw === '') {
    return DEFAULT_MS;
  }
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed) || parsed <= 0) {
    process.stderr.write(
      `Warning: QMD_EMBED_SESSION_MAX_DURATION_MS="${raw}" is not a valid positive integer; using default 30 minutes\n`
    );
    return DEFAULT_MS;
  }
  return parsed;
}

/**
 * Generate vector embeddings for documents that are missing or have stale
 * embeddings (fingerprint mismatch or incomplete chunks).
 *
 * This is the main embedding pipeline entry point. The pipeline:
 * 1. Optionally force-clear existing embeddings with `options.force`
 * 2. Discover pending document hashes via {@link getPendingEmbeddingDocs}
 * 3. Build batches respecting `maxDocsPerBatch` and `maxBatchBytes`
 * 4. Chunk each document using the provided `chunkDocumentFn`
 * 5. Detect embedding dimensions from the first chunk
 * 6. Embed chunks in sub-batches of 32 via `session.embedBatch`
 * 7. Retry failed chunks individually (up to 3 attempts)
 * 8. Abort if error rate exceeds 80% (stops data corruption)
 * 9. Remove incomplete chunk sets after each batch
 *
 * The function is a pure data pipeline — it takes explicit dependencies
 * (`db`, `ensureVecDbOp`, `extractTitleFn`, `chunkDocumentFn`) and does
 * not manage database lifecycle.
 *
 * @param db - Database handle for reading/writing embeddings
 * @param ensureVecDbOp - Callback to ensure the vectors_vec table exists with the
 *   correct dimensions (receives `dimensions: number`)
 * @param extractTitleFn - Function to extract a document title from body + filename
 * @param chunkDocumentFn - Async function to split a document body into chunks
 *   (typically {@link chunkDocumentByTokens} or {@link chunkDocumentAsync})
 * @param options - {@link EmbedOptions} for model selection, batching, force mode,
 *   collection filter, chunk strategy, and progress reporting.
 *   `options.llm` lets callers inject a RemoteLLM or test stub.
 * @returns An {@link EmbedResult} with counts of documents/chunks processed,
 *   error count, failure details, and total duration in milliseconds
 *
 * **Side effects:**
 * - Reads `documents`, `content` tables to discover pending documents
 * - Writes to `content_vectors` and `vectors_vec` via {@link insertEmbedding}
 * - Calls the LLM embedding endpoint for every chunk
 * - May call `ensureVecDbOp` to create/drop the vectors virtual table
 * - Calls `options.onProgress` after each sub-batch if provided
 * - Calls `extractTitleFn` and `chunkDocumentFn` for each document
 */
export async function generateEmbeddings(
  db: Database,
  ensureVecDbOp: (dimensions: number) => void,
  extractTitleFn: (content: string, filename: string) => string,
  chunkDocumentFn: (
    content: string,
    maxTokens?: number,
    overlapTokens?: number,
    windowTokens?: number,
    filepath?: string,
    chunkStrategy?: ChunkStrategy,
    signal?: AbortSignal
  ) => Promise<{ text: string; pos: number; tokens: number }[]>,
  options?: EmbedOptions & { llm?: LLM },
): Promise<EmbedResult> {
  const llm = getStoreLlm(options?.llm);
  const model = options?.model ?? llm.embedModelName ?? DEFAULT_EMBED_MODEL_URI;
  const fingerprint = getEmbeddingFingerprint(model);
  const now = new Date().toISOString();
  const { maxDocsPerBatch, maxBatchBytes } = resolveEmbedOptions(options);
  const encoder = new TextEncoder();

  if (options?.force) {
    clearAllEmbeddings(db, options?.collection);
  }

  const docsToEmbed = getPendingEmbeddingDocs(db, options?.collection, model);

  if (docsToEmbed.length === 0) {
    return { docsProcessed: 0, chunksEmbedded: 0, errors: 0, durationMs: 0 };
  }
  const totalBytes = docsToEmbed.reduce((sum, doc) => sum + Math.max(0, doc.bytes), 0);
  const totalDocs = docsToEmbed.length;
  const startTime = Date.now();

  const embedModelUri = model;
  const embedMaxDuration = resolveEmbedMaxDuration();

  const result = await withLLMSessionForLlm(llm, async (session) => {
    let chunksEmbedded = 0;
    let bytesProcessed = 0;
    let totalChunks = 0;
    let vectorTableInitialized = false;
    const BATCH_SIZE = 32;
    const RETRY_AFTER_SUCCESSFUL_CHUNKS = 64;
    const MAX_RETRY_ATTEMPTS = 3;
    const failures = new Map<string, EmbedFailure>();
    const retryQueue = new Map<string, ChunkItem>();
    let successesSinceRetry = 0;

    const failureList = () => [...failures.values()];
    const activeErrorCount = () => failures.size;
    const chunkKey = (chunk: ChunkItem) => `${chunk.hash}:${chunk.seq}`;
    const reasonFromError = (error: unknown) => {
      const raw = error instanceof Error ? error.message : String(error);
      return raw.length > 180 ? `${raw.slice(0, 177)}...` : raw;
    };
    const recordFailure = (chunk: ChunkItem, reason: string) => {
      const key = chunkKey(chunk);
      const previous = failures.get(key);
      failures.set(key, {
        path: chunk.path,
        hash: chunk.hash,
        seq: chunk.seq,
        attempts: (previous?.attempts ?? 0) + 1,
        reason,
      });
      retryQueue.set(key, chunk);
    };
    const clearFailure = (chunk: ChunkItem) => {
      const key = chunkKey(chunk);
      failures.delete(key);
      retryQueue.delete(key);
    };
    const tryEmbedChunk = async (chunk: ChunkItem): Promise<boolean> => {
      try {
        const text = formatDocForEmbedding(chunk.text, chunk.title, embedModelUri);
        const result = await session.embed(text, { model });
        if (!result) {
          recordFailure(chunk, "embedding returned no vector");
          return false;
        }
        insertEmbedding(db, chunk.hash, chunk.seq, chunk.pos, new Float32Array(result.embedding), model, now, chunk.expectedTotalChunks, fingerprint);
        chunksEmbedded++;
        successesSinceRetry++;
        clearFailure(chunk);
        return true;
      } catch (error) {
        recordFailure(chunk, reasonFromError(error));
        return false;
      }
    };
    const retryFailedChunks = async (force = false) => {
      if (!session.isValid || retryQueue.size === 0) return;
      if (!force && successesSinceRetry < RETRY_AFTER_SUCCESSFUL_CHUNKS) return;
      successesSinceRetry = 0;

      do {
        let retried = 0;
        for (const [key, chunk] of [...retryQueue]) {
          const failure = failures.get(key);
          if (!failure || failure.attempts >= MAX_RETRY_ATTEMPTS) continue;
          retried++;
          await tryEmbedChunk(chunk);
        }
        if (!force || retried === 0) break;
      } while (session.isValid && [...retryQueue].some(([key]) => {
        const failure = failures.get(key);
        return !!failure && failure.attempts < MAX_RETRY_ATTEMPTS;
      }));
    };
    const batches = buildEmbeddingBatches(docsToEmbed, maxDocsPerBatch, maxBatchBytes);

    for (const batchMeta of batches) {
      if (!session.isValid) {
        console.warn(`⚠ Session expired — skipping remaining document batches`);
        break;
      }

      const batchDocs = getEmbeddingDocsForBatch(db, batchMeta);
      const batchChunks: ChunkItem[] = [];
      const expectedChunksByHash = new Map<string, number>();
      const batchBytes = batchMeta.reduce((sum, doc) => sum + Math.max(0, doc.bytes), 0);

      for (const doc of batchDocs) {
        if (!doc.body.trim()) continue;

        const title = extractTitleFn(doc.body, doc.path);
        const chunks = await chunkDocumentFn(
          doc.body,
          undefined, undefined, undefined,
          doc.path,
          options?.chunkStrategy,
          session.signal,
        );

        for (let seq = 0; seq < chunks.length; seq++) {
          batchChunks.push({
            hash: doc.hash,
            path: doc.path,
            title,
            text: chunks[seq]!.text,
            seq,
            pos: chunks[seq]!.pos,
            tokens: chunks[seq]!.tokens,
            bytes: encoder.encode(chunks[seq]!.text).length,
            expectedTotalChunks: chunks.length,
          });
        }
        expectedChunksByHash.set(doc.hash, chunks.length);
      }

      totalChunks += batchChunks.length;

      if (batchChunks.length === 0) {
        bytesProcessed += batchBytes;
        options?.onProgress?.({ chunksEmbedded, totalChunks, bytesProcessed, totalBytes, errors: activeErrorCount(), failures: failureList() });
        continue;
      }

      if (!vectorTableInitialized) {
        const firstChunk = batchChunks[0]!;
        const firstText = formatDocForEmbedding(firstChunk.text, firstChunk.title, embedModelUri);
        const firstResult = await session.embed(firstText, { model });
        if (!firstResult) {
          throw new Error("Failed to get embedding dimensions from first chunk");
        }
        ensureVecDbOp(firstResult.embedding.length);
        vectorTableInitialized = true;
      }

      const totalBatchChunkBytes = batchChunks.reduce((sum, chunk) => sum + chunk.bytes, 0);
      let batchChunkBytesProcessed = 0;

      for (let batchStart = 0; batchStart < batchChunks.length; batchStart += BATCH_SIZE) {
        if (!session.isValid) {
          const remainingChunks = batchChunks.slice(batchStart);
          for (const chunk of remainingChunks) recordFailure(chunk, "LLM session expired before embedding chunk");
          console.warn(`⚠ Session expired — skipping ${remainingChunks.length} remaining chunks`);
          break;
        }

        const processed = chunksEmbedded + activeErrorCount();
        if (processed >= BATCH_SIZE && activeErrorCount() > processed * 0.8) {
          const remainingChunks = batchChunks.slice(batchStart);
          for (const chunk of remainingChunks) recordFailure(chunk, "embedding aborted because error rate was too high");
          console.warn(`⚠ Error rate too high (${activeErrorCount()}/${processed}) — aborting embedding`);
          break;
        }

        const batchEnd = Math.min(batchStart + BATCH_SIZE, batchChunks.length);
        const chunkBatch = batchChunks.slice(batchStart, batchEnd);
        const texts = chunkBatch.map(chunk => formatDocForEmbedding(chunk.text, chunk.title, embedModelUri));

        try {
          const embeddings = await session.embedBatch(texts, { model });
          for (let i = 0; i < chunkBatch.length; i++) {
            const chunk = chunkBatch[i]!;
            const embedding = embeddings[i];
            if (embedding) {
              insertEmbedding(db, chunk.hash, chunk.seq, chunk.pos, new Float32Array(embedding.embedding), model, now, chunk.expectedTotalChunks, fingerprint);
              chunksEmbedded++;
              successesSinceRetry++;
              clearFailure(chunk);
            } else {
              recordFailure(chunk, "batch embedding returned no vector");
            }
            batchChunkBytesProcessed += chunk.bytes;
          }
          await retryFailedChunks();
        } catch (error) {
          const batchReason = reasonFromError(error);
          if (!session.isValid) {
            for (const chunk of chunkBatch) recordFailure(chunk, `batch failed and session expired: ${batchReason}`);
            batchChunkBytesProcessed += chunkBatch.reduce((sum, c) => sum + c.bytes, 0);
          } else {
            for (const chunk of chunkBatch) {
              await tryEmbedChunk(chunk);
              batchChunkBytesProcessed += chunk.bytes;
              await retryFailedChunks();
            }
          }
        }

        const proportionalBytes = totalBatchChunkBytes === 0
          ? batchBytes
          : Math.min(batchBytes, Math.round((batchChunkBytesProcessed / totalBatchChunkBytes) * batchBytes));
        options?.onProgress?.({
          chunksEmbedded,
          totalChunks,
          bytesProcessed: bytesProcessed + proportionalBytes,
          totalBytes,
          errors: activeErrorCount(),
          failures: failureList(),
        });
      }

      await retryFailedChunks(true);

      const removedPartialChunks = removeIncompleteEmbeddings(db, expectedChunksByHash, model);
      if (removedPartialChunks > 0) {
        chunksEmbedded = Math.max(0, chunksEmbedded - removedPartialChunks);
      }

      bytesProcessed += batchBytes;
      options?.onProgress?.({ chunksEmbedded, totalChunks, bytesProcessed, totalBytes, errors: activeErrorCount(), failures: failureList() });
    }

    return { chunksEmbedded, errors: activeErrorCount(), failures: failureList() };
  }, { maxDuration: embedMaxDuration, name: 'generateEmbeddings' });

  return {
    docsProcessed: totalDocs,
    chunksEmbedded: result.chunksEmbedded,
    errors: result.errors,
    failures: result.failures,
    durationMs: Date.now() - startTime,
  };
}
