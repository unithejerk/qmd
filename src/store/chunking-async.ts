/**
 * Async chunking functions for document processing.
 *
 * Extracted from src/store.ts to reduce module size and clarify boundaries.
 *
 * This module provides:
 *  - chunkDocument:       sync regex-only chunking
 *  - chunkDocumentAsync:  async AST-aware chunking
 *  - chunkDocumentByTokens: token-count-based chunking with local or remote
 *                           tokenizer support, including cancellation
 */

import {
  CHUNK_SIZE_TOKENS,
  CHUNK_OVERLAP_TOKENS,
  CHUNK_SIZE_CHARS,
  CHUNK_OVERLAP_CHARS,
  CHUNK_WINDOW_TOKENS,
  CHUNK_WINDOW_CHARS,
  scanBreakPoints,
  findCodeFences,
  mergeBreakPoints,
  chunkDocumentWithBreakPoints,
  type ChunkStrategy,
} from "./chunking.js";
import {
  getDefaultLlamaCpp,
  isRemoteConfigured,
} from "../llm/singleton.js";
import { remoteConfigFromEnv } from "../remote/config.js";
import {
  remoteDetokenize,
  remoteTokenize,
  remoteTokenizerAvailable,
  resolveRemoteTokenizerMode,
  type RemoteTokenizerConfig,
} from "../remote/tokenizer.js";

/** One-time flag to avoid spamming the chunkDocumentByTokens remote-fallback warning. */
let _remoteChunkWarningShown = false;
let _remoteTokenizerWarningShown = false;

/**
 * Chunk a document using regex-only break point detection.
 * This is the sync, backward-compatible API used by tests and legacy callers.
 */
export function chunkDocument(
  content: string,
  maxChars: number = CHUNK_SIZE_CHARS,
  overlapChars: number = CHUNK_OVERLAP_CHARS,
  windowChars: number = CHUNK_WINDOW_CHARS
): { text: string; pos: number }[] {
  const breakPoints = scanBreakPoints(content);
  const codeFences = findCodeFences(content);
  return chunkDocumentWithBreakPoints(content, breakPoints, codeFences, maxChars, overlapChars, windowChars);
}

/**
 * Async AST-aware chunking. Detects language from filepath, computes AST
 * break points for supported code files, merges with regex break points,
 * and delegates to the shared chunk algorithm.
 *
 * Falls back to regex-only when strategy is "regex", filepath is absent,
 * or language is unsupported.
 */
export async function chunkDocumentAsync(
  content: string,
  maxChars: number = CHUNK_SIZE_CHARS,
  overlapChars: number = CHUNK_OVERLAP_CHARS,
  windowChars: number = CHUNK_WINDOW_CHARS,
  filepath?: string,
  chunkStrategy: ChunkStrategy = "regex",
): Promise<{ text: string; pos: number }[]> {
  const regexPoints = scanBreakPoints(content);
  const codeFences = findCodeFences(content);

  let breakPoints = regexPoints;
  if (chunkStrategy === "auto" && filepath) {
    const { getASTBreakPoints } = await import("../ast.js");
    const astPoints = await getASTBreakPoints(content, filepath);
    if (astPoints.length > 0) {
      breakPoints = mergeBreakPoints(regexPoints, astPoints);
    }
  }

  return chunkDocumentWithBreakPoints(content, breakPoints, codeFences, maxChars, overlapChars, windowChars);
}

