/**
 * Collection reindexing logic
 *
 * Extracted from store.ts to keep the store module focused on data access.
 */

import fastGlob from "fast-glob";
import { readFileSync, statSync } from "node:fs";
import { getRealPath, normalizePathSeparators, resolve } from "./path-utils.js";
import { splitTopLevelCommaPatterns } from "../glob-patterns.js";
import {
  deactivateDocument,
  extractTitle,
  findOrMigrateLegacyDocument,
  getActiveDocumentPaths,
  hashContent,
  insertContent,
  insertDocument,
  updateDocument,
  updateDocumentSourceMetadata,
  updateDocumentTitle,
  UNKNOWN_SOURCE_MTIME_MS,
} from "./document-ops.js";
import { cleanupOrphanedContent } from "./cleanup.js";
import type { Store } from "../store.js";

// =============================================================================
// Reindex — pure-logic functions for SDK and CLI
// =============================================================================

export type ReindexProgress = {
  file: string;
  current: number;
  total: number;
};

export type ReindexResult = {
  indexed: number;
  updated: number;
  unchanged: number;
  removed: number;
  orphanedCleaned: number;
};

/**
 * Re-index a single collection by scanning the filesystem and updating the database.
 * Pure function — no console output, no db lifecycle management.
 */
export async function reindexCollection(
  store: Store,
  collectionPath: string,
  globPattern: string,
  collectionName: string,
  options?: {
    ignorePatterns?: string[];
    onProgress?: (info: ReindexProgress) => void;
  }
): Promise<ReindexResult> {
  const db = store.db;
  const now = new Date().toISOString();
  const excludeDirs = ["node_modules", ".git", ".cache", "vendor", "dist", "build"];

  const allIgnore = [
    ...excludeDirs.map(d => `**/${d}/**`),
    ...(options?.ignorePatterns || []),
  ];
  const patterns = splitTopLevelCommaPatterns(globPattern);
  const fastGlobInput = patterns.length === 1 ? patterns[0]! : patterns;
  const allFiles: string[] = await fastGlob(fastGlobInput, {
    cwd: collectionPath,
    onlyFiles: true,
    followSymbolicLinks: false,
    dot: false,
    ignore: allIgnore,
  });
  // Filter hidden files/folders
  const files = allFiles.filter(file => {
    const parts = file.split("/");
    return !parts.some(part => part.startsWith("."));
  });

  const total = files.length;
  let indexed = 0, updated = 0, unchanged = 0, processed = 0;
  const seenPaths = new Set<string>();

  for (const relativeFile of files) {
    const filepath = getRealPath(resolve(collectionPath, relativeFile));
    const path = normalizePathSeparators(relativeFile);
    seenPaths.add(path);

    let sourceMetadata: SourceMetadata;
    try {
      sourceMetadata = getSourceMetadata(filepath);
    } catch {
      processed++;
      options?.onProgress?.({ file: relativeFile, current: processed, total });
      continue;
    }

    const existing = findOrMigrateLegacyDocument(db, collectionName, path);
    if (
      existing &&
      existing.sourceMtimeMs === sourceMetadata.sourceMtimeMs &&
      existing.sourceSize === sourceMetadata.sourceSize
    ) {
      unchanged++;
      processed++;
      options?.onProgress?.({ file: relativeFile, current: processed, total });
      continue;
    }

    let content: string;
    try {
      content = readFileSync(filepath, "utf-8");
    } catch {
      processed++;
      options?.onProgress?.({ file: relativeFile, current: processed, total });
      continue;
    }

    if (!content.trim()) {
      processed++;
      continue;
    }

    const hash = await hashContent(content);
    const title = extractTitle(content, relativeFile);

    if (existing) {
      if (existing.hash === hash) {
        if (existing.title !== title) {
          updateDocumentTitle(db, existing.id, title, now, sourceMetadata.sourceMtimeMs, sourceMetadata.sourceSize);
          updated++;
        } else {
          updateDocumentSourceMetadata(db, existing.id, sourceMetadata.sourceMtimeMs, sourceMetadata.sourceSize);
          unchanged++;
        }
      } else {
        insertContent(db, hash, content, now);
        updateDocument(db, existing.id, title, hash,
          sourceMetadata.modifiedAt,
          sourceMetadata.sourceMtimeMs,
          sourceMetadata.sourceSize,
        );
        updated++;
      }
    } else {
      indexed++;
      insertContent(db, hash, content, now);
      insertDocument(db, collectionName, path, title, hash,
        sourceMetadata.createdAt,
        sourceMetadata.modifiedAt,
        sourceMetadata.sourceMtimeMs,
        sourceMetadata.sourceSize,
      );
    }

    processed++;
    options?.onProgress?.({ file: relativeFile, current: processed, total });
  }

  // Deactivate documents that no longer exist
  const allActive = getActiveDocumentPaths(db, collectionName);
  let removed = 0;
  for (const path of allActive) {
    if (!seenPaths.has(path)) {
      deactivateDocument(db, collectionName, path);
      removed++;
    }
  }

  const orphanedCleaned = cleanupOrphanedContent(db);

  return { indexed, updated, removed, unchanged, orphanedCleaned };
}

function normalizeSourceMtimeMs(mtimeMs: number): number {
  return Number.isFinite(mtimeMs) ? Math.trunc(mtimeMs) : UNKNOWN_SOURCE_MTIME_MS;
}

type SourceMetadata = {
  sourceMtimeMs: number;
  sourceSize: number;
  createdAt: string;
  modifiedAt: string;
};

function getSourceMetadata(filepath: string): SourceMetadata {
  const stat = statSync(filepath);
  return {
    sourceMtimeMs: normalizeSourceMtimeMs(stat.mtimeMs),
    sourceSize: stat.size,
    createdAt: new Date(stat.birthtimeMs || stat.mtimeMs).toISOString(),
    modifiedAt: new Date(stat.mtimeMs).toISOString(),
  };
}
