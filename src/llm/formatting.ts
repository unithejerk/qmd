/**
 * Detect if a model URI uses the Qwen3-Embedding format.
 * Qwen3-Embedding uses a different prompting style than nomic/embeddinggemma.
 */
export function isQwen3EmbeddingModel(modelUri: string): boolean {
  return /qwen.*embed/i.test(modelUri) || /embed.*qwen/i.test(modelUri);
}

/**
 * Detect if a model URI refers to a remote API model (not a local GGUF model).
 * Remote models handle their own prompt formatting, so no prefixes should be added.
 * Returns true for model names that don't start with "hf:" and don't end in ".gguf".
 */
export function isRemoteModel(modelUri: string): boolean {
  // Local models use hf: URIs (HuggingFace) or local file paths ending in .gguf
  return !modelUri.startsWith("hf:") && !modelUri.endsWith(".gguf");
}

export function formatQueryForEmbeddingWithModel(query: string, modelUri: string): string {
  if (isRemoteModel(modelUri)) return query;
  if (isQwen3EmbeddingModel(modelUri)) {
    return `Instruct: Retrieve relevant documents for the given query\nQuery: ${query}`;
  }
  return `task: search result | query: ${query}`;
}

export function formatDocForEmbeddingWithModel(text: string, title: string | undefined, modelUri: string): string {
  if (isRemoteModel(modelUri)) return title ? `${title}\n${text}` : text;
  if (isQwen3EmbeddingModel(modelUri)) {
    // Qwen3-Embedding: documents are raw text, no task prefix
    return title ? `${title}\n${text}` : text;
  }
  return `title: ${title || "none"} | text: ${text}`;
}
