import { existsSync } from "fs";
import {
  homedir,
  buildVirtualPath,
  parseVirtualPath,
  resolveVirtualPath,
  extractSnippet,
  addLineNumbers,
  type ExpandedQuery,
  type HybridQueryExplain,
  type ChunkStrategy,
} from "../store.js";
import {
  escapeCSV,
  type OutputFormat,
} from "./formatter.js";
import { sanitizeFTS5Term } from "../store.js";
import {
  getCollection as getCollectionFromYaml,
  loadConfig,
  getDefaultCollectionNames,
} from "../collections.js";
import {
  closeDb,
  getDb,
  getActiveIndexName,
  renderFullPath,
} from "./lifecycle.js";

// =============================================================================
// Terminal colors (respects NO_COLOR env)
// =============================================================================

const useColor = !process.env.NO_COLOR && process.stdout.isTTY;
const c = {
  reset: useColor ? "\x1b[0m" : "",
  dim: useColor ? "\x1b[2m" : "",
  bold: useColor ? "\x1b[1m" : "",
  cyan: useColor ? "\x1b[36m" : "",
  yellow: useColor ? "\x1b[33m" : "",
  green: useColor ? "\x1b[32m" : "",
  magenta: useColor ? "\x1b[35m" : "",
  blue: useColor ? "\x1b[34m" : "",
};

// =============================================================================
// Types
// =============================================================================

export type OutputOptions = {
  format: OutputFormat;
  full: boolean;
  limit: number;
  minScore: number;
  all?: boolean;
  collection?: string | string[];  // Filter by collection name(s)
  lineNumbers?: boolean; // Add line numbers to output
  explain?: boolean;     // Include retrieval score traces (query only)
  context?: string;      // Optional context for query expansion
  candidateLimit?: number;  // Max candidates to rerank (default: 40)
  intent?: string;       // Domain intent for disambiguation
  skipRerank?: boolean;  // Skip LLM reranking, use RRF scores only
  chunkStrategy?: ChunkStrategy;  // "auto" (default) or "regex"
  fullPath?: boolean;    // Show realpath instead of qmd:// URI (relative to $PWD when subpath)
};

export type OutputRow = {
  file: string;
  displayPath: string;
  title: string;
  body: string;
  score: number;
  context?: string | null;
  chunkPos?: number;
  chunkLen?: number;
  hash?: string;
  docid?: string;
  explain?: HybridQueryExplain;
};

type EmptySearchReason = "no_results" | "min_score";

export interface ParsedStructuredQuery {
  searches: ExpandedQuery[];
  intent?: string;
}

const DEFAULT_EDITOR_URI_TEMPLATE = "vscode://file/{path}:{line}:{col}";

// =============================================================================
// FTS5 query utilities
// =============================================================================

