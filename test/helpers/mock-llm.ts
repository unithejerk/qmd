/**
 * MockLLM — Fake LLM implementation for tests that don't need real GGUF models.
 *
 * Implements the full LLM interface with deterministic, sensible defaults.
 * Inject via setDefaultLlamaCpp(new MockLLM()) in beforeAll, restore with
 * setDefaultLlamaCpp(null) in afterAll.
 */
import type {
  LLM,
  EmbeddingResult,
  EmbedOptions,
  GenerateResult,
  GenerateOptions,
  ModelInfo,
  Queryable,
  RerankDocument,
  RerankResult,
  RerankOptions,
} from "../../src/llm.js";

const DIM = 3;
const EMBED_MODEL = "mock-embed";
const GENERATE_MODEL = "mock-generate";
const RERANK_MODEL = "mock-rerank";

function makeVector(): number[] {
  return [0.1, 0.2, 0.3];
}

function tokenize(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 1));
}

function termOverlap(a: string, b: string): number {
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let overlap = 0;
  for (const t of ta) if (tb.has(t)) overlap++;
  return overlap / Math.max(ta.size, tb.size);
}

export class MockLLM implements LLM {
  readonly embedModelName = EMBED_MODEL;
  readonly generateModelName = GENERATE_MODEL;
  readonly rerankModelName = RERANK_MODEL;

  async embed(text: string, _options?: EmbedOptions): Promise<EmbeddingResult | null> {
    return { embedding: makeVector(), model: EMBED_MODEL };
  }

  async embedBatch(texts: string[], options?: EmbedOptions): Promise<(EmbeddingResult | null)[]> {
    return texts.map(() => ({ embedding: makeVector(), model: options?.model || EMBED_MODEL }));
  }

  async generate(prompt: string, _options?: GenerateOptions): Promise<GenerateResult | null> {
    return { text: `Generated response for: ${prompt.slice(0, 50)}`, model: GENERATE_MODEL, done: true };
  }

  async modelExists(model: string): Promise<ModelInfo> {
    return { name: model, exists: true };
  }

  async expandQuery(query: string, _options?: { context?: string; includeLexical?: boolean; intent?: string }): Promise<Queryable[]> {
    const includeLexical = _options?.includeLexical ?? true;
    const results: Queryable[] = [
      { type: 'hyde', text: `A document discussing ${query} in detail` },
      { type: 'vec', text: `information about ${query}` },
    ];
    if (includeLexical) {
      results.push({ type: 'lex', text: query });
    }
    return results;
  }

  async rerank(query: string, documents: RerankDocument[], _options?: RerankOptions): Promise<RerankResult> {
    const scored = documents.map((doc, i) => ({
      file: doc.file,
      score: termOverlap(query, doc.text) + (1 - i / (documents.length + 10)),
      index: i,
    }));
    scored.sort((a, b) => b.score - a.score);
    return { results: scored, model: RERANK_MODEL };
  }

  async dispose(): Promise<void> {
    // no-op
  }
}
