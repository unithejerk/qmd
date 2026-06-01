/**
 * Database cleanup and health-check operations.
 *
 * Extracted from src/store.ts to reduce module size and clarify boundaries.
 */

import type { Database } from "../db.js";
import { isSqliteVecAvailableState } from "./db-init.js";
import {
  getHashesNeedingEmbedding,
  withLazyContentVectorMigration,
} from "./embedding-pipeline.js";
import { DEFAULT_EMBED_MODEL_URI } from "../llm.js";

// =============================================================================
// Index health
// =============================================================================

export type IndexHealthInfo = {
  needsEmbedding: number;
  totalDocs: number;
  daysStale: number | null;
};

export function getIndexHealth(db: Database, model: string = DEFAULT_EMBED_MODEL_URI): IndexHealthInfo {
  const needsEmbedding = getHashesNeedingEmbedding(db, undefined, model);
  const totalDocs = (db.prepare(`SELECT COUNT(*) as count FROM documents WHERE active = 1`).get() as { count: number }).count;

  const mostRecent = db.prepare(`SELECT MAX(modified_at) as latest FROM documents WHERE active = 1`).get() as { latest: string | null };
  let daysStale: number | null = null;
  if (mostRecent?.latest) {
    const lastUpdate = new Date(mostRecent.latest);
    daysStale = Math.floor((Date.now() - lastUpdate.getTime()) / (24 * 60 * 60 * 1000));
  }

  return { needsEmbedding, totalDocs, daysStale };
}

// =============================================================================
// Cleanup and maintenance operations
// =============================================================================

/**
 * Delete cached LLM API responses.
 * Returns the number of cached responses deleted.
 */
export function deleteLLMCache(db: Database): number {
  const result = db.prepare(`DELETE FROM llm_cache`).run();
  return result.changes;
}

/**
 * Remove inactive document records (active = 0).
 * Returns the number of inactive documents deleted.
 */
export function deleteInactiveDocuments(db: Database): number {
  const result = db.prepare(`DELETE FROM documents WHERE active = 0`).run();
  return result.changes;
}

/**
 * Remove orphaned content hashes that are not referenced by any document.
 * Inactive documents are soft-deleted tombstones, so their content rows must
 * remain referenced until deleteInactiveDocuments() hard-deletes them.
 * Returns the number of orphaned content hashes deleted.
 */
export function cleanupOrphanedContent(db: Database): number {
  const result = db.prepare(`
    DELETE FROM content
    WHERE hash NOT IN (SELECT DISTINCT hash FROM documents)
  `).run();
  return result.changes;
}

/**
 * Remove orphaned vector embeddings that are not referenced by any active document.
 * Returns the number of orphaned embedding chunks deleted.
 */
export function cleanupOrphanedVectors(db: Database): number {
  // sqlite-vec may not be loaded (e.g. Bun's bun:sqlite lacks loadExtension).
  // The vectors_vec virtual table can appear in sqlite_master from a prior
  // session, but querying it without the vec0 module loaded will crash (#380).
  if (!isSqliteVecAvailableState()) {
    return 0;
  }

  // The schema entry can exist even when sqlite-vec itself is unavailable
  // (for example when reopening a DB without vec0 loaded). In that case,
  // touching the virtual table throws "no such module: vec0" and cleanup
  // should degrade gracefully like the rest of the vector features.
  try {
    db.prepare(`SELECT 1 FROM vectors_vec LIMIT 0`).get();
  } catch {
    return 0;
  }

  return withLazyContentVectorMigration(db, () => {
    // Count orphaned vectors first
    const countResult = db.prepare(`
      SELECT COUNT(*) as c FROM content_vectors cv
      WHERE NOT EXISTS (
        SELECT 1 FROM documents d WHERE d.hash = cv.hash AND d.active = 1
      )
    `).get() as { c: number };

    if (countResult.c === 0) {
      return 0;
    }

    // Delete from vectors_vec first
    db.exec(`
      DELETE FROM vectors_vec WHERE hash_seq IN (
        SELECT cv.hash || '_' || cv.seq FROM content_vectors cv
        WHERE NOT EXISTS (
          SELECT 1 FROM documents d WHERE d.hash = cv.hash AND d.active = 1
        )
      )
    `);

    // Delete from content_vectors
    db.exec(`
      DELETE FROM content_vectors WHERE hash NOT IN (
        SELECT hash FROM documents WHERE active = 1
      )
    `);

    return countResult.c;
  });
}

/**
 * Run VACUUM to reclaim unused space in the database.
 * This operation rebuilds the database file to eliminate fragmentation.
 */
export function vacuumDatabase(db: Database): void {
  db.exec(`VACUUM`);
}
