/**
 * Retrieval primitives — document lookup, search, and status.
 *
 * This module provides:
 *  - Document types and virtual-path handling
 *  - Low-level FTS and vector search
 *  - Document retrieval (findDocument, getDocumentBody, findDocuments)
 *  - Fuzzy matching and docid lookup
 *  - Snippet extraction
 *  - Context resolution
 *  - Collection management
 */

import picomatch from "picomatch";
import type { Database } from "../db.js";
import {
  homedir,
  getRealPath,
  resolve as resolvePath,
} from "./path-utils.js";
import {
  buildInheritedContext,
  getStoreCollections,
  getStoreCollection,
  getStoreGlobalContext,
  getStoreContexts,
  updateStoreContext,
  removeStoreContext,
  setStoreGlobalContext,
  deleteStoreCollection,
  renameStoreCollection,
} from "./config-sync.js";
import {
  normalizeCjkForFTS,
  containsCjk,
  sanitizeFTS5Phrase,
} from "./db-init.js";
import {
  withLazyContentVectorMigration,
  getHashesNeedingEmbedding,
} from "./embedding-pipeline.js";
import {
  getDefaultLlamaCpp,
  formatQueryForEmbedding,
  formatDocForEmbedding,
  DEFAULT_EMBED_MODEL_URI,
  type LLM,
  type ILLMSession,
} from "../llm.js";
import {
  CHUNK_SIZE_CHARS,
} from "./chunking.js";

// =============================================================================
// Document types
// =============================================================================

/**
 * Unified document result type with all metadata.
 * Body is optional - use getDocumentBody() to load it separately if needed.
 */
export type DocumentResult = {
  filepath: string;           // Full filesystem path
  displayPath: string;        // Short display path (e.g., "docs/readme.md")
  title: string;              // Document title (from first heading or filename)
  context: string | null;     // Folder context description if configured
  hash: string;               // Content hash for caching/change detection
  docid: string;              // Short docid (first 6 chars of hash) for quick reference
  collectionName: string;     // Parent collection name
  modifiedAt: string;         // Last modification timestamp
  bodyLength: number;         // Body length in bytes (useful before loading)
  body?: string;              // Document body (optional, load with getDocumentBody)
};

/**
 * Search result extends DocumentResult with score and source info
 */
export type SearchResult = DocumentResult & {
  score: number;              // Relevance score (0-1)
  source: "fts" | "vec";      // Search source (full-text or vector)
  chunkPos?: number;          // Character position of matching chunk (for vector search)
};

export type SearchResultOptions = {
  includeBody?: boolean;
  includeContext?: boolean;
};

/**
 * Ranked result for RRF fusion (simplified, used internally)
 */
export type RankedResult = {
  file: string;
  displayPath: string;
  title: string;
  score: number;
};

export type RRFContributionTrace = {
  listIndex: number;
  source: "fts" | "vec";
  queryType: "original" | "lex" | "vec" | "hyde";
  query: string;
  rank: number;            // 1-indexed rank within list
  weight: number;
  backendScore: number;    // Backend-normalized score before fusion
  rrfContribution: number; // weight / (k + rank)
};

export type RRFScoreTrace = {
  contributions: RRFContributionTrace[];
  baseScore: number;       // Sum of reciprocal-rank contributions
  topRank: number;         // Best (lowest) rank seen across lists
  topRankBonus: number;    // +0.05 for rank 1, +0.02 for rank 2-3
  totalScore: number;      // baseScore + topRankBonus
};

export type HybridQueryExplain = {
  ftsScores: number[];
  vectorScores: number[];
  rrf: {
    rank: number;          // Rank after RRF fusion (1-indexed)
    positionScore: number; // 1 / rank used in position-aware blending
    weight: number;        // Position-aware RRF weight (0.75 / 0.60 / 0.40)
    baseScore: number;
    topRankBonus: number;
    totalScore: number;
    contributions: RRFContributionTrace[];
  };
  rerankScore: number;
  blendedScore: number;
};

/**
 * Error result when document is not found
 */
export type DocumentNotFound = {
  error: "not_found";
  query: string;
  similarFiles: string[];
};

/**
 * Result from multi-get operations
 */
export type MultiGetResult = {
  doc: DocumentResult;
  skipped: false;
} | {
  doc: Pick<DocumentResult, "filepath" | "displayPath">;
  skipped: true;
  skipReason: string;
};

export type CollectionInfo = {
  name: string;
  path: string | null;
  pattern: string | null;
  documents: number;
  lastUpdated: string;
};

export type IndexStatus = {
  totalDocuments: number;
  needsEmbedding: number;
  hasVectorIndex: boolean;
  collections: CollectionInfo[];
};

// =============================================================================
// Docid helpers
// =============================================================================

/**
 * Extract short docid from a full hash (first 6 characters).
 */
export function getDocid(hash: string): string {
  return hash.slice(0, 6);
}

/** Replace emoji/symbol codepoints with their hex representation (e.g. 🐘 → 1f418) */
export function emojiToHex(str: string): string {
  return str.replace(/(?:\p{So}\p{Mn}?|\p{Sk})+/gu, (run) => {
    return [...run].filter(c => /\p{So}|\p{Sk}/u.test(c))
      .map(c => c.codePointAt(0)!.toString(16)).join('-');
  });
}

/**
 * Handelize a filename to be more token-friendly.
 */
