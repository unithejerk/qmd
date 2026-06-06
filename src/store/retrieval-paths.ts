/**
 * Document identifiers and virtual-path utilities.
 *
 * Keeps path normalization, docid lookup, fuzzy matching, and glob matching
 * separate from search and document hydration.
 */

import picomatch from "picomatch";
import type { Database } from "../db.js";
import { resolve as resolvePath } from "./path-utils.js";
import { getStoreCollection, getStoreCollections } from "./config-sync.js";

export { emojiToHex, handelize } from "./path-utils.js";

// =============================================================================
// Docid helpers
// =============================================================================

/**
 * Extract a short docid from a full content hash.
 *
 * The docid is the first 6 hexadecimal characters of the hash, used for
 * human-friendly document references (e.g. `#abc123`).
 *
 * @param hash - Full content hash (typically a SHA-256 hex string)
 * @returns First 6 characters of the hash
 */
export function getDocid(hash: string): string {
  return hash.slice(0, 6);
}

/**
 * Normalize a docid string by stripping surrounding quotes and leading `#`.
 *
 * Accepts any of the common user-input formats: `#abc123`, `abc123`,
 * `"#abc123"`, `'abc123'`, etc.
 *
 * @param docid - Raw docid string from user input
 * @returns Normalized hex-only string (without `#` or quotes)
 */
export function normalizeDocid(docid: string): string {
  let normalized = docid.trim();

  // Strip surrounding quotes (single or double)
  if ((normalized.startsWith('"') && normalized.endsWith('"')) ||
      (normalized.startsWith("'") && normalized.endsWith("'"))) {
    normalized = normalized.slice(1, -1);
  }

  // Strip leading # if present
  if (normalized.startsWith('#')) {
    normalized = normalized.slice(1);
  }

  return normalized;
}

/**
 * Check if a string looks like a docid reference.
 * Accepts: #abc123, abc123, "#abc123", "abc123", '#abc123', 'abc123'
 * Returns true if the normalized form is a valid hex string of 6+ chars.
 */
export function isDocid(input: string): boolean {
  const normalized = normalizeDocid(input);
  // Must be at least 6 hex characters
  return normalized.length >= 6 && /^[a-f0-9]+$/i.test(normalized);
}

// =============================================================================
// Virtual path handling
// =============================================================================

export type VirtualPath = {
  collectionName: string;
  path: string;  // relative path within collection
  indexName?: string;
};

/**
 * Normalize a virtual path to a consistent `qmd://collection/path` format.
 *
 * Handles various input styles:
 * - `qmd:////collection/path` (extra slashes) -> `qmd://collection/path`
 * - `//collection/path` (missing `qmd:` prefix) -> `qmd://collection/path`
 * - Bare filesystem paths and docids are returned as-is
 *
 * @param input - A virtual path, filesystem path, or docid string
 * @returns The normalized canonical form
 */
export function normalizeVirtualPath(input: string): string {
  let path = input.trim();

  // Handle qmd:// with extra slashes: qmd:////collection/path -> qmd://collection/path
  if (path.startsWith('qmd:')) {
    path = path.slice(4);
    path = path.replace(/^\/+/, '');
    return `qmd://${path}`;
  }

  // Handle //collection/path (missing qmd: prefix)
  if (path.startsWith('//')) {
    path = path.replace(/^\/+/, '');
    return `qmd://${path}`;
  }

  return path;
}

/**
 * Parse a virtual path URI into its structured components.
 *
 * Accepts formats:
 * - `qmd://collection-name/path/to/file.md`
 * - `qmd://collection-name?index=someIndex` (with optional query-string index name)
 * - `qmd://collection-name/` (collection root)
 *
 * @param virtualPath - A `qmd://` URI string (will be normalized first)
 * @returns A {@link VirtualPath} object with `collectionName`, `path`, and optional `indexName`,
 *   or `null` if the path does not match the virtual path pattern
 */