/**
 * Chunk a document using the LLM tokenizer for accurate token-count boundaries.
 *
 * ## Local mode (default)
 *
 * Uses llama.cpp's tokenizer for exact token counts. More accurate than
 * character-based chunking. Requires a loaded local GGUF model.
 *
 * ## Remote mode (when isRemoteConfigured() returns true)
 *
 * Falls back to character-based chunking with a ~3 chars/token estimate.
 * **The returned token counts are estimates, not exact.** This is because
 * remote providers don't expose tokenizers. Chunks may be slightly larger
 * or smaller than maxTokens. If exact token limits matter, use a local
 * model or pre-chunk documents externally.
 *
 * ## AST-aware chunking
 *
 * When filepath and chunkStrategy are provided, uses tree-sitter AST
 * break points for supported code files (TypeScript, Python, Go). This
 * produces chunks aligned to function/class boundaries.
 *
 * @param content       - Raw document text
 * @param maxTokens     - Target max tokens per chunk (default CHUNK_SIZE_TOKENS)
 * @param overlapTokens - Overlap between consecutive chunks in tokens
 * @param windowTokens  - Window size for AST context analysis
 * @param filepath      - Optional file path for AST detection and language selection
 * @param chunkStrategy - "auto" (AST for code, regex otherwise) or "regex"
 * @param signal        - Optional AbortSignal for cancellation
 * @returns Array of chunks with text, byte position, and **estimated** token count
 */
