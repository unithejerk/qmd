/**
 * Auto-generated split from test/store.test.ts
 */
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { join } from "node:path";
import { mkdtemp, unlink, writeFile, mkdir, rm } from "node:fs/promises";
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


describe("Path fidelity", () => {
  test("reindexCollection stores literal paths for special-character filenames", async () => {
    const { store: store, configDir } = await createTestStore(testDir);
    const collectionDir = await mkdtemp(join(testDir, "literal-paths-"));
    const collectionName = "literal-paths";

    try {
      const weirdName = "Budget & Revenue (Q4) [2024].md";
      const weirdSubDir = join(collectionDir, "subdir");
      const weirdSubName = "Notes #42 - foo@bar.md";
      await mkdir(weirdSubDir, { recursive: true });
      await writeFile(join(collectionDir, weirdName), "# Budget\n\nsearchterm-beta\n");
      await writeFile(join(weirdSubDir, weirdSubName), "# Notes\n\nsearchterm-gamma\n");

      await createTestCollection(store, configDir, { pwd: collectionDir, glob: "**/*.md", name: collectionName });
      const result = await reindexCollection(store, collectionDir, "**/*.md", collectionName);
      expect(result.indexed).toBe(2);

      const rows = store.db.prepare(
        "SELECT path FROM documents WHERE collection = ? AND active = 1 ORDER BY path"
      ).all(collectionName) as Array<{ path: string }>;
      const paths = rows.map((row) => row.path);

      expect(paths).toContain(weirdName);
      expect(paths).toContain(`subdir/${weirdSubName}`);
      expect(paths).not.toContain("Budget-Revenue-Q4-2024.md");
      expect(paths).not.toContain("subdir/Notes-42-foo-bar.md");

      expect(store.toVirtualPath(join(collectionDir, weirdName))).toBe(
        `qmd://${collectionName}/${weirdName}`
      );
    } finally {
      await rm(collectionDir, { recursive: true, force: true });
      await cleanupTestStore(store, configDir);
    }
  });
});
