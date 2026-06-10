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


describe("Path Context", () => {
  test("getContextForFile returns null when no context set", async () => {
    const { store: store, configDir } = await createTestStore(testDir);
    const context = store.getContextForFile("/some/random/path.md");
    expect(context).toBeNull();
    await cleanupTestStore(store, configDir);
  });

  test("getContextForFile returns matching context", async () => {
    const { store: store, configDir } = await createTestStore(testDir);
    const collectionName = await createTestCollection(store, configDir, { pwd: "/test/collection", glob: "**/*.md" });
    await addPathContext(store, configDir, collectionName, "/docs", "Documentation files");

    // Insert a document so getContextForFile can find it
    await insertTestDocument(store.db, collectionName, {
      name: "readme",
      displayPath: "docs/readme.md",
    });

    const context = store.getContextForFile("/test/collection/docs/readme.md");
    expect(context).toBe("Documentation files");

    await cleanupTestStore(store, configDir);
  });

  test("getContextForFile returns all matching contexts", async () => {
    const { store: store, configDir } = await createTestStore(testDir);
    const collectionName = await createTestCollection(store, configDir, { pwd: "/test/collection", glob: "**/*.md" });
    await addPathContext(store, configDir, collectionName, "/", "General test files");
    await addPathContext(store, configDir, collectionName, "/docs", "Documentation files");
    await addPathContext(store, configDir, collectionName, "/docs/api", "API documentation");

    // Insert documents so getContextForFile can find them
    await insertTestDocument(store.db, collectionName, {
      name: "readme",
      displayPath: "readme.md",
    });
    await insertTestDocument(store.db, collectionName, {
      name: "guide",
      displayPath: "docs/guide.md",
    });
    await insertTestDocument(store.db, collectionName, {
      name: "reference",
      displayPath: "docs/api/reference.md",
    });

    // Context now returns ALL matching contexts joined with \n\n
    expect(store.getContextForFile("/test/collection/readme.md")).toBe("General test files");
    expect(store.getContextForFile("/test/collection/docs/guide.md")).toBe("General test files\n\nDocumentation files");
    expect(store.getContextForFile("/test/collection/docs/api/reference.md")).toBe("General test files\n\nDocumentation files\n\nAPI documentation");

    await cleanupTestStore(store, configDir);
  });
});

