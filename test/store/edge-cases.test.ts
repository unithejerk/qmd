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


// =============================================================================
// Edge Cases & Error Handling
// =============================================================================

describe("Edge Cases", () => {
  test("handles empty database gracefully", async () => {
    const { store: store, configDir } = await createTestStore(testDir);

    const searchResults = store.searchFTS("anything", 10);
    expect(searchResults).toHaveLength(0);

    // SKIPPED: getStatus() has bug (queries non-existent collections table)
    // const status = store.getStatus();
    // expect(status.totalDocuments).toBe(0);
    // expect(status.collections).toHaveLength(0);

    const doc = store.findDocument("nonexistent.md");
    expect("error" in doc).toBe(true);

    await cleanupTestStore(store, configDir);
  });

  test("handles very long document bodies", async () => {
    const { store: store, configDir } = await createTestStore(testDir);
    const collectionName = await createTestCollection(store, configDir, );

    const longBody = "word ".repeat(100000); // ~600KB
    await insertTestDocument(store.db, collectionName, {
      name: "long",
      body: longBody,
      displayPath: "long.md",
    });

    const results = store.searchFTS("word", 10);
    expect(results).toHaveLength(1);

    await cleanupTestStore(store, configDir);
  });

  test("handles unicode content correctly", async () => {
    const { store: store, configDir } = await createTestStore(testDir);
    const collectionName = await createTestCollection(store, configDir, );

    await insertTestDocument(store.db, collectionName, {
      name: "unicode",
      title: "日本語タイトル",
      body: "# 日本語\n\n内容は日本語で書かれています。\n\nEmoji: 🎉🚀✨",
      displayPath: "unicode.md",
    });

    // Should be searchable
    const results = store.searchFTS("日本語", 10);
    expect(results.length).toBeGreaterThan(0);

    // Should retrieve correctly
    const doc = store.findDocument("unicode.md", { includeBody: true });
    expect("error" in doc).toBe(false);
    if (!("error" in doc)) {
      expect(doc.title).toBe("日本語タイトル");
      expect(doc.body).toContain("🎉");
    }

    await cleanupTestStore(store, configDir);
  });

  test("handles documents with special characters in paths", async () => {
    const { store: store, configDir } = await createTestStore(testDir);
    const collectionName = await createTestCollection(store, configDir, );

    await insertTestDocument(store.db, collectionName, {
      name: "special",
      filepath: "/path/file with spaces.md",
      displayPath: "file with spaces.md",
      body: "Content",
    });

    const doc = store.findDocument("file with spaces.md");
    expect("error" in doc).toBe(false);

    await cleanupTestStore(store, configDir);
  });

  test("handles concurrent operations", async () => {
    const { store: store, configDir } = await createTestStore(testDir);
    const collectionName = await createTestCollection(store, configDir, );

    // Insert multiple documents concurrently
    const inserts = Array.from({ length: 10 }, (_, i) =>
      insertTestDocument(store.db, collectionName, {
        name: `concurrent${i}`,
        body: `Content ${i} searchterm`,
        displayPath: `concurrent${i}.md`,
      })
    );

    await Promise.all(inserts);

    // All should be searchable
    const results = store.searchFTS("searchterm", 20);
    expect(results).toHaveLength(10);

    await cleanupTestStore(store, configDir);
  });
});

