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
// Store Creation Tests
// =============================================================================

describe("Store Creation", () => {
  test("createStore throws without explicit path in test mode", () => {
    // In test mode, createStore without path should throw to prevent accidental writes.
    // Other tests may enable production mode in the same Bun process, so reset first.
    _resetProductionModeForTesting();
    const originalIndexPath = process.env.INDEX_PATH;
    delete process.env.INDEX_PATH;

    expect(() => createStore()).toThrow("Database path not set");

    // Restore
    if (originalIndexPath) process.env.INDEX_PATH = originalIndexPath;
  });

  test("createStore creates a new store with custom path", async () => {
    const { store: store, configDir } = await createTestStore(testDir);
    expect(store.dbPath).toBe(store.dbPath);
    expect(store.db).toBeDefined();
    expect(typeof store.db.exec).toBe("function");
    await cleanupTestStore(store, configDir);
  });

  test("createStore initializes database schema", async () => {
    const { store: store, configDir } = await createTestStore(testDir);

    // Check tables exist
    const tables = store.db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type='table'
      ORDER BY name
    `).all() as { name: string }[];

    const tableNames = tables.map(t => t.name);
    expect(tableNames).toContain("documents");
    expect(tableNames).toContain("documents_fts");
    expect(tableNames).toContain("content_vectors");
    expect(tableNames).toContain("content");
    expect(tableNames).toContain("llm_cache");
    // Note: path_contexts table removed in favor of YAML-based context storage

    await cleanupTestStore(store, configDir);
  });

  test("createStore defers content_vectors embed_fingerprint migration until embedding health needs it", async () => {
    const dbPath = join(testDir, `legacy-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
    const model = "hf:test/embed-model.gguf";
    const legacyDb = openDatabase(dbPath);
    legacyDb.exec(`
      CREATE TABLE content (
        hash TEXT PRIMARY KEY,
        doc TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE documents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        collection TEXT NOT NULL,
        path TEXT NOT NULL,
        title TEXT,
        hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        modified_at TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        FOREIGN KEY (hash) REFERENCES content(hash) ON DELETE CASCADE,
        UNIQUE(collection, path)
      );
      CREATE TABLE content_vectors (
        hash TEXT NOT NULL,
        seq INTEGER NOT NULL DEFAULT 0,
        pos INTEGER NOT NULL DEFAULT 0,
        model TEXT NOT NULL,
        total_chunks INTEGER NOT NULL DEFAULT 1,
        embedded_at TEXT NOT NULL,
        PRIMARY KEY (hash, seq)
      )
    `);
    const now = new Date().toISOString();
    legacyDb.prepare(`INSERT INTO content (hash, doc, created_at) VALUES (?, ?, ?)`).run("hash1", "# Legacy\nbody", now);
    legacyDb.prepare(`INSERT INTO documents (collection, path, title, hash, created_at, modified_at, active) VALUES (?, ?, ?, ?, ?, ?, 1)`).run("test", "legacy.md", "Legacy", "hash1", now, now);
    legacyDb.prepare(`INSERT INTO content_vectors (hash, seq, pos, model, total_chunks, embedded_at) VALUES (?, ?, ?, ?, ?, ?)`).run("hash1", 0, 0, model, 1, now);
    legacyDb.close();

    const store = createStore(dbPath);
    let columns = store.db.prepare(`PRAGMA table_info(content_vectors)`).all() as { name: string }[];
    expect(columns.map(col => col.name)).not.toContain("embed_fingerprint");

    expect(store.getHashesNeedingEmbedding(model)).toBe(1);

    columns = store.db.prepare(`PRAGMA table_info(content_vectors)`).all() as { name: string }[];
    const migratedRow = store.db.prepare(`SELECT embed_fingerprint FROM content_vectors WHERE hash = ?`).get("hash1") as { embed_fingerprint: string };
    expect(columns.map(col => col.name)).toContain("embed_fingerprint");
    expect(migratedRow.embed_fingerprint).toBe("");

    await cleanupTestStore(store, configDir);
  });

  test("content_vectors column repair runs the full ALTER series and retries the failed operation", async () => {
    const dbPath = join(testDir, `legacy-no-seq-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
    const model = "hf:test/embed-model.gguf";
    const legacyDb = openDatabase(dbPath);
    legacyDb.exec(`
      CREATE TABLE content (
        hash TEXT PRIMARY KEY,
        doc TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE documents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        collection TEXT NOT NULL,
        path TEXT NOT NULL,
        title TEXT,
        hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        modified_at TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        FOREIGN KEY (hash) REFERENCES content(hash) ON DELETE CASCADE,
        UNIQUE(collection, path)
      );
      CREATE TABLE content_vectors (
        hash TEXT NOT NULL,
        model TEXT NOT NULL,
        embed_fingerprint TEXT NOT NULL DEFAULT '',
        total_chunks INTEGER NOT NULL DEFAULT 1,
        embedded_at TEXT NOT NULL
      )
    `);
    legacyDb.close();

    const store = createStore(dbPath);
    let columns = store.db.prepare(`PRAGMA table_info(content_vectors)`).all() as { name: string }[];
    expect(columns.map(col => col.name)).not.toContain("seq");
    expect(columns.map(col => col.name)).not.toContain("pos");

    store.ensureVecTable(3);
    store.insertEmbedding("hash1", 1, 42, new Float32Array([1, 2, 3]), model, new Date().toISOString(), 2);

    columns = store.db.prepare(`PRAGMA table_info(content_vectors)`).all() as { name: string }[];
    const columnNames = columns.map(col => col.name);
    expect(columnNames).toEqual(expect.arrayContaining(["seq", "pos", "model", "embed_fingerprint", "total_chunks", "embedded_at"]));
    expect(store.db.prepare(`SELECT seq, pos, model, total_chunks FROM content_vectors WHERE hash = ?`).get("hash1")).toEqual({
      seq: 1,
      pos: 42,
      model,
      total_chunks: 2,
    });

    await cleanupTestStore(store, configDir);
  });

  test("createStore sets WAL journal mode", async () => {
    const { store: store, configDir } = await createTestStore(testDir);
    const result = store.db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    expect(result.journal_mode).toBe("wal");
    await cleanupTestStore(store, configDir);
  });

  test("verifySqliteVecLoaded throws when sqlite-vec is not loaded", () => {
    const db = openDatabase(":memory:");
    try {
      expect(() => verifySqliteVecLoaded(db)).toThrow("sqlite-vec extension is unavailable");
    } finally {
      db.close();
    }
  });

  test("verifySqliteVecLoaded succeeds when sqlite-vec is loaded", () => {
    const db = openDatabase(":memory:");
    try {
      loadSqliteVec(db);
      expect(() => verifySqliteVecLoaded(db)).not.toThrow();
    } finally {
      db.close();
    }
  });

  test("ensureVecTable surfaces actionable sqlite-vec guidance", async () => {
    const { store: store, configDir } = await createTestStore(testDir);
    try {
      if (typeof process.getBuiltinModule === "function") {
        expect(() => store.ensureVecTable(768)).not.toThrow();
      } else {
        expect(() => store.ensureVecTable(768)).toThrow(/sqlite-vec extension is unavailable/);
        expect(() => store.ensureVecTable(768)).toThrow(/Install Homebrew SQLite/);
      }
    } finally {
      await cleanupTestStore(store, configDir);
    }
  });

  test("store.close closes the database connection", async () => {
    const { store: store, configDir } = await createTestStore(testDir);
    store.close();
    // Attempting to use db after close should throw
    expect(() => store.db.prepare("SELECT 1").get()).toThrow();
    try {
      await unlink(store.dbPath);
    } catch {}
  });
});

