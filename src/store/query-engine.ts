/**
 * Query engine — hybrid, vector, and structured search orchestration.
 *
 * This module provides:
 *  - Query expansion via LLM (expandQuery)
 *  - LLM reranking (rerank)
 *  - Reciprocal Rank Fusion (reciprocalRankFusion, buildRrfTrace)
 *  - Hybrid search pipeline (hybridQuery)
 *  - Vector-only search (vectorSearchQuery)
 *  - Structured pre-expanded search (structuredSearch)
 */

import type { Database } from "../db.js";
import {
  getStoreLlm,
} from "./embedding-pipeline.js";
import {
  formatQueryForEmbedding,
  getDefaultLlamaCpp,
  DEFAULT_EMBED_MODEL_URI,
  DEFAULT_RERANK_MODEL_URI,
  DEFAULT_GENERATE_MODEL_URI,
  type LLM,
} from "../llm.js";
import {
  searchFTS,
  searchVec,
  createContextResolver,
  loadSearchDocumentsByFilepaths,
  extractIntentTerms,
  getDocid,
  type SearchResultOptions,
  type RankedResult,
  type RRFContributionTrace,
  type RRFScoreTrace,
  type HybridQueryExplain,
} from "./retrieval.js";

import { chunkDocumentAsync } from "./chunking-async.js";
import {
  getCacheKey,
  getCachedResult,
  setCachedResult,
} from "./cache.js";

// =============================================================================
// Constants
// =============================================================================

const RERANK_TOP_CHUNKS_PER_DOC = 3;
const CANDIDATE_LIMIT_LOW_AMBIGUITY_MAX = 24;
const CANDIDATE_LIMIT_HIGH_AMBIGUITY_MAX = 80;
const EXPANSION_MAX_PER_TYPE: Record<"lex" | "vec" | "hyde", number> = {
  lex: 2,
  vec: 3,
  hyde: 2,
};
const EXPANSION_MIN_NOVELTY_JACCARD = 0.12;
const EXPANSION_NEAR_DUPLICATE_JACCARD = 0.88;

export const STRONG_SIGNAL_MIN_SCORE = 0.85;
export const STRONG_SIGNAL_MIN_GAP = 0.15;
export const RERANK_CANDIDATE_LIMIT = 40;

// =============================================================================
// Query expansion types
// =============================================================================

export type ExpandedQuery = {
  type: 'lex' | 'vec' | 'hyde';
  query: string;
  /** 1-indexed line number in the structured search request, if applicable */
  line?: number;
};

// =============================================================================
// Query expansion
// =============================================================================

function tokenizeForSimilarity(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .map((t) => t.trim())
      .filter((t) => t.length > 1),
  );
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function filterExpandedQueries(raw: ExpandedQuery[], originalQuery: string): ExpandedQuery[] {
  const sourceTokens = tokenizeForSimilarity(originalQuery);
  const perTypeCount = new Map<ExpandedQuery["type"], number>();
  const keptTokenSets: Array<{ type: ExpandedQuery["type"]; tokens: Set<string> }> = [];
  const seenNormalized = new Set<string>();
  const filtered: ExpandedQuery[] = [];

  for (const entry of raw) {
    const normalized = entry.query.toLowerCase().replace(/\s+/g, " ").trim();
    if (!normalized || seenNormalized.has(normalized)) continue;
    seenNormalized.add(normalized);

    const tokens = tokenizeForSimilarity(entry.query);
    const novelty = 1 - jaccardSimilarity(sourceTokens, tokens);
    if (novelty < EXPANSION_MIN_NOVELTY_JACCARD) continue;

    let duplicate = false;
    for (const existing of keptTokenSets) {
      if (existing.type !== entry.type) continue;
      if (jaccardSimilarity(existing.tokens, tokens) >= EXPANSION_NEAR_DUPLICATE_JACCARD) {
        duplicate = true;
        break;
      }
    }
    if (duplicate) continue;

    const used = perTypeCount.get(entry.type) ?? 0;
    const limit = EXPANSION_MAX_PER_TYPE[entry.type];
    if (used >= limit) continue;

    perTypeCount.set(entry.type, used + 1);
    keptTokenSets.push({ type: entry.type, tokens });
    filtered.push(entry);
  }

  return filtered;
}

export async function expandQuery(query: string, model: string = DEFAULT_GENERATE_MODEL_URI, db: Database, intent?: string, llmOverride?: LLM): Promise<ExpandedQuery[]> {
  const cacheKey = getCacheKey("expandQuery", { query, model, ...(intent && { intent }) });
  const cached = getCachedResult(db, cacheKey);
  if (cached) {
    try {
      const parsed = JSON.parse(cached) as unknown;
      if (!Array.isArray(parsed)) return [];
      const rows = parsed as Array<Record<string, unknown>>;
      if (rows.length > 0 && typeof rows[0]?.query === "string") {
        return rows.map((r) => ({ type: r.type as ExpandedQuery["type"], query: String(r.query) }));
      } else if (rows.length > 0 && typeof rows[0]?.text === "string") {
        return rows.map((r) => ({ type: r.type as ExpandedQuery["type"], query: String(r.text) }));
      }
    } catch {
      // Old cache format — re-expand
    }
  }

  const llm = llmOverride ?? getDefaultLlamaCpp();
  const results = await llm.expandQuery(query, { intent });

  const rawExpanded: ExpandedQuery[] = results
    .filter(r => r.text !== query)
    .map(r => ({ type: r.type, query: r.text }));
  const expanded = filterExpandedQueries(rawExpanded, query);

  if (expanded.length > 0) {
    setCachedResult(db, cacheKey, JSON.stringify(expanded));
  }

  return expanded;
}