export async function chunkDocumentByTokens(
  content: string,
  maxTokens: number = CHUNK_SIZE_TOKENS,
  overlapTokens: number = CHUNK_OVERLAP_TOKENS,
  windowTokens: number = CHUNK_WINDOW_TOKENS,
  filepath?: string,
  chunkStrategy: ChunkStrategy = "regex",
  signal?: AbortSignal
): Promise<{ text: string; pos: number; tokens: number }[]> {
  const resolveRemoteTokenizerConfig = (): RemoteTokenizerConfig | null => {
    const clean = (value: string | undefined): string => (value || '').trim().replace(/\/+$/, '');
    const envCfg = remoteConfigFromEnv().embed;

    const overrideBaseUrl = clean(process.env.QMD_TOKENIZER_BASE_URL);
    const overrideModel = (process.env.QMD_TOKENIZER_MODEL || '').trim();
    const overrideApiKey = (process.env.QMD_TOKENIZER_API_KEY || process.env.OPENAI_API_KEY || '').trim();

    const envBaseUrl = clean(envCfg?.baseUrl);
    const envModel = (envCfg?.model || '').trim();
    const envApiKey = (envCfg?.apiKey || '').trim();

    let baseUrl = overrideBaseUrl || envBaseUrl;
    let model = overrideModel || envModel;
    let apiKey = overrideApiKey || envApiKey;

    // YAML-only remote setup may not populate env vars. In that case, attempt
    // to read endpoint config from the currently injected RemoteLLM instance.
    const defaultLlmUnknown = getDefaultLlamaCpp() as unknown as {
      embedCfg?: { baseUrl?: string; model?: string; apiKey?: string };
    };
    const embedCfg = defaultLlmUnknown?.embedCfg;
    if ((!baseUrl || !model) && embedCfg) {
      baseUrl = baseUrl || clean(embedCfg.baseUrl);
      model = model || (embedCfg.model || '').trim();
      apiKey = apiKey || (embedCfg.apiKey || '').trim();
    }

    if (!baseUrl || !model) return null;
    return { baseUrl, model, apiKey };
  };

  const fallbackCharChunking = async (reason: string): Promise<{ text: string; pos: number; tokens: number }[]> => {
    if (!_remoteChunkWarningShown) {
      console.warn(
        `Remote tokenizer unavailable (${reason}) — chunkDocumentByTokens using character-based chunking ` +
        'with estimated token counts (~3 chars/token). Token counts are approximate.'
      );
      _remoteChunkWarningShown = true;
    }
    const avgCharsPerToken = 3;
    const maxChars = maxTokens * avgCharsPerToken;
    const overlapChars = overlapTokens * avgCharsPerToken;
    const windowChars = windowTokens * avgCharsPerToken;
    const charChunks = await chunkDocumentAsync(content, maxChars, overlapChars, windowChars, filepath, chunkStrategy);
    return charChunks.map(chunk => ({
      text: chunk.text,
      pos: chunk.pos,
      tokens: Math.ceil(chunk.text.length / avgCharsPerToken),
    }));
  };

  const hasLocalTokenizerApi = (candidate: unknown): candidate is {
    tokenize: (text: string) => Promise<readonly unknown[]>;
    detokenize: (tokens: readonly unknown[]) => Promise<string>;
  } => (
    !!candidate
    && typeof candidate === 'object'
    && typeof (candidate as { tokenize?: unknown }).tokenize === 'function'
    && typeof (candidate as { detokenize?: unknown }).detokenize === 'function'
  );

  const tokenizerMode = resolveRemoteTokenizerMode();
  const defaultLlm = getDefaultLlamaCpp();
  const remoteMode = isRemoteConfigured() || !hasLocalTokenizerApi(defaultLlm as unknown);

  if (remoteMode) {
    if (tokenizerMode === 'off') {
      return fallbackCharChunking('QMD_REMOTE_TOKENIZER=off');
    }

    const remoteTokenizerCfg = resolveRemoteTokenizerConfig();
    if (!remoteTokenizerCfg) {
      if (tokenizerMode === 'force') {
        throw new Error(
          'QMD_REMOTE_TOKENIZER=force is set, but remote tokenizer config is missing. ' +
          'Set QMD_TOKENIZER_BASE_URL/QMD_TOKENIZER_MODEL or QMD_EMBED_BASE_URL/QMD_EMBED_MODEL.'
        );
      }
      return fallbackCharChunking('remote tokenizer config missing');
    }

    const available = await remoteTokenizerAvailable(remoteTokenizerCfg);
    if (!available) {
      if (tokenizerMode === 'force') {
        throw new Error(
          `QMD_REMOTE_TOKENIZER=force is set, but tokenizer endpoint is unavailable at ${remoteTokenizerCfg.baseUrl}.`
        );
      }
      return fallbackCharChunking('tokenizer endpoint unavailable');
    }

    if (!_remoteTokenizerWarningShown) {
      console.warn(
        `Remote tokenizer enabled — chunkDocumentByTokens using ${remoteTokenizerCfg.baseUrl}/tokenize ` +
        'and /detokenize for exact token limits.'
      );
      _remoteTokenizerWarningShown = true;
    }

    const avgCharsPerToken = 3;
    const maxChars = maxTokens * avgCharsPerToken;
    const overlapChars = overlapTokens * avgCharsPerToken;
    const windowChars = windowTokens * avgCharsPerToken;

    const charChunks = await chunkDocumentAsync(content, maxChars, overlapChars, windowChars, filepath, chunkStrategy);
    const results: { text: string; pos: number; tokens: number }[] = [];
    const clampOverlapChars = (value: number, maxCharsValue: number): number => {
      if (maxCharsValue <= 1) return 0;
      return Math.max(0, Math.min(maxCharsValue - 1, Math.floor(value)));
    };

    const pushChunkWithinTokenLimit = async (text: string, pos: number): Promise<void> => {
      if (signal?.aborted) return;

      const tokens = await remoteTokenize(remoteTokenizerCfg, text);
      if (tokens.length <= maxTokens || text.length <= 1) {
        results.push({ text, pos, tokens: tokens.length });
        return;
      }

      const actualCharsPerToken = text.length / tokens.length;
      let safeMaxChars = Math.floor(maxTokens * actualCharsPerToken * 0.95);
      if (!Number.isFinite(safeMaxChars) || safeMaxChars < 1) {
        safeMaxChars = Math.floor(text.length / 2);
      }
      safeMaxChars = Math.max(1, Math.min(text.length - 1, safeMaxChars));

      let nextOverlapChars = clampOverlapChars(
        overlapChars * actualCharsPerToken / 2,
        safeMaxChars,
      );
      let nextWindowChars = Math.max(0, Math.floor(windowChars * actualCharsPerToken / 2));
      let subChunks = chunkDocument(text, safeMaxChars, nextOverlapChars, nextWindowChars);

      if (
        subChunks.length <= 1
        || subChunks[0]?.text.length === text.length
      ) {
        safeMaxChars = Math.max(1, Math.floor(text.length / 2));
        nextOverlapChars = 0;
        nextWindowChars = 0;
        subChunks = chunkDocument(text, safeMaxChars, nextOverlapChars, nextWindowChars);
      }

      if (
        subChunks.length <= 1
        || subChunks[0]?.text.length === text.length
      ) {
        const fallbackTokens = tokens.slice(0, Math.max(1, maxTokens));
        const truncatedText = await remoteDetokenize(remoteTokenizerCfg, fallbackTokens);
        results.push({
          text: truncatedText,
          pos,
          tokens: fallbackTokens.length,
        });
        return;
      }

      for (const subChunk of subChunks) {
        await pushChunkWithinTokenLimit(
          text.slice(subChunk.pos, subChunk.pos + subChunk.text.length),
          pos + subChunk.pos,
        );
      }
    };

    for (const chunk of charChunks) {
      await pushChunkWithinTokenLimit(chunk.text, chunk.pos);
    }
    return results;
  }

  const llm = defaultLlm;

  // Use moderate chars/token estimate (prose ~4, code ~2, mixed ~3)
  // If chunks exceed limit, they'll be re-split with actual ratio
  const avgCharsPerToken = 3;
  const maxChars = maxTokens * avgCharsPerToken;
  const overlapChars = overlapTokens * avgCharsPerToken;
  const windowChars = windowTokens * avgCharsPerToken;

  // Chunk in character space with conservative estimate
  // Use AST-aware chunking for the first pass when filepath/strategy provided
  let charChunks = await chunkDocumentAsync(content, maxChars, overlapChars, windowChars, filepath, chunkStrategy);

  // Tokenize and split any chunks that still exceed limit
  const results: { text: string; pos: number; tokens: number }[] = [];
  const clampOverlapChars = (value: number, maxChars: number): number => {
    if (maxChars <= 1) return 0;
    return Math.max(0, Math.min(maxChars - 1, Math.floor(value)));
  };

  const pushChunkWithinTokenLimit = async (text: string, pos: number): Promise<void> => {
    if (signal?.aborted) return;

    const tokens = await llm.tokenize(text);
    if (tokens.length <= maxTokens || text.length <= 1) {
      results.push({ text, pos, tokens: tokens.length });
      return;
    }

    const actualCharsPerToken = text.length / tokens.length;
    let safeMaxChars = Math.floor(maxTokens * actualCharsPerToken * 0.95);
    if (!Number.isFinite(safeMaxChars) || safeMaxChars < 1) {
      safeMaxChars = Math.floor(text.length / 2);
    }
    safeMaxChars = Math.max(1, Math.min(text.length - 1, safeMaxChars));

    let nextOverlapChars = clampOverlapChars(
      overlapChars * actualCharsPerToken / 2,
      safeMaxChars,
    );
    let nextWindowChars = Math.max(0, Math.floor(windowChars * actualCharsPerToken / 2));
    let subChunks = chunkDocument(text, safeMaxChars, nextOverlapChars, nextWindowChars);

    // Pathological single-line blobs can produce no meaningful breakpoint progress.
    // Fall back to a simple half split so every recursion step strictly shrinks.
    if (
      subChunks.length <= 1
      || subChunks[0]?.text.length === text.length
    ) {
      safeMaxChars = Math.max(1, Math.floor(text.length / 2));
      nextOverlapChars = 0;
      nextWindowChars = 0;
      subChunks = chunkDocument(text, safeMaxChars, nextOverlapChars, nextWindowChars);
    }

    if (
      subChunks.length <= 1
      || subChunks[0]?.text.length === text.length
    ) {
      const fallbackTokens = tokens.slice(0, Math.max(1, maxTokens));
      const truncatedText = await llm.detokenize(fallbackTokens);
      results.push({
        text: truncatedText,
        pos,
        tokens: fallbackTokens.length,
      });
      return;
    }

    for (const subChunk of subChunks) {
      await pushChunkWithinTokenLimit(text.slice(subChunk.pos, subChunk.pos + subChunk.text.length), pos + subChunk.pos);
    }
  };

  for (const chunk of charChunks) {
    await pushChunkWithinTokenLimit(chunk.text, chunk.pos);
  }

  return results;
}
