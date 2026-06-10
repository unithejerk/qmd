/**
 * Auto-generated split from test/store.test.ts
 */
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { join } from "node:path";
import { unlink } from "node:fs/promises";
import { disposeDefaultLlamaCpp } from "../../src/llm.js";
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
});

afterAll(async () => {
  await disposeDefaultLlamaCpp();
  await teardownTestDir(testDir);
});


describe("FTS Search", () => {
  test("searchFTS returns empty array for no matches", async () => {
    const { store: store, configDir } = await createTestStore(testDir);
    const collectionName = await createTestCollection(store, configDir, );
    await insertTestDocument(store.db, collectionName, {
      name: "doc1",
      body: "The quick brown fox jumps over the lazy dog",
    });

    const results = store.searchFTS("nonexistent-term-xyz", 10);
    expect(results).toHaveLength(0);

    await cleanupTestStore(store, configDir);
  });

  test("searchFTS finds documents by keyword", async () => {
    const { store: store, configDir } = await createTestStore(testDir);
    const collectionName = await createTestCollection(store, configDir, );
    await insertTestDocument(store.db, collectionName, {
      name: "doc1",
      title: "Fox Document",
      body: "The quick brown fox jumps over the lazy dog",
      displayPath: "test/doc1.md",
    });

    const results = store.searchFTS("fox", 10);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.displayPath).toBe(`${collectionName}/test/doc1.md`);
    expect(results[0]!.filepath).toBe(`qmd://${collectionName}/test/doc1.md`);
    expect(results[0]!.source).toBe("fts");

    await cleanupTestStore(store, configDir);
  });

  test("searchFTS ranks title matches higher", async () => {
    const { store: store, configDir } = await createTestStore(testDir);
    const collectionName = await createTestCollection(store, configDir, );

    // Document with "fox" in body only
    await insertTestDocument(store.db, collectionName, {
      name: "body-match",
      title: "Some Other Title",
      body: "The fox is here in the body",
      displayPath: "test/body.md",
    });

    // Document with "fox" in title (via name field which is indexed)
    await insertTestDocument(store.db, collectionName, {
      name: "fox",
      title: "Fox Title",
      body: "Different content without the animal fox",
      displayPath: "test/title.md",
    });

    const results = store.searchFTS("fox", 10);
    // Both documents contain "fox" in the body now, so we should get 2 results
    expect(results.length).toBe(2);
    // Title/name match should rank higher due to BM25 weights
    expect(results[0]!.displayPath).toBe(`${collectionName}/test/title.md`);

    await cleanupTestStore(store, configDir);
  });

  test("searchFTS title boost outweighs higher body frequency", async () => {
    const { store: store, configDir } = await createTestStore(testDir);
    const collectionName = await createTestCollection(store, configDir, );

    // Document with "quantum" mentioned in a longer body but NOT in the title
    await insertTestDocument(store.db, collectionName, {
      name: "body-only",
      title: "General Science Notes",
      body: "This research paper discusses quantum mechanics and the quantum model of computation. The quantum approach offers improvements over classical methods.",
      displayPath: "test/body-only.md",
    });

    // Document with "quantum" in the title but a shorter body mention
    await insertTestDocument(store.db, collectionName, {
      name: "title-match",
      title: "Quantum Computing Overview",
      body: "An introduction to the fundamentals of this emerging computing paradigm.",
      displayPath: "test/title-match.md",
    });

    const results = store.searchFTS("quantum", 10);
    expect(results.length).toBe(2);
    // Title-match doc should rank higher due to BM25 column weights boosting title
    expect(results[0]!.displayPath).toBe(`${collectionName}/test/title-match.md`);

    await cleanupTestStore(store, configDir);
  });

  test("searchFTS respects limit parameter", async () => {
    const { store: store, configDir } = await createTestStore(testDir);
    const collectionName = await createTestCollection(store, configDir, );

    // Insert 10 documents
    for (let i = 0; i < 10; i++) {
      await insertTestDocument(store.db, collectionName, {
        name: `doc${i}`,
        body: "common keyword appears here",
        displayPath: `test/doc${i}.md`,
      });
    }

    const results = store.searchFTS("common keyword", 3);
    expect(results).toHaveLength(3);

    await cleanupTestStore(store, configDir);
  });

  test("searchFTS filters by collection name", async () => {
    const { store: store, configDir } = await createTestStore(testDir);
    const collection1 = await createTestCollection(store, configDir, { pwd: "/path/one", glob: "**/*.md", name: "one" });
    const collection2 = await createTestCollection(store, configDir, { pwd: "/path/two", glob: "**/*.md", name: "two" });

    await insertTestDocument(store.db, collection1, {
      name: "doc1",
      body: "searchable content",
      displayPath: "doc1.md",
    });

    await insertTestDocument(store.db, collection2, {
      name: "doc2",
      body: "searchable content",
      displayPath: "doc2.md",
    });

    const allResults = store.searchFTS("searchable", 10);
    expect(allResults).toHaveLength(2);

    // Filter by collection name
    const filtered = store.searchFTS("searchable", 10, collection1);
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.displayPath).toBe(`${collection1}/doc1.md`);

    await cleanupTestStore(store, configDir);
  });

  test("searchFTS can skip body/context for retrieval-only paths", async () => {
    const { store: store, configDir } = await createTestStore(testDir);
    const collectionName = await createTestCollection(store, configDir, );

    await insertTestDocument(store.db, collectionName, {
      name: "doc1",
      body: "searchable content",
      displayPath: "doc1.md",
    });

    const results = store.searchFTS("searchable", 10, collectionName, {
      includeBody: false,
      includeContext: false,
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.body).toBeUndefined();
    expect(results[0]?.context).toBeNull();
    expect(results[0]?.bodyLength).toBeGreaterThan(0);

    await cleanupTestStore(store, configDir);
  });

  test("searchFTS finds CJK documents by exact and mixed queries", async () => {
    const { store: store, configDir } = await createTestStore(testDir);
    const collectionName = await createTestCollection(store, configDir, );

    await insertTestDocument(store.db, collectionName, {
      name: "zh",
      title: "中文检索说明",
      body: "这里介绍 vector 数据库和关键词检索。",
      displayPath: "cjk/zh.md",
    });
    await insertTestDocument(store.db, collectionName, {
      name: "ja",
      title: "日本語検索メモ",
      body: "この文書は検索品質とトークン化について説明します。",
      displayPath: "cjk/ja.md",
    });
    await insertTestDocument(store.db, collectionName, {
      name: "ko",
      title: "한국어 검색 노트",
      body: "이 문서는 검색 품질과 토큰화 문제를 설명합니다.",
      displayPath: "cjk/ko.md",
    });

    expect(store.searchFTS("关键词检索", 10).map(r => r.displayPath)).toContain(`${collectionName}/cjk/zh.md`);
    expect(store.searchFTS("検索品質", 10).map(r => r.displayPath)).toContain(`${collectionName}/cjk/ja.md`);
    expect(store.searchFTS("검색 품질", 10).map(r => r.displayPath)).toContain(`${collectionName}/cjk/ko.md`);
    expect(store.searchFTS("vector 关键词", 10).map(r => r.displayPath)).toContain(`${collectionName}/cjk/zh.md`);

    await cleanupTestStore(store, configDir);
  });

  test("searchFTS keeps English behavior while indexing CJK text", async () => {
    const { store: store, configDir } = await createTestStore(testDir);
    const collectionName = await createTestCollection(store, configDir, );

    await insertTestDocument(store.db, collectionName, {
      name: "english",
      title: "Vector Search Notes",
      body: "The quick brown fox explains vector search and BM25 ranking.",
      displayPath: "english.md",
    });
    await insertTestDocument(store.db, collectionName, {
      name: "zh",
      title: "中文检索说明",
      body: "这里介绍向量数据库和关键词检索。",
      displayPath: "zh.md",
    });

    const foxResults = store.searchFTS("quick fox", 10);
    expect(foxResults.map(r => r.displayPath)).toContain(`${collectionName}/english.md`);
    expect(foxResults.map(r => r.displayPath)).not.toContain(`${collectionName}/zh.md`);

    await cleanupTestStore(store, configDir);
  });

  test("searchFTS handles special characters in query", async () => {
    const { store: store, configDir } = await createTestStore(testDir);
    const collectionName = await createTestCollection(store, configDir, );
    await insertTestDocument(store.db, collectionName, {
      name: "doc1",
      body: "Function with params: foo(bar, baz)",
      displayPath: "test/doc1.md",
    });

    // Should not throw on special characters
    const results = store.searchFTS("foo(bar)", 10);
    // Results may vary based on FTS5 handling
    expect(Array.isArray(results)).toBe(true);

    await cleanupTestStore(store, configDir);
  });

  // BM25 IDF requires corpus depth — helper adds non-matching docs so term frequency
  // differentiation produces meaningful scores (2-doc corpus has near-zero IDF).
  async function addNoiseDocuments(db: Database, collectionName: string, count = 8) {
    for (let i = 0; i < count; i++) {
      await insertTestDocument(db, collectionName, {
        name: `noise${i}`,
        title: `Unrelated Topic ${i}`,
        body: `This document discusses completely different subjects like gardening and cooking ${i}`,
        displayPath: `test/noise${i}.md`,
      });
    }
  }

  test("searchFTS scores: stronger BM25 match → higher normalized score", async () => {
    const { store: store, configDir } = await createTestStore(testDir);
    const collectionName = await createTestCollection(store, configDir, );
    await addNoiseDocuments(store.db, collectionName);

    // "alpha" appears in title (10x weight) + body → strong BM25
    await insertTestDocument(store.db, collectionName, {
      name: "strong",
      title: "Alpha Guide",
      body: "This is the definitive alpha reference with alpha details and more alpha info",
      displayPath: "test/strong.md",
    });

    // "alpha" appears once in body only → weaker BM25
    await insertTestDocument(store.db, collectionName, {
      name: "weak",
      title: "General Notes",
      body: "Some notes that mention alpha in passing among other topics and keywords",
      displayPath: "test/weak.md",
    });

    const results = store.searchFTS("alpha", 10);
    expect(results.length).toBe(2);

    // Verify score direction: stronger match (title + body) should score HIGHER
    const strongResult = results.find(r => r.displayPath.includes("strong"))!;
    const weakResult = results.find(r => r.displayPath.includes("weak"))!;
    expect(strongResult.score).toBeGreaterThan(weakResult.score);

    // Verify scores are in valid (0, 1) range
    for (const r of results) {
      expect(r.score).toBeGreaterThan(0);
      expect(r.score).toBeLessThan(1);
    }

    await cleanupTestStore(store, configDir);
  });

  test("searchFTS scores: minScore filter keeps strong matches, drops weak", async () => {
    const { store: store, configDir } = await createTestStore(testDir);
    const collectionName = await createTestCollection(store, configDir, );
    await addNoiseDocuments(store.db, collectionName);

    // Strong match: keyword in title (10x weight) + repeated in body
    await insertTestDocument(store.db, collectionName, {
      name: "strong",
      title: "Kubernetes Deployment",
      body: "Kubernetes deployment strategies for kubernetes clusters using kubernetes operators",
      displayPath: "test/strong.md",
    });

    // Weak match: keyword appears once in body only
    await insertTestDocument(store.db, collectionName, {
      name: "weak",
      title: "Random Notes",
      body: "Various topics including a brief kubernetes mention among many other unrelated things",
      displayPath: "test/weak.md",
    });

    const allResults = store.searchFTS("kubernetes", 10);
    expect(allResults.length).toBe(2);

    // With a minScore threshold, strong match should survive, weak should be filterable
    const strongScore = allResults.find(r => r.displayPath.includes("strong"))!.score;
    const weakScore = allResults.find(r => r.displayPath.includes("weak"))!.score;

    // Find a threshold between them
    const threshold = (strongScore + weakScore) / 2;
    const filtered = allResults.filter(r => r.score >= threshold);

    // Strong match survives the filter, weak does not
    expect(filtered.length).toBe(1);
    expect(filtered[0]!.displayPath).toContain("strong");

    await cleanupTestStore(store, configDir);
  });

  test("searchFTS ignores inactive documents", async () => {
    const { store: store, configDir } = await createTestStore(testDir);
    const collectionName = await createTestCollection(store, configDir, );

    await insertTestDocument(store.db, collectionName, {
      name: "active",
      body: "findme content",
      displayPath: "test/active.md",
      active: 1,
    });

    await insertTestDocument(store.db, collectionName, {
      name: "inactive",
      body: "findme content",
      displayPath: "test/inactive.md",
      active: 0,
    });

    const results = store.searchFTS("findme", 10);
    expect(results).toHaveLength(1);
    expect(results[0]!.displayPath).toBe(`${collectionName}/test/active.md`);
    expect(results[0]!.filepath).toBe(`qmd://${collectionName}/test/active.md`);

    await cleanupTestStore(store, configDir);
  });

  test("searchFTS scores: strong signal detection works with correct normalization", async () => {
    const { store: store, configDir } = await createTestStore(testDir);
    const collectionName = await createTestCollection(store, configDir, );

    // BM25 IDF needs meaningful corpus depth for strong signal to fire.
    // 50 noise docs give IDF ≈ log(50/2) ≈ 3.2 — enough for scores above 0.85.
    await addNoiseDocuments(store.db, collectionName, 50);

    // Dominant: keyword in filepath (10x BM25 weight column) + title + body
    await insertTestDocument(store.db, collectionName, {
      name: "dominant",
      title: "Zephyr Configuration Guide",
      body: "Complete zephyr configuration guide. Zephyr setup instructions for zephyr deployment.",
      displayPath: "zephyr/zephyr-guide.md",
    });

    // Weak: keyword once in body only, longer doc dilutes TF
    await insertTestDocument(store.db, collectionName, {
      name: "weak",
      title: "General Notes",
      body: "Various topics covering many areas of technology and design. " +
        "One of them might relate to zephyr but mostly about other things entirely. " +
        "Additional content about databases, networking, security, performance, " +
        "monitoring, deployment, testing, and documentation practices.",
      displayPath: "notes/misc.md",
    });

    const results = store.searchFTS("zephyr", 10);
    expect(results.length).toBe(2);

    const topScore = results[0]!.score;
    const secondScore = results[1]!.score;

    // With correct normalization: strong match should be well above threshold
    expect(topScore).toBeGreaterThanOrEqual(STRONG_SIGNAL_MIN_SCORE);

    // Gap should exceed threshold when there's a dominant match
    const gap = topScore - secondScore;
    expect(gap).toBeGreaterThanOrEqual(STRONG_SIGNAL_MIN_GAP);

    // Full strong signal check should pass (this was dead code before the fix)
    const hasStrongSignal = topScore >= STRONG_SIGNAL_MIN_SCORE && gap >= STRONG_SIGNAL_MIN_GAP;
    expect(hasStrongSignal).toBe(true);

    await cleanupTestStore(store, configDir);
  });

  test("searchFTS matches dotted version tokens as phrases", async () => {
    const { store: store, configDir } = await createTestStore(testDir);
    const collectionName = await createTestCollection(store, configDir, );

    await insertTestDocument(store.db, collectionName, {
      name: "release-notes",
      title: "Release Notes",
      body: "version 2026.4.10 is released with many improvements",
      displayPath: "test/release.md",
    });
    await addNoiseDocuments(store.db, collectionName);

    // Full dotted version should match
    const results = store.searchFTS("2026.4.10", 10);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.displayPath).toBe(`${collectionName}/test/release.md`);

    await cleanupTestStore(store, configDir);
  });

  test("searchFTS with dotted version still returns normal text results", async () => {
    const { store: store, configDir } = await createTestStore(testDir);
    const collectionName = await createTestCollection(store, configDir, );

    await insertTestDocument(store.db, collectionName, {
      name: "mixed",
      title: "Mixed Content",
      body: "version 2026.4.10 introduces new features like improved search",
      displayPath: "test/mixed.md",
    });
    await addNoiseDocuments(store.db, collectionName);

    // Normal text query should still work alongside version data
    const results = store.searchFTS("search", 10);
    expect(results.length).toBeGreaterThan(0);
    expect(results.some(r => r.displayPath === `${collectionName}/test/mixed.md`)).toBe(true);

    await cleanupTestStore(store, configDir);
  });

  test("searchFTS partial dotted version still matches", async () => {
    const { store: store, configDir } = await createTestStore(testDir);
    const collectionName = await createTestCollection(store, configDir, );

    await insertTestDocument(store.db, collectionName, {
      name: "versioned",
      title: "Versioned Doc",
      body: "this references version 4.10 of the protocol",
      displayPath: "test/versioned.md",
    });
    await addNoiseDocuments(store.db, collectionName);

    // Partial version "4.10" should still find the document
    const results = store.searchFTS("4.10", 10);
    expect(results.length).toBeGreaterThan(0);
    expect(results.some(r => r.displayPath === `${collectionName}/test/versioned.md`)).toBe(true);

    await cleanupTestStore(store, configDir);
  });
});

// =============================================================================
// Document Retrieval Tests
// =============================================================================