// =============================================================================
// Reranking
// =============================================================================

export async function rerank(query: string, documents: { file: string; text: string }[], model: string = DEFAULT_RERANK_MODEL_URI, db: Database, intent?: string, llmOverride?: LLM): Promise<{ file: string; score: number }[]> {
  const rerankQuery = intent ? `${intent}\n\n${query}` : query;

  const cachedResults: Map<string, number> = new Map();
  const uncachedDocsByChunk: Map<string, { file: string; text: string }> = new Map();

  for (const doc of documents) {
    const cacheKey = getCacheKey("rerank", { query: rerankQuery, model, chunk: doc.text });
    const legacyCacheKey = getCacheKey("rerank", { query, file: doc.file, model, chunk: doc.text });
    const cached = getCachedResult(db, cacheKey) ?? getCachedResult(db, legacyCacheKey);
    if (cached !== null) {
      cachedResults.set(doc.text, parseFloat(cached));
    } else {
      uncachedDocsByChunk.set(doc.text, { file: doc.file, text: doc.text });
    }
  }

  if (uncachedDocsByChunk.size > 0) {
    const llm = llmOverride ?? getDefaultLlamaCpp();
    const uncachedDocs = [...uncachedDocsByChunk.values()];
    const rerankResult = await llm.rerank(rerankQuery, uncachedDocs, { model });

    const textByFile = new Map(uncachedDocs.map(d => [d.file, d.text]));
    for (const result of rerankResult.results) {
      const chunk = textByFile.get(result.file) || "";
      const cacheKey = getCacheKey("rerank", { query: rerankQuery, model, chunk });
      setCachedResult(db, cacheKey, result.score.toString());
      cachedResults.set(chunk, result.score);
    }
  }

  return documents
    .map(doc => ({ file: doc.file, score: cachedResults.get(doc.text) || 0 }))
    .sort((a, b) => b.score - a.score);
}

// =============================================================================
// Reciprocal Rank Fusion
// =============================================================================

export function reciprocalRankFusion(
  resultLists: RankedResult[][],
  weights: number[] = [],
  k: number = 60
): RankedResult[] {
  const scores = new Map<string, { result: RankedResult; rrfScore: number; topRank: number }>();

  for (let listIdx = 0; listIdx < resultLists.length; listIdx++) {
    const list = resultLists[listIdx];
    if (!list) continue;
    const weight = weights[listIdx] ?? 1.0;

    for (let rank = 0; rank < list.length; rank++) {
      const result = list[rank];
      if (!result) continue;
      const rrfContribution = weight / (k + rank + 1);
      const existing = scores.get(result.file);

      if (existing) {
        existing.rrfScore += rrfContribution;
        existing.topRank = Math.min(existing.topRank, rank);
      } else {
        scores.set(result.file, {
          result,
          rrfScore: rrfContribution,
          topRank: rank,
        });
      }
    }
  }

  for (const entry of scores.values()) {
    if (entry.topRank === 0) {
      entry.rrfScore += 0.05;
    } else if (entry.topRank <= 2) {
      entry.rrfScore += 0.02;
    }
  }

  return Array.from(scores.values())
    .sort((a, b) => b.rrfScore - a.rrfScore)
    .map(e => ({ ...e.result, score: e.rrfScore }));
}

export type RankedListMeta = {
  source: "fts" | "vec";
  queryType: "original" | "lex" | "vec" | "hyde";
  query: string;
};

export function buildRrfTrace(
  resultLists: RankedResult[][],
  weights: number[] = [],
  listMeta: RankedListMeta[] = [],
  k: number = 60
): Map<string, RRFScoreTrace> {
  const traces = new Map<string, RRFScoreTrace>();

  for (let listIdx = 0; listIdx < resultLists.length; listIdx++) {
    const list = resultLists[listIdx];
    if (!list) continue;
    const weight = weights[listIdx] ?? 1.0;
    const meta = listMeta[listIdx] ?? {
      source: "fts",
      queryType: "original",
      query: "",
    } as const;

    for (let rank0 = 0; rank0 < list.length; rank0++) {
      const result = list[rank0];
      if (!result) continue;
      const rank = rank0 + 1;
      const contribution = weight / (k + rank);
      const existing = traces.get(result.file);

      const detail: RRFContributionTrace = {
        listIndex: listIdx,
        source: meta.source,
        queryType: meta.queryType,
        query: meta.query,
        rank,
        weight,
        backendScore: result.score,
        rrfContribution: contribution,
      };

      if (existing) {
        existing.baseScore += contribution;
        existing.topRank = Math.min(existing.topRank, rank);
        existing.contributions.push(detail);
      } else {
        traces.set(result.file, {
          contributions: [detail],
          baseScore: contribution,
          topRank: rank,
          topRankBonus: 0,
          totalScore: 0,
        });
      }
    }
  }

  for (const trace of traces.values()) {
    let bonus = 0;
    if (trace.topRank === 1) bonus = 0.05;
    else if (trace.topRank <= 3) bonus = 0.02;
    trace.topRankBonus = bonus;
    trace.totalScore = trace.baseScore + bonus;
  }

  return traces;
}