// Build FTS5 query: phrase-aware with fallback to individual terms
export function buildFTS5Query(query: string): string {
  // Replace dots in version patterns (e.g., "2026.4.10") with spaces so FTS5
  // can match them as an exact phrase of adjacent tokens.
  const versionNormalized = query.replace(/(\d+\.\d[\d.]*)/g, (m) => m.replace(/\./g, ' '));

  // Sanitize the full query for phrase matching
  const sanitizedQuery = versionNormalized.replace(/[^\w\s']/g, '').trim();

  const terms = versionNormalized
    .split(/\s+/)
    .map(sanitizeFTS5Term)
    .filter(term => term.length >= 2); // Skip single chars and empty

  if (terms.length === 0) return "";
  if (terms.length === 1) return `"${terms[0]!.replace(/"/g, '""')}"`;

  // Strategy: exact phrase OR proximity match OR individual terms
  // Exact phrase matches rank highest, then close proximity, then any term
  const phrase = `"${sanitizedQuery.replace(/"/g, '""')}"`;
  const quotedTerms = terms.map(t => `"${t.replace(/"/g, '""')}"`);

  // FTS5 NEAR syntax: NEAR(term1 term2, distance)
  const nearPhrase = `NEAR(${quotedTerms.join(' ')}, 10)`;
  const orTerms = quotedTerms.join(' OR ');

  // Exact phrase > proximity > any term
  return `(${phrase}) OR (${nearPhrase}) OR (${orTerms})`;
}

// =============================================================================
// Score formatting
// =============================================================================

// Normalize BM25 score to 0-1 range using sigmoid
export function normalizeBM25(score: number): number {
  // BM25 scores are negative in SQLite (lower = better)
  // Typical range: -15 (excellent) to -2 (weak match)
  // Map to 0-1 where higher is better
  const absScore = Math.abs(score);
  // Sigmoid-ish normalization: maps ~2-15 range to ~0.1-0.95
  return 1 / (1 + Math.exp(-(absScore - 5) / 3));
}

// Highlight query terms in text (skip short words < 3 chars)
export function highlightTerms(text: string, query: string): string {
  if (!useColor) return text;
  const terms = query.toLowerCase().split(/\s+/).filter(t => t.length >= 3);
  let result = text;
  for (const term of terms) {
    const regex = new RegExp(`(${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
    result = result.replace(regex, `${c.yellow}${c.bold}$1${c.reset}`);
  }
  return result;
}

// Format score with color based on value
export function formatScore(score: number): string {
  const pct = (score * 100).toFixed(0).padStart(3);
  if (!useColor) return `${pct}%`;
  if (score >= 0.7) return `${c.green}${pct}%${c.reset}`;
  if (score >= 0.4) return `${c.yellow}${pct}%${c.reset}`;
  return `${c.dim}${pct}%${c.reset}`;
}

export function formatExplainNumber(value: number): string {
  return value.toFixed(4);
}

// =============================================================================
// Path utilities
// =============================================================================

// Shorten directory path for display - relative to $HOME (used for context paths, not documents)
export function shortPath(dirpath: string): string {
  const home = homedir();
  if (dirpath.startsWith(home)) {
    return '~' + dirpath.slice(home.length);
  }
  return dirpath;
}

// Emit format-safe empty output for search commands.
export function printEmptySearchResults(format: OutputFormat, reason: EmptySearchReason = "no_results"): void {
  if (format === "json") {
    console.log("[]");
    return;
  }
  if (format === "csv") {
    console.log("docid,score,file,title,context,line,snippet");
    return;
  }
  if (format === "xml") {
    console.log("<results></results>");
    return;
  }
  if (format === "md" || format === "files") {
    return;
  }

  if (reason === "min_score") {
    console.log("No results found above minimum score threshold.");
    return;
  }
  console.log("No results found.");
}

// =============================================================================
// Editor URI utilities
// =============================================================================

function encodePathForEditorUri(absolutePath: string): string {
  return encodeURI(absolutePath)
    .replace(/\?/g, "%3F")
    .replace(/#/g, "%23");
}

export function getEditorUriTemplate(): string {
  const envTemplate = process.env.QMD_EDITOR_URI?.trim();
  if (envTemplate) return envTemplate;

  try {
    const config = loadConfig() as unknown as {
      editor_uri?: string;
      editor_uri_template?: string;
      editorUri?: string;
      [key: string]: unknown;
    };
    const configTemplate = (
      config.editor_uri
      || config.editor_uri_template
      || config.editorUri
      || (typeof config["editor-uri"] === "string" ? config["editor-uri"] : undefined)
    )?.trim();

    if (configTemplate) return configTemplate;
  } catch {
    // Ignore config parsing issues and use default template.
  }

  return DEFAULT_EDITOR_URI_TEMPLATE;
}

export function buildEditorUri(template: string, absolutePath: string, line: number, col: number): string {
  const safeLine = Number.isFinite(line) && line > 0 ? Math.floor(line) : 1;
  const safeCol = Number.isFinite(col) && col > 0 ? Math.floor(col) : 1;
  const encodedPath = encodePathForEditorUri(absolutePath);

  return template
    .replace(/\{path\}/g, encodedPath)
    .replace(/\{line\}/g, String(safeLine))
    .replace(/\{col\}/g, String(safeCol))
    .replace(/\{column\}/g, String(safeCol));
}

export function termLink(text: string, url: string, isTTY: boolean = !!process.stdout.isTTY): string {
  if (!isTTY) return text;
  return `\x1b]8;;${url}\x07${text}\x1b]8;;\x07`;
}

// =============================================================================
// Result formatting
// =============================================================================

export function outputResults(results: OutputRow[], query: string, opts: OutputOptions): void {
  const filtered = results.filter(r => r.score >= opts.minScore).slice(0, opts.limit);

  if (filtered.length === 0) {
    printEmptySearchResults(opts.format, "min_score");
    return;
  }

  // Helper to create qmd:// URI from displayPath
  const toQmdPath = (displayPath: string) => {
    const [collectionName, ...segments] = displayPath.split("/");
    if (!collectionName || segments.length === 0) {
      return `qmd://${displayPath}`;
    }
    const indexName = getActiveIndexName();
    return buildVirtualPath(
      collectionName,
      segments.join("/"),
      indexName === "index" ? undefined : indexName,
    );
  };

  // Helper to pick the visible path for a result. With --full-path we swap
  // the qmd:// URI for the file's on-disk path via renderFullPath() (./-
  // prefixed relative when under $PWD, absolute realpath otherwise). Falls
  // back to qmd:// if the file is no longer resolvable on disk.
  const linkDbForPaths = opts.fullPath ? getDb() : null;
  const displayPathFor = (row: OutputRow): string => {
    // Always rebuild from displayPath so the active index name is included
    // as ?index=… for non-default indexes. row.file may not carry it.
    const qmdUri = toQmdPath(row.displayPath);
    if (!opts.fullPath || !linkDbForPaths) return qmdUri;
    const absolute = resolveVirtualPath(linkDbForPaths, qmdUri);
    if (!absolute || !existsSync(absolute)) return qmdUri;
    return renderFullPath(absolute);
  };

  if (opts.format === "json") {
    // JSON output for LLM consumption
    const output = filtered.map(row => {
      const docid = row.docid || (row.hash ? row.hash.slice(0, 6) : undefined);
      const snippetInfo = extractSnippet(row.body, query, 300, row.chunkPos, row.chunkLen, opts.intent);
      let body = opts.full ? row.body : undefined;
      let snippet = !opts.full ? snippetInfo.snippet : undefined;
      if (opts.lineNumbers) {
        if (body) body = addLineNumbers(body);
        if (snippet) snippet = addLineNumbers(snippet);
      }
      // With --full-path, omit docid (the on-disk path is the identifier).
      return {
        ...(docid && !opts.fullPath && { docid: `#${docid}` }),
        score: Math.round(row.score * 100) / 100,
        file: displayPathFor(row),
        line: snippetInfo.line,
        title: row.title,
        ...(row.context && { context: row.context }),
        ...(body && { body }),
        ...(snippet && { snippet }),
        ...(opts.explain && row.explain && { explain: row.explain }),
      };
    });
    console.log(JSON.stringify(output, null, 2));
  } else if (opts.format === "files") {
    // Simple docid,score,filepath,context output
    for (const row of filtered) {
      const docid = row.docid || (row.hash ? row.hash.slice(0, 6) : "");
      const ctx = row.context ? `,"${row.context.replace(/"/g, '""')}"` : "";
      if (opts.fullPath) {
        // --full-path: drop the docid, the on-disk path is the identifier.
        console.log(`${row.score.toFixed(2)},${displayPathFor(row)}${ctx}`);
      } else {
        console.log(`#${docid},${row.score.toFixed(2)},${displayPathFor(row)}${ctx}`);
      }
    }
  } else if (opts.format === "cli") {
    const editorUriTemplate = getEditorUriTemplate();
    const linkDb = getDb();

    for (let i = 0; i < filtered.length; i++) {
      const row = filtered[i];
      if (!row) continue;
      const { line, snippet } = extractSnippet(row.body, query, 500, row.chunkPos, row.chunkLen, opts.intent);
      const docid = row.docid || (row.hash ? row.hash.slice(0, 6) : undefined);

      // Line 1: filepath with docid
      // Default: show the full qmd:// URI so the user can see which collection
      // a hit lives in and can pipe the same string straight back into
      // `qmd get`. A bare collection-relative path like `sources/foo.md` is
      // ambiguous: it's not a real filesystem path, not a URI, and not a
      // shell-friendly identifier on its own.
      // With --full-path the visible label is the file's on-disk path
      // ($PWD-relative when in a subfolder; absolute realpath otherwise),
      // and the docid is omitted because the path is the identifier.
      const virtualPath = toQmdPath(row.displayPath);
      const parsed = parseVirtualPath(virtualPath);
      const absolutePath = resolveVirtualPath(linkDb, virtualPath);
      const visiblePath = displayPathFor(row);

      // Only show :line if we actually found a term match in the snippet body (exclude header line).
      const snippetBody = snippet.split("\n").slice(1).join("\n").toLowerCase();
      const hasMatch = query.toLowerCase().split(/\s+/).some(t => t.length > 0 && snippetBody.includes(t));
      const lineInfo = hasMatch ? `:${line}` : "";
      const docidStr = (docid && !opts.fullPath) ? ` ${c.dim}#${docid}${c.reset}` : "";

      if (process.stdout.isTTY && absolutePath && parsed?.path) {
        const linkLine = hasMatch ? line : 1;
        const linkTarget = buildEditorUri(editorUriTemplate, absolutePath, linkLine, 1);
        const clickable = termLink(`${visiblePath}${lineInfo}`, linkTarget);
        console.log(`${c.cyan}${clickable}${c.reset}${docidStr}`);
      } else {
        console.log(`${c.cyan}${visiblePath}${c.dim}${lineInfo}${c.reset}${docidStr}`);
      }

      // Line 2: Title (if available)
      if (row.title) {
        console.log(`${c.bold}Title: ${row.title}${c.reset}`);
      }

      // Line 3: Context (if available)
      if (row.context) {
        console.log(`${c.dim}Context: ${row.context}${c.reset}`);
      }

      // Line 4: Score
      const score = formatScore(row.score);
      console.log(`Score: ${c.bold}${score}${c.reset}`);
      if (opts.explain && row.explain) {
        const explain = row.explain;
        const ftsScores = explain.ftsScores.length > 0
          ? explain.ftsScores.map(formatExplainNumber).join(", ")
          : "none";
        const vecScores = explain.vectorScores.length > 0
          ? explain.vectorScores.map(formatExplainNumber).join(", ")
          : "none";
        const contribSummary = explain.rrf.contributions
          .slice()
          .sort((a, b) => b.rrfContribution - a.rrfContribution)
          .slice(0, 3)
          .map(c => `${c.source}/${c.queryType}#${c.rank}:${formatExplainNumber(c.rrfContribution)}`)
          .join(" | ");

        console.log(`${c.dim}Explain: fts=[${ftsScores}] vec=[${vecScores}]${c.reset}`);
        console.log(`${c.dim}  RRF: total=${formatExplainNumber(explain.rrf.totalScore)} base=${formatExplainNumber(explain.rrf.baseScore)} bonus=${formatExplainNumber(explain.rrf.topRankBonus)} rank=${explain.rrf.rank}${c.reset}`);
        console.log(`${c.dim}  Blend: ${Math.round(explain.rrf.weight * 100)}%*${formatExplainNumber(explain.rrf.positionScore)} + ${Math.round((1 - explain.rrf.weight) * 100)}%*${formatExplainNumber(explain.rerankScore)} = ${formatExplainNumber(explain.blendedScore)}${c.reset}`);
        if (contribSummary.length > 0) {
          console.log(`${c.dim}  Top RRF contributions: ${contribSummary}${c.reset}`);
        }
      }
      console.log();

      // Snippet with highlighting (diff-style header included)
      const content = opts.full ? row.body : snippet;
      const displayContent = opts.lineNumbers ? addLineNumbers(content, opts.full ? 1 : line) : content;
      const highlighted = highlightTerms(displayContent, query);
      console.log(highlighted);

      // Double empty line between results
      if (i < filtered.length - 1) console.log('\n');
    }
  } else if (opts.format === "md") {
    for (let i = 0; i < filtered.length; i++) {
      const row = filtered[i];
      if (!row) continue;
      const visiblePath = displayPathFor(row);
      const heading = row.title || visiblePath;
      const docid = row.docid || (row.hash ? row.hash.slice(0, 6) : undefined);
      let content = opts.full ? row.body : extractSnippet(row.body, query, 500, row.chunkPos, row.chunkLen, opts.intent).snippet;
      if (opts.lineNumbers) {
        content = addLineNumbers(content);
      }
      const fileLine = `**file:** \`${visiblePath}\`\n`;
      // With --full-path the on-disk path is the identifier; drop the docid line.
      const docidLine = (docid && !opts.fullPath) ? `**docid:** \`#${docid}\`\n` : "";
      const contextLine = row.context ? `**context:** ${row.context}\n` : "";
      console.log(`---\n# ${heading}\n${fileLine}${docidLine}${contextLine}\n${content}\n`);
    }
  } else if (opts.format === "xml") {
    for (const row of filtered) {
      const titleAttr = row.title ? ` title="${row.title.replace(/"/g, '&quot;')}"` : "";
      const contextAttr = row.context ? ` context="${row.context.replace(/"/g, '&quot;')}"` : "";
      const docid = row.docid || (row.hash ? row.hash.slice(0, 6) : "");
      let content = opts.full ? row.body : extractSnippet(row.body, query, 500, row.chunkPos, row.chunkLen, opts.intent).snippet;
      if (opts.lineNumbers) {
        content = addLineNumbers(content);
      }
      const docidAttr = opts.fullPath ? "" : ` docid="#${docid}"`;
      console.log(`<file${docidAttr} name="${displayPathFor(row)}"${titleAttr}${contextAttr}>\n${content}\n</file>\n`);
    }
  } else {
    // CSV format
    const csvHeader = opts.fullPath
      ? "score,file,title,context,line,snippet"
      : "docid,score,file,title,context,line,snippet";
    console.log(csvHeader);
    for (const row of filtered) {
      const { line, snippet } = extractSnippet(row.body, query, 500, row.chunkPos, row.chunkLen, opts.intent);
      let content = opts.full ? row.body : snippet;
      if (opts.lineNumbers) {
        content = addLineNumbers(content, opts.full ? 1 : line);
      }
      const docid = row.docid || (row.hash ? row.hash.slice(0, 6) : "");
      const snippetText = content || "";
      const path = escapeCSV(displayPathFor(row));
      const tail = `${path},${escapeCSV(row.title || "")},${escapeCSV(row.context || "")},${line},${escapeCSV(snippetText)}`;
      if (opts.fullPath) {
        console.log(`${row.score.toFixed(4)},${tail}`);
      } else {
        console.log(`#${docid},${row.score.toFixed(4)},${tail}`);
      }
    }
  }
}