export function handelize(path: string): string {
  if (!path || path.trim() === '') {
    throw new Error('handelize: path cannot be empty');
  }

  const segments = path.split('/').filter(Boolean);
  const lastSegment = segments[segments.length - 1] || '';
  const filenameWithoutExt = lastSegment.replace(/\.[^.]+$/, '');
  const hasValidContent = /[\p{L}\p{N}\p{So}\p{Sk}$]/u.test(filenameWithoutExt);
  if (!hasValidContent) {
    throw new Error(`handelize: path "${path}" has no valid filename content`);
  }

  const result = path
    .replace(/___/g, '/')
    .split('/')
    .map((segment, idx, arr) => {
      const isLastSegment = idx === arr.length - 1;
      segment = emojiToHex(segment);

      if (isLastSegment) {
        const extMatch = segment.match(/(\.[a-z0-9]+)$/i);
        const ext = extMatch ? extMatch[1] : '';
        const nameWithoutExt = ext ? segment.slice(0, -ext.length) : segment;

        const cleanedName = nameWithoutExt
          .replace(/[^\p{L}\p{N}$]+/gu, '-')
          .replace(/^-+|-+$/g, '');

        return cleanedName + ext;
      } else {
        return segment
          .replace(/[^\p{L}\p{N}$]+/gu, '-')
          .replace(/^-+|-+$/g, '');
      }
    })
    .filter(Boolean)
    .join('/');

  if (!result) {
    throw new Error(`handelize: path "${path}" resulted in empty string after processing`);
  }

  return result;
}

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

export function normalizeVirtualPath(input: string): string {
  let path = input.trim();

  // Handle qmd:// with extra slashes: qmd:////collection/path -> qmd://collection/path
  if (path.startsWith('qmd:')) {
    // Remove qmd: prefix and normalize slashes
    path = path.slice(4);
    // Remove leading slashes and re-add exactly two
    path = path.replace(/^\/+/, '');
    return `qmd://${path}`;
  }

  // Handle //collection/path (missing qmd: prefix)
  if (path.startsWith('//')) {
    path = path.replace(/^\/+/, '');
    return `qmd://${path}`;
  }

  // Return as-is for other cases (filesystem paths, docids, bare collection/path, etc.)
  return path;
}

/**
 * Parse a virtual path like "qmd://collection-name/path/to/file.md"
 * into its components.
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
 * Build a virtual path from collection name and relative path.
 */
export function buildVirtualPath(collectionName: string, path: string, indexName?: string): string {
  const base = `qmd://${collectionName}/${path}`;
  return indexName ? `${base}?index=${encodeURIComponent(indexName)}` : base;
}

/**
 * Check if a path is explicitly a virtual path.
 * Only recognizes explicit virtual path formats:
 * - qmd://collection/path.md
 * - //collection/path.md
 */
export function isVirtualPath(path: string): boolean {
  const trimmed = path.trim();

  // Explicit qmd:// prefix (with any number of slashes)
  if (trimmed.startsWith('qmd:')) return true;

  // //collection/path format (missing qmd: prefix)
  if (trimmed.startsWith('//')) return true;

  return false;
}

export function resolveVirtualPath(db: Database, virtualPath: string): string | null {
  const parsed = parseVirtualPath(virtualPath);
  if (!parsed) return null;

  const coll = getCollectionByName(db, parsed.collectionName);
  if (!coll) return null;

  return resolvePath(coll.pwd, parsed.path);
}

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

// =============================================================================
// FTS Search
// =============================================================================

export function sanitizeFTS5Term(term: string): string {
  return term.replace(/[^\p{L}\p{N}'_]/gu, '').toLowerCase();
}

function isHyphenatedToken(token: string): boolean {
  return /^[\p{L}\p{N}][\p{L}\p{N}'-]*-[\p{L}\p{N}][\p{L}\p{N}'-]*$/u.test(token);
}

function sanitizeHyphenatedTerm(term: string): string {
  return term.split('-').map(t => sanitizeFTS5Term(t)).filter(t => t).join(' ');
}

function buildFTS5Query(query: string): string | null {
  const positive: string[] = [];
  const negative: string[] = [];

  let i = 0;
  const s = query.trim();

  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i]!)) i++;
    if (i >= s.length) break;

    const negated = s[i] === '-';
    if (negated) i++;

    if (s[i] === '"') {
      const start = i + 1;
      i++;
      while (i < s.length && s[i] !== '"') i++;
      const phrase = s.slice(start, i).trim();
      i++;
      if (phrase.length > 0) {
        const sanitized = sanitizeFTS5Phrase(phrase, sanitizeFTS5Term);
        if (sanitized) {
          const ftsPhrase = `"${sanitized}"`;
          if (negated) negative.push(ftsPhrase);
          else positive.push(ftsPhrase);
        }
      }
    } else {
      const start = i;
      while (i < s.length && !/[\s"]/.test(s[i]!)) i++;
      const term = s.slice(start, i);

      if (isHyphenatedToken(term)) {
        const sanitized = sanitizeHyphenatedTerm(term);
        if (sanitized) {
          const ftsPhrase = `"${sanitized}"`;
          if (negated) negative.push(ftsPhrase);
          else positive.push(ftsPhrase);
        }
      } else if (containsCjk(term)) {
        const sanitized = sanitizeFTS5Phrase(term, sanitizeFTS5Term);
        if (sanitized) {
          const ftsPhrase = `"${sanitized}"`;
          if (negated) negative.push(ftsPhrase);
          else positive.push(ftsPhrase);
        }
      } else if (/^[\d]+\.[\d.]+$/.test(term)) {
        // Dotted version token (e.g. 2026.4.10) — replace dots with spaces
        // so FTS5 matches it as an exact phrase of adjacent tokens.
        const phrase = term.replace(/\./g, ' ');
        const ftsPhrase = `"${phrase}"`;
        if (negated) negative.push(ftsPhrase);
        else positive.push(ftsPhrase);
      } else {
        const sanitized = sanitizeFTS5Term(term);
        if (sanitized) {
          const ftsTerm = `"${sanitized}"*`;
          if (negated) negative.push(ftsTerm);
          else positive.push(ftsTerm);
        }
      }
    }
  }

  if (positive.length === 0 && negative.length === 0) return null;
  if (positive.length === 0) return null;

  let result = positive.join(' AND ');
  for (const neg of negative) {
    result = `${result} NOT ${neg}`;
  }

  return result;
}

