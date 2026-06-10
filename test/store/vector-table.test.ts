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
// Vector Table Tests
// =============================================================================

describe("Vector Table", () => {
  test("ensureVecTable creates vector table", async () => {
    const { store: store, configDir } = await createTestStore(testDir);

    // Initially no vector table
    let exists = store.db.prepare(`
      SELECT name FROM sqlite_master WHERE type='table' AND name='vectors_vec'
    `).get();
    expect(exists).toBeFalsy(); // null or undefined

    // Create vector table
    store.ensureVecTable(768);

    exists = store.db.prepare(`
      SELECT name FROM sqlite_master WHERE type='table' AND name='vectors_vec'
    `).get();
    expect(exists).toBeTruthy();

    await cleanupTestStore(store, configDir);
  });

  test("ensureVecTable throws on dimension mismatch instead of silently rebuilding", async () => {
    const { store: store, configDir } = await createTestStore(testDir);

    // Create with 768 dimensions
    store.ensureVecTable(768);

    // Check dimensions
    const tableInfo = store.db.prepare(`
      SELECT sql FROM sqlite_master WHERE type='table' AND name='vectors_vec'
    `).get() as { sql: string };
    expect(tableInfo.sql).toContain("float[768]");

    // Attempting to use a different dimension should throw (not silently drop data)
    expect(() => store.ensureVecTable(1024)).toThrow(/dimension mismatch/i);

    // Original table should still exist untouched
    const tableInfoAfter = store.db.prepare(`
      SELECT sql FROM sqlite_master WHERE type='table' AND name='vectors_vec'
    `).get() as { sql: string };
    expect(tableInfoAfter.sql).toContain("float[768]");

    await cleanupTestStore(store, configDir);
  });

  test("insertEmbedding is idempotent for an existing vec0 hash_seq (#598)", async () => {
    const { store: store, configDir } = await createTestStore(testDir);
    store.ensureVecTable(2);

    const hash = "existinghashseq";
    const first = new Float32Array([0.1, 0.2]);
    const second = new Float32Array([0.3, 0.4]);
    const now = new Date().toISOString();

    store.db.prepare(`INSERT INTO vectors_vec (hash_seq, embedding) VALUES (?, ?)`).run(`${hash}_0`, first);

    // Reproduces sqlite-vec's broken conflict handling: vec0 does not honor OR REPLACE.
    expect(() => {
      store.db.prepare(`INSERT OR REPLACE INTO vectors_vec (hash_seq, embedding) VALUES (?, ?)`).run(`${hash}_0`, second);
    }).toThrow(/UNIQUE constraint failed/i);

    // QMD must therefore use DELETE + INSERT when upserting the vector row.
    expect(() => store.insertEmbedding(hash, 0, 0, second, "test-model", now)).not.toThrow();

    const vectorCount = store.db.prepare(`SELECT COUNT(*) AS count FROM vectors_vec WHERE hash_seq = ?`).get(`${hash}_0`) as { count: number };
    const metadataCount = store.db.prepare(`SELECT COUNT(*) AS count FROM content_vectors WHERE hash = ? AND seq = 0`).get(hash) as { count: number };
    expect(vectorCount.count).toBe(1);
    expect(metadataCount.count).toBe(1);

    await cleanupTestStore(store, configDir);
  });
});

// =============================================================================
// Integration Tests
// =============================================================================

