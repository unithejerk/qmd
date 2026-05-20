/**
 * embedding-provider.ts - Remote embedding provider factory
 *
 * Creates an LLM implementation that talks to OpenAI-compatible /v1/embeddings
 * endpoint. Works with vLLM, Ollama, OpenAI, text-embeddings-inference, etc.
 *
 * This is a drop-in replacement for LlamaCpp that implements the same LLM interface.
 * Import and use in place of `new LlamaCpp()`:
 *
 *   const llm = await createRemoteLLM({ config });
 *
 * Phase 5: Per-endpoint config + real expand/rerank/generate via OpenRouter.
 */

import type {
  LLM,
  EmbeddingResult,
  EmbedOptions,
  GenerateResult,
  GenerateOptions,
  ModelInfo,
  Queryable,
  RerankResult,
  RerankDocument,
  RerankOptions,
} from './llm.js';

// =============================================================================
// Types
// =============================================================================

export type EndpointConfig = {
  baseUrl: string;
  model: string;
  apiKey?: string;
};

export type RemoteLLMConfig = {
  embed?: EndpointConfig;
  expand?: EndpointConfig;
  rerank?: EndpointConfig;
  generate?: EndpointConfig;

  /** Backward compat: old flat config fields treated as embed endpoint */
  baseUrl?: string;
  embedModel?: string;
  apiKey?: string;

  /** Max texts per batch request (default: 100) */
  maxBatchSize?: number;
  /** HTTP request timeout in ms (default: 30000) */
  timeoutMs?: number;
};

// =============================================================================
// Helpers
// =============================================================================

const OPENROUTER_DEFAULT_URL = 'https://openrouter.ai/api/v1';

/**
 * Workaround for Node.js undici ByteString bug with Unicode chars > 255.
 * Returns a Buffer so undici doesn't try to re-encode the string through its
 * broken ByteString path.
 */
function jsonBody(obj: unknown): Buffer {
  return Buffer.from(JSON.stringify(obj), 'utf-8');
}

/**
 * Resolve an EndpointConfig from env vars with fallback chain.
 */
function resolveEndpoint(
  _name: string,
  envSuffix: string,
  modelDefault: string,
  urlDefault: string,
): EndpointConfig {
  const baseUrl =
    (process.env[`QMD_${envSuffix}_BASE_URL`] || urlDefault).replace(/\/+$/, '');
  const model = process.env[`QMD_${envSuffix}_MODEL`] || modelDefault;
  const apiKey = process.env[`QMD_${envSuffix}_API_KEY`] || process.env.OPENAI_API_KEY;
  return { baseUrl, model, apiKey };
}

// =============================================================================
// RemoteLLM — implements the LLM interface via HTTP
// =============================================================================

export class RemoteLLM implements LLM {
  /** Embed endpoint config */
  readonly embedCfg: EndpointConfig;
  /** Query expansion endpoint config */
  readonly expandCfg: EndpointConfig;
  /** Rerank endpoint config */
  readonly rerankCfg: EndpointConfig;
  /** Text generation endpoint config */
  readonly generateCfg: EndpointConfig;

  readonly maxBatchSize: number;
  readonly timeoutMs: number;

  constructor(config: RemoteLLMConfig = {}) {
    // --- Backward compat: treat old flat config as embed endpoint ---
    const oldBaseUrl = config.baseUrl || process.env.OPENAI_BASE_URL;
    const oldModel = config.embedModel;
    const oldKey = config.apiKey;

    // --- Embed endpoint ---
    if (config.embed) {
      this.embedCfg = {
        baseUrl: config.embed.baseUrl.replace(/\/+$/, ''),
        model: config.embed.model,
        apiKey: config.embed.apiKey || process.env.OPENAI_API_KEY,
      };
    } else if (oldBaseUrl) {
      this.embedCfg = {
        baseUrl: oldBaseUrl.replace(/\/+$/, ''),
        model: oldModel || process.env.QMD_EMBED_MODEL || 'Qwen/Qwen3-Embedding-0.6B',
        apiKey: oldKey || process.env.OPENAI_API_KEY,
      };
    } else {
      this.embedCfg = resolveEndpoint('embed', 'EMBED', 'Qwen/Qwen3-Embedding-0.6B', 'http://localhost:11434/v1');
    }

    // --- Expand endpoint ---
    if (config.expand) {
      this.expandCfg = {
        baseUrl: config.expand.baseUrl.replace(/\/+$/, ''),
        model: config.expand.model,
        apiKey: config.expand.apiKey || process.env.OPENAI_API_KEY,
      };
    } else {
      this.expandCfg = resolveEndpoint('expand', 'EXPAND', 'google/gemini-2.0-flash-lite-001', OPENROUTER_DEFAULT_URL);
    }

    // --- Rerank endpoint ---
    if (config.rerank) {
      this.rerankCfg = {
        baseUrl: config.rerank.baseUrl.replace(/\/+$/, ''),
        model: config.rerank.model,
        apiKey: config.rerank.apiKey || process.env.OPENAI_API_KEY,
      };
    } else {
      this.rerankCfg = resolveEndpoint('rerank', 'RERANK', 'cohere/rerank-v3.5', OPENROUTER_DEFAULT_URL);
    }

    // --- Generate endpoint ---
    if (config.generate) {
      this.generateCfg = {
        baseUrl: config.generate.baseUrl.replace(/\/+$/, ''),
        model: config.generate.model,
        apiKey: config.generate.apiKey || process.env.OPENAI_API_KEY,
      };
    } else {
      this.generateCfg = resolveEndpoint('generate', 'GENERATE', 'google/gemini-2.0-flash-lite-001', OPENROUTER_DEFAULT_URL);
    }

    this.maxBatchSize = config.maxBatchSize || parseInt(process.env.QMD_EMBED_BATCH_SIZE || '100', 10);
    this.timeoutMs = config.timeoutMs || parseInt(process.env.QMD_EMBED_TIMEOUT || '30000', 10);
  }

