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


describe("Fuzzy Matching", () => {
  test("findSimilarFiles finds similar paths", async () => {
    const { store: store, configDir } = await createTestStore(testDir);
    const collectionName = await createTestCollection(store, configDir, );

    await insertTestDocument(store.db, collectionName, {
      name: "readme",
      displayPath: "docs/readme.md",
    });
    await insertTestDocument(store.db, collectionName, {
      name: "readmi",
      displayPath: "docs/readmi.md", // typo
    });

    const similar = store.findSimilarFiles("docs/readme.md", 3, 5);
    expect(similar).toContain("docs/readme.md");

    await cleanupTestStore(store, configDir);
  });

  test("findSimilarFiles respects maxDistance", async () => {
    const { store: store, configDir } = await createTestStore(testDir);
    const collectionName = await createTestCollection(store, configDir, );

    await insertTestDocument(store.db, collectionName, {
      name: "abc",
      displayPath: "abc.md",
    });
    await insertTestDocument(store.db, collectionName, {
      name: "xyz",
      displayPath: "xyz.md", // very different
    });

    const similar = store.findSimilarFiles("abc.md", 1, 5); // max distance 1
    expect(similar).toContain("abc.md");
    expect(similar).not.toContain("xyz.md");

    await cleanupTestStore(store, configDir);
  });

  test("matchFilesByGlob matches patterns", async () => {
    const { store: store, configDir } = await createTestStore(testDir);
    const collectionName = await createTestCollection(store, configDir, );

    await insertTestDocument(store.db, collectionName, {
      filepath: "/p/journals/2024-01.md",
      displayPath: "journals/2024-01.md",
    });
    await insertTestDocument(store.db, collectionName, {
      filepath: "/p/journals/2024-02.md",
      displayPath: "journals/2024-02.md",
    });
    await insertTestDocument(store.db, collectionName, {
      filepath: "/p/docs/readme.md",
      displayPath: "docs/readme.md",
    });

    const matches = store.matchFilesByGlob("journals/*.md");
    expect(matches).toHaveLength(2);
    expect(matches.every(m => m.displayPath.startsWith("journals/"))).toBe(true);

    await cleanupTestStore(store, configDir);
  });

  test("matchFilesByGlob matches collection/path patterns", async () => {
    const { store: store, configDir } = await createTestStore(testDir);
    const collectionName = await createTestCollection(store, configDir, );

    await insertTestDocument(store.db, collectionName, {
      filepath: "/p/readme.md",
      displayPath: "readme.md",
    });
    await insertTestDocument(store.db, collectionName, {
      filepath: "/p/changelog.md",
      displayPath: "changelog.md",
    });

    const matches = store.matchFilesByGlob(`${collectionName}/*.md`);
    expect(matches).toHaveLength(2);

    await cleanupTestStore(store, configDir);
  });

  test("matchFilesByGlob matches brace expansion", async () => {
    const { store: store, configDir } = await createTestStore(testDir);
    const collectionName = await createTestCollection(store, configDir, );

    await insertTestDocument(store.db, collectionName, {
      filepath: "/p/readme.md",
      displayPath: "readme.md",
    });
    await insertTestDocument(store.db, collectionName, {
      filepath: "/p/changelog.md",
      displayPath: "changelog.md",
    });
    await insertTestDocument(store.db, collectionName, {
      filepath: "/p/license.md",
      displayPath: "license.md",
    });

    const matches = store.matchFilesByGlob(`${collectionName}/{readme,changelog}.md`);
    expect(matches).toHaveLength(2);

    await cleanupTestStore(store, configDir);
  });
});

// =============================================================================
// Vector Table Tests
// =============================================================================