// =============================================================================
// Search hooks and options
// =============================================================================

export interface SearchHooks {
  onStrongSignal?: (topScore: number) => void;
  onExpandStart?: () => void;
  onExpand?: (original: string, expanded: ExpandedQuery[], elapsedMs: number) => void;
  onEmbedStart?: (count: number) => void;
  onEmbedDone?: (elapsedMs: number) => void;
  onRerankStart?: (chunkCount: number) => void;
  onRerankDone?: (elapsedMs: number) => void;
}

export interface HybridQueryOptions {
  collection?: string;
  limit?: number;
  minScore?: number;
  candidateLimit?: number;
  explain?: boolean;
  intent?: string;
  skipRerank?: boolean;
  chunkStrategy?: import("./chunking.js").ChunkStrategy;
  hooks?: SearchHooks;
}

export interface HybridQueryResult {
  file: string;
  displayPath: string;
  title: string;
  body: string;
  bestChunk: string;
  bestChunkPos: number;
  score: number;
  context: string | null;
  docid: string;
  explain?: HybridQueryExplain;
}

export interface VectorSearchOptions {
  collection?: string;
  limit?: number;
  minScore?: number;
  intent?: string;
  hooks?: Pick<SearchHooks, 'onExpand'>;
}

export interface VectorSearchResult {
  file: string;
  displayPath: string;
  title: string;
  body: string;
  score: number;
  context: string | null;
  docid: string;
}

export interface StructuredSearchOptions {
  collections?: string[];
  limit?: number;
  minScore?: number;
  candidateLimit?: number;
  explain?: boolean;
  intent?: string;
  skipRerank?: boolean;
  chunkStrategy?: import("./chunking.js").ChunkStrategy;
  hooks?: SearchHooks;
}

// =============================================================================
// Helper functions
// =============================================================================

export function getHybridRrfWeights(rankedListMeta: RankedListMeta[]): number[] {
  return rankedListMeta.map(meta => meta.queryType === "original" ? 2.0 : 1.0);
}

function resolveAdaptiveCandidateLimit(
  fused: RankedResult[],
  requestedCandidateLimit: number | undefined,
  resultLimit: number,
): number {
  if (requestedCandidateLimit && requestedCandidateLimit > 0) return requestedCandidateLimit;
  if (fused.length <= resultLimit) return Math.max(resultLimit, 1);

  const defaultLimit = RERANK_CANDIDATE_LIMIT;
  const topScore = fused[0]?.score ?? 0;
  const secondScore = fused[1]?.score ?? 0;
  const scoreGap = topScore - secondScore;
  const k = Math.min(8, fused.length);
  const topK = fused.slice(0, k).map((r) => r.score);
  const mean = topK.reduce((sum, s) => sum + s, 0) / topK.length;
  const variance = topK.reduce((sum, s) => sum + Math.pow(s - mean, 2), 0) / topK.length;
  const spread = Math.sqrt(Math.max(variance, 0));

  if (scoreGap >= 0.035 && spread <= 0.012) {
    return Math.min(
      Math.max(resultLimit * 2, 12),
      CANDIDATE_LIMIT_LOW_AMBIGUITY_MAX,
      fused.length,
    );
  }

  if (scoreGap <= 0.01 || spread >= 0.03) {
    return Math.min(
      Math.max(defaultLimit, resultLimit * 6),
      CANDIDATE_LIMIT_HIGH_AMBIGUITY_MAX,
      fused.length,
    );
  }

  return Math.min(defaultLimit, fused.length);
}

type ChunkSelection = {
  chunks: { text: string; pos: number }[];
  rankedIndices: number[];
};

type ChunkRerankCandidate = {
  rerankId: string;
  docFile: string;
  chunkIndex: number;
  text: string;
  pos: number;
};

function selectChunkIndicesForRerank(
  chunks: { text: string; pos: number }[],
  queryTerms: string[],
  intentTerms: string[],
  maxChunks: number = RERANK_TOP_CHUNKS_PER_DOC,
): number[] {
  const scored = chunks.map((chunk, idx) => {
    const chunkLower = chunk.text.toLowerCase();
    let score = queryTerms.reduce((acc, term) => acc + (chunkLower.includes(term) ? 1 : 0), 0);
    for (const term of intentTerms) {
      if (chunkLower.includes(term)) score += 0.5; // INTENT_WEIGHT_CHUNK
    }
    return { idx, score };
  });

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.idx - b.idx;
  });

  const top = scored.slice(0, Math.max(1, Math.min(maxChunks, chunks.length))).map((row) => row.idx);
  return top.length > 0 ? top : [0];
}

// =============================================================================
// Hybrid Query
// =============================================================================

/** Store API surface needed by the query engine (subset of Store methods with pre-bound db) */
export interface StoreQueryApi {
  db: Database;
  llm?: LLM;
  searchFTS(query: string, limit?: number, collectionName?: string, options?: SearchResultOptions): ReturnType<typeof searchFTS>;
  searchVec(query: string, model: string, limit?: number, collectionName?: string, session?: unknown, precomputedEmbedding?: number[], llm?: LLM, options?: SearchResultOptions): ReturnType<typeof searchVec>;
  expandQuery(query: string, model?: string, intent?: string): Promise<ExpandedQuery[]>;
  rerank(query: string, documents: { file: string; text: string }[], model?: string, intent?: string): Promise<{ file: string; score: number }[]>;
  embedModelName?: string;
  generateModelName?: string;
  rerankModelName?: string;
}