export function parseVirtualPath(virtualPath: string): VirtualPath | null {
  // Normalize the path first
  const normalized = normalizeVirtualPath(virtualPath);
  const [pathPart = normalized, queryString = ""] = normalized.split("?");

  // Match: qmd://collection-name[/optional-path]
  // Allows: qmd://name, qmd://name/, qmd://name/path
  const match = pathPart.match(/^qmd:\/\/([^\/]+)\/?(.*)$/);
  if (!match?.[1]) return null;
  const indexName = new URLSearchParams(queryString).get("index")?.trim() || undefined;
  return {
    collectionName: match[1],
    path: match[2] ?? '',  // Empty string for collection root
    ...(indexName ? { indexName } : {}),
  };
}

/**
 * Build a virtual path URI from collection name, relative path, and optional index.
 *
 * The resulting URI is in the form `qmd://collectionName/path` with an
 * optional `?index=...` query parameter for multi-index collections.
 *
 * @param collectionName - Name of the collection (encoded as the URI authority)
 * @param path - Relative path within the collection
 * @param indexName - Optional index name (appended as a query parameter)
 * @returns A virtual path URI string
 */
export function buildVirtualPath(collectionName: string, path: string, indexName?: string): string {
  const base = `qmd://${collectionName}/${path}`;
  return indexName ? `${base}?index=${encodeURIComponent(indexName)}` : base;
}

/**
 * Check whether a string is a virtual path URI.
 *
 * Recognizes:
 * - `qmd://collection/path.md` (preferred format)
 * - `//collection/path.md` (short form, missing `qmd:` prefix)
 *
 * Bare filesystem paths and docid strings return `false`.
 *
 * @param path - The string to test
 * @returns `true` if the string starts with `qmd:` or `//`
 */
export function isVirtualPath(path: string): boolean {
  const trimmed = path.trim();

  // Explicit qmd:// prefix (with any number of slashes)
  if (trimmed.startsWith('qmd:')) return true;

  // //collection/path format (missing qmd: prefix)
  if (trimmed.startsWith('//')) return true;

  return false;
}

/**
 * Resolve a virtual path to an absolute filesystem path.
 *
 * Parses the virtual path to extract the collection name and relative path,
 * then looks up the collection's base directory and joins them.
 *
 * @param db - Database handle (used to look up the collection's base path)
 * @param virtualPath - A `qmd://collection/path` URI
 * @returns Absolute filesystem path, or `null` if the collection is not found
 */
export function resolveVirtualPath(db: Database, virtualPath: string): string | null {
  const parsed = parseVirtualPath(virtualPath);
  if (!parsed) return null;

  const coll = getStoreCollection(db, parsed.collectionName);
  if (!coll) return null;

  return resolvePath(coll.path, parsed.path);
}

/**
 * Convert an absolute filesystem path to its virtual path URI.
 *
 * Iterates all registered collections and checks whether the path falls
 * within any collection's base directory. If the corresponding document
 * is found in the database, returns its `qmd://` URI.
 *
 * @param db - Database handle (used to look up collections and verify the document)
 * @param absolutePath - Absolute filesystem path to convert
 * @returns Virtual path URI, or `null` if the path doesn't belong to any collection
 */
export function toVirtualPath(db: Database, absolutePath: string): string | null {
  // Get all collections from DB
  const collections = getStoreCollections(db);

  // Find which collection this absolute path belongs to
  for (const coll of collections) {
    if (absolutePath.startsWith(coll.path + '/') || absolutePath === coll.path) {
      // Extract relative path
      const relativePath = absolutePath.startsWith(coll.path + '/')
        ? absolutePath.slice(coll.path.length + 1)
        : '';

      // Verify this document exists in the database
      const doc = db.prepare(`
        SELECT d.path
        FROM documents d
        WHERE d.collection = ? AND d.path = ? AND d.active = 1
        LIMIT 1
      `).get(coll.name, relativePath) as { path: string } | null;

      if (doc) {
        return buildVirtualPath(coll.name, relativePath);
      }
    }
  }

  return null;
}