// =============================================================================
// Collection filtering
// =============================================================================

// Resolve -c collection filter: supports single string, array, or undefined.
// Returns validated collection names (exits on unknown collection).
export function resolveCollectionFilter(raw: string | string[] | undefined, useDefaults: boolean = false): string[] {
  // If no filter specified and useDefaults is true, use default collections
  if (!raw && useDefaults) {
    return getDefaultCollectionNames();
  }
  if (!raw) return [];
  const names = Array.isArray(raw) ? raw : [raw];
  const validated: string[] = [];
  for (const name of names) {
    const coll = getCollectionFromYaml(name);
    if (!coll) {
      console.error(`Collection not found: ${name}`);
      closeDb();
      process.exit(1);
    }
    validated.push(name);
  }
  return validated;
}

// Post-filter results to only include files from specified collections.
export function filterByCollections<T extends { filepath?: string; file?: string }>(results: T[], collectionNames: string[]): T[] {
  if (collectionNames.length <= 1) return results;
  const prefixes = collectionNames.map(n => `qmd://${n}/`);
  return results.filter(r => {
    const path = r.filepath || r.file || '';
    return prefixes.some(p => path.startsWith(p));
  });
}

// =============================================================================
// Structured query parsing
// =============================================================================

/**
 * Parse structured search query syntax.
 * Lines starting with lex:, vec:, or hyde: are routed directly.
 * Plain lines without prefix go through query expansion.
 *
 * Returns null if this is a plain query (single line, no prefix).
 * Returns ExpandedQuery[] if structured syntax detected.
 * Throws if multiple plain lines (ambiguous).
 *
 * Examples:
 *   "CAP theorem"                    -> null (plain query, use expansion)
 *   "lex: CAP theorem"               -> [{ type: 'lex', query: 'CAP theorem' }]
 *   "lex: CAP\nvec: consistency"     -> [{ type: 'lex', ... }, { type: 'vec', ... }]
 *   "CAP\nconsistency"               -> throws (multiple plain lines)
 */
