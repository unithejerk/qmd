/**
 * Search-result snippet scoring and document hydration helpers.
 */

import type { Database } from "../db.js";
import { CHUNK_SIZE_CHARS } from "./chunking.js";
import { getDocid, parseVirtualPath } from "./retrieval-paths.js";
import type { DocumentResult } from "./retrieval.js";

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

/**
 * Extract meaningful terms from an intent string for weighted snippet boosting.
 *
 * Lowercases the string, splits on whitespace, strips leading/trailing
 * non-alphanumeric characters, and filters out single-character terms and
 * common stop words (defined in `INTENT_STOP_WORDS`).
 *
 * Used by {@link extractSnippet} to boost lines that match intent terms
 * (at weight {@link INTENT_WEIGHT_SNIPPET}) in addition to query terms.
 *
 * @param intent - The intent string (typically from query expansion)
 * @returns Array of filtered, meaningful intent terms
 */
export function extractIntentTerms(intent: string): string[] {
  return intent.toLowerCase().split(/\s+/)
    .map(t => t.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter(t => t.length > 1 && !INTENT_STOP_WORDS.has(t));
}

/**
 * Extract a relevant snippet from a document body based on query and intent terms.
 *
 * The algorithm:
 * 1. If `chunkPos` is given (from vector search), narrow the search window to
 *    the vicinity of the matching chunk (`chunkPos - 100` to `chunkPos + searchLen + 100`)
 * 2. Score each line by counting query term matches (weight 1.0) and intent term
 *    matches (weight {@link INTENT_WEIGHT_SNIPPET} = 0.3)
 * 3. Select the highest-scoring line as the snippet anchor
 * 4. Return a context window of 1 line before and 3 lines after the anchor
 * 5. Format result as a unified-diff-style header with absolute line numbers
 *
 * If no matching line is found in the chunk window, falls back to searching
 * the full body.
 *
 * @param body - Full document body text
 * @param query - Raw search query (split into whitespace-separated terms)
 * @param maxLen - Maximum snippet text length in characters (default 500)
 * @param chunkPos - Optional character position of the matching chunk (from vector search)
 * @param chunkLen - Optional length of the matching chunk (defaults to `CHUNK_SIZE_CHARS`)
 * @param intent - Optional intent string to extract additional boosting terms
 * @returns A {@link SnippetResult} with line number, formatted snippet text, and context counts
 */
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
 * Prepend line numbers to each line of text.
 *
 * Format: `N: <line content>` where N starts at `startLine` and increments.
 *
 * @param text - The text to number
 * @param startLine - The number for the first line (default 1)
 * @returns Numbered text string
 */
export function addLineNumbers(text: string, startLine: number = 1): string {
  const lines = text.split('\n');
  return lines.map((line, i) => `${startLine + i}: ${line}`).join('\n');
}

export type HydratedSearchDocument = DocumentResult & { body: string };

/**
 * Hydrate search result filepaths with full document bodies and metadata.
 *
 * Takes a list of filepath strings (virtual or filesystem) and loads their
 * complete document data from the database in a single batch. Supports
 * both virtual path lookups (`qmd://collection/path`) and direct virtual
 * path matching for efficiency.
 *
 * @param db - Database handle
 * @param filepaths - Array of filepath strings to hydrate
 * @param resolveContext - A context resolver function (typically from {@link createContextResolver})
 * @returns A Map from filepath to fully hydrated {@link HydratedSearchDocument}
 *
 * **Side effects:** Reads `documents` and `content` tables.
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