// =============================================================================
// Fuzzy matching and docid lookup
// =============================================================================

/**
 * Look up a document by its short docid (6+ hex characters of the content hash).
 *
 * Accepts any format supported by {@link normalizeDocid} (with or without `#`,
 * surrounding quotes) and searches for documents whose hash starts with the
 * given prefix.
 *
 * @param db - Database handle
 * @param docid - Docid string (e.g. `#abc123`, `abc123`, `"abc123"`)
 * @returns Object with `filepath` (virtual path) and `hash`, or `null` if not found
 */
export function findDocumentByDocid(db: Database, docid: string): { filepath: string; hash: string } | null {
  const shortHash = normalizeDocid(docid);

  if (shortHash.length < 1) return null;

  // Look up documents where hash starts with the short hash
  const doc = db.prepare(`
    SELECT 'qmd://' || d.collection || '/' || d.path as filepath, d.hash
    FROM documents d
    WHERE d.hash LIKE ? AND d.active = 1
    LIMIT 1
  `).get(`${shortHash}%`) as { filepath: string; hash: string } | null;

  return doc;
}

/**
 * Find active document paths that are within a Levenshtein distance of the query.
 *
 * Used by {@link findDocument} to provide "did you mean?" suggestions when a
 * path lookup fails. Compares the lowercase query against lowercase document paths.
 *
 * @param db - Database handle
 * @param query - The path or name to fuzzy-match against
 * @param maxDistance - Maximum Levenshtein distance (default 3)
 * @param limit - Maximum number of results (default 5)
 * @returns Array of matching document paths
 */
export function findSimilarFiles(db: Database, query: string, maxDistance: number = 3, limit: number = 5): string[] {
  const allFiles = db.prepare(`
    SELECT d.path
    FROM documents d
    WHERE d.active = 1
  `).all() as { path: string }[];
  const queryLower = query.toLowerCase();
  const scored = allFiles
    .map(f => ({ path: f.path, dist: levenshtein(f.path.toLowerCase(), queryLower) }))
    .filter(f => f.dist <= maxDistance)
    .sort((a, b) => a.dist - b.dist)
    .slice(0, limit);
  return scored.map(f => f.path);
}

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i]![0] = i;
  for (let j = 0; j <= n; j++) dp[0]![j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i]![j] = Math.min(
        dp[i - 1]![j]! + 1,
        dp[i]![j - 1]! + 1,
        dp[i - 1]![j - 1]! + cost
      );
    }
  }
  return dp[m]![n]!;
}

/**
 * Match active document paths against a glob pattern.
 *
 * Uses picomatch for glob matching. The pattern is tested against:
 * - The virtual path (`qmd://collection/path`)
 * - The raw document path
 * - The `collection/path` composite
 *
 * @param db - Database handle
 * @param pattern - Glob pattern (e.g. `**\/*.md`, `docs/*`)
 * @returns Array of matching file metadata with virtual path, display path, and body length
 */
export function matchFilesByGlob(db: Database, pattern: string): { filepath: string; displayPath: string; bodyLength: number }[] {
  const allFiles = db.prepare(`
    SELECT
      'qmd://' || d.collection || '/' || d.path as virtual_path,
      LENGTH(content.doc) as body_length,
      d.path,
      d.collection
    FROM documents d
    JOIN content ON content.hash = d.hash
    WHERE d.active = 1
  `).all() as { virtual_path: string; body_length: number; path: string; collection: string }[];

  const isMatch = picomatch(pattern);
  return allFiles
    .filter(f => isMatch(f.virtual_path) || isMatch(f.path) || isMatch(f.collection + '/' + f.path))
    .map(f => ({
      filepath: f.virtual_path,
      displayPath: f.path,
      bodyLength: f.body_length
    }));
}