/**
 * Hybrid search: BM25 + vector + query expansion + RRF + chunked reranking.
 */
export async function hybridQuery(
  store: StoreQueryApi,
  query: string,
  options?: HybridQueryOptions
): Promise<HybridQueryResult[]> {
  const db = store.db;
  const limit = options?.limit ?? 10;
  const minScore = options?.minScore ?? 0;
  const requestedCandidateLimit = options?.candidateLimit;
  const collection = options?.collection;
  const explain = options?.explain ?? false;
  const intent = options?.intent;
  const skipRerank = options?.skipRerank ?? false;
  const hooks = options?.hooks;
  const retrievalOptions: SearchResultOptions = { includeBody: false, includeContext: false };

  const rankedLists: RankedResult[][] = [];
  const rankedListMeta: RankedListMeta[] = [];
  const docidMap = new Map<string, string>();
  const hasVectors = !!store.db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='vectors_vec'`
  ).get();

  // Step 1: BM25 probe
  const initialFts = store.searchFTS(query, 20, collection, retrievalOptions);
  const topScore = initialFts[0]?.score ?? 0;
  const secondScore = initialFts[1]?.score ?? 0;
  const hasStrongSignal = !intent && initialFts.length > 0
    && topScore >= STRONG_SIGNAL_MIN_SCORE
    && (topScore - secondScore) >= STRONG_SIGNAL_MIN_GAP;

  if (hasStrongSignal) hooks?.onStrongSignal?.(topScore);

  // Step 2: Expand query
  hooks?.onExpandStart?.();
  const expandStart = Date.now();
  const expanded = hasStrongSignal
    ? []
    : await store.expandQuery(query, undefined, intent);

  hooks?.onExpand?.(query, expanded, Date.now() - expandStart);

  if (initialFts.length > 0) {
    for (const r of initialFts) docidMap.set(r.filepath, r.docid);
    rankedLists.push(initialFts.map(r => ({
      file: r.filepath, displayPath: r.displayPath,
      title: r.title, score: r.score,
    })));
    rankedListMeta.push({ source: "fts", queryType: "original", query });
  }

  // Step 3: Route searches by query type
  for (const q of expanded) {
    if (q.type === 'lex') {
      const ftsResults = store.searchFTS(q.query, 20, collection, retrievalOptions);
      if (ftsResults.length > 0) {
        for (const r of ftsResults) docidMap.set(r.filepath, r.docid);
        rankedLists.push(ftsResults.map(r => ({
          file: r.filepath, displayPath: r.displayPath,
          title: r.title, score: r.score,
        })));
        rankedListMeta.push({ source: "fts", queryType: "lex", query: q.query });
      }
    }
  }

  if (hasVectors) {
    const vecQueries: { text: string; queryType: "original" | "vec" | "hyde" }[] = [
      { text: query, queryType: "original" },
    ];
    for (const q of expanded) {
      if (q.type === 'vec' || q.type === 'hyde') {
        vecQueries.push({ text: q.query, queryType: q.type });
      }
    }

    const embedModel = store.embedModelName ?? DEFAULT_EMBED_MODEL_URI;
    const textsToEmbed = vecQueries.map(q => formatQueryForEmbedding(q.text, embedModel));
    hooks?.onEmbedStart?.(textsToEmbed.length);
    const embedStart = Date.now();
    const llm = getStoreLlm(store.llm);
    const embeddings = await llm.embedBatch(textsToEmbed, { model: embedModel, isQuery: true });
    hooks?.onEmbedDone?.(Date.now() - embedStart);

    for (let i = 0; i < vecQueries.length; i++) {
      const embedding = embeddings[i]?.embedding;
      if (!embedding) continue;

      const vecResults = await store.searchVec(
        vecQueries[i]!.text, embedModel, 20, collection,
        undefined, embedding, undefined, retrievalOptions
      );
      if (vecResults.length > 0) {
        for (const r of vecResults) docidMap.set(r.filepath, r.docid);
        rankedLists.push(vecResults.map(r => ({
          file: r.filepath, displayPath: r.displayPath,
          title: r.title, score: r.score,
        })));
        rankedListMeta.push({
          source: "vec",
          queryType: vecQueries[i]!.queryType,
          query: vecQueries[i]!.text,
        });
      }
    }
  }

  // Step 4: RRF fusion
  const weights = getHybridRrfWeights(rankedListMeta);
  const fused = reciprocalRankFusion(rankedLists, weights);
  const rrfTraceByFile = explain ? buildRrfTrace(rankedLists, weights, rankedListMeta) : null;
  const candidateLimit = resolveAdaptiveCandidateLimit(fused, requestedCandidateLimit, limit);
  const candidates = fused.slice(0, candidateLimit);

  if (candidates.length === 0) return [];
  const resolveContext = createContextResolver(store.db);
  const hydratedCandidates = loadSearchDocumentsByFilepaths(store.db, candidates.map(candidate => candidate.file), resolveContext);

  // Step 5: Chunk documents
  const queryTerms = query.toLowerCase().split(/\s+/).filter(t => t.length > 2);
  const intentTerms = intent ? extractIntentTerms(intent) : [];
  const docChunkMap = new Map<string, ChunkSelection>();
  const candidateDocMap = new Map<string, { filepath: string; displayPath: string; title: string; hash: string; collectionName: string; modifiedAt: string; bodyLength: number; body: string; context: string | null; docid: string }>();

  const chunkStrategy = options?.chunkStrategy;
  for (const cand of candidates) {
    const hydrated = hydratedCandidates.get(cand.file);
    if (!hydrated) continue;
    candidateDocMap.set(cand.file, hydrated);
    const chunks = await chunkDocumentAsync(hydrated.body, undefined, undefined, undefined, cand.file, chunkStrategy);
    if (chunks.length === 0) continue;

    docChunkMap.set(cand.file, {
      chunks,
      rankedIndices: selectChunkIndicesForRerank(chunks, queryTerms, intentTerms),
    });
  }

  if (skipRerank) {
    const seenFiles = new Set<string>();
    return candidates
      .map((cand, i) => {
        const chunkInfo = docChunkMap.get(cand.file);
        const candidate = candidateDocMap.get(cand.file);
        const bestIdx = chunkInfo?.rankedIndices[0] ?? 0;
        const bestChunk = chunkInfo?.chunks[bestIdx]?.text || candidate?.body || "";
        const bestChunkPos = chunkInfo?.chunks[bestIdx]?.pos || 0;
        const rrfRank = i + 1;
        const rrfScore = 1 / rrfRank;
        const trace = rrfTraceByFile?.get(cand.file);
        const explainData: HybridQueryExplain | undefined = explain ? {
          ftsScores: trace?.contributions.filter(c => c.source === "fts").map(c => c.backendScore) ?? [],
          vectorScores: trace?.contributions.filter(c => c.source === "vec").map(c => c.backendScore) ?? [],
          rrf: {
            rank: rrfRank,
            positionScore: rrfScore,
            weight: 1.0,
            baseScore: trace?.baseScore ?? 0,
            topRankBonus: trace?.topRankBonus ?? 0,
            totalScore: trace?.totalScore ?? 0,
            contributions: trace?.contributions ?? [],
          },
          rerankScore: 0,
          blendedScore: rrfScore,
        } : undefined;

        return {
          file: cand.file,
          displayPath: candidate?.displayPath || cand.displayPath,
          title: candidate?.title || cand.title,
          body: candidate?.body || "",
          bestChunk,
          bestChunkPos,
          score: rrfScore,
          context: candidate?.context ?? null,
          docid: docidMap.get(cand.file) || "",
          ...(explainData ? { explain: explainData } : {}),
        };
      })
      .filter(r => {
        if (seenFiles.has(r.file)) return false;
        seenFiles.add(r.file);
        return true;
      })
      .filter(r => r.score >= minScore)
      .slice(0, limit);
  }

  // Step 6: Rerank
  const chunkCandidates: ChunkRerankCandidate[] = [];
  for (const cand of candidates) {
    const chunkInfo = docChunkMap.get(cand.file);
    if (!chunkInfo) continue;
    for (const idx of chunkInfo.rankedIndices) {
      const chunk = chunkInfo.chunks[idx];
      if (!chunk) continue;
      chunkCandidates.push({
        rerankId: `${cand.file}#${idx}`,
        docFile: cand.file,
        chunkIndex: idx,
        text: chunk.text,
        pos: chunk.pos,
      });
    }
  }

  hooks?.onRerankStart?.(chunkCandidates.length);
  const rerankStart = Date.now();
  const reranked = await store.rerank(
    query,
    chunkCandidates.map((c) => ({ file: c.rerankId, text: c.text })),
    undefined,
    intent,
  );
  hooks?.onRerankDone?.(Date.now() - rerankStart);

  const rerankCandidateById = new Map(chunkCandidates.map((c) => [c.rerankId, c]));
  const bestChunkByDoc = new Map<string, { score: number; chunk: ChunkRerankCandidate }>();
  for (const row of reranked) {
    const candidate = rerankCandidateById.get(row.file);
    if (!candidate) continue;
    const existing = bestChunkByDoc.get(candidate.docFile);
    if (!existing || row.score > existing.score) {
      bestChunkByDoc.set(candidate.docFile, { score: row.score, chunk: candidate });
    }
  }

  // Step 7: Blend RRF position score with reranker score
  const rrfRankMap = new Map(candidates.map((c, i) => [c.file, i + 1]));

  const blended = candidates.map(cand => {
    const rrfRank = rrfRankMap.get(cand.file) || candidateLimit;
    const bestChunk = bestChunkByDoc.get(cand.file);
    const rerankScore = bestChunk?.score ?? 0;
    let rrfWeight: number;
    if (rrfRank <= 3) rrfWeight = 0.75;
    else if (rrfRank <= 10) rrfWeight = 0.60;
    else rrfWeight = 0.40;
    const rrfScore = 1 / rrfRank;
    const blendedScore = rrfWeight * rrfScore + (1 - rrfWeight) * rerankScore;

    const candidate = candidateDocMap.get(cand.file);
    const chunkInfo = docChunkMap.get(cand.file);
    const bestIdx = bestChunk?.chunk.chunkIndex ?? chunkInfo?.rankedIndices[0] ?? 0;
    const bestChunkText = (bestChunk?.chunk.text ?? chunkInfo?.chunks[bestIdx]?.text) || candidate?.body || "";
    const bestChunkPos = (bestChunk?.chunk.pos ?? chunkInfo?.chunks[bestIdx]?.pos) || 0;
    const trace = rrfTraceByFile?.get(cand.file);
    const explainData: HybridQueryExplain | undefined = explain ? {
      ftsScores: trace?.contributions.filter(c => c.source === "fts").map(c => c.backendScore) ?? [],
      vectorScores: trace?.contributions.filter(c => c.source === "vec").map(c => c.backendScore) ?? [],
      rrf: {
        rank: rrfRank,
        positionScore: rrfScore,
        weight: rrfWeight,
        baseScore: trace?.baseScore ?? 0,
        topRankBonus: trace?.topRankBonus ?? 0,
        totalScore: trace?.totalScore ?? 0,
        contributions: trace?.contributions ?? [],
      },
      rerankScore,
      blendedScore,
    } : undefined;

    return {
      file: cand.file,
      displayPath: candidate?.displayPath || "",
      title: candidate?.title || "",
      body: candidate?.body || "",
      bestChunk: bestChunkText,
      bestChunkPos,
      score: blendedScore,
      context: candidate?.context ?? null,
      docid: docidMap.get(cand.file) || "",
      ...(explainData ? { explain: explainData } : {}),
    };
  }).sort((a, b) => b.score - a.score);

  // Step 8: Dedup
  const seenFiles = new Set<string>();
  return blended
    .filter(r => {
      if (seenFiles.has(r.file)) return false;
      seenFiles.add(r.file);
      return true;
    })
    .filter(r => r.score >= minScore)
    .slice(0, limit);
}

