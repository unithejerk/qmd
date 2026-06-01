/**
 * store/infrastructure.test.ts - Tests for embedding formatting, caching, collections,
 * reindex, index status, and embedding batching
 *
 * Run with: bun test store/infrastructure.test.ts
 */

import { describe, test, expect, beforeAll, afterAll, vi } from "vitest";
import { createStore, generateEmbeddings } from "../../src/store.js";
import type { Store, CollectionConfig, SearchResult } from "../../src/store.js";
import type { Database } from "../../src/db.js";
import { unlink, mkdtemp, rmdir, writeFile, mkdir, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { getCacheKey } from "../../src/store/cache.js";
import { syncConfigToDb } from "../../src/store/config-sync.js";
import { reindexCollection } from "../../src/store/reindex.js";
import { getEmbeddingFingerprint, getHashesNeedingEmbedding } from "../../src/store/embedding-pipeline.js";
import { getIndexHealth } from "../../src/store/cleanup.js";
import { formatQueryForEmbedding, formatDocForEmbedding } from "../../src/llm.js";
import { hybridQuery, vectorSearchQuery, structuredSearch } from "../../src/store/query-engine.js";
import * as llmModule from "../../src/llm.js";
import { disposeDefaultLlamaCpp, setDefaultLlamaCpp } from "../../src/llm.js";

// =============================================================================
// Test Utilities (copied from store.test.ts)
// =============================================================================

let testDir: string;
let testDbPath: string;
let testConfigDir: string;
let currentTestStore: Store | null = null;

async function createTestStore(): Promise<Store> {
  testDbPath = join(testDir, `test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);

  // Set up test config directory
  const configPrefix = join(testDir, `config-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  testConfigDir = await mkdtemp(configPrefix);

  // Set environment variable to use test config
  process.env.QMD_CONFIG_DIR = testConfigDir;

  // Create empty YAML config
  const emptyConfig: CollectionConfig = { collections: {} };
  await writeFile(
    join(testConfigDir, "index.yml"),
    YAML.stringify(emptyConfig)
  );

  const store = createStore(testDbPath);
  currentTestStore = store;
  return store;
}

async function cleanupTestDb(store: Store): Promise<void> {
  currentTestStore = null;
  store.close();
  try {
    await unlink(store.dbPath);
  } catch {
    // Ignore if file doesn't exist
  }

  // Clean up test config directory
  try {
    const { readdir, unlink: unlinkFile, rmdir: rmdirAsync } = await import("node:fs/promises");
    const files = await readdir(testConfigDir);
    for (const file of files) {
      await unlinkFile(join(testConfigDir, file));
    }
    await rmdirAsync(testConfigDir);
  } catch {
    // Ignore cleanup errors
  }

  // Clear environment variable
  delete process.env.QMD_CONFIG_DIR;
}

// Helper to insert a test document directly into the database
async function insertTestDocument(
  db: Database,
  collectionName: string,
  opts: {
    name?: string;
    title?: string;
    hash?: string;
    displayPath?: string;
    filepath?: string;
    body?: string;
    active?: number;
  }
): Promise<number> {
  const now = new Date().toISOString();
  const name = opts.name || "test-doc";
  const title = opts.title || "Test Document";

  // Use displayPath if provided, otherwise filepath's basename, otherwise default
  let path: string;
  if (opts.displayPath) {
    path = opts.displayPath;
  } else if (opts.filepath) {
    // Extract relative path from filepath by removing collection path
    // For tests, assume filepath is either relative or we want the whole path as the document path
    path = opts.filepath.startsWith('/') ? opts.filepath : opts.filepath;
  } else {
    path = `test/${name}.md`;
  }

  const body = opts.body || "# Test Document\n\nThis is test content.";
  const active = opts.active ?? 1;

  // Generate hash from body if not provided
  const hash = opts.hash || await hashContent(body);

  // Insert content (with OR IGNORE for deduplication)
  insertContent(db, hash, body, now);

  insertDocument(db, collectionName, path, title, hash, now, now);
  const row = db.prepare(`
    SELECT id FROM documents WHERE collection = ? AND path = ?
  `).get(collectionName, path) as { id: number } | undefined;

  if (active === 0 && row) {
    db.prepare(`UPDATE documents SET active = 0 WHERE id = ?`).run(row.id);
  }

  return row?.id ?? 0;
}

/** Sync YAML config file to SQLite store_collections in the current test store */
async function syncTestConfig(): Promise<void> {
  if (!currentTestStore) return;
  const configPath = join(testConfigDir, "index.yml");
  const { readFile } = await import("node:fs/promises");
  const content = await readFile(configPath, "utf-8");
  const config = YAML.parse(content) as CollectionConfig;
  // Clear config hash to force re-sync
  currentTestStore.db.prepare(`DELETE FROM store_config WHERE key = 'config_hash'`).run();
  syncConfigToDb(currentTestStore.db, config);
}

// Helper to create a test collection in YAML config
async function createTestCollection(
  options: { pwd?: string; glob?: string; name?: string } = {}
): Promise<string> {
  const pwd = options.pwd || "/test/collection";
  const glob = options.glob || "**/*.md";
  const name = options.name || pwd.split('/').filter(Boolean).pop() || 'test';

  // Read current config
  const configPath = join(testConfigDir, "index.yml");
  const { readFile } = await import("node:fs/promises");
  const content = await readFile(configPath, "utf-8");
  const config = YAML.parse(content) as CollectionConfig;

  // Add collection
  config.collections[name] = {
    path: pwd,
    pattern: glob,
  };

  // Write back
  await writeFile(configPath, YAML.stringify(config));
  await syncTestConfig();
  return name;
}

// =============================================================================
// Test Setup
// =============================================================================

beforeAll(async () => {
  testDir = await mkdtemp(join(tmpdir(), "qmd-test-"));
});

afterAll(async () => {
  // Ensure native resources are released to avoid ggml-metal asserts on process exit.
  await disposeDefaultLlamaCpp();

  try {
    // Clean up test directory
    const { readdir, unlink } = await import("node:fs/promises");
    const files = await readdir(testDir);
    for (const file of files) {
      await unlink(join(testDir, file));
    }
    await rmdir(testDir);
  } catch {
    // Ignore cleanup errors
  }
});

// =============================================================================
// Embedding Format Tests
// =============================================================================

describe("Embedding Formatting", () => {
  test("formatQueryForEmbedding adds search task prefix", () => {
    const formatted = formatQueryForEmbedding("how to deploy");
    expect(formatted).toBe("task: search result | query: how to deploy");
  });

  test("formatDocForEmbedding adds title and text prefix", () => {
    const formatted = formatDocForEmbedding("Some content", "My Title");
    expect(formatted).toBe("title: My Title | text: Some content");
  });

  test("formatDocForEmbedding handles missing title", () => {
    const formatted = formatDocForEmbedding("Some content");
    expect(formatted).toBe("title: none | text: Some content");
  });
});

// =============================================================================
// Caching Tests
// =============================================================================

describe("Caching", () => {
  test("getCacheKey generates consistent keys", () => {
    const key1 = getCacheKey("http://example.com", { query: "test" });
    const key2 = getCacheKey("http://example.com", { query: "test" });
    expect(key1).toBe(key2);
    expect(key1).toMatch(/^[a-f0-9]{64}$/);
  });

  test("getCacheKey generates different keys for different inputs", () => {
    const key1 = getCacheKey("http://example.com", { query: "test1" });
    const key2 = getCacheKey("http://example.com", { query: "test2" });
    expect(key1).not.toBe(key2);
  });

  test("store cache operations work correctly", async () => {
    const store = await createTestStore();

    const key = "test-cache-key";
    const value = "cached result";

    // Initially empty
    expect(store.getCachedResult(key)).toBeNull();

    // Set cache
    store.setCachedResult(key, value);

    // Retrieve cache
    expect(store.getCachedResult(key)).toBe(value);

    // Clear cache
    store.clearCache();
    expect(store.getCachedResult(key)).toBeNull();

    await cleanupTestDb(store);
  });
});

// =============================================================================
// Collection Tests
// =============================================================================

describe("Collections", () => {
  test("collections are managed via YAML config", async () => {
    const store = await createTestStore();
    const collectionName = await createTestCollection({ pwd: "/home/user/projects/myapp", glob: "**/*.md" });

    // Collections are now in YAML, not in the database
    expect(collectionName).toBe("myapp");

    await cleanupTestDb(store);
  });
});

// =============================================================================
// Reindex Collection Tests
// =============================================================================

describe("Reindex Collection", () => {
  test("stores source metadata so unchanged files can be skipped on later runs", async () => {
    const store = await createTestStore();
    const collectionName = "docs";
    const collectionPath = join(testDir, `incremental-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(collectionPath, { recursive: true });

    const filepath = join(collectionPath, "note.md");
    await writeFile(filepath, "# Incremental\n\nSame content");

    const firstResult = await reindexCollection(store, collectionPath, "**/*.md", collectionName);
    expect(firstResult.indexed).toBe(1);

    const firstRow = store.db.prepare(`
      SELECT source_mtime_ms, source_size
      FROM documents
      WHERE collection = ? AND path = ?
    `).get(collectionName, "note.md") as { source_mtime_ms: number; source_size: number };
    expect(firstRow.source_mtime_ms).toBeGreaterThan(0);
    expect(firstRow.source_size).toBeGreaterThan(0);

    const secondResult = await reindexCollection(store, collectionPath, "**/*.md", collectionName);
    expect(secondResult).toMatchObject({ indexed: 0, updated: 0, unchanged: 1, removed: 0 });

    await cleanupTestDb(store);
  });

  test("preserves document id and embeddings when file path changes only by case", async () => {
    const store = await createTestStore();
    const collectionName = "docs";
    const collectionPath = join(testDir, `case-rename-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(collectionPath, { recursive: true });

    const originalPath = join(collectionPath, "README.md");
    const renamedPath = join(collectionPath, "readme.md");
    const body = "# Case Rename\n\nContent that should keep the same embedding.";
    await writeFile(originalPath, body);

    const firstResult = await reindexCollection(store, collectionPath, "**/*.md", collectionName);
    expect(firstResult.indexed).toBe(1);

    const before = store.db.prepare(`
      SELECT id, path, hash FROM documents
      WHERE collection = ? AND active = 1
    `).get(collectionName) as { id: number; path: string; hash: string };
    expect(before.path).toBe("README.md");

    store.db.prepare(`
      INSERT INTO content_vectors (hash, seq, pos, model, embedded_at)
      VALUES (?, 0, 0, 'test-model', ?)
    `).run(before.hash, new Date().toISOString());

    await rename(originalPath, renamedPath);

    const secondResult = await reindexCollection(store, collectionPath, "**/*.md", collectionName);
    expect(secondResult.indexed).toBe(0);
    expect(secondResult.unchanged).toBe(1);
    expect(secondResult.removed).toBe(0);

    const afterRows = store.db.prepare(`
      SELECT id, path, hash, active FROM documents
      WHERE collection = ?
      ORDER BY id
    `).all(collectionName) as { id: number; path: string; hash: string; active: number }[];
    expect(afterRows).toHaveLength(1);
    expect(afterRows[0]).toMatchObject({ id: before.id, path: "readme.md", hash: before.hash, active: 1 });

    const vectorCount = store.db.prepare(`
      SELECT COUNT(*) AS count FROM content_vectors WHERE hash = ?
    `).get(before.hash) as { count: number };
    expect(vectorCount.count).toBe(1);

    const ftsRows = store.db.prepare(`
      SELECT rowid, filepath FROM documents_fts WHERE rowid = ?
    `).all(before.id) as { rowid: number; filepath: string }[];
    expect(ftsRows).toEqual([{ rowid: before.id, filepath: "docs/readme.md" }]);

    await cleanupTestDb(store);
  });
});

// =============================================================================
// Index Status Tests
// =============================================================================

describe("Index Status", () => {
  test("getStatus returns correct structure", async () => {
    const store = await createTestStore();
    const status = store.getStatus();
    expect(status).toHaveProperty("totalDocuments");
    expect(status).toHaveProperty("needsEmbedding");
    expect(status).toHaveProperty("hasVectorIndex");
    expect(status).toHaveProperty("collections");
    expect(Array.isArray(status.collections)).toBe(true);

    await cleanupTestDb(store);
  });

  test("getStatus counts documents correctly", async () => {
    const store = await createTestStore();
    const collectionName = await createTestCollection();

    await insertTestDocument(store.db, collectionName, { name: "doc1", active: 1 });
    await insertTestDocument(store.db, collectionName, { name: "doc2", active: 1 });
    await insertTestDocument(store.db, collectionName, { name: "doc3", active: 0 }); // inactive

    const status = store.getStatus();
    expect(status.totalDocuments).toBe(2); // Only active docs

    await cleanupTestDb(store);
  });

  test("getStatus reports collection info", async () => {
    const store = await createTestStore();
    const collectionName = await createTestCollection({ pwd: "/test/path", glob: "**/*.md" });
    await insertTestDocument(store.db, collectionName, { name: "doc1" });

    const status = store.getStatus();
    expect(status.collections.length).toBeGreaterThanOrEqual(1);
    const col = status.collections.find(c => c.name === collectionName);
    expect(col).toBeDefined();
    expect(col?.path).toBe("/test/path");
    expect(col?.pattern).toBe("**/*.md");
    expect(col?.documents).toBe(1);

    await cleanupTestDb(store);
  });

  test("getHashesNeedingEmbedding counts correctly", async () => {
    const store = await createTestStore();
    const collectionName = await createTestCollection();

    // Add documents with different hashes
    await insertTestDocument(store.db, collectionName, { name: "doc1", hash: "hash1" });
    await insertTestDocument(store.db, collectionName, { name: "doc2", hash: "hash2" });
    await insertTestDocument(store.db, collectionName, { name: "doc3", hash: "hash1" }); // same hash as doc1

    const needsEmbedding = store.getHashesNeedingEmbedding();
    expect(needsEmbedding).toBe(2); // hash1 and hash2

    await cleanupTestDb(store);
  });

  test("embedding health is scoped to the active embed model", async () => {
    const store = await createTestStore();
    const collectionName = await createTestCollection();
    const activeModel = "hf:active/embed-model.gguf";
    const staleModel = "hf:stale/embed-model.gguf";
    const now = new Date().toISOString();

    store.llm = { embedModelName: activeModel } as any;
    store.ensureVecTable(3);
    await insertTestDocument(store.db, collectionName, { name: "doc1", hash: "hash1" });
    store.insertEmbedding("hash1", 0, 0, new Float32Array([1, 2, 3]), staleModel, now, 1);

    expect(store.getHashesNeedingEmbedding()).toBe(1);
    expect(store.getStatus().needsEmbedding).toBe(1);
    expect(store.getIndexHealth().needsEmbedding).toBe(1);
    expect(store.getHashesNeedingEmbedding(staleModel)).toBe(0);

    await cleanupTestDb(store);
  });

  test("embedding health treats stale fingerprints as needing re-embedding", async () => {
    const store = await createTestStore();
    const collectionName = await createTestCollection();
    const model = "hf:test/embed-model.gguf";
    const now = new Date().toISOString();

    store.llm = { embedModelName: model } as any;
    store.ensureVecTable(3);
    await insertTestDocument(store.db, collectionName, { name: "doc1", hash: "hash1" });
    store.insertEmbedding("hash1", 0, 0, new Float32Array([1, 2, 3]), model, now, 1, "stale1");

    expect(getEmbeddingFingerprint(model)).toMatch(/^[a-f0-9]{6}$/);
    expect(store.getHashesNeedingEmbedding()).toBe(1);

    await cleanupTestDb(store);
  });

  test("getIndexHealth returns health info", async () => {
    const store = await createTestStore();
    const collectionName = await createTestCollection();
    await insertTestDocument(store.db, collectionName, { name: "doc1" });

    const health = store.getIndexHealth();
    expect(health).toHaveProperty("needsEmbedding");
    expect(health).toHaveProperty("totalDocs");
    expect(health).toHaveProperty("daysStale");
    expect(health.totalDocs).toBe(1);

    await cleanupTestDb(store);
  });
});

// =============================================================================
// Embedding batching tests
// =============================================================================

describe("Embedding batching", () => {
  function createFakeTokenizer() {
    return {
      async tokenize(text: string) {
        return new Array(Math.max(1, Math.ceil(text.length / 16))).fill(1);
      },
    };
  }

  function createFakeEmbedLlm() {
    const embedBatchCalls: string[][] = [];
    const embedCalls: { text: string; options?: { model?: string } }[] = [];
    const embedBatchModelCalls: ({ model?: string } | undefined)[] = [];
    return {
      embedBatchCalls,
      embedCalls,
      embedBatchModelCalls,
      async embed(text: string, options?: { model?: string }) {
        embedCalls.push({ text, options });
        return { embedding: [0.1, 0.2, 0.3], model: "fake-embed" };
      },
      async embedBatch(texts: string[], options?: { model?: string }) {
        embedBatchCalls.push([...texts]);
        embedBatchModelCalls.push(options);
        return texts.map((_text, index) => ({
          embedding: [index + 1, index + 2, index + 3],
          model: "fake-embed",
        }));
      },
    };
  }

  test("generateEmbeddings flushes batches when maxDocsPerBatch is reached", async () => {
    const store = await createTestStore();
    const db = store.db;
    const fakeLlm = createFakeEmbedLlm();

    setDefaultLlamaCpp(createFakeTokenizer() as any);
    store.llm = fakeLlm as any;

    try {
      await insertTestDocument(db, "docs", { name: "one", body: "# One\n\nAlpha" });
      await insertTestDocument(db, "docs", { name: "two", body: "# Two\n\nBeta" });
      await insertTestDocument(db, "docs", { name: "three", body: "# Three\n\nGamma" });

      const result = await generateEmbeddings(store, {
        maxDocsPerBatch: 1,
        maxBatchBytes: 1024 * 1024,
      });

      expect(fakeLlm.embedBatchCalls).toHaveLength(3);
      expect(fakeLlm.embedBatchCalls.map(call => call.length)).toEqual([1, 1, 1]);
      expect(result.docsProcessed).toBe(3);
      expect(result.chunksEmbedded).toBe(3);
      expect(db.prepare(`SELECT COUNT(*) as count FROM content_vectors`).get()).toEqual({ count: 3 });
    } finally {
      setDefaultLlamaCpp(null);
      await cleanupTestDb(store);
    }
  });

  test("generateEmbeddings flushes batches when maxBatchBytes is reached", async () => {
    const store = await createTestStore();
    const db = store.db;
    const fakeLlm = createFakeEmbedLlm();

    setDefaultLlamaCpp(createFakeTokenizer() as any);
    store.llm = fakeLlm as any;

    const docOne = "# One\n\n" + "A".repeat(36);
    const docTwo = "# Two\n\n" + "B".repeat(36);
    const docThree = "# Three\n\n" + "C".repeat(36);
    const batchLimit = new TextEncoder().encode(docOne).length
      + new TextEncoder().encode(docTwo).length
      + 1;

    try {
      await insertTestDocument(db, "docs", { name: "a-one", body: docOne });
      await insertTestDocument(db, "docs", { name: "b-two", body: docTwo });
      await insertTestDocument(db, "docs", { name: "c-three", body: docThree });

      const result = await generateEmbeddings(store, {
        maxDocsPerBatch: 64,
        maxBatchBytes: batchLimit,
      });

      expect(fakeLlm.embedBatchCalls).toHaveLength(2);
      expect(fakeLlm.embedBatchCalls.map(call => call.length)).toEqual([2, 1]);
      expect(result.docsProcessed).toBe(3);
      expect(result.chunksEmbedded).toBe(3);
    } finally {
      setDefaultLlamaCpp(null);
      await cleanupTestDb(store);
    }
  });

  test("generateEmbeddings passes the selected model through to embed calls and metadata", async () => {
    const store = await createTestStore();
    const db = store.db;
    const fakeLlm = createFakeEmbedLlm();
    const model = "hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf";

    setDefaultLlamaCpp(createFakeTokenizer() as any);
    store.llm = fakeLlm as any;

    try {
      await insertTestDocument(db, "docs", { name: "one", body: "# One\n\nAlpha" });

      const result = await generateEmbeddings(store, { model });

      expect(result.chunksEmbedded).toBe(1);
      expect(fakeLlm.embedCalls[0]?.options?.model).toBe(model);
      expect(fakeLlm.embedBatchModelCalls).toEqual([{ model }]);
      expect(db.prepare(`SELECT DISTINCT model FROM content_vectors`).all()).toEqual([{ model }]);
    } finally {
      setDefaultLlamaCpp(null);
      await cleanupTestDb(store);
    }
  });

  test("generateEmbeddings uses the active llm embed model when no explicit model is passed", async () => {
    const store = await createTestStore();
    const db = store.db;
    const fakeLlm = createFakeEmbedLlm();
    const model = "hf:env/embed-model.gguf";

    setDefaultLlamaCpp(createFakeTokenizer() as any);
    store.llm = { ...fakeLlm, embedModelName: model } as any;

    try {
      await insertTestDocument(db, "docs", { name: "one", body: "# One\n\nAlpha" });

      const result = await generateEmbeddings(store);

      expect(result.chunksEmbedded).toBe(1);
      expect(fakeLlm.embedCalls[0]?.options?.model).toBe(model);
      expect(fakeLlm.embedBatchModelCalls).toEqual([{ model }]);
      expect(db.prepare(`SELECT DISTINCT model FROM content_vectors`).all()).toEqual([{ model }]);
    } finally {
      setDefaultLlamaCpp(null);
      await cleanupTestDb(store);
    }
  });

  test("generateEmbeddings does not mark a partially embedded multi-chunk document complete", async () => {
    const store = await createTestStore();
    const db = store.db;
    let embedCalls = 0;
    const fakeLlm = {
      async embed(_text: string, _options?: { model?: string }) {
        embedCalls++;
        return embedCalls === 1
          ? { embedding: [0.1, 0.2, 0.3], model: "fake-embed" }
          : null;
      },
      async embedBatch(texts: string[], _options?: { model?: string }) {
        return texts.map((_text, index) => index === 0
          ? { embedding: [1, 2, 3], model: "fake-embed" }
          : null
        );
      },
    };

    setDefaultLlamaCpp(createFakeTokenizer() as any);
    store.llm = fakeLlm as any;

    try {
      await insertTestDocument(db, "docs", {
        name: "long-doc",
        body: "# Long doc\n\n" + "partial embedding regression ".repeat(260),
      });

      const result = await generateEmbeddings(store);

      expect(result.errors).toBeGreaterThan(0);
      expect(result.failures?.[0]?.attempts).toBe(3);
      expect(db.prepare(`SELECT COUNT(*) as count FROM content_vectors`).get()).toEqual({ count: 0 });
      expect(db.prepare(`SELECT COUNT(*) as count FROM vectors_vec`).get()).toEqual({ count: 0 });
      expect(store.getHashesNeedingEmbedding()).toBe(1);
      expect(store.getStatus().needsEmbedding).toBe(1);
    } finally {
      setDefaultLlamaCpp(null);
      await cleanupTestDb(store);
    }
  });

  test("generateEmbeddings clears chunk errors after successful retry", async () => {
    const store = await createTestStore();
    const db = store.db;
    const fakeLlm = {
      async embed(_text: string, _options?: { model?: string }) {
        return { embedding: [0.1, 0.2, 0.3], model: "fake-embed" };
      },
      async embedBatch(texts: string[], _options?: { model?: string }) {
        return texts.map((_text, index) => index === 0
          ? { embedding: [1, 2, 3], model: "fake-embed" }
          : null
        );
      },
    };

    setDefaultLlamaCpp(createFakeTokenizer() as any);
    store.llm = fakeLlm as any;

    try {
      await insertTestDocument(db, "docs", {
        name: "retry-doc",
        body: "# Retry doc\n\n" + "transient embedding failure ".repeat(260),
      });

      const result = await generateEmbeddings(store);

      expect(result.errors).toBe(0);
      expect(result.failures).toEqual([]);
      expect(db.prepare(`SELECT COUNT(*) as count FROM content_vectors`).get()).toEqual({ count: result.chunksEmbedded });
      expect(store.getHashesNeedingEmbedding()).toBe(0);
    } finally {
      setDefaultLlamaCpp(null);
      await cleanupTestDb(store);
    }
  });

  test("generateEmbeddings opens a long-lived LLM session for embed runs", async () => {
    const store = await createTestStore();
    const fakeLlm = createFakeEmbedLlm();
    const sessionSpy = vi.spyOn(llmModule, "withLLMSessionForLlm");

    setDefaultLlamaCpp(createFakeTokenizer() as any);
    store.llm = fakeLlm as any;

    try {
      await insertTestDocument(store.db, "docs", { name: "one", body: "# One\n\nAlpha" });

      await generateEmbeddings(store);

      expect(sessionSpy).toHaveBeenCalledWith(
        fakeLlm,
        expect.any(Function),
        expect.objectContaining({ maxDuration: 30 * 60 * 1000, name: "generateEmbeddings" }),
      );
    } finally {
      sessionSpy.mockRestore();
      setDefaultLlamaCpp(null);
      await cleanupTestDb(store);
    }
  });

  test("vectorSearchQuery uses the active llm embed model for vector lookups", async () => {
    const store = await createTestStore();
    const model = "hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf";
    const embedBatchSpy = vi.fn(async (texts: string[]) => texts.map(() => ({
      embedding: [1, 2, 3],
      model,
    })));
    const searchVecSpy = vi.fn(async () => [] as SearchResult[]) as any;

    store.db.exec(`CREATE TABLE vectors_vec (hash_seq TEXT PRIMARY KEY, embedding BLOB)`);
    store.llm = { embedModelName: model, embedBatch: embedBatchSpy } as any;
    store.searchVec = searchVecSpy as any;
    store.expandQuery = vi.fn(async () => []) as any;

    try {
      await vectorSearchQuery(store, "custom query", { limit: 7, minScore: 0 });

      expect(embedBatchSpy).toHaveBeenCalledTimes(1);
      expect(searchVecSpy).toHaveBeenCalledTimes(1);
      expect(searchVecSpy.mock.calls[0]?.[0]).toBe("custom query");
      expect(searchVecSpy.mock.calls[0]?.[1]).toBe(model);
      expect(searchVecSpy.mock.calls[0]?.[2]).toBe(7);
      expect(searchVecSpy.mock.calls[0]?.[5]).toEqual([1, 2, 3]);
    } finally {
      await cleanupTestDb(store);
    }
  });

  test("hybridQuery uses the active llm embed model for precomputed vector lookups", async () => {
    const store = await createTestStore();
    const model = "hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf";
    const embedBatchSpy = vi.fn(async (texts: string[]) => texts.map(() => ({
      embedding: [1, 2, 3],
      model,
    })));
    const searchVecSpy = vi.fn(async () => [] as SearchResult[]) as any;

    store.db.exec(`CREATE TABLE vectors_vec (hash_seq TEXT PRIMARY KEY, embedding BLOB)`);
    store.llm = {
      embedModelName: model,
      embedBatch: embedBatchSpy,
    } as any;
    store.searchVec = searchVecSpy as any;
    store.searchFTS = vi.fn(() => []) as any;
    store.expandQuery = vi.fn(async () => []) as any;

    try {
      await hybridQuery(store, "hybrid query", { limit: 5, minScore: 0, skipRerank: true });

      expect(embedBatchSpy).toHaveBeenCalledTimes(1);
      expect(searchVecSpy).toHaveBeenCalledTimes(1);
      expect(searchVecSpy.mock.calls[0]?.[0]).toBe("hybrid query");
      expect(searchVecSpy.mock.calls[0]?.[1]).toBe(model);
      expect(searchVecSpy.mock.calls[0]?.[5]).toEqual([1, 2, 3]);
    } finally {
      await cleanupTestDb(store);
    }
  });

  test("structuredSearch uses the active llm embed model for precomputed vector lookups", async () => {
    const store = await createTestStore();
    const model = "hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf";
    const embedBatchSpy = vi.fn(async (texts: string[]) => texts.map(() => ({
      embedding: [1, 2, 3],
      model,
    })));
    const searchVecSpy = vi.fn(async () => [] as SearchResult[]) as any;

    store.db.exec(`CREATE TABLE vectors_vec (hash_seq TEXT PRIMARY KEY, embedding BLOB)`);
    store.llm = {
      embedModelName: model,
      embedBatch: embedBatchSpy,
    } as any;
    store.searchVec = searchVecSpy as any;

    try {
      await structuredSearch(store, [{ type: "vec", query: "structured query" }], {
        limit: 5,
        minScore: 0,
        skipRerank: true,
      });

      expect(embedBatchSpy).toHaveBeenCalledTimes(1);
      expect(searchVecSpy).toHaveBeenCalledTimes(1);
      expect(searchVecSpy.mock.calls[0]?.[0]).toBe("structured query");
      expect(searchVecSpy.mock.calls[0]?.[1]).toBe(model);
      expect(searchVecSpy.mock.calls[0]?.[5]).toEqual([1, 2, 3]);
    } finally {
      await cleanupTestDb(store);
    }
  });

  test("generateEmbeddings rejects invalid batch limits", async () => {
    const store = await createTestStore();

    try {
      await expect(generateEmbeddings(store, { maxDocsPerBatch: 0 })).rejects.toThrow(
        "maxDocsPerBatch"
      );
      await expect(generateEmbeddings(store, { maxBatchBytes: 0 })).rejects.toThrow(
        "maxBatchBytes"
      );
    } finally {
      setDefaultLlamaCpp(null);
      await cleanupTestDb(store);
    }
  });
});
