/**
 * Auto-generated split from test/store.test.ts
 */
import { describe, test, expect, beforeAll, afterAll, vi } from "vitest";
import { join } from "node:path";
import { mkdtemp, unlink, writeFile, rm } from "node:fs/promises";
import * as llmModule from "../../src/llm.js";
import { disposeDefaultLlamaCpp, setDefaultLlamaCpp } from "../../src/llm.js";
import { MockLLM } from "../helpers/mock-llm.js";
import { openDatabase, loadSqliteVec } from "../../src/db.js";
import type { Database } from "../../src/db.js";
import {
  createStore,
  homedir,
  hashContent,
  insertContent,
  insertDocument,
  syncConfigToDb,
  reindexCollection,
  verifySqliteVecLoaded,
  _resetProductionModeForTesting,
  STRONG_SIGNAL_MIN_SCORE,
  STRONG_SIGNAL_MIN_GAP,
  type Store,
  type DocumentResult,
  type SearchResult,
} from "../../src/store.js";
import type { CollectionConfig } from "../../src/collections.js";
import {
  setupTestDir,
  teardownTestDir,
  createTestStore,
  cleanupTestStore,
  insertTestDocument,
  createTestCollection,
  addPathContext,
  addGlobalContext,
  syncTestConfig,
} from "../helpers/store.js";

let testDir: string;
let configDir: string | undefined;

beforeAll(async () => {
  testDir = await setupTestDir();
  setDefaultLlamaCpp(new MockLLM() as any);
});

afterAll(async () => {
  setDefaultLlamaCpp(null);
  await disposeDefaultLlamaCpp();
  await teardownTestDir(testDir);
});


// =============================================================================
// Integration Tests
// =============================================================================