export function validateSemanticQuery(query: string): string | null {
  if (/(^|\s)-[\w"]/.test(query)) {
    return 'Negation (-term) is not supported in vec/hyde queries. Use lex for exclusions.';
  }
  return null;
}

export function validateLexQuery(query: string): string | null {
  if (/[\r\n]/.test(query)) {
    return 'Lex queries must be a single line. Remove newline characters or split into separate lex: lines.';
  }
  const quoteCount = (query.match(/"/g) ?? []).length;
  if (quoteCount % 2 === 1) {
    return 'Lex query has an unmatched double quote ("). Add the closing quote or remove it.';
  }
  return null;
}

function resolveSearchResultOptions(options?: SearchResultOptions): Required<SearchResultOptions> {
  return {
    includeBody: options?.includeBody ?? true,
    includeContext: options?.includeContext ?? true,
  };
}

export function searchFTS(
  db: Database,
  query: string,
  limit: number = 20,
  collectionName?: string,
  options?: SearchResultOptions
): SearchResult[] {
  const { includeBody, includeContext } = resolveSearchResultOptions(options);
  const ftsQuery = buildFTS5Query(query);
  if (!ftsQuery) return [];

  const params: (string | number)[] = [ftsQuery];
  const ftsLimit = collectionName ? limit * 10 : limit;

  let sql = `
    WITH fts_matches AS (
      SELECT rowid, bm25(documents_fts, 1.5, 4.0, 1.0) as bm25_score
      FROM documents_fts
      WHERE documents_fts MATCH ?
      ORDER BY bm25_score ASC
      LIMIT ${ftsLimit}
    )
    SELECT
      'qmd://' || d.collection || '/' || d.path as filepath,
      d.collection || '/' || d.path as display_path,
      d.title,
      LENGTH(content.doc) as body_length,
      ${includeBody ? "content.doc as body," : ""}
      d.hash,
      d.modified_at,
      d.collection,
      fm.bm25_score
    FROM fts_matches fm
    JOIN documents d ON d.id = fm.rowid
    JOIN content ON content.hash = d.hash
    WHERE d.active = 1
  `;

  if (collectionName) {
    sql += ` AND d.collection = ?`;
    params.push(String(collectionName));
  }

  sql += ` ORDER BY fm.bm25_score ASC LIMIT ?`;
  params.push(limit);

  const contextResolver = includeContext ? createContextResolver(db) : null;
  const rows = db.prepare(sql).all(...params) as {
    filepath: string;
    display_path: string;
    title: string;
    body_length: number;
    body?: string;
    hash: string;
    modified_at: string;
    collection: string;
    bm25_score: number;
  }[];
  return rows.map(row => {
    const score = Math.abs(row.bm25_score) / (1 + Math.abs(row.bm25_score));
    const result: SearchResult = {
      filepath: row.filepath,
      displayPath: row.display_path,
      title: row.title,
      hash: row.hash,
      docid: getDocid(row.hash),
      collectionName: row.collection,
      modifiedAt: row.modified_at,
      bodyLength: row.body_length,
      context: contextResolver ? contextResolver(row.filepath) : null,
      score,
      source: "fts" as const,
    };
    if (includeBody && row.body !== undefined) {
      result.body = row.body;
    }
    return result;
  });
}

// =============================================================================
// Vector Search
// =============================================================================

async function getEmbedding(text: string, model: string, isQuery: boolean, session?: ILLMSession, llmOverride?: LLM): Promise<number[] | null> {
  const formattedText = isQuery ? formatQueryForEmbedding(text, model) : formatDocForEmbedding(text, undefined, model);
  const result = session
    ? await session.embed(formattedText, { model, isQuery })
    : await (llmOverride ?? getDefaultLlamaCpp()).embed(formattedText, { model, isQuery });
  return result?.embedding || null;
}

export async function searchVec(
  db: Database,
  query: string,
  model: string,
  limit: number = 20,
  collectionName?: string,
  session?: ILLMSession,
  precomputedEmbedding?: number[],
  llm?: LLM,
  options?: SearchResultOptions
): Promise<SearchResult[]> {
  const { includeBody, includeContext } = resolveSearchResultOptions(options);
  const tableExists = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='vectors_vec'`).get();
  if (!tableExists) return [];

  const embedding = precomputedEmbedding ?? await getEmbedding(query, model, true, session, llm);
  if (!embedding) return [];

  const vecResults = db.prepare(`
    SELECT hash_seq, distance
    FROM vectors_vec
    WHERE embedding MATCH ? AND k = ?
  `).all(new Float32Array(embedding), limit * 3) as { hash_seq: string; distance: number }[];

  if (vecResults.length === 0) return [];

  const hashSeqs = vecResults.map(r => r.hash_seq);
  const distanceMap = new Map(vecResults.map(r => [r.hash_seq, r.distance]));

  const placeholders = hashSeqs.map(() => '?').join(',');
  let docSql = `
    SELECT
      cv.hash || '_' || cv.seq as hash_seq,
      cv.hash,
      cv.pos,
      'qmd://' || d.collection || '/' || d.path as filepath,
      d.collection || '/' || d.path as display_path,
      d.title,
      LENGTH(content.doc) as body_length,
      ${includeBody ? "content.doc as body," : ""}
      d.modified_at,
      d.collection
    FROM content_vectors cv
    JOIN documents d ON d.hash = cv.hash AND d.active = 1
    JOIN content ON content.hash = d.hash
    WHERE cv.hash || '_' || cv.seq IN (${placeholders})
  `;
  const params: string[] = [...hashSeqs];

  if (collectionName) {
    docSql += ` AND d.collection = ?`;
    params.push(collectionName);
  }

  const docRows = withLazyContentVectorMigration(db, () => db.prepare(docSql).all(...params) as {
    hash_seq: string; hash: string; pos: number; filepath: string;
    display_path: string; title: string; body_length: number; body?: string; modified_at: string; collection: string;
  }[]);

  const seen = new Map<string, { row: typeof docRows[0]; bestDist: number }>();
  for (const row of docRows) {
    const distance = distanceMap.get(row.hash_seq) ?? 1;
    const existing = seen.get(row.filepath);
    if (!existing || distance < existing.bestDist) {
      seen.set(row.filepath, { row, bestDist: distance });
    }
  }

  const contextResolver = includeContext ? createContextResolver(db) : null;
  return Array.from(seen.values())
    .sort((a, b) => a.bestDist - b.bestDist)
    .slice(0, limit)
    .map(({ row, bestDist }) => {
      const result: SearchResult = {
        filepath: row.filepath,
        displayPath: row.display_path,
        title: row.title,
        hash: row.hash,
        docid: getDocid(row.hash),
        collectionName: row.collection,
        modifiedAt: row.modified_at,
        bodyLength: row.body_length,
        context: contextResolver ? contextResolver(row.filepath) : null,
        score: 1 - bestDist,
        source: "vec" as const,
        chunkPos: row.pos,
      };
      if (includeBody && row.body !== undefined) {
        result.body = row.body;
      }
      return result;
    });
}

// =============================================================================
// Document retrieval
// =============================================================================

type DbDocRow = {
  virtual_path: string;
  display_path: string;
  title: string;
  hash: string;
  collection: string;
  path: string;
  modified_at: string;
  body_length: number;
  body?: string;
};

/**
 * Find a document by filename/path, docid (#hash), or with fuzzy matching.
 */
export function findDocument(db: Database, filename: string, options: { includeBody?: boolean } = {}): DocumentResult | DocumentNotFound {
  let filepath = filename;
  const colonMatch = filepath.match(/:(\d+)$/);
  if (colonMatch) {
    filepath = filepath.slice(0, -colonMatch[0].length);
  }

  if (isDocid(filepath)) {
    const docidMatch = findDocumentByDocid(db, filepath);
    if (docidMatch) {
      filepath = docidMatch.filepath;
    } else {
      return { error: "not_found", query: filename, similarFiles: [] };
    }
  }

  if (filepath.startsWith('~/')) {
    filepath = homedir() + filepath.slice(1);
  }

  const bodyCol = options.includeBody ? `, content.doc as body` : ``;

  const selectCols = `
    'qmd://' || d.collection || '/' || d.path as virtual_path,
    d.collection || '/' || d.path as display_path,
    d.title,
    d.hash,
    d.collection,
    d.modified_at,
    LENGTH(content.doc) as body_length
    ${bodyCol}
  `;

  let doc = db.prepare(`
    SELECT ${selectCols}
    FROM documents d
    JOIN content ON content.hash = d.hash
    WHERE 'qmd://' || d.collection || '/' || d.path = ? AND d.active = 1
  `).get(filepath) as DbDocRow | null;

  if (!doc) {
    doc = db.prepare(`
      SELECT ${selectCols}
      FROM documents d
      JOIN content ON content.hash = d.hash
      WHERE 'qmd://' || d.collection || '/' || d.path LIKE ? AND d.active = 1
      LIMIT 1
    `).get(`%${filepath}`) as DbDocRow | null;
  }

  if (!doc && !filepath.startsWith('qmd://')) {
    const collections = getStoreCollections(db);
    for (const coll of collections) {
      let relativePath: string | null = null;

      if (filepath.startsWith(coll.path + '/')) {
        relativePath = filepath.slice(coll.path.length + 1);
      } else if (!filepath.startsWith('/')) {
        relativePath = filepath;
      }

      if (relativePath) {
        doc = db.prepare(`
          SELECT ${selectCols}
          FROM documents d
          JOIN content ON content.hash = d.hash
          WHERE d.collection = ? AND d.path = ? AND d.active = 1
        `).get(coll.name, relativePath) as DbDocRow | null;
        if (doc) break;
      }
    }
  }

  if (!doc) {
    const similar = findSimilarFiles(db, filepath, 5, 5);
    return { error: "not_found", query: filename, similarFiles: similar };
  }

  const virtualPath = doc.virtual_path || `qmd://${doc.collection}/${doc.display_path}`;
  const context = getContextForFile(db, virtualPath);

  return {
    filepath: virtualPath,
    displayPath: doc.display_path,
    title: doc.title,
    context,
    hash: doc.hash,
    docid: getDocid(doc.hash),
    collectionName: doc.collection,
    modifiedAt: doc.modified_at,
    bodyLength: doc.body_length,
    ...(options.includeBody && doc.body !== undefined && { body: doc.body }),
  };
}

/**
 * Get the body content for a document
 */
export function getDocumentBody(db: Database, doc: DocumentResult | { filepath: string }, fromLine?: number, maxLines?: number): string | null {
  const filepath = doc.filepath;

  let row: { body: string } | null = null;

  if (filepath.startsWith('qmd://')) {
    row = db.prepare(`
      SELECT content.doc as body
      FROM documents d
      JOIN content ON content.hash = d.hash
      WHERE 'qmd://' || d.collection || '/' || d.path = ? AND d.active = 1
    `).get(filepath) as { body: string } | null;
  }

  if (!row) {
    const collections = getStoreCollections(db);
    for (const coll of collections) {
      if (filepath.startsWith(coll.path + '/')) {
        const relativePath = filepath.slice(coll.path.length + 1);
        row = db.prepare(`
          SELECT content.doc as body
          FROM documents d
          JOIN content ON content.hash = d.hash
          WHERE d.collection = ? AND d.path = ? AND d.active = 1
        `).get(coll.name, relativePath) as { body: string } | null;
        if (row) break;
      }
    }
  }

  if (!row) return null;

  let body = row.body;
  if (fromLine !== undefined || maxLines !== undefined) {
    const lines = body.split('\n');
    const start = Math.max(0, (fromLine || 1) - 1);
    const end = maxLines !== undefined ? start + maxLines : lines.length;
    body = lines.slice(start, end).join('\n');
  }

  return body;
}

/**
 * Find multiple documents by glob pattern or comma-separated list
 */
export function findDocuments(
  db: Database,
  pattern: string,
  options: { includeBody?: boolean; maxBytes?: number } = {}
): { docs: MultiGetResult[]; errors: string[] } {
  const DEFAULT_MULTI_GET_MAX_BYTES = 10 * 1024;
  const isCommaSeparated = pattern.includes(',') && !pattern.includes('*') && !pattern.includes('?') && !pattern.includes('{');
  const errors: string[] = [];
  const maxBytes = options.maxBytes ?? DEFAULT_MULTI_GET_MAX_BYTES;

  const bodyCol = options.includeBody ? `, content.doc as body` : ``;
  const selectCols = `
    'qmd://' || d.collection || '/' || d.path as virtual_path,
    d.collection || '/' || d.path as display_path,
    d.title,
    d.hash,
    d.collection,
    d.modified_at,
    LENGTH(content.doc) as body_length
    ${bodyCol}
  `;

  let fileRows: DbDocRow[];

  if (isCommaSeparated) {
    const names = pattern.split(',').map(s => s.trim()).filter(Boolean);
    fileRows = [];
    for (const name of names) {
      let doc = db.prepare(`
        SELECT ${selectCols}
        FROM documents d
        JOIN content ON content.hash = d.hash
        WHERE 'qmd://' || d.collection || '/' || d.path = ? AND d.active = 1
      `).get(name) as DbDocRow | null;
      if (!doc) {
        doc = db.prepare(`
          SELECT ${selectCols}
          FROM documents d
          JOIN content ON content.hash = d.hash
          WHERE 'qmd://' || d.collection || '/' || d.path LIKE ? AND d.active = 1
          LIMIT 1
        `).get(`%${name}`) as DbDocRow | null;
      }
      if (doc) {
        fileRows.push(doc);
      } else {
        const similar = findSimilarFiles(db, name, 5, 3);
        let msg = `File not found: ${name}`;
        if (similar.length > 0) {
          msg += ` (did you mean: ${similar.join(', ')}?)`;
        }
        errors.push(msg);
      }
    }
  } else {
    const matched = matchFilesByGlob(db, pattern);
    if (matched.length === 0) {
      errors.push(`No files matched pattern: ${pattern}`);
      return { docs: [], errors };
    }
    const virtualPaths = matched.map(m => m.filepath);
    const placeholders = virtualPaths.map(() => '?').join(',');
    fileRows = db.prepare(`
      SELECT ${selectCols}
      FROM documents d
      JOIN content ON content.hash = d.hash
      WHERE 'qmd://' || d.collection || '/' || d.path IN (${placeholders}) AND d.active = 1
    `).all(...virtualPaths) as DbDocRow[];
  }

  const results: MultiGetResult[] = [];

  for (const row of fileRows) {
    const virtualPath = row.virtual_path || `qmd://${row.collection}/${row.display_path}`;
    const context = getContextForFile(db, virtualPath);

    if (row.body_length > maxBytes) {
      results.push({
        doc: { filepath: virtualPath, displayPath: row.display_path },
        skipped: true,
        skipReason: `File too large (${Math.round(row.body_length / 1024)}KB > ${Math.round(maxBytes / 1024)}KB)`,
      });
      continue;
    }

    results.push({
      doc: {
        filepath: virtualPath,
        displayPath: row.display_path,
        title: row.title || row.display_path.split('/').pop() || row.display_path,
        context,
        hash: row.hash,
        docid: getDocid(row.hash),
        collectionName: row.collection,
        modifiedAt: row.modified_at,
        bodyLength: row.body_length,
        ...(options.includeBody && row.body !== undefined && { body: row.body }),
      },
      skipped: false,
    });
  }

  return { docs: results, errors };
}

// =============================================================================
// Context resolution
// =============================================================================

/**
 * Get context for a file path using hierarchical inheritance.
 */
export function getContextForPath(db: Database, collectionName: string, path: string): string | null {
  return buildInheritedContext(
    getStoreCollection(db, collectionName),
    getStoreGlobalContext(db),
    path
  );
}

/**
 * Get context for a file path (virtual or filesystem).
 */
export function getContextForFile(db: Database, filepath: string): string | null {
  if (!filepath) return null;

  const collections = getStoreCollections(db);

  let collectionName: string | null = null;
  let relativePath: string | null = null;

  const parsedVirtual = filepath.startsWith('qmd://') ? parseVirtualPath(filepath) : null;
  if (parsedVirtual) {
    collectionName = parsedVirtual.collectionName;
    relativePath = parsedVirtual.path;
  } else {
    for (const coll of collections) {
      if (!coll || !coll.path) continue;

      if (filepath.startsWith(coll.path + '/') || filepath === coll.path) {
        collectionName = coll.name;
        relativePath = filepath.startsWith(coll.path + '/')
          ? filepath.slice(coll.path.length + 1)
          : '';
        break;
      }
    }

    if (!collectionName || relativePath === null) return null;
  }

  const coll = getStoreCollection(db, collectionName);
  if (!coll) return null;

  const doc = db.prepare(`
    SELECT d.path
    FROM documents d
    WHERE d.collection = ? AND d.path = ? AND d.active = 1
    LIMIT 1
  `).get(collectionName, relativePath) as { path: string } | null;

  if (!doc) return null;

  return buildInheritedContext(coll, getStoreGlobalContext(db), relativePath);
}

/**
 * Create a context resolver closure for batch lookups.
 */
export function createContextResolver(db: Database): (filepath: string) => string | null {
  const collections = getStoreCollections(db);
  const collectionByName = new Map(collections.map(collection => [collection.name, collection]));
  const globalContext = getStoreGlobalContext(db);

  return (filepath: string) => {
    if (!filepath) return null;

    const parsedVirtual = filepath.startsWith("qmd://") ? parseVirtualPath(filepath) : null;
    if (parsedVirtual) {
      return buildInheritedContext(
        collectionByName.get(parsedVirtual.collectionName) ?? null,
        globalContext,
        parsedVirtual.path
      );
    }

    for (const collection of collections) {
      if (filepath.startsWith(collection.path + "/") || filepath === collection.path) {
        const relativePath = filepath === collection.path ? "" : filepath.slice(collection.path.length + 1);
        return buildInheritedContext(collection, globalContext, relativePath);
      }
    }

    return null;
  };
}

// =============================================================================
// Collection management
// =============================================================================

export function getCollectionByName(db: Database, name: string): { name: string; pwd: string; glob_pattern: string } | null {
  const collection = getStoreCollection(db, name);
  if (!collection) return null;

  return {
    name: collection.name,
    pwd: collection.path,
    glob_pattern: collection.pattern,
  };
}

export function listCollections(db: Database): { name: string; pwd: string; glob_pattern: string; doc_count: number; active_count: number; last_modified: string | null; includeByDefault: boolean }[] {
  const collections = getStoreCollections(db);

  const result = collections.map(coll => {
    const stats = db.prepare(`
      SELECT
        COUNT(d.id) as doc_count,
        SUM(CASE WHEN d.active = 1 THEN 1 ELSE 0 END) as active_count,
        MAX(d.modified_at) as last_modified
      FROM documents d
      WHERE d.collection = ?
    `).get(coll.name) as { doc_count: number; active_count: number; last_modified: string | null } | null;

    return {
      name: coll.name,
      pwd: coll.path,
      glob_pattern: coll.pattern,
      doc_count: stats?.doc_count || 0,
      active_count: stats?.active_count || 0,
      last_modified: stats?.last_modified || null,
      includeByDefault: coll.includeByDefault !== false,
    };
  });

  return result;
}

export function removeCollection(db: Database, collectionName: string): { deletedDocs: number; cleanedHashes: number } {
  const docResult = db.prepare(`DELETE FROM documents WHERE collection = ?`).run(collectionName);

  const cleanupResult = db.prepare(`
    DELETE FROM content
    WHERE hash NOT IN (SELECT DISTINCT hash FROM documents WHERE active = 1)
  `).run();

  deleteStoreCollection(db, collectionName);

  return {
    deletedDocs: docResult.changes,
    cleanedHashes: cleanupResult.changes
  };
}

export function renameCollection(db: Database, oldName: string, newName: string): void {
  db.prepare(`UPDATE documents SET collection = ? WHERE collection = ?`)
    .run(newName, oldName);

  renameStoreCollection(db, oldName, newName);
}

export function getAllCollections(db: Database): { name: string }[] {
  const collections = getStoreCollections(db);
  return collections.map(c => ({ name: c.name }));
}

export function getCollectionsWithoutContext(db: Database): { name: string; pwd: string; doc_count: number }[] {
  const allCollections = getStoreCollections(db);
  const collectionsWithoutContext: { name: string; pwd: string; doc_count: number }[] = [];

  for (const coll of allCollections) {
    if (!coll.context || Object.keys(coll.context).length === 0) {
      const stats = db.prepare(`
        SELECT COUNT(d.id) as doc_count
        FROM documents d
        WHERE d.collection = ? AND d.active = 1
      `).get(coll.name) as { doc_count: number } | null;

      collectionsWithoutContext.push({
        name: coll.name,
        pwd: coll.path,
        doc_count: stats?.doc_count || 0,
      });
    }
  }

  return collectionsWithoutContext.sort((a, b) => a.name.localeCompare(b.name));
}

export function getTopLevelPathsWithoutContext(db: Database, collectionName: string): string[] {
  const paths = db.prepare(`
    SELECT DISTINCT path FROM documents
    WHERE collection = ? AND active = 1
  `).all(collectionName) as { path: string }[];

  const dbColl = getStoreCollection(db, collectionName);
  if (!dbColl) return [];

  const contextPrefixes = new Set<string>();
  if (dbColl.context) {
    for (const prefix of Object.keys(dbColl.context)) {
      contextPrefixes.add(prefix);
    }
  }

  const topLevelDirs = new Set<string>();
  for (const { path } of paths) {
    const parts = path.split('/').filter(Boolean);
    if (parts.length > 1) {
      const dir = parts[0];
      if (dir) topLevelDirs.add(dir);
    }
  }

  const missing: string[] = [];
  for (const dir of topLevelDirs) {
    let hasContext = false;
    for (const prefix of contextPrefixes) {
      if (prefix === '' || prefix === dir || dir.startsWith(prefix + '/')) {
        hasContext = true;
        break;
      }
    }
    if (!hasContext) {
      missing.push(dir);
    }
  }

  return missing.sort();
}

// =============================================================================
// Context CRUD
// =============================================================================

export function insertContext(db: Database, collectionId: number, pathPrefix: string, context: string): void {
  const coll = db.prepare(`SELECT name FROM collections WHERE id = ?`).get(collectionId) as { name: string } | null;
  if (!coll) {
    throw new Error(`Collection with id ${collectionId} not found`);
  }

  updateStoreContext(db, coll.name, pathPrefix, context);
}

export function deleteContext(db: Database, collectionName: string, pathPrefix: string): number {
  const success = removeStoreContext(db, collectionName, pathPrefix);
  return success ? 1 : 0;
}

export function deleteGlobalContexts(db: Database): number {
  let deletedCount = 0;

  setStoreGlobalContext(db, undefined);
  deletedCount++;

  const collections = getStoreCollections(db);
  for (const coll of collections) {
    const success = removeStoreContext(db, coll.name, '');
    if (success) deletedCount++;
  }

  return deletedCount;
}

export function listPathContexts(db: Database): { collection_name: string; path_prefix: string; context: string }[] {
  const allContexts = getStoreContexts(db);

  return allContexts.map(ctx => ({
    collection_name: ctx.collection,
    path_prefix: ctx.path,
    context: ctx.context,
  })).sort((a, b) => {
    if (a.collection_name !== b.collection_name) {
      return a.collection_name.localeCompare(b.collection_name);
    }
    if (a.path_prefix.length !== b.path_prefix.length) {
      return b.path_prefix.length - a.path_prefix.length;
    }
    return a.path_prefix.localeCompare(b.path_prefix);
  });
}

// =============================================================================
// Status
// =============================================================================

export function getStatus(db: Database, model: string = DEFAULT_EMBED_MODEL_URI): IndexStatus {
  // DB is source of truth for collections — config provides supplementary metadata
  const dbCollections = db.prepare(`
    SELECT
      collection as name,
      COUNT(*) as active_count,
      MAX(modified_at) as last_doc_update
    FROM documents
    WHERE active = 1
    GROUP BY collection
  `).all() as { name: string; active_count: number; last_doc_update: string | null }[];

  // Build a lookup from store_collections for path/pattern metadata
  const storeCollections = getStoreCollections(db);
  const configLookup = new Map(storeCollections.map(c => [c.name, { path: c.path, pattern: c.pattern }]));

  const collections: CollectionInfo[] = dbCollections.map(row => {
    const config = configLookup.get(row.name);
    return {
      name: row.name,
      path: config?.path ?? null,
      pattern: config?.pattern ?? null,
      documents: row.active_count,
      lastUpdated: row.last_doc_update || new Date().toISOString(),
    };
  });

  // Sort by last update time (most recent first)
  collections.sort((a, b) => {
    if (!a.lastUpdated) return 1;
    if (!b.lastUpdated) return -1;
    return new Date(b.lastUpdated).getTime() - new Date(a.lastUpdated).getTime();
  });

  const totalDocs = (db.prepare(`SELECT COUNT(*) as c FROM documents WHERE active = 1`).get() as { c: number }).c;
  const needsEmbedding = getHashesNeedingEmbedding(db, undefined, model);
  const hasVectors = !!db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='vectors_vec'`).get();

  return {
    totalDocuments: totalDocs,
    needsEmbedding,
    hasVectorIndex: hasVectors,
    collections,
  };
}

// =============================================================================
// Snippet extraction
// =============================================================================

export type SnippetResult = {
  line: number;
  snippet: string;
  linesBefore: number;
  linesAfter: number;
  snippetLines: number;
};

/** Weight for intent terms relative to query terms (1.0) in snippet scoring */
export const INTENT_WEIGHT_SNIPPET = 0.3;

/** Weight for intent terms relative to query terms (1.0) in chunk selection */
export const INTENT_WEIGHT_CHUNK = 0.5;

const INTENT_STOP_WORDS = new Set([
  "am", "an", "as", "at", "be", "by", "do", "he", "if",
  "in", "is", "it", "me", "my", "no", "of", "on", "or", "so",
  "to", "up", "us", "we",
  "all", "and", "any", "are", "but", "can", "did", "for", "get",
  "has", "her", "him", "his", "how", "its", "let", "may", "not",
  "our", "out", "the", "too", "was", "who", "why", "you",
  "also", "does", "find", "from", "have", "into", "more", "need",
  "show", "some", "tell", "that", "them", "this", "want", "what",
  "when", "will", "with", "your",
  "about", "looking", "notes", "search", "where", "which",
]);

export function extractIntentTerms(intent: string): string[] {
  return intent.toLowerCase().split(/\s+/)
    .map(t => t.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter(t => t.length > 1 && !INTENT_STOP_WORDS.has(t));
}

export function extractSnippet(body: string, query: string, maxLen = 500, chunkPos?: number, chunkLen?: number, intent?: string): SnippetResult {
  const totalLines = body.split('\n').length;
  let searchBody = body;
  let lineOffset = 0;

  if (chunkPos !== undefined && chunkPos >= 0) {
    const searchLen = chunkLen || CHUNK_SIZE_CHARS;
    const contextStart = Math.max(0, chunkPos - 100);
    const contextEnd = Math.min(body.length, chunkPos + searchLen + 100);
    searchBody = body.slice(contextStart, contextEnd);
    if (contextStart > 0) {
      lineOffset = body.slice(0, contextStart).split('\n').length - 1;
    }
  }

  const lines = searchBody.split('\n');
  const queryTerms = query.toLowerCase().split(/\s+/).filter(t => t.length > 0);
  const intentTerms = intent ? extractIntentTerms(intent) : [];
  let bestLine = 0, bestScore = -1;

  for (let i = 0; i < lines.length; i++) {
    const lineLower = (lines[i] ?? "").toLowerCase();
    let score = 0;
    for (const term of queryTerms) {
      if (lineLower.includes(term)) score += 1.0;
    }
    for (const term of intentTerms) {
      if (lineLower.includes(term)) score += INTENT_WEIGHT_SNIPPET;
    }
    if (score > bestScore) {
      bestScore = score;
      bestLine = i;
    }
  }

  if (chunkPos !== undefined && chunkPos >= 0 && bestScore <= 0) {
    if (chunkPos === 0) {
      return extractSnippet(body, query, maxLen, undefined, undefined, intent);
    }
    const contextStart = Math.max(0, chunkPos - 100);
    bestLine = chunkPos > contextStart
      ? searchBody.slice(0, chunkPos - contextStart).split('\n').length - 1
      : 0;
  }

  const start = Math.max(0, bestLine - 1);
  const end = Math.min(lines.length, bestLine + 3);
  const snippetLines = lines.slice(start, end);
  let snippetText = snippetLines.join('\n');

  if (chunkPos && chunkPos > 0 && snippetText.trim().length === 0) {
    return extractSnippet(body, query, maxLen, undefined, undefined, intent);
  }

  if (snippetText.length > maxLen) snippetText = snippetText.substring(0, maxLen - 3) + "...";

  const absoluteStart = lineOffset + start + 1;
  const snippetLineCount = snippetLines.length;
  const linesBefore = absoluteStart - 1;
  const linesAfter = totalLines - (absoluteStart + snippetLineCount - 1);

  const header = `@@ -${absoluteStart},${snippetLineCount} @@ (${linesBefore} before, ${linesAfter} after)`;
  const snippet = `${header}\n${snippetText}`;

  return {
    line: lineOffset + bestLine + 1,
    snippet,
    linesBefore,
    linesAfter,
    snippetLines: snippetLineCount,
  };
}

// =============================================================================
// Shared helpers (used by both CLI and MCP)
// =============================================================================

/**
 * Add line numbers to text content.
 */
export function addLineNumbers(text: string, startLine: number = 1): string {
  const lines = text.split('\n');
  return lines.map((line, i) => `${startLine + i}: ${line}`).join('\n');
}

export type HydratedSearchDocument = DocumentResult & { body: string };

/**
 * Hydrate search results with full document bodies.
 */
export function loadSearchDocumentsByFilepaths(
  db: Database,
  filepaths: string[],
  resolveContext: (filepath: string) => string | null
): Map<string, HydratedSearchDocument> {
  const uniqueFilepaths = [...new Set(filepaths)];
  if (uniqueFilepaths.length === 0) return new Map();

  type HydrationRow = {
    filepath: string;
    display_path: string;
    title: string;
    hash: string;
    collection: string;
    modified_at: string;
    body_length: number;
    body: string;
  };

  const rows: HydrationRow[] = [];

  const virtualPairs = new Map<string, { collection: string; path: string }>();
  const fallbackFilepaths: string[] = [];

  for (const filepath of uniqueFilepaths) {
    const parsed = filepath.startsWith('qmd://') ? parseVirtualPath(filepath) : null;
    if (parsed) {
      const key = `${parsed.collectionName} ${parsed.path}`;
      if (!virtualPairs.has(key)) {
        virtualPairs.set(key, { collection: parsed.collectionName, path: parsed.path });
      }
    } else {
      fallbackFilepaths.push(filepath);
    }
  }

  if (virtualPairs.size > 0) {
    const pairs = [...virtualPairs.values()];
    const wherePairs = pairs.map(() => `(d.collection = ? AND d.path = ?)`).join(' OR ');
    const params = pairs.flatMap((p) => [p.collection, p.path]);
    const indexedRows = db.prepare(`
      SELECT
        'qmd://' || d.collection || '/' || d.path as filepath,
        d.collection || '/' || d.path as display_path,
        d.title,
        d.hash,
        d.collection,
        d.modified_at,
        LENGTH(content.doc) as body_length,
        content.doc as body
      FROM documents d
      JOIN content ON content.hash = d.hash
      WHERE d.active = 1
        AND (${wherePairs})
    `).all(...params) as HydrationRow[];
    rows.push(...indexedRows);
  }

  if (fallbackFilepaths.length > 0) {
    const placeholders = fallbackFilepaths.map(() => '?').join(',');
    const fallbackRows = db.prepare(`
      SELECT
        'qmd://' || d.collection || '/' || d.path as filepath,
        d.collection || '/' || d.path as display_path,
        d.title,
        d.hash,
        d.collection,
        d.modified_at,
        LENGTH(content.doc) as body_length,
        content.doc as body
      FROM documents d
      JOIN content ON content.hash = d.hash
      WHERE 'qmd://' || d.collection || '/' || d.path IN (${placeholders})
        AND d.active = 1
    `).all(...fallbackFilepaths) as HydrationRow[];
    rows.push(...fallbackRows);
  }

  return new Map(rows.map(row => [row.filepath, {
    filepath: row.filepath,
    displayPath: row.display_path,
    title: row.title,
    context: resolveContext(row.filepath),
    hash: row.hash,
    docid: getDocid(row.hash),
    collectionName: row.collection,
    modifiedAt: row.modified_at,
    bodyLength: row.body_length,
    body: row.body,
  }]));
}