export function parseStructuredQuery(query: string): ParsedStructuredQuery | null {
  const rawLines = query.split('\n').map((line, idx) => ({
    raw: line,
    trimmed: line.trim(),
    number: idx + 1,
  })).filter(line => line.trimmed.length > 0);

  if (rawLines.length === 0) return null;

  const prefixRe = /^(lex|vec|hyde):\s*/i;
  const expandRe = /^expand:\s*/i;
  const intentRe = /^intent:\s*/i;
  const typed: ExpandedQuery[] = [];
  let intent: string | undefined;

  for (const line of rawLines) {
    if (expandRe.test(line.trimmed)) {
      if (rawLines.length > 1) {
        throw new Error(`Line ${line.number} starts with expand:, but query documents cannot mix expand with typed lines. Submit a single expand query instead.`);
      }
      const text = line.trimmed.replace(expandRe, '').trim();
      if (!text) {
        throw new Error('expand: query must include text.');
      }
      return null; // treat as standalone expand query
    }

    // Parse intent: lines
    if (intentRe.test(line.trimmed)) {
      if (intent !== undefined) {
        throw new Error(`Line ${line.number}: only one intent: line is allowed per query document.`);
      }
      const text = line.trimmed.replace(intentRe, '').trim();
      if (!text) {
        throw new Error(`Line ${line.number}: intent: must include text.`);
      }
      intent = text;
      continue;
    }

    const match = line.trimmed.match(prefixRe);
    if (match) {
      const type = match[1]!.toLowerCase() as 'lex' | 'vec' | 'hyde';
      const text = line.trimmed.slice(match[0].length).trim();
      if (!text) {
        throw new Error(`Line ${line.number} (${type}:) must include text.`);
      }
      if (/\r|\n/.test(text)) {
        throw new Error(`Line ${line.number} (${type}:) contains a newline. Keep each query on a single line.`);
      }
      typed.push({ type, query: text, line: line.number });
      continue;
    }

    if (rawLines.length === 1) {
      // Single plain line -> implicit expand
      return null;
    }

    throw new Error(`Line ${line.number} is missing a lex:/vec:/hyde:/intent: prefix. Each line in a query document must start with one.`);
  }

  // intent: alone is not a valid query — must have at least one search
  if (intent && typed.length === 0) {
    throw new Error('intent: cannot appear alone. Add at least one lex:, vec:, or hyde: line.');
  }

  return typed.length > 0 ? { searches: typed, intent } : null;
}

// =============================================================================
// Query expansion logging
// =============================================================================

// Log query expansion as a tree to stderr (CLI progress feedback)
export function logExpansionTree(originalQuery: string, expanded: ExpandedQuery[]): void {
  const lines: string[] = [];
  lines.push(`${c.dim}├─ ${originalQuery}${c.reset}`);
  for (const q of expanded) {
    let preview = q.query.replace(/\n/g, ' ');
    if (preview.length > 72) preview = preview.substring(0, 69) + '...';
    lines.push(`${c.dim}├─ ${q.type}: ${preview}${c.reset}`);
  }
  if (lines.length > 0) {
    lines[lines.length - 1] = lines[lines.length - 1]!.replace('├─', '└─');
  }
  for (const line of lines) process.stderr.write(line + '\n');
}