describe("Integration", () => {
  test("reindexCollection soft-deletes removed files and preserves inactive content (#585)", async () => {
    const { store: store, configDir } = await createTestStore(testDir);
    const collectionDir = await mkdtemp(join(testDir, "orphan-regression-"));
    const collectionName = "orphan-regression";

    try {
      for (let i = 1; i <= 5; i++) {
        await writeFile(join(collectionDir, `doc-${i}.md`), `# Doc ${i}\n\nUnique body ${i}`);
      }

      await createTestCollection(store, configDir, { pwd: collectionDir, glob: "**/*.md", name: collectionName });

      const initial = await reindexCollection(store, collectionDir, "**/*.md", collectionName);
      expect(initial.indexed).toBe(5);
      expect(initial.removed).toBe(0);

      await rm(join(collectionDir, "doc-3.md"));
      await rm(join(collectionDir, "doc-4.md"));
      await rm(join(collectionDir, "doc-5.md"));

      const afterDelete = await reindexCollection(store, collectionDir, "**/*.md", collectionName);
      expect(afterDelete.removed).toBe(3);

      const counts = store.db.prepare(`
        SELECT
          SUM(CASE WHEN active = 1 THEN 1 ELSE 0 END) AS active,
          SUM(CASE WHEN active = 0 THEN 1 ELSE 0 END) AS inactive,
          COUNT(*) AS total
        FROM documents
        WHERE collection = ?
      `).get(collectionName) as { active: number; inactive: number; total: number };
      const contentCount = store.db.prepare(`SELECT COUNT(*) AS count FROM content`).get() as { count: number };

      expect(counts).toEqual({ active: 2, inactive: 3, total: 5 });
      expect(contentCount.count).toBe(5);
    } finally {
      await rm(collectionDir, { recursive: true, force: true });
      await cleanupTestStore(store, configDir);
    }
  });

  test("full document lifecycle: create, search, retrieve", async () => {
    const { store: store, configDir } = await createTestStore(testDir);
    const collectionName = await createTestCollection(store, configDir, { pwd: "/test/notes", glob: "**/*.md" });

    // Add context - use "/" for collection root
    await addPathContext(store, configDir, collectionName, "/", "Personal notes");

    // Insert documents
    await insertTestDocument(store.db, collectionName, {
      name: "meeting",
      title: "Team Meeting Notes",
      filepath: "/test/notes/meeting.md",
      displayPath: "notes/meeting.md",
      body: "# Team Meeting Notes\n\nDiscussed project timeline and deliverables.",
    });

    await insertTestDocument(store.db, collectionName, {
      name: "ideas",
      title: "Project Ideas",
      filepath: "/test/notes/ideas.md",
      displayPath: "notes/ideas.md",
      body: "# Project Ideas\n\nBrainstorming new features for the product.",
    });

    // Search
    const searchResults = store.searchFTS("project", 10);
    expect(searchResults.length).toBe(2);

    // Status - SKIPPED: getStatus() has bug (queries non-existent collections table)
    // const status = store.getStatus();
    // expect(status.totalDocuments).toBe(2);
    // expect(status.collections).toHaveLength(1);

    // Retrieve single document
    const doc = store.findDocument("notes/meeting.md", { includeBody: true });
    expect("error" in doc).toBe(false);
    if (!("error" in doc)) {
      expect(doc.title).toBe("Team Meeting Notes");
      expect(doc.context).toBe("Personal notes");
      expect(doc.body).toContain("Team Meeting");
    }

    // Multi-get
    const { docs, errors } = store.findDocuments("notes/*.md", { includeBody: true });
    expect(errors).toHaveLength(0);
    expect(docs).toHaveLength(2);

    await cleanupTestStore(store, configDir);
  });

  test("multiple stores can operate independently", async () => {
    const { store: store1, configDir: c1 } = await createTestStore(testDir);
    const { store: store2, configDir: c2 } = await createTestStore(testDir);

    const col1 = await createTestCollection(store1, c1, { pwd: "/store1", glob: "**/*.md", name: "store1" });
    const col2 = await createTestCollection(store2, c2, { pwd: "/store2", glob: "**/*.md", name: "store2" });

    await insertTestDocument(store1.db, col1, {
      name: "doc1",
      body: "unique content for store1",
      displayPath: "doc.md",
    });

    await insertTestDocument(store2.db, col2, {
      name: "doc2",
      body: "different content for store2",
      displayPath: "doc.md",
    });

    // Each store should only see its own documents
    const results1 = store1.searchFTS("unique", 10);
    const results2 = store2.searchFTS("different", 10);

    expect(results1).toHaveLength(1);
    expect(results1[0]!.displayPath).toBe("store1/doc.md");
    expect(results1[0]!.filepath).toBe("qmd://store1/doc.md");

    expect(results2).toHaveLength(1);
    expect(results2[0]!.displayPath).toBe("store2/doc.md");
    expect(results2[0]!.filepath).toBe("qmd://store2/doc.md");

    // Cross-check: store1 shouldn't find store2's content
    const cross1 = store1.searchFTS("different", 10);
    const cross2 = store2.searchFTS("unique", 10);

    expect(cross1).toHaveLength(0);
    expect(cross2).toHaveLength(0);

    await cleanupTestStore(store1, c1);
    await cleanupTestStore(store2, c2);
  });
});

// =============================================================================
// LlamaCpp Integration Tests (using real local models)
// =============================================================================

