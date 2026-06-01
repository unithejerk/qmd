/**
 * Document Operations — content/document CRUD helpers for QMD store.
 *
 * Provides all functions for creating, reading, updating, and deactivating
 * documents and their content-addressable storage. Also handles FTS index
 * maintenance and legacy path migration.
 */

import { createHash } from "crypto";
import type { Database } from "../db.js";
import { normalizeCjkForFTS } from "./db-init.js";

export const UNKNOWN_SOURCE_MTIME_MS = -1;
export const UNKNOWN_SOURCE_SIZE = -1;

// =============================================================================
// Content hashing & title extraction
// =============================================================================

/**
 * Produce a SHA-256 hex digest of a content string.
 */
export async function hashContent(content: string): Promise<string> {
  const hash = createHash("sha256");
  hash.update(content);
  return hash.digest("hex");
}

const titleExtractors: Record<string, (content: string) => string | null> = {
  '.md': (content) => {
    const match = content.match(/^##?\s+(.+)$/m);
    if (match) {
      const title = (match[1] ?? "").trim();
      if (title === "📝 Notes" || title === "Notes") {
        const nextMatch = content.match(/^##\s+(.+)$/m);
        if (nextMatch?.[1]) return nextMatch[1].trim();
      }
      return title;
    }
    return null;
  },
  '.org': (content) => {
    const titleProp = content.match(/^#\+TITLE:\s*(.+)$/im);
    if (titleProp?.[1]) return titleProp[1].trim();
    const heading = content.match(/^\*+\s+(.+)$/m);
    if (heading?.[1]) return heading[1].trim();
    return null;
  },
};

/**
 * Extract a title from document content. Falls back to the filename stem
 * when no heading or title property is found.
 */
export function extractTitle(content: string, filename: string): string {
  const ext = filename.slice(filename.lastIndexOf('.')).toLowerCase();
  const extractor = titleExtractors[ext];
  if (extractor) {
    const title = extractor(content);
    if (title) return title;
  }
  return filename.replace(/\.[^.]+$/, "").split("/").pop() || filename;
}

// =============================================================================
// FTS index maintenance (internal)
// =============================================================================

/**
 * Rebuild the FTS5 entry for a single active document.
 * Deletes any existing row and inserts fresh CJK-normalised text.
 */
function rebuildDocumentFTS(db: Database, documentId: number): void {
  const row = db.prepare(`
    SELECT d.id, d.collection, d.path, d.title, content.doc as body
    FROM documents d
    JOIN content ON content.hash = d.hash
    WHERE d.id = ? AND d.active = 1
  `).get(documentId) as { id: number; collection: string; path: string; title: string; body: string } | undefined;

  db.prepare(`DELETE FROM documents_fts WHERE rowid = ?`).run(documentId);
  if (!row) return;

  db.prepare(`
    INSERT INTO documents_fts(rowid, filepath, title, body)
    VALUES (?, ?, ?, ?)
  `).run(
    row.id,
    normalizeCjkForFTS(`${row.collection}/${row.path}`),
    normalizeCjkForFTS(row.title),
    normalizeCjkForFTS(row.body)
  );
}

// =============================================================================
// Content storage
// =============================================================================

/**
 * Insert content into the content table (content-addressable storage).
 * Uses INSERT OR IGNORE so duplicate hashes are skipped.
 */
export function insertContent(db: Database, hash: string, content: string, createdAt: string): void {
  db.prepare(`INSERT OR IGNORE INTO content (hash, doc, created_at) VALUES (?, ?, ?)`)
    .run(hash, content, createdAt);
}

// =============================================================================
// Document CRUD
// =============================================================================

/**
 * Insert a new document into the documents table.
 */
export function insertDocument(
  db: Database,
  collectionName: string,
  path: string,
  title: string,
  hash: string,
  createdAt: string,
  modifiedAt: string,
  sourceMtimeMs: number = UNKNOWN_SOURCE_MTIME_MS,
  sourceSize: number = UNKNOWN_SOURCE_SIZE
): void {
  db.prepare(`
    INSERT INTO documents (collection, path, title, hash, created_at, modified_at, source_mtime_ms, source_size, active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
    ON CONFLICT(collection, path) DO UPDATE SET
      title = excluded.title,
      hash = excluded.hash,
      modified_at = excluded.modified_at,
      source_mtime_ms = excluded.source_mtime_ms,
      source_size = excluded.source_size,
      active = 1
  `).run(collectionName, path, title, hash, createdAt, modifiedAt, sourceMtimeMs, sourceSize);

  const row = db.prepare(`SELECT id FROM documents WHERE collection = ? AND path = ?`).get(collectionName, path) as { id: number } | undefined;
  if (row) rebuildDocumentFTS(db, row.id);
}

/**
 * Find an active document by collection name and path.
 */
export function findActiveDocument(
  db: Database,
  collectionName: string,
  path: string
) : { id: number; hash: string; title: string; sourceMtimeMs: number; sourceSize: number } | null {
  const row = db.prepare(`
    SELECT id, hash, title, source_mtime_ms, source_size FROM documents
    WHERE collection = ? AND path = ? AND active = 1
  `).get(collectionName, path) as {
    id: number;
    hash: string;
    title: string;
    source_mtime_ms: number;
    source_size: number;
  } | undefined;
  return row ? {
    id: row.id,
    hash: row.hash,
    title: row.title,
    sourceMtimeMs: row.source_mtime_ms,
    sourceSize: row.source_size,
  } : null;
}

/**
 * Find an active document, falling back to a case-insensitive path match.
 * If found under a different casing, renames it in-place and rebuilds the
 * FTS entry. Embeddings are keyed by content hash, so the rename is
 * safe — no re-embedding required.
 *
 * @internal Used by reindexCollection and indexFiles during qmd update.
 * Returns null if the document does not exist under either path.
 */
export function findOrMigrateLegacyDocument(
  db: Database,
  collectionName: string,
  path: string
): { id: number; hash: string; title: string; sourceMtimeMs: number; sourceSize: number } | null {
  const existing = findActiveDocument(db, collectionName, path);
  if (existing) return existing;

  const legacy = db.prepare(`
    SELECT id, hash, title FROM documents
    WHERE collection = ? AND path COLLATE NOCASE = ? AND active = 1
    ORDER BY id
    LIMIT 1
  `).get(collectionName, path) as { id: number; hash: string; title: string } | undefined;
  if (!legacy) return null;

  // Wrap rename + FTS rebuild in a transaction for atomicity.
  const migrate = db.transaction(() => {
    // Use OR IGNORE so a UNIQUE conflict (e.g. both "readme.md" and
    // "README.md" already exist) is a no-op rather than crashing.
    const result = db.prepare(
      `UPDATE OR IGNORE documents SET path = ? WHERE id = ? AND active = 1`
    ).run(path, legacy.id);

    if (result.changes === 0) return false;

    rebuildDocumentFTS(db, legacy.id);

    return true;
  });

  if (!migrate()) return null;

  return findActiveDocument(db, collectionName, path);
}

/**
 * Update the title, modified_at, and source metadata for a document.
 */
export function updateDocumentTitle(
  db: Database,
  documentId: number,
  title: string,
  modifiedAt: string,
  sourceMtimeMs: number = UNKNOWN_SOURCE_MTIME_MS,
  sourceSize: number = UNKNOWN_SOURCE_SIZE
): void {
  db.prepare(`
    UPDATE documents
    SET title = ?, modified_at = ?, source_mtime_ms = ?, source_size = ?
    WHERE id = ?
  `).run(title, modifiedAt, sourceMtimeMs, sourceSize, documentId);
  rebuildDocumentFTS(db, documentId);
}

/**
 * Update only the source-metadata columns for a document
 * (used when content hasn't changed but mtime/size has).
 */
export function updateDocumentSourceMetadata(
  db: Database,
  documentId: number,
  sourceMtimeMs: number,
  sourceSize: number
): void {
  db.prepare(`
    UPDATE documents
    SET source_mtime_ms = ?, source_size = ?
    WHERE id = ?
  `).run(sourceMtimeMs, sourceSize, documentId);
}

/**
 * Update an existing document's hash, title, modified_at, and source metadata.
 * Used when content changes but the file path stays the same.
 */
export function updateDocument(
  db: Database,
  documentId: number,
  title: string,
  hash: string,
  modifiedAt: string,
  sourceMtimeMs: number = UNKNOWN_SOURCE_MTIME_MS,
  sourceSize: number = UNKNOWN_SOURCE_SIZE
): void {
  db.prepare(`
    UPDATE documents
    SET title = ?, hash = ?, modified_at = ?, source_mtime_ms = ?, source_size = ?
    WHERE id = ?
  `).run(title, hash, modifiedAt, sourceMtimeMs, sourceSize, documentId);
  rebuildDocumentFTS(db, documentId);
}

/**
 * Deactivate a document (mark as inactive but don't delete).
 */
export function deactivateDocument(db: Database, collectionName: string, path: string): void {
  db.prepare(`UPDATE documents SET active = 0 WHERE collection = ? AND path = ? AND active = 1`)
    .run(collectionName, path);
}

/**
 * Get all active document paths for a collection.
 */
export function getActiveDocumentPaths(db: Database, collectionName: string): string[] {
  const rows = db.prepare(`
    SELECT path FROM documents WHERE collection = ? AND active = 1
  `).all(collectionName) as { path: string }[];
  return rows.map(r => r.path);
}