  // =========================================================================
  // Model name getters
  // =========================================================================

  get embedModelName(): string {
    return this.embedCfg.model;
  }

  get generateModelName(): string | undefined {
    return this.expandCfg.model;
  }

  get rerankModelName(): string | undefined {
    return this.rerankCfg.model;
  }

  // =========================================================================
  // LLM interface: embed
  // =========================================================================

  async embed(text: string, options?: EmbedOptions): Promise<EmbeddingResult | null> {
    const results = await this.embedBatch([text], options);
    return results[0] ?? null;
  }

  async embedBatch(texts: string[], _options?: EmbedOptions): Promise<(EmbeddingResult | null)[]> {
    const results: (EmbeddingResult | null)[] = [];

    for (let i = 0; i < texts.length; i += this.maxBatchSize) {
      const batch = texts.slice(i, i + this.maxBatchSize);
      const batchResults = await this.embedWithRetry(batch);
      results.push(...batchResults);
    }

    return results;
  }

  private async embedWithRetry(texts: string[], retries = 3): Promise<(EmbeddingResult | null)[]> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
        };
        if (this.embedCfg.apiKey) {
          headers['Authorization'] = `Bearer ${this.embedCfg.apiKey}`;
        }

        const resp = await fetch(`${this.embedCfg.baseUrl}/embeddings`, {
          method: 'POST',
          headers,
          body: jsonBody({
            model: this.embedCfg.model,
            input: texts,
          }),
          signal: controller.signal,
        });

        clearTimeout(timeout);

        if (!resp.ok) {
          const errBody = await resp.text().catch(() => '');
          throw new Error(`Embedding API error ${resp.status}: ${errBody.slice(0, 200)}`);
        }

        const data = await resp.json() as {
          data: Array<{ embedding: number[]; index?: number }>;
        };

        return data.data.map((item) => ({
          embedding: item.embedding,
          model: this.embedCfg.model,
        }));

      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < retries - 1) {
          const delay = 1000 * Math.pow(2, attempt);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    console.error(`RemoteLLM: embedding failed after ${retries} retries:`, lastError?.message);
    return texts.map(() => null);
  }

  // =========================================================================
  // LLM interface: generate
  // =========================================================================

  async generate(prompt: string, _options?: GenerateOptions): Promise<GenerateResult | null> {
    try {
      const ep = this.generateCfg;
      const baseUrl = ep.baseUrl;

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (ep.apiKey) {
        headers['Authorization'] = `Bearer ${ep.apiKey}`;
      }

      const resp = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: jsonBody({
          model: ep.model,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: _options?.maxTokens ?? 1024,
          temperature: _options?.temperature ?? 0.7,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!resp.ok) {
        const errBody = await resp.text().catch(() => '');
        throw new Error(`Generate API error ${resp.status}: ${errBody.slice(0, 200)}`);
      }

      const data = await resp.json() as {
        choices: Array<{ message: { content: string } }>;
        model: string;
      };

      return {
        text: data.choices[0]?.message?.content ?? '',
        model: data.model || ep.model,
        done: true,
      };
    } catch (err) {
      console.error('RemoteLLM: generate failed:', err instanceof Error ? err.message : String(err));
      return null;
    }
  }

  // =========================================================================
  // LLM interface: modelExists
  // =========================================================================

  async modelExists(model: string): Promise<ModelInfo> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);

      const headers: Record<string, string> = {};
      if (this.embedCfg.apiKey) {
        headers['Authorization'] = `Bearer ${this.embedCfg.apiKey}`;
      }

      // Try the embed base URL's models endpoint (works for vLLM, OpenAI, etc.)
      const baseForModels = this.embedCfg.baseUrl.replace(/\/v1$/, '');
      const resp = await fetch(`${baseForModels}/models`, {
        headers,
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (resp.ok) {
        const data = await resp.json() as { data?: Array<{ id: string }> };
        if (data.data) {
          const exists = data.data.some((m: { id: string }) => m.id === model);
          return { name: model, exists };
        }
      }
    } catch {
      // Fall through — return exists: true as before
    }

    return { name: model, exists: true };
  }

  // =========================================================================
  // LLM interface: expandQuery
  // =========================================================================

  async expandQuery(query: string, options?: { context?: string; includeLexical?: boolean; intent?: string }): Promise<Queryable[]> {
    const ep = this.expandCfg;
    if (!ep.apiKey) {
      console.warn('RemoteLLM: expand endpoint has no API key, returning passthrough query');
      return [{ type: 'lex', text: query }];
    }

    const intent = options?.intent ? ` with intent: ${options.intent}` : '';
    const prompt = `Expand this search query for a document retrieval system${intent}.
Output ONLY three lines, nothing else, no markdown, no explanation:

lex: <keyword-focused variant>
vec: <semantically rephrased version>
hyde: <short hypothetical document passage>

Original query: "${query}"`;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

      const resp = await fetch(`${ep.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${ep.apiKey}`,
        },
        body: jsonBody({
          model: ep.model,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 600,
          temperature: 0.7,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!resp.ok) {
        const errBody = await resp.text().catch(() => '');
        throw new Error(`Expand API error ${resp.status}: ${errBody.slice(0, 200)}`);
      }

      const data = await resp.json() as {
        choices: Array<{ message: { content: string } }>;
      };

      const content = data.choices[0]?.message?.content ?? '';

      // Parse: find any line containing "lex:", "vec:", or "hyde:" anywhere in the text
      // (handles markdown wrapping, bold labels, etc.)
      const queryables: Queryable[] = [];
      const typeRegex = /(lex|vec|hyde)\s*[:.]\s*(.+?)(?:\n|$)/gi;
      let match;
      while ((match = typeRegex.exec(content)) !== null) {
        const type = match[1]?.toLowerCase() as 'lex' | 'vec' | 'hyde' | undefined;
        const raw = match[2];
        if (!type || !raw) continue;
        const text = raw.trim().replace(/\*\*/g, '').replace(/^"|"$/g, '');
        if (text && text.length > 3) {
          queryables.push({ type, text });
        }
      }

      if (queryables.length > 0) {
        return queryables;
      }

      // Parse failed — fall through
      console.warn('RemoteLLM: expand query response could not be parsed, using passthrough');
    } catch (err) {
      console.error('RemoteLLM: expandQuery failed:', err instanceof Error ? err.message : String(err));
    }

    return [{ type: 'lex', text: query }];
  }

  // =========================================================================
  // LLM interface: rerank
  // =========================================================================

  async rerank(query: string, documents: RerankDocument[], _options?: RerankOptions): Promise<RerankResult> {
    const ep = this.rerankCfg;
    if (!ep.apiKey) {
      console.warn('RemoteLLM: rerank endpoint has no API key, returning uniform scores');
      return {
        results: documents.map((doc, i) => ({ file: doc.file, score: 1.0, index: i })),
        model: ep.model,
      };
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

      const resp = await fetch(`${ep.baseUrl}/rerank`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${ep.apiKey}`,
        },
        body: jsonBody({
          model: ep.model,
          query,
          documents: documents.map(d => d.text),
          top_n: documents.length,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!resp.ok) {
        const errBody = await resp.text().catch(() => '');
        throw new Error(`Rerank API error ${resp.status}: ${errBody.slice(0, 200)}`);
      }

      const data = await resp.json() as {
        results: Array<{ index: number; relevance_score: number }>;
        model?: string;
      };

      return {
        results: data.results.map(r => ({
          index: r.index,
          score: r.relevance_score,
          file: documents[r.index]?.file ?? `doc-${r.index}`,
        })),
        model: data.model || ep.model,
      };
    } catch (err) {
      console.error('RemoteLLM: rerank failed:', err instanceof Error ? err.message : String(err));
      // Fall back to uniform scores
      return {
        results: documents.map((doc, i) => ({ file: doc.file, score: 1.0, index: i })),
        model: ep.model,
      };
    }
  }

  // =========================================================================
  // LLM interface: dispose
  // =========================================================================

  async dispose(): Promise<void> {
    // Nothing to clean up for HTTP client
  }

  // =========================================================================
  // Utility: health check / probe
  // =========================================================================

  /**
   * Verify the remote server is reachable and return embedding dimensions.
   * Useful at startup to catch misconfiguration early.
   */
  async probe(): Promise<{ ok: boolean; dimensions: number; error?: string }> {
    try {
      const result = await this.embed('dimension-probe');
      if (result) {
        return { ok: true, dimensions: result.embedding.length };
      }
      return { ok: false, dimensions: 0, error: 'Null result from probe' };
    } catch (err) {
      return { ok: false, dimensions: 0, error: String(err) };
    }
  }
}