// =============================================================================
// Vector Search Query
// =============================================================================

export async function vectorSearchQuery(
  store: StoreQueryApi,
  query: string,
  options?: VectorSearchOptions
): Promise<VectorSearchResult[]> {
  const limit = options?.limit ?? 10;
  const minScore = options?.minScore ?? 0.3;
  const collection = options?.collection;
  const intent = options?.intent;

  const hasVectors = !!store.db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='vectors_vec'`
  ).get();
  if (!hasVectors) return [];

  const expandStart = Date.now();
  const allExpanded = await store.expandQuery(query, undefined, intent);
  const vecExpanded = allExpanded.filter(q => q.type !== 'lex');
  options?.hooks?.onExpand?.(query, vecExpanded, Date.now() - expandStart);

  const embedModel = store.embedModelName ?? DEFAULT_EMBED_MODEL_URI;
  const queryTexts = [query, ...vecExpanded.map(q => q.query)];
  const textsToEmbed = queryTexts.map(q => formatQueryForEmbedding(q, embedModel));
  const llm = getStoreLlm();
  const embeddings = await llm.embedBatch(textsToEmbed, { model: embedModel, isQuery: true });
  const allResults = new Map<string, VectorSearchResult>();
  const retrievalOptions: SearchResultOptions = { includeBody: false, includeContext: false };
  for (let i = 0; i < queryTexts.length; i++) {
    const embedding = embeddings[i]?.embedding;
    if (!embedding) continue;

    const vecResults = await store.searchVec(
      queryTexts[i]!,
      embedModel,
      limit,
      collection,
      undefined,
      embedding,
      undefined,
      retrievalOptions
    );
    for (const r of vecResults) {
      const existing = allResults.get(r.filepath);
      if (!existing || r.score > existing.score) {
        allResults.set(r.filepath, {
          file: r.filepath,
          displayPath: r.displayPath,
          title: r.title,
          body: "",
          score: r.score,
          context: null,
          docid: r.docid,
        });
      }
    }
  }

  const resolveContext = createContextResolver(store.db);
  const topResults = Array.from(allResults.values())
    .sort((a, b) => b.score - a.score)
    .filter(r => r.score >= minScore)
    .slice(0, limit);
  const hydrated = loadSearchDocumentsByFilepaths(store.db, topResults.map(result => result.file), resolveContext);

  return topResults.map(result => {
    const doc = hydrated.get(result.file);
    return {
      ...result,
      displayPath: doc?.displayPath || result.displayPath,
      title: doc?.title || result.title,
      body: doc?.body || "",
      context: doc?.context ?? null,
      docid: doc?.docid || result.docid,
    };
  });
}

// =============================================================================
// Structured Search
// =============================================================================

export async function structuredSearch(
  store: StoreQueryApi,
  searches: ExpandedQuery[],
  options?: StructuredSearchOptions
): Promise<HybridQueryResult[]> {
  const limit = options?.limit ?? 10;
  const minScore = options?.minScore ?? 0;
  const requestedCandidateLimit = options?.candidateLimit;
  const explain = options?.explain ?? false;
  const intent = options?.intent;
  const skipRerank = options?.skipRerank ?? false;
  const hooks = options?.hooks;
  const retrievalOptions: SearchResultOptions = { includeBody: false, includeContext: false };

  const collections = options?.collections;

  if (searches.length === 0) return [];

  // Validate queries
  for (const search of searches) {
    const location = search.line ? `Line ${search.line}` : 'Structured search';
    if (/[\r\n]/.test(search.query)) {
      throw new Error(`${location} (${search.type}): queries must be single-line. Remove newline characters.`);
    }
    if (search.type === 'lex') {
      const { validateLexQuery } = await import("./retrieval.js");
      const error = validateLexQuery(search.query);
      if (error) {
        throw new Error(`${location} (lex): ${error}`);
      }
    } else if (search.type === 'vec' || search.type === 'hyde') {
      const { validateSemanticQuery } = await import("./retrieval.js");
      const error = validateSemanticQuery(search.query);
      if (error) {
        throw new Error(`${location} (${search.type}): ${error}`);
      }
    }
  }

  const rankedLists: RankedResult[][] = [];
  const rankedListMeta: RankedListMeta[] = [];
  const docidMap = new Map<string, string>();
  const hasVectors = !!store.db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='vectors_vec'`
  ).get();

  const collectionList = collections ?? [undefined];

  // Step 1: FTS for lex searches
  for (const search of searches) {
    if (search.type === 'lex') {
      for (const coll of collectionList) {
        const ftsResults = store.searchFTS(search.query, 20, coll, retrievalOptions);
        if (ftsResults.length > 0) {
          for (const r of ftsResults) docidMap.set(r.filepath, r.docid);
          rankedLists.push(ftsResults.map(r => ({
            file: r.filepath, displayPath: r.displayPath,
            title: r.title, score: r.score,
          })));
          rankedListMeta.push({
            source: "fts",
            queryType: "lex",
            query: search.query,
          });
        }
      }
    }
  }

  // Step 2: Vector for vec/hyde searches
  if (hasVectors) {
    const vecSearches = searches.filter(
      (s): s is ExpandedQuery & { type: 'vec' | 'hyde' } =>
        s.type === 'vec' || s.type === 'hyde'
    );
    if (vecSearches.length > 0) {
      const embedModel = store.embedModelName ?? DEFAULT_EMBED_MODEL_URI;
      const textsToEmbed = vecSearches.map(s => formatQueryForEmbedding(s.query, embedModel));
      hooks?.onEmbedStart?.(textsToEmbed.length);
      const embedStart = Date.now();
      const llm = getStoreLlm(store.llm);
      const embeddings = await llm.embedBatch(textsToEmbed, { model: embedModel, isQuery: true });
      hooks?.onEmbedDone?.(Date.now() - embedStart);

      for (let i = 0; i < vecSearches.length; i++) {
        const embedding = embeddings[i]?.embedding;
        if (!embedding) continue;

        for (const coll of collectionList) {
          const vecResults = await store.searchVec(
            vecSearches[i]!.query, embedModel, 20, coll,
            undefined, embedding, undefined, retrievalOptions
          );
          if (vecResults.length > 0) {
            for (const r of vecResults) docidMap.set(r.filepath, r.docid);
            rankedLists.push(vecResults.map(r => ({
              file: r.filepath, displayPath: r.displayPath,
              title: r.title, score: r.score,
            })));
            rankedListMeta.push({
              source: "vec",
              queryType: vecSearches[i]!.type,
              query: vecSearches[i]!.query,
            });
          }
        }
      }
    }
  }

  if (rankedLists.length === 0) return [];

  // Step 3: RRF fusion
  const weights = rankedLists.map((_, i) => i === 0 ? 2.0 : 1.0);
  const fused = reciprocalRankFusion(rankedLists, weights);
  const rrfTraceByFile = explain ? buildRrfTrace(rankedLists, weights, rankedListMeta) : null;
  const candidateLimit = resolveAdaptiveCandidateLimit(fused, requestedCandidateLimit, limit);
  const candidates = fused.slice(0, candidateLimit);

  if (candidates.length === 0) return [];
  const resolveContext = createContextResolver(store.db);
  const hydratedCandidates = loadSearchDocumentsByFilepaths(store.db, candidates.map(candidate => candidate.file), resolveContext);

  hooks?.onExpand?.("", [], 0);

  // Step 4: Chunk documents
  const primaryQuery = searches.find(s => s.type === 'lex')?.query
    || searches.find(s => s.type === 'vec')?.query
    || searches[0]?.query || "";
  const queryTerms = primaryQuery.toLowerCase().split(/\s+/).filter(t => t.length > 2);
  const intentTerms = intent ? extractIntentTerms(intent) : [];
  const docChunkMap = new Map<string, ChunkSelection>();
  const candidateDocMap = new Map<string, { filepath: string; displayPath: string; title: string; hash: string; collectionName: string; modifiedAt: string; bodyLength: number; body: string; context: string | null; docid: string }>();
  const ssChunkStrategy = options?.chunkStrategy;

  for (const cand of candidates) {
    const hydrated = hydratedCandidates.get(cand.file);
    if (!hydrated) continue;
    candidateDocMap.set(cand.file, hydrated);
    const chunks = await chunkDocumentAsync(hydrated.body, undefined, undefined, undefined, cand.file, ssChunkStrategy);
    if (chunks.length === 0) continue;

    docChunkMap.set(cand.file, {
      chunks,
      rankedIndices: selectChunkIndicesForRerank(chunks, queryTerms, intentTerms),
    });
  }

  if (skipRerank) {
    const seenFiles = new Set<string>();
    return candidates
      .map((cand, i) => {
        const chunkInfo = docChunkMap.get(cand.file);
        const candidate = candidateDocMap.get(cand.file);
        const bestIdx = chunkInfo?.rankedIndices[0] ?? 0;
        const bestChunk = chunkInfo?.chunks[bestIdx]?.text || candidate?.body || "";
        const bestChunkPos = chunkInfo?.chunks[bestIdx]?.pos || 0;
        const rrfRank = i + 1;
        const rrfScore = 1 / rrfRank;
        const trace = rrfTraceByFile?.get(cand.file);
        const explainData: HybridQueryExplain | undefined = explain ? {
          ftsScores: trace?.contributions.filter(c => c.source === "fts").map(c => c.backendScore) ?? [],
          vectorScores: trace?.contributions.filter(c => c.source === "vec").map(c => c.backendScore) ?? [],
          rrf: {
            rank: rrfRank,
            positionScore: rrfScore,
            weight: 1.0,
            baseScore: trace?.baseScore ?? 0,
            topRankBonus: trace?.topRankBonus ?? 0,
            totalScore: trace?.totalScore ?? 0,
            contributions: trace?.contributions ?? [],
          },
          rerankScore: 0,
          blendedScore: rrfScore,
        } : undefined;

        return {
          file: cand.file,
          displayPath: candidate?.displayPath || cand.displayPath,
          title: candidate?.title || cand.title,
          body: candidate?.body || "",
          bestChunk,
          bestChunkPos,
          score: rrfScore,
          context: candidate?.context ?? null,
          docid: docidMap.get(cand.file) || "",
          ...(explainData ? { explain: explainData } : {}),
        };
      })
      .filter(r => {
        if (seenFiles.has(r.file)) return false;
        seenFiles.add(r.file);
        return true;
      })
      .filter(r => r.score >= minScore)
      .slice(0, limit);
  }

  // Step 5: Rerank
  const chunkCandidates: ChunkRerankCandidate[] = [];
  for (const cand of candidates) {
    const chunkInfo = docChunkMap.get(cand.file);
    if (!chunkInfo) continue;
    for (const idx of chunkInfo.rankedIndices) {
      const chunk = chunkInfo.chunks[idx];
      if (!chunk) continue;
      chunkCandidates.push({
        rerankId: `${cand.file}#${idx}`,
        docFile: cand.file,
        chunkIndex: idx,
        text: chunk.text,
        pos: chunk.pos,
      });
    }
  }

  hooks?.onRerankStart?.(chunkCandidates.length);
  const rerankStart2 = Date.now();
  const reranked = await store.rerank(
    primaryQuery,
    chunkCandidates.map((c) => ({ file: c.rerankId, text: c.text })),
    undefined,
    intent,
  );
  hooks?.onRerankDone?.(Date.now() - rerankStart2);

  const rerankCandidateById = new Map(chunkCandidates.map((c) => [c.rerankId, c]));
  const bestChunkByDoc = new Map<string, { score: number; chunk: ChunkRerankCandidate }>();
  for (const row of reranked) {
    const candidate = rerankCandidateById.get(row.file);
    if (!candidate) continue;
    const existing = bestChunkByDoc.get(candidate.docFile);
    if (!existing || row.score > existing.score) {
      bestChunkByDoc.set(candidate.docFile, { score: row.score, chunk: candidate });
    }
  }

  // Step 6: Blend RRF position with reranker
  const rrfRankMap = new Map(candidates.map((c, i) => [c.file, i + 1]));

  const blended = candidates.map(cand => {
    const rrfRank = rrfRankMap.get(cand.file) || candidateLimit;
    const bestChunk = bestChunkByDoc.get(cand.file);
    const rerankScore = bestChunk?.score ?? 0;
    let rrfWeight: number;
    if (rrfRank <= 3) rrfWeight = 0.75;
    else if (rrfRank <= 10) rrfWeight = 0.60;
    else rrfWeight = 0.40;
    const rrfScore = 1 / rrfRank;
    const blendedScore = rrfWeight * rrfScore + (1 - rrfWeight) * rerankScore;

    const candidate = candidateDocMap.get(cand.file);
    const chunkInfo = docChunkMap.get(cand.file);
    const bestIdx = bestChunk?.chunk.chunkIndex ?? chunkInfo?.rankedIndices[0] ?? 0;
    const bestChunkText = (bestChunk?.chunk.text ?? chunkInfo?.chunks[bestIdx]?.text) || candidate?.body || "";
    const bestChunkPos = (bestChunk?.chunk.pos ?? chunkInfo?.chunks[bestIdx]?.pos) || 0;
    const trace = rrfTraceByFile?.get(cand.file);
    const explainData: HybridQueryExplain | undefined = explain ? {
      ftsScores: trace?.contributions.filter(c => c.source === "fts").map(c => c.backendScore) ?? [],
      vectorScores: trace?.contributions.filter(c => c.source === "vec").map(c => c.backendScore) ?? [],
      rrf: {
        rank: rrfRank,
        positionScore: rrfScore,
        weight: rrfWeight,
        baseScore: trace?.baseScore ?? 0,
        topRankBonus: trace?.topRankBonus ?? 0,
        totalScore: trace?.totalScore ?? 0,
        contributions: trace?.contributions ?? [],
      },
      rerankScore,
      blendedScore,
    } : undefined;

    return {
      file: cand.file,
      displayPath: candidate?.displayPath || "",
      title: candidate?.title || "",
      body: candidate?.body || "",
      bestChunk: bestChunkText,
      bestChunkPos,
      score: blendedScore,
      context: candidate?.context ?? null,
      docid: docidMap.get(cand.file) || "",
      ...(explainData ? { explain: explainData } : {}),
    };
  }).sort((a, b) => b.score - a.score);

  // Step 7: Dedup
  const seenFiles = new Set<string>();
  return blended
    .filter(r => {
      if (seenFiles.has(r.file)) return false;
      seenFiles.add(r.file);
      return true;
    })
    .filter(r => r.score >= minScore)
    .slice(0, limit);
}