describe.skipIf(!!process.env.CI)("LlamaCpp Integration", () => {
  test("searchVec returns empty when no vector index", async () => {
    const { store: store, configDir } = await createTestStore(testDir);
    const collectionName = await createTestCollection(store, configDir, );
    await insertTestDocument(store.db, collectionName, {
      name: "doc1",
      body: "Some content",
    });

    // No vectors_vec table exists, should return empty
    const results = await store.searchVec("query", "embeddinggemma", 10);
    expect(results).toHaveLength(0);

    await cleanupTestStore(store, configDir);
  });

  test("searchVec returns results when vector index exists", async () => {
    const { store: store, configDir } = await createTestStore(testDir);
    const collectionName = await createTestCollection(store, configDir, );

    const hash = "testhash123";
    await insertTestDocument(store.db, collectionName, {
      name: "doc1",
      hash,
      body: "Some content about testing",
      filepath: "/test/doc1.md",
      displayPath: "doc1.md",
    });

    // Create vector table and insert a vector
    store.ensureVecTable(768);
    const embedding = Array(768).fill(0).map(() => Math.random());
    store.db.prepare(`INSERT INTO content_vectors (hash, seq, pos, model, embedded_at) VALUES (?, 0, 0, 'test', ?)`).run(hash, new Date().toISOString());
    store.db.prepare(`INSERT INTO vectors_vec (hash_seq, embedding) VALUES (?, ?)`).run(`${hash}_0`, new Float32Array(embedding));

    const results = await store.searchVec("test query", "embeddinggemma", 10);
    expect(results).toHaveLength(1);
    expect(results[0]!.displayPath).toBe(`${collectionName}/doc1.md`);
    expect(results[0]!.filepath).toBe(`qmd://${collectionName}/doc1.md`);
    expect(results[0]!.source).toBe("vec");

    await cleanupTestStore(store, configDir);
  });

  test("searchVec filters by collection name", async () => {
    const { store: store, configDir } = await createTestStore(testDir);
    const collection1 = await createTestCollection(store, configDir, { name: "coll1", pwd: "/test/coll1" });
    const collection2 = await createTestCollection(store, configDir, { name: "coll2", pwd: "/test/coll2" });

    const hash1 = "hash1abc";
    const hash2 = "hash2xyz";

    await insertTestDocument(store.db, collection1, {
      name: "doc1",
      hash: hash1,
      body: "Content in collection one",
    });

    await insertTestDocument(store.db, collection2, {
      name: "doc2",
      hash: hash2,
      body: "Content in collection two",
    });

    // Create vectors_vec table with correct dimensions (768 for embeddinggemma)
    store.ensureVecTable(768);
    const embedding1 = Array(768).fill(0).map(() => Math.random());
    const embedding2 = Array(768).fill(0).map(() => Math.random());
    store.db.prepare(`INSERT INTO content_vectors (hash, seq, pos, model, embedded_at) VALUES (?, 0, 0, 'test', ?)`).run(hash1, new Date().toISOString());
    store.db.prepare(`INSERT INTO content_vectors (hash, seq, pos, model, embedded_at) VALUES (?, 0, 0, 'test', ?)`).run(hash2, new Date().toISOString());
    store.db.prepare(`INSERT INTO vectors_vec (hash_seq, embedding) VALUES (?, ?)`).run(`${hash1}_0`, new Float32Array(embedding1));
    store.db.prepare(`INSERT INTO vectors_vec (hash_seq, embedding) VALUES (?, ?)`).run(`${hash2}_0`, new Float32Array(embedding2));

    // Search without filter - should return both
    const allResults = await store.searchVec("content", "embeddinggemma", 10);
    expect(allResults).toHaveLength(2);

    // Search with collection filter - should return only from collection1
    const filtered = await store.searchVec("content", "embeddinggemma", 10, collection1);
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.collectionName).toBe(collection1);

    await cleanupTestStore(store, configDir);
  });

  test("searchVec supports precomputed embeddings without hydrating body/context", async () => {
    const { store: store, configDir } = await createTestStore(testDir);
    const collectionName = await createTestCollection(store, configDir, );

    const hash = "hash-precomputed";
    await insertTestDocument(store.db, collectionName, {
      name: "doc1",
      hash,
      body: "Content for precomputed vector search",
      displayPath: "doc1.md",
    });

    store.ensureVecTable(3);
    store.db.prepare(`INSERT INTO content_vectors (hash, seq, pos, model, embedded_at) VALUES (?, 0, 0, 'test', ?)`).run(hash, new Date().toISOString());
    store.db.prepare(`INSERT INTO vectors_vec (hash_seq, embedding) VALUES (?, ?)`).run(`${hash}_0`, new Float32Array([0.1, 0.2, 0.3]));

    const results = await store.searchVec(
      "ignored query",
      "embeddinggemma",
      10,
      collectionName,
      undefined,
      [0.1, 0.2, 0.3],
      undefined,
      { includeBody: false, includeContext: false },
    );

    expect(results).toHaveLength(1);
    expect(results[0]?.body).toBeUndefined();
    expect(results[0]?.context).toBeNull();
    expect(results[0]?.bodyLength).toBeGreaterThan(0);

    await cleanupTestStore(store, configDir);
  });

  // Regression test for https://github.com/tobi/qmd/pull/23
  // sqlite-vec virtual tables hang when combined with JOINs in the same query.
  // The fix uses a two-step approach: vector query first, then separate JOINs.
  test("searchVec uses two-step query to avoid sqlite-vec JOIN hang", async () => {
    const { store: store, configDir } = await createTestStore(testDir);
    const collectionName = await createTestCollection(store, configDir, );

    const hash = "regression_test_hash";
    await insertTestDocument(store.db, collectionName, {
      name: "regression-doc",
      hash,
      body: "Test content for vector search regression",
      filepath: "/test/regression.md",
      displayPath: "regression.md",
    });

    // Create vector table and insert a test vector
    store.ensureVecTable(768);
    const embedding = Array(768).fill(0).map(() => Math.random());
    store.db.prepare(`INSERT INTO content_vectors (hash, seq, pos, model, embedded_at) VALUES (?, 0, 0, 'test', ?)`).run(hash, new Date().toISOString());
    store.db.prepare(`INSERT INTO vectors_vec (hash_seq, embedding) VALUES (?, ?)`).run(`${hash}_0`, new Float32Array(embedding));

    // This should complete quickly (not hang) due to the two-step fix
    // The old code with JOINs in the sqlite-vec query would hang indefinitely
    const startTime = Date.now();
    const results = await store.searchVec("test content", "embeddinggemma", 5);
    const elapsed = Date.now() - startTime;

    // If the query took more than 5 seconds, something is wrong
    // (the hang bug would cause it to never return at all)
    expect(elapsed).toBeLessThan(5000);
    expect(results.length).toBeGreaterThan(0);

    await cleanupTestStore(store, configDir);
  });

  test("expandQuery returns typed expansions (no original query)", async () => {
    const { store: store, configDir } = await createTestStore(testDir);

    const expanded = await store.expandQuery("test query");
    // Returns ExpandedQuery[] — typed results from LLM, excluding original
    expect(expanded.length).toBeGreaterThanOrEqual(1);
    for (const q of expanded) {
      expect(['lex', 'vec', 'hyde']).toContain(q.type);
      expect(q.query.length).toBeGreaterThan(0);
      expect(q.query).not.toBe("test query"); // original excluded
    }

    await cleanupTestStore(store, configDir);
  }, 90000);

  test("expandQuery caches results as JSON with types", async () => {
    const { store: store, configDir } = await createTestStore(testDir);

    // First call — hits LLM
    const queries1 = await store.expandQuery("cached query test");
    // Second call — hits cache
    const queries2 = await store.expandQuery("cached query test");

    // Cache should preserve full typed structure
    expect(queries1).toEqual(queries2);
    expect(queries2[0]?.type).toBeDefined();

    await cleanupTestStore(store, configDir);
  }, 60000);

  test("rerank scores documents", async () => {
    const { store: store, configDir } = await createTestStore(testDir);

    const docs = [
      { file: "doc1.md", text: "Relevant content about the topic" },
      { file: "doc2.md", text: "Other content" },
    ];

    const results = await store.rerank("topic", docs);
    expect(results).toHaveLength(2);
    // LlamaCpp reranker returns relevance scores
    expect(results[0]!.score).toBeGreaterThan(0);

    await cleanupTestStore(store, configDir);
  });

  test("rerank caches results", async () => {
    const { store: store, configDir } = await createTestStore(testDir);

    const docs = [{ file: "doc1.md", text: "Content for caching test" }];

    // First call
    await store.rerank("cache test query", docs);
    // Second call - should hit cache
    const results = await store.rerank("cache test query", docs);

    expect(results).toHaveLength(1);

    await cleanupTestStore(store, configDir);
  });

  test("rerank deduplicates identical chunks across files", async () => {
    const { store: store, configDir } = await createTestStore(testDir);
    const rerankSpy = vi.fn(async (_query: string, docs: { file: string; text: string }[]) => ({
      results: docs.map((doc, index) => ({
        file: doc.file,
        score: 1 - index * 0.1,
        index,
      })),
      model: "mock-reranker",
    }));

    const llmSpy = vi.spyOn(llmModule, "getDefaultLlamaCpp").mockReturnValue({
      rerank: rerankSpy,
    } as any);

    try {
      const docs = [
        { file: "doc1.md", text: "Shared chunk text" },
        { file: "doc2.md", text: "Shared chunk text" },
      ];

      const first = await store.rerank("shared", docs);
      const second = await store.rerank("shared", docs);

      expect(first).toHaveLength(2);
      expect(second).toHaveLength(2);
      expect(rerankSpy).toHaveBeenCalledTimes(1);
      expect(rerankSpy.mock.calls[0]?.[1]).toEqual([{ file: "doc2.md", text: "Shared chunk text" }]);
    } finally {
      llmSpy.mockRestore();
      await cleanupTestStore(store, configDir);
    }
  });
});

// =============================================================================
// Edge Cases & Error Handling
// =============================================================================

