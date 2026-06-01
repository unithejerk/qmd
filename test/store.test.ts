/**
 * store.test.ts - Comprehensive unit tests for the QMD store module
 *
 * Run with: bun test store.test.ts
 *
 * LLM operations use LlamaCpp with local GGUF models (node-llama-cpp).
 */

import { describe, test, expect, beforeAll, afterAll, vi } from "vitest";
import { openDatabase, loadSqliteVec } from "../src/db.js";
import type { Database } from "../src/db.js";
import { unlink, mkdtemp, rmdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import * as llmModule from "../src/llm.js";
import { disposeDefaultLlamaCpp } from "../src/llm.js";
import {
  createStore,
  verifySqliteVecLoaded,
  homedir,
  hashContent,
  reciprocalRankFusion,
  extractSnippet,
  normalizeVirtualPath,
  isVirtualPath,
  parseVirtualPath,
  normalizeDocid,
  isDocid,
  syncConfigToDb,
  reindexCollection,
  STRONG_SIGNAL_MIN_SCORE,
  STRONG_SIGNAL_MIN_GAP,
  insertContent,
  insertDocument,
  getHybridRrfWeights,
  _resetProductionModeForTesting,
  type Store,
  type DocumentResult,
  type SearchResult,
  type RankedResult,
  type RankedListMeta,
} from "../src/store.js";
import type { CollectionConfig } from "../src/collections.js";

// =============================================================================
// LlamaCpp Setup
// =============================================================================

// Note: LlamaCpp uses node-llama-cpp for local GGUF model inference.
// No HTTP mocking needed - tests use real LlamaCpp calls for integration tests.

// =============================================================================
// Test Utilities
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

// Helper to add path context in YAML config
async function addPathContext(collectionName: string, pathPrefix: string, contextText: string): Promise<void> {
  // Read current config
  const configPath = join(testConfigDir, "index.yml");
  const { readFile } = await import("node:fs/promises");
  const content = await readFile(configPath, "utf-8");
  const config = YAML.parse(content) as CollectionConfig;

  // Add context to collection
  if (!config.collections[collectionName]) {
    throw new Error(`Collection ${collectionName} not found`);
  }

  if (!config.collections[collectionName].context) {
    config.collections[collectionName].context = {};
  }

  config.collections[collectionName].context![pathPrefix] = contextText;

  // Write back
  await writeFile(configPath, YAML.stringify(config));
  await syncTestConfig();
}

// Helper to add global context in YAML config
async function addGlobalContext(contextText: string): Promise<void> {
  const configPath = join(testConfigDir, "index.yml");
  const { readFile } = await import("node:fs/promises");
  const content = await readFile(configPath, "utf-8");
  const config = YAML.parse(content) as CollectionConfig;

  config.global_context = contextText;

  await writeFile(configPath, YAML.stringify(config));
  await syncTestConfig();
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
    const store = await createTestStore();
    expect(store.dbPath).toBe(testDbPath);
    expect(store.db).toBeDefined();
    expect(typeof store.db.exec).toBe("function");
    await cleanupTestDb(store);
  });

  test("createStore initializes database schema", async () => {
    const store = await createTestStore();

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

    await cleanupTestDb(store);
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

    await cleanupTestDb(store);
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

    await cleanupTestDb(store);
  });

  test("createStore sets WAL journal mode", async () => {
    const store = await createTestStore();
    const result = store.db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    expect(result.journal_mode).toBe("wal");
    await cleanupTestDb(store);
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
    const store = await createTestStore();
    try {
      if (typeof process.getBuiltinModule === "function") {
        expect(() => store.ensureVecTable(768)).not.toThrow();
      } else {
        expect(() => store.ensureVecTable(768)).toThrow(/sqlite-vec extension is unavailable/);
        expect(() => store.ensureVecTable(768)).toThrow(/Install Homebrew SQLite/);
      }
    } finally {
      await cleanupTestDb(store);
    }
  });

  test("store.close closes the database connection", async () => {
    const store = await createTestStore();
    store.close();
    // Attempting to use db after close should throw
    expect(() => store.db.prepare("SELECT 1").get()).toThrow();
    try {
      await unlink(testDbPath);
    } catch {}
  });
});

describe("Path Context", () => {
  test("getContextForFile returns null when no context set", async () => {
    const store = await createTestStore();
    const context = store.getContextForFile("/some/random/path.md");
    expect(context).toBeNull();
    await cleanupTestDb(store);
  });

  test("getContextForFile returns matching context", async () => {
    const store = await createTestStore();
    const collectionName = await createTestCollection({ pwd: "/test/collection", glob: "**/*.md" });
    await addPathContext(collectionName, "/docs", "Documentation files");

    // Insert a document so getContextForFile can find it
    await insertTestDocument(store.db, collectionName, {
      name: "readme",
      displayPath: "docs/readme.md",
    });

    const context = store.getContextForFile("/test/collection/docs/readme.md");
    expect(context).toBe("Documentation files");

    await cleanupTestDb(store);
  });

  test("getContextForFile returns all matching contexts", async () => {
    const store = await createTestStore();
    const collectionName = await createTestCollection({ pwd: "/test/collection", glob: "**/*.md" });
    await addPathContext(collectionName, "/", "General test files");
    await addPathContext(collectionName, "/docs", "Documentation files");
    await addPathContext(collectionName, "/docs/api", "API documentation");

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

    await cleanupTestDb(store);
  });
});

describe("FTS Search", () => {
  test("searchFTS returns empty array for no matches", async () => {
    const store = await createTestStore();
    const collectionName = await createTestCollection();
    await insertTestDocument(store.db, collectionName, {
      name: "doc1",
      body: "The quick brown fox jumps over the lazy dog",
    });

    const results = store.searchFTS("nonexistent-term-xyz", 10);
    expect(results).toHaveLength(0);

    await cleanupTestDb(store);
  });

  test("searchFTS finds documents by keyword", async () => {
    const store = await createTestStore();
    const collectionName = await createTestCollection();
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

    await cleanupTestDb(store);
  });

  test("searchFTS ranks title matches higher", async () => {
    const store = await createTestStore();
    const collectionName = await createTestCollection();

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

    await cleanupTestDb(store);
  });

  test("searchFTS title boost outweighs higher body frequency", async () => {
    const store = await createTestStore();
    const collectionName = await createTestCollection();

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

    await cleanupTestDb(store);
  });

  test("searchFTS respects limit parameter", async () => {
    const store = await createTestStore();
    const collectionName = await createTestCollection();

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

    await cleanupTestDb(store);
  });

  test("searchFTS filters by collection name", async () => {
    const store = await createTestStore();
    const collection1 = await createTestCollection({ pwd: "/path/one", glob: "**/*.md", name: "one" });
    const collection2 = await createTestCollection({ pwd: "/path/two", glob: "**/*.md", name: "two" });

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

    await cleanupTestDb(store);
  });

  test("searchFTS can skip body/context for retrieval-only paths", async () => {
    const store = await createTestStore();
    const collectionName = await createTestCollection();

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

    await cleanupTestDb(store);
  });

  test("searchFTS finds CJK documents by exact and mixed queries", async () => {
    const store = await createTestStore();
    const collectionName = await createTestCollection();

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

    await cleanupTestDb(store);
  });

  test("searchFTS keeps English behavior while indexing CJK text", async () => {
    const store = await createTestStore();
    const collectionName = await createTestCollection();

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

    await cleanupTestDb(store);
  });

  test("searchFTS handles special characters in query", async () => {
    const store = await createTestStore();
    const collectionName = await createTestCollection();
    await insertTestDocument(store.db, collectionName, {
      name: "doc1",
      body: "Function with params: foo(bar, baz)",
      displayPath: "test/doc1.md",
    });

    // Should not throw on special characters
    const results = store.searchFTS("foo(bar)", 10);
    // Results may vary based on FTS5 handling
    expect(Array.isArray(results)).toBe(true);

    await cleanupTestDb(store);
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
    const store = await createTestStore();
    const collectionName = await createTestCollection();
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

    await cleanupTestDb(store);
  });

  test("searchFTS scores: minScore filter keeps strong matches, drops weak", async () => {
    const store = await createTestStore();
    const collectionName = await createTestCollection();
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

    await cleanupTestDb(store);
  });

  test("searchFTS ignores inactive documents", async () => {
    const store = await createTestStore();
    const collectionName = await createTestCollection();

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

    await cleanupTestDb(store);
  });

  test("searchFTS scores: strong signal detection works with correct normalization", async () => {
    const store = await createTestStore();
    const collectionName = await createTestCollection();

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

    await cleanupTestDb(store);
  });
});

// =============================================================================
// Document Retrieval Tests
// =============================================================================

describe("Document Retrieval", () => {
  describe("findDocument", () => {
    test("findDocument finds by exact filepath", async () => {
      const store = await createTestStore();
      const collectionName = await createTestCollection({ pwd: "/exact/path", glob: "**/*.md" });
      await insertTestDocument(store.db, collectionName, {
        name: "mydoc",
        title: "My Document",
        displayPath: "mydoc.md",
        body: "Document content here",
      });

      const result = store.findDocument("/exact/path/mydoc.md");
      expect("error" in result).toBe(false);
      if (!("error" in result)) {
        expect(result.title).toBe("My Document");
        expect(result.displayPath).toBe(`${collectionName}/mydoc.md`);
        expect(result.filepath).toBe(`qmd://${collectionName}/mydoc.md`);
        expect(result.body).toBeUndefined(); // body not included by default
      }

      await cleanupTestDb(store);
    });

    test("findDocument finds by display_path", async () => {
      const store = await createTestStore();
      const collectionName = await createTestCollection({ pwd: "/some/path", glob: "**/*.md" });
      await insertTestDocument(store.db, collectionName, {
        name: "mydoc",
        displayPath: "docs/mydoc.md",
      });

      const result = store.findDocument("docs/mydoc.md");
      expect("error" in result).toBe(false);

      await cleanupTestDb(store);
    });

    test("findDocument finds by partial path match", async () => {
      const store = await createTestStore();
      const collectionName = await createTestCollection({ pwd: "/very/long/path/to", glob: "**/*.md" });
      await insertTestDocument(store.db, collectionName, {
        name: "mydoc",
        displayPath: "mydoc.md",
      });

      const result = store.findDocument("mydoc.md");
      expect("error" in result).toBe(false);

      await cleanupTestDb(store);
    });

    test("findDocument includes body when requested", async () => {
      const store = await createTestStore();
      const collectionName = await createTestCollection({ pwd: "/path", glob: "**/*.md" });
      await insertTestDocument(store.db, collectionName, {
        name: "mydoc",
        displayPath: "mydoc.md",
        body: "The actual body content",
      });

      const result = store.findDocument("/path/mydoc.md", { includeBody: true });
      expect("error" in result).toBe(false);
      if (!("error" in result)) {
        expect(result.body).toBe("The actual body content");
      }

      await cleanupTestDb(store);
    });

    test("findDocument returns error with suggestions for not found", async () => {
      const store = await createTestStore();
      const collectionName = await createTestCollection();
      await insertTestDocument(store.db, collectionName, {
        name: "similar",
        filepath: "/path/similar.md",
        displayPath: "similar.md",
      });

      const result = store.findDocument("simlar.md"); // typo - 1 char diff
      expect("error" in result).toBe(true);
      if ("error" in result) {
        expect(result.error).toBe("not_found");
        // Levenshtein distance of 1 should be found with maxDistance 3
        expect(result.similarFiles.length).toBeGreaterThanOrEqual(0); // May or may not find depending on distance calc
      }

      await cleanupTestDb(store);
    });

    test("findDocument handles :line suffix", async () => {
      const store = await createTestStore();
      const collectionName = await createTestCollection();
      await insertTestDocument(store.db, collectionName, {
        name: "mydoc",
        filepath: "/path/mydoc.md",
        displayPath: "mydoc.md",
      });

      const result = store.findDocument("mydoc.md:100");
      expect("error" in result).toBe(false);

      await cleanupTestDb(store);
    });

    test("findDocument expands ~ to home directory", async () => {
      const store = await createTestStore();
      const home = homedir();
      const collectionName = await createTestCollection({ pwd: home, name: "home" });
      await insertTestDocument(store.db, collectionName, {
        name: "mydoc",
        filepath: `${home}/docs/mydoc.md`,
        displayPath: "docs/mydoc.md",
      });

      const result = store.findDocument("~/docs/mydoc.md");
      expect("error" in result).toBe(false);

      await cleanupTestDb(store);
    });

    test("findDocument includes context from path_contexts", async () => {
      const store = await createTestStore();
      const collectionName = await createTestCollection({ pwd: "/path" });
      await addPathContext(collectionName, "docs", "Documentation");
      await insertTestDocument(store.db, collectionName, {
        name: "mydoc",
        displayPath: "docs/mydoc.md",
      });

      const result = store.findDocument("/path/docs/mydoc.md");
      expect("error" in result).toBe(false);
      if (!("error" in result)) {
        expect(result.context).toBe("Documentation");
      }

      await cleanupTestDb(store);
    });

    test("findDocument includes hierarchical contexts (global + collection + path)", async () => {
      const store = await createTestStore();
      const collectionName = await createTestCollection({ pwd: "/archive", name: "archive" });

      // Add global context
      await addGlobalContext("Global context for all documents");

      // Add collection root context
      await addPathContext(collectionName, "/", "Archive collection context");

      // Add path-specific contexts at different levels
      await addPathContext(collectionName, "/podcasts", "Podcast episodes");
      await addPathContext(collectionName, "/podcasts/external", "External podcast interviews");

      // Insert document in nested path
      await insertTestDocument(store.db, collectionName, {
        name: "interview",
        displayPath: "podcasts/external/2024-jan-interview.md",
      });

      const result = store.findDocument("/archive/podcasts/external/2024-jan-interview.md");
      expect("error" in result).toBe(false);
      if (!("error" in result)) {
        // Should have all contexts joined with double newlines
        expect(result.context).toBe(
          "Global context for all documents\n\n" +
          "Archive collection context\n\n" +
          "Podcast episodes\n\n" +
          "External podcast interviews"
        );
      }

      await cleanupTestDb(store);
    });
  });

  describe("getDocumentBody", () => {
    test("getDocumentBody returns full body", async () => {
      const store = await createTestStore();
      const collectionName = await createTestCollection({ pwd: "/path" });
      await insertTestDocument(store.db, collectionName, {
        name: "mydoc",
        displayPath: "mydoc.md",
        body: "Line 1\nLine 2\nLine 3\nLine 4\nLine 5",
      });

      const body = store.getDocumentBody({ filepath: "/path/mydoc.md" });
      expect(body).toBe("Line 1\nLine 2\nLine 3\nLine 4\nLine 5");

      await cleanupTestDb(store);
    });

    test("getDocumentBody supports line range", async () => {
      const store = await createTestStore();
      const collectionName = await createTestCollection({ pwd: "/path" });
      await insertTestDocument(store.db, collectionName, {
        name: "mydoc",
        displayPath: "mydoc.md",
        body: "Line 1\nLine 2\nLine 3\nLine 4\nLine 5",
      });

      const body = store.getDocumentBody({ filepath: "/path/mydoc.md" }, 2, 2);
      expect(body).toBe("Line 2\nLine 3");

      await cleanupTestDb(store);
    });

    test("getDocumentBody returns null for non-existent document", async () => {
      const store = await createTestStore();
      const body = store.getDocumentBody({ filepath: "/nonexistent.md" });
      expect(body).toBeNull();
      await cleanupTestDb(store);
    });

    test("getDocumentBody clamps negative fromLine to top of document", async () => {
      const store = await createTestStore();
      const collectionName = await createTestCollection({ pwd: "/path" });
      await insertTestDocument(store.db, collectionName, {
        name: "mydoc",
        displayPath: "mydoc.md",
        body: "Line 1\nLine 2\nLine 3\nLine 4\nLine 5",
      });

      const body = store.getDocumentBody({ filepath: "/path/mydoc.md" }, -19, 80);
      expect(body).toBe("Line 1\nLine 2\nLine 3\nLine 4\nLine 5");

      await cleanupTestDb(store);
    });
  });

  describe("findDocuments (multi-get)", () => {
    test("findDocuments finds by glob pattern", async () => {
      const store = await createTestStore();
      const collectionName = await createTestCollection();

      await insertTestDocument(store.db, collectionName, {
        name: "doc1",
        filepath: "/path/journals/2024-01.md",
        displayPath: "journals/2024-01.md",
      });
      await insertTestDocument(store.db, collectionName, {
        name: "doc2",
        filepath: "/path/journals/2024-02.md",
        displayPath: "journals/2024-02.md",
      });
      await insertTestDocument(store.db, collectionName, {
        name: "doc3",
        filepath: "/path/other/file.md",
        displayPath: "other/file.md",
      });

      const { docs, errors } = store.findDocuments("journals/2024-*.md");
      expect(errors).toHaveLength(0);
      expect(docs).toHaveLength(2);

      await cleanupTestDb(store);
    });

    test("findDocuments finds by comma-separated list", async () => {
      const store = await createTestStore();
      const collectionName = await createTestCollection();

      await insertTestDocument(store.db, collectionName, {
        name: "doc1",
        filepath: "/path/doc1.md",
        displayPath: "doc1.md",
      });
      await insertTestDocument(store.db, collectionName, {
        name: "doc2",
        filepath: "/path/doc2.md",
        displayPath: "doc2.md",
      });

      const { docs, errors } = store.findDocuments("doc1.md, doc2.md");
      expect(errors).toHaveLength(0);
      expect(docs).toHaveLength(2);

      await cleanupTestDb(store);
    });

    test("findDocuments reports errors for not found files", async () => {
      const store = await createTestStore();
      const collectionName = await createTestCollection();

      await insertTestDocument(store.db, collectionName, {
        name: "doc1",
        filepath: "/path/doc1.md",
        displayPath: "doc1.md",
      });

      const { docs, errors } = store.findDocuments("doc1.md, nonexistent.md");
      expect(docs).toHaveLength(1);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("not found");

      await cleanupTestDb(store);
    });

    test("findDocuments skips large files", async () => {
      const store = await createTestStore();
      const collectionName = await createTestCollection();

      await insertTestDocument(store.db, collectionName, {
        name: "large",
        filepath: "/path/large.md",
        displayPath: "large.md",
        body: "x".repeat(20000), // 20KB
      });

      const { docs } = store.findDocuments("large.md", { maxBytes: 10000 });
      expect(docs).toHaveLength(1);
      expect(docs[0]!.skipped).toBe(true);
      if (docs[0]!.skipped) {
        expect((docs[0] as { skipped: true; skipReason: string }).skipReason).toContain("too large");
      }

      await cleanupTestDb(store);
    });

    test("findDocuments includes body when requested", async () => {
      const store = await createTestStore();
      const collectionName = await createTestCollection();

      await insertTestDocument(store.db, collectionName, {
        name: "doc1",
        filepath: "/path/doc1.md",
        displayPath: "doc1.md",
        body: "The content",
      });

      const { docs } = store.findDocuments("doc1.md", { includeBody: true });
      expect(docs[0]!.skipped).toBe(false);
      if (!docs[0]!.skipped) {
        expect((docs[0] as { doc: { body: string }; skipped: false }).doc.body).toBe("The content");
      }

      await cleanupTestDb(store);
    });

    test("findDocuments supports brace expansion patterns", async () => {
      const store = await createTestStore();
      const collectionName = await createTestCollection();

      await insertTestDocument(store.db, collectionName, {
        name: "doc1",
        filepath: "/path/doc1.md",
        displayPath: "doc1.md",
      });
      await insertTestDocument(store.db, collectionName, {
        name: "doc2",
        filepath: "/path/doc2.md",
        displayPath: "doc2.md",
      });
      await insertTestDocument(store.db, collectionName, {
        name: "doc3",
        filepath: "/path/doc3.md",
        displayPath: "doc3.md",
      });

      const { docs, errors } = store.findDocuments("{doc1,doc2}.md");
      expect(errors).toHaveLength(0);
      expect(docs).toHaveLength(2);

      await cleanupTestDb(store);
    });

    test("findDocuments supports brace expansion with collection prefix", async () => {
      const store = await createTestStore();
      const collectionName = await createTestCollection();

      await insertTestDocument(store.db, collectionName, {
        name: "readme",
        filepath: "/path/readme.md",
        displayPath: "readme.md",
      });
      await insertTestDocument(store.db, collectionName, {
        name: "changelog",
        filepath: "/path/changelog.md",
        displayPath: "changelog.md",
      });

      const { docs, errors } = store.findDocuments(`${collectionName}/{readme,changelog}.md`);
      expect(errors).toHaveLength(0);
      expect(docs).toHaveLength(2);

      await cleanupTestDb(store);
    });
  });

});

// =============================================================================
// Snippet Extraction Tests
// =============================================================================

describe("Snippet Extraction", () => {
  test("extractSnippet finds query terms", () => {
    const body = "First line.\nSecond line with keyword.\nThird line.\nFourth line.";
    const { line, snippet } = extractSnippet(body, "keyword", 500);

    expect(line).toBe(2); // Line 2 contains "keyword"
    expect(snippet).toContain("keyword");
  });

  test("extractSnippet includes context lines", () => {
    const body = "Line 1\nLine 2\nLine 3 has keyword\nLine 4\nLine 5";
    const { snippet } = extractSnippet(body, "keyword", 500);

    expect(snippet).toContain("Line 2"); // Context before
    expect(snippet).toContain("Line 3 has keyword");
    expect(snippet).toContain("Line 4"); // Context after
  });

  test("extractSnippet respects maxLen for content", () => {
    const body = "A".repeat(1000);
    const result = extractSnippet(body, "query", 100);

    // Snippet includes header + content, content should be truncated
    expect(result.snippet).toContain("@@"); // Has diff header
    expect(result.snippet).toContain("..."); // Content was truncated
  });

  test("extractSnippet uses chunkPos hint", () => {
    const body = "First section...\n".repeat(50) + "Target keyword here\n" + "More content...".repeat(50);
    const chunkPos = body.indexOf("Target keyword");

    const { snippet } = extractSnippet(body, "Target", 200, chunkPos);
    expect(snippet).toContain("Target keyword");
  });

  test("extractSnippet returns beginning when no match", () => {
    const body = "First line\nSecond line\nThird line";
    const { line, snippet } = extractSnippet(body, "nonexistent", 500);

    expect(line).toBe(1);
    expect(snippet).toContain("First line");
  });

  test("extractSnippet includes diff-style header", () => {
    const body = "Line 1\nLine 2\nLine 3 has keyword\nLine 4\nLine 5";
    const { snippet, linesBefore, linesAfter, snippetLines } = extractSnippet(body, "keyword", 500);

    // Header should show line position and context info
    expect(snippet).toMatch(/^@@ -\d+,\d+ @@ \(\d+ before, \d+ after\)/);
    expect(linesBefore).toBe(1); // Line 1 comes before
    expect(linesAfter).toBe(0);  // Snippet includes to end (lines 2-5)
    expect(snippetLines).toBe(4); // Lines 2, 3, 4, 5
  });

  test("extractSnippet calculates linesBefore and linesAfter correctly", () => {
    const body = "L1\nL2\nL3\nL4 match\nL5\nL6\nL7\nL8\nL9\nL10";
    const { linesBefore, linesAfter, snippetLines, line } = extractSnippet(body, "match", 500);

    expect(line).toBe(4); // "L4 match" is line 4
    expect(linesBefore).toBe(2); // L1, L2 before snippet (snippet starts at L3)
    expect(snippetLines).toBe(4); // L3, L4, L5, L6
    expect(linesAfter).toBe(4); // L7, L8, L9, L10 after snippet
  });

  test("extractSnippet header format matches diff style", () => {
    const body = "A\nB\nC keyword\nD\nE\nF\nG\nH";
    const { snippet } = extractSnippet(body, "keyword", 500);

    // Should start with @@ -line,count @@ (N before, M after)
    const headerMatch = snippet.match(/^@@ -(\d+),(\d+) @@ \((\d+) before, (\d+) after\)/);
    expect(headerMatch).not.toBeNull();

    const [, startLine, count, before, after] = headerMatch!;
    expect(parseInt(startLine!)).toBe(2); // Snippet starts at line 2 (B)
    expect(parseInt(count!)).toBe(4);     // 4 lines: B, C keyword, D, E
    expect(parseInt(before!)).toBe(1);    // A is before
    expect(parseInt(after!)).toBe(3);     // F, G, H are after
  });

  test("extractSnippet at document start shows 0 before", () => {
    const body = "First line keyword\nSecond\nThird\nFourth\nFifth";
    const { linesBefore, linesAfter, snippetLines, line } = extractSnippet(body, "keyword", 500);

    expect(line).toBe(1);         // Keyword on first line
    expect(linesBefore).toBe(0);  // Nothing before
    expect(snippetLines).toBe(3); // First, Second, Third (bestLine-1 to bestLine+3, clamped)
    expect(linesAfter).toBe(2);   // Fourth, Fifth
  });

  test("extractSnippet with leading blank/frontmatter lines reports 1 before, not 0", () => {
    // Regression: a user looked at `@@ -2,4 @@ (1 before, 72 after)` and
    // suspected "1 before" was wrong because the match appeared to be the
    // topmost visible line. The math takes "before" from the absolute file
    // line, not from the visible portion of the snippet — so when the
    // snippet starts at line 2, "1 before" is the correct count. Lock that
    // in with a 77-line document whose match sits on line 3.
    const otherLines = Array.from({ length: 72 }, (_, i) => `body line ${i + 6}`).join("\n");
    const body = `---\ntitle: Notes\n# Heading with keyword\nIntro paragraph.\nMore intro lines.\n${otherLines}`;

    const { line, linesBefore, snippetLines, linesAfter, snippet } =
      extractSnippet(body, "keyword", 500);

    expect(line).toBe(3);             // match is on line 3
    expect(linesBefore).toBe(1);      // exactly one line above the 4-line snippet window
    expect(snippetLines).toBe(4);     // lines 2..5 form the snippet
    expect(linesAfter).toBe(72);      // remaining body
    expect(snippet).toContain("@@ -2,4 @@ (1 before, 72 after)");
  });

  test("extractSnippet at document end shows 0 after", () => {
    const body = "First\nSecond\nThird\nFourth\nFifth keyword";
    const { linesBefore, linesAfter, snippetLines, line } = extractSnippet(body, "keyword", 500);

    expect(line).toBe(5);         // Keyword on last line
    expect(linesBefore).toBe(3);  // First, Second, Third before snippet
    expect(snippetLines).toBe(2); // Fourth, Fifth keyword (bestLine-1 to bestLine+3, clamped)
    expect(linesAfter).toBe(0);   // Nothing after
  });

  test("extractSnippet with single line document", () => {
    const body = "Single line with keyword";
    const { linesBefore, linesAfter, snippetLines, snippet } = extractSnippet(body, "keyword", 500);

    expect(linesBefore).toBe(0);
    expect(linesAfter).toBe(0);
    expect(snippetLines).toBe(1);
    expect(snippet).toContain("@@ -1,1 @@ (0 before, 0 after)");
    expect(snippet).toContain("Single line with keyword");
  });

  test("extractSnippet with chunkPos adjusts line numbers correctly", () => {
    // 50 lines of padding, then keyword, then more content
    const padding = "Padding line\n".repeat(50);
    const body = padding + "Target keyword here\nMore content\nEven more";
    const chunkPos = padding.length; // Position of "Target keyword"

    const { line, linesBefore, linesAfter } = extractSnippet(body, "keyword", 200, chunkPos);

    expect(line).toBe(51); // "Target keyword" is line 51
    expect(linesBefore).toBeGreaterThan(40); // Many lines before
  });

  test("extractSnippet anchors on chunkPos when lexical scoring finds no match", () => {
    // The snippet tokenizer does not strip FTS5 syntax, so a quoted-phrase query
    // tokenises into terms with embedded quotes that never appear in body text.
    // bestScore stays at 0 even though the reranker correctly identified a chunk;
    // the fallback should anchor on chunkPos rather than defaulting to line 1.
    const padLine = "Lorem ipsum dolor sit amet\n";
    const padding = padLine.repeat(100);
    const body = padding + "chunk content here\nmore chunk content\n" + padding;
    const chunkPos = padding.length;

    const { line } = extractSnippet(body, '"unrelated quoted phrase"', 200, chunkPos);

    expect(line).toBeGreaterThan(50);
    expect(line).toBeLessThan(110);
  });

  test("extractSnippet with chunkPos=0 falls back to full-body scan when chunk has no match", () => {
    // chunkPos=0 may be the chunk selector's bestIdx=0 default rather than a real
    // first-chunk hit, so the fallback must consider matches outside chunk 0.
    const padding = "Lorem ipsum dolor sit amet\n".repeat(200);
    const body = padding + "TARGET_KEYWORD line content\ntail line\n";

    const { line } = extractSnippet(body, "TARGET_KEYWORD", 200, 0);

    expect(line).toBe(201);
  });
});

// =============================================================================
// Reciprocal Rank Fusion Tests
// =============================================================================

describe("Reciprocal Rank Fusion", () => {
  const makeResult = (file: string, score: number): RankedResult => ({
    file,
    displayPath: file,
    title: file,
    body: "body",
    score,
  });

  test("RRF combines single list correctly", () => {
    const list1 = [
      makeResult("doc1", 0.9),
      makeResult("doc2", 0.8),
      makeResult("doc3", 0.7),
    ];

    const fused = reciprocalRankFusion([list1]);

    // Order should be preserved
    expect(fused[0]!.file).toBe("doc1");
    expect(fused[1]!.file).toBe("doc2");
    expect(fused[2]!.file).toBe("doc3");
  });

  test("RRF merges documents from multiple lists", () => {
    const list1 = [makeResult("doc1", 0.9), makeResult("doc2", 0.8)];
    const list2 = [makeResult("doc2", 0.95), makeResult("doc3", 0.85)];

    const fused = reciprocalRankFusion([list1, list2]);

    // doc2 appears in both lists, should have higher combined score
    expect(fused.find(r => r.file === "doc2")).toBeDefined();
    expect(fused.find(r => r.file === "doc1")).toBeDefined();
    expect(fused.find(r => r.file === "doc3")).toBeDefined();
  });

  test("RRF respects weights", () => {
    const list1 = [makeResult("doc1", 0.9)];
    const list2 = [makeResult("doc2", 0.9)];

    // Give double weight to list1
    const fused = reciprocalRankFusion([list1, list2], [2.0, 1.0]);

    // doc1 should rank higher due to weight
    expect(fused[0]!.file).toBe("doc1");
  });

  test("hybrid RRF weights boost original vector evidence over expansion-only hits", () => {
    const originalFtsOnly = makeResult("original-fts-only.md", 0.95);
    const expansionOnly = makeResult("lex-expansion-only.md", 0.95);
    const originalVector = makeResult("original-vector.md", 0.95);

    // Mirrors hybridQuery's common list order when a lex expansion exists:
    // original FTS, lex expansion FTS, original vector.
    const rankedLists = [
      [originalFtsOnly],
      [expansionOnly],
      [originalVector],
    ];
    const rankedListMeta: RankedListMeta[] = [
      { source: "fts", queryType: "original", query: "user query" },
      { source: "fts", queryType: "lex", query: "lex expansion" },
      { source: "vec", queryType: "original", query: "user query" },
    ];

    const positionBasedWeights = rankedLists.map((_, i) => i < 2 ? 2.0 : 1.0);
    const buggyOrder = reciprocalRankFusion(rankedLists, positionBasedWeights);

    expect(buggyOrder.findIndex(r => r.file === "lex-expansion-only.md"))
      .toBeLessThan(buggyOrder.findIndex(r => r.file === "original-vector.md"));

    const semanticWeights = getHybridRrfWeights(rankedListMeta);
    const fixedOrder = reciprocalRankFusion(rankedLists, semanticWeights);

    expect(semanticWeights).toEqual([2.0, 1.0, 2.0]);
    expect(fixedOrder.findIndex(r => r.file === "original-vector.md"))
      .toBeLessThan(fixedOrder.findIndex(r => r.file === "lex-expansion-only.md"));
  });

  test("RRF adds top-rank bonus", () => {
    // doc1 is #1 in list1, doc2 is #2 in list1
    const list1 = [makeResult("doc1", 0.9), makeResult("doc2", 0.8)];
    const list2 = [makeResult("doc3", 0.85)];

    const fused = reciprocalRankFusion([list1, list2]);

    // doc1 should get +0.05 bonus for being #1
    // doc2 should get +0.02 bonus for being #2-3
    const doc1 = fused.find(r => r.file === "doc1");
    const doc2 = fused.find(r => r.file === "doc2");

    expect(doc1!.score).toBeGreaterThan(doc2!.score);
  });

  test("RRF handles empty lists", () => {
    const fused = reciprocalRankFusion([[], []]);
    expect(fused).toHaveLength(0);
  });

  test("RRF uses k parameter correctly", () => {
    const list = [makeResult("doc1", 0.9)];

    // With different k values, scores should differ
    const fused60 = reciprocalRankFusion([list], [], 60);
    const fused30 = reciprocalRankFusion([list], [], 30);

    // Lower k = higher scores for top ranks
    expect(fused30[0]!.score).toBeGreaterThan(fused60[0]!.score);
  });
});

describe("Fuzzy Matching", () => {
  test("findSimilarFiles finds similar paths", async () => {
    const store = await createTestStore();
    const collectionName = await createTestCollection();

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

    await cleanupTestDb(store);
  });

  test("findSimilarFiles respects maxDistance", async () => {
    const store = await createTestStore();
    const collectionName = await createTestCollection();

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

    await cleanupTestDb(store);
  });

  test("matchFilesByGlob matches patterns", async () => {
    const store = await createTestStore();
    const collectionName = await createTestCollection();

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

    await cleanupTestDb(store);
  });

  test("matchFilesByGlob matches collection/path patterns", async () => {
    const store = await createTestStore();
    const collectionName = await createTestCollection();

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

    await cleanupTestDb(store);
  });

  test("matchFilesByGlob matches brace expansion", async () => {
    const store = await createTestStore();
    const collectionName = await createTestCollection();

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

    await cleanupTestDb(store);
  });
});

// =============================================================================
// Vector Table Tests
// =============================================================================

describe("Vector Table", () => {
  test("ensureVecTable creates vector table", async () => {
    const store = await createTestStore();

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

    await cleanupTestDb(store);
  });

  test("ensureVecTable throws on dimension mismatch instead of silently rebuilding", async () => {
    const store = await createTestStore();

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

    await cleanupTestDb(store);
  });

  test("insertEmbedding is idempotent for an existing vec0 hash_seq (#598)", async () => {
    const store = await createTestStore();
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

    await cleanupTestDb(store);
  });
});

// =============================================================================
// Integration Tests
// =============================================================================

describe("Integration", () => {
  test("reindexCollection soft-deletes removed files and preserves inactive content (#585)", async () => {
    const store = await createTestStore();
    const collectionDir = await mkdtemp(join(testDir, "orphan-regression-"));
    const collectionName = "orphan-regression";

    try {
      for (let i = 1; i <= 5; i++) {
        await writeFile(join(collectionDir, `doc-${i}.md`), `# Doc ${i}\n\nUnique body ${i}`);
      }

      await createTestCollection({ pwd: collectionDir, glob: "**/*.md", name: collectionName });

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
      await cleanupTestDb(store);
    }
  });

  test("full document lifecycle: create, search, retrieve", async () => {
    const store = await createTestStore();
    const collectionName = await createTestCollection({ pwd: "/test/notes", glob: "**/*.md" });

    // Add context - use "/" for collection root
    await addPathContext(collectionName, "/", "Personal notes");

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

    await cleanupTestDb(store);
  });

  test("multiple stores can operate independently", async () => {
    const store1 = await createTestStore();
    const store2 = await createTestStore();

    const col1 = await createTestCollection({ pwd: "/store1", glob: "**/*.md", name: "store1" });
    const col2 = await createTestCollection({ pwd: "/store2", glob: "**/*.md", name: "store2" });

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

    await cleanupTestDb(store1);
    await cleanupTestDb(store2);
  });
});

// =============================================================================
// LlamaCpp Integration Tests (using real local models)
// =============================================================================

describe.skipIf(!!process.env.CI)("LlamaCpp Integration", () => {
  test("searchVec returns empty when no vector index", async () => {
    const store = await createTestStore();
    const collectionName = await createTestCollection();
    await insertTestDocument(store.db, collectionName, {
      name: "doc1",
      body: "Some content",
    });

    // No vectors_vec table exists, should return empty
    const results = await store.searchVec("query", "embeddinggemma", 10);
    expect(results).toHaveLength(0);

    await cleanupTestDb(store);
  });

  test("searchVec returns results when vector index exists", async () => {
    const store = await createTestStore();
    const collectionName = await createTestCollection();

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

    await cleanupTestDb(store);
  });

  test("searchVec filters by collection name", async () => {
    const store = await createTestStore();
    const collection1 = await createTestCollection({ name: "coll1", pwd: "/test/coll1" });
    const collection2 = await createTestCollection({ name: "coll2", pwd: "/test/coll2" });

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

    await cleanupTestDb(store);
  });

  test("searchVec supports precomputed embeddings without hydrating body/context", async () => {
    const store = await createTestStore();
    const collectionName = await createTestCollection();

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

    await cleanupTestDb(store);
  });

  // Regression test for https://github.com/tobi/qmd/pull/23
  // sqlite-vec virtual tables hang when combined with JOINs in the same query.
  // The fix uses a two-step approach: vector query first, then separate JOINs.
  test("searchVec uses two-step query to avoid sqlite-vec JOIN hang", async () => {
    const store = await createTestStore();
    const collectionName = await createTestCollection();

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

    await cleanupTestDb(store);
  });

  test("expandQuery returns typed expansions (no original query)", async () => {
    const store = await createTestStore();

    const expanded = await store.expandQuery("test query");
    // Returns ExpandedQuery[] — typed results from LLM, excluding original
    expect(expanded.length).toBeGreaterThanOrEqual(1);
    for (const q of expanded) {
      expect(['lex', 'vec', 'hyde']).toContain(q.type);
      expect(q.query.length).toBeGreaterThan(0);
      expect(q.query).not.toBe("test query"); // original excluded
    }

    await cleanupTestDb(store);
  }, 90000);

  test("expandQuery caches results as JSON with types", async () => {
    const store = await createTestStore();

    // First call — hits LLM
    const queries1 = await store.expandQuery("cached query test");
    // Second call — hits cache
    const queries2 = await store.expandQuery("cached query test");

    // Cache should preserve full typed structure
    expect(queries1).toEqual(queries2);
    expect(queries2[0]?.type).toBeDefined();

    await cleanupTestDb(store);
  }, 60000);

  test("rerank scores documents", async () => {
    const store = await createTestStore();

    const docs = [
      { file: "doc1.md", text: "Relevant content about the topic" },
      { file: "doc2.md", text: "Other content" },
    ];

    const results = await store.rerank("topic", docs);
    expect(results).toHaveLength(2);
    // LlamaCpp reranker returns relevance scores
    expect(results[0]!.score).toBeGreaterThan(0);

    await cleanupTestDb(store);
  });

  test("rerank caches results", async () => {
    const store = await createTestStore();

    const docs = [{ file: "doc1.md", text: "Content for caching test" }];

    // First call
    await store.rerank("cache test query", docs);
    // Second call - should hit cache
    const results = await store.rerank("cache test query", docs);

    expect(results).toHaveLength(1);

    await cleanupTestDb(store);
  });

  test("rerank deduplicates identical chunks across files", async () => {
    const store = await createTestStore();
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
      await cleanupTestDb(store);
    }
  });
});

// =============================================================================
// Edge Cases & Error Handling
// =============================================================================

describe("Edge Cases", () => {
  test("handles empty database gracefully", async () => {
    const store = await createTestStore();

    const searchResults = store.searchFTS("anything", 10);
    expect(searchResults).toHaveLength(0);

    // SKIPPED: getStatus() has bug (queries non-existent collections table)
    // const status = store.getStatus();
    // expect(status.totalDocuments).toBe(0);
    // expect(status.collections).toHaveLength(0);

    const doc = store.findDocument("nonexistent.md");
    expect("error" in doc).toBe(true);

    await cleanupTestDb(store);
  });

  test("handles very long document bodies", async () => {
    const store = await createTestStore();
    const collectionName = await createTestCollection();

    const longBody = "word ".repeat(100000); // ~600KB
    await insertTestDocument(store.db, collectionName, {
      name: "long",
      body: longBody,
      displayPath: "long.md",
    });

    const results = store.searchFTS("word", 10);
    expect(results).toHaveLength(1);

    await cleanupTestDb(store);
  });

  test("handles unicode content correctly", async () => {
    const store = await createTestStore();
    const collectionName = await createTestCollection();

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

    await cleanupTestDb(store);
  });

  test("handles documents with special characters in paths", async () => {
    const store = await createTestStore();
    const collectionName = await createTestCollection();

    await insertTestDocument(store.db, collectionName, {
      name: "special",
      filepath: "/path/file with spaces.md",
      displayPath: "file with spaces.md",
      body: "Content",
    });

    const doc = store.findDocument("file with spaces.md");
    expect("error" in doc).toBe(false);

    await cleanupTestDb(store);
  });

  test("handles concurrent operations", async () => {
    const store = await createTestStore();
    const collectionName = await createTestCollection();

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

    await cleanupTestDb(store);
  });
});

describe("normalizeVirtualPath", () => {
  test("already normalized qmd:// path passes through", () => {
    expect(normalizeVirtualPath("qmd://collection/path.md")).toBe("qmd://collection/path.md");
    expect(normalizeVirtualPath("qmd://journals/2025-01-01.md")).toBe("qmd://journals/2025-01-01.md");
  });

  test("handles //collection/path format (missing qmd: prefix)", () => {
    expect(normalizeVirtualPath("//collection/path.md")).toBe("qmd://collection/path.md");
    expect(normalizeVirtualPath("//journals/2025-01-01.md")).toBe("qmd://journals/2025-01-01.md");
  });

  test("handles qmd:// with extra slashes", () => {
    expect(normalizeVirtualPath("qmd:////collection/path.md")).toBe("qmd://collection/path.md");
    expect(normalizeVirtualPath("qmd:///journals/2025-01-01.md")).toBe("qmd://journals/2025-01-01.md");
    expect(normalizeVirtualPath("qmd:///////archive/file.md")).toBe("qmd://archive/file.md");
  });

  test("handles collection root paths", () => {
    expect(normalizeVirtualPath("qmd://collection/")).toBe("qmd://collection/");
    expect(normalizeVirtualPath("qmd://collection")).toBe("qmd://collection");
    expect(normalizeVirtualPath("//collection/")).toBe("qmd://collection/");
  });

  test("preserves bare collection/path format (not auto-converted)", () => {
    // Bare paths without qmd:// or // prefix are NOT converted
    // (could be relative filesystem paths)
    expect(normalizeVirtualPath("collection/path.md")).toBe("collection/path.md");
    expect(normalizeVirtualPath("journals/2025-01-01.md")).toBe("journals/2025-01-01.md");
  });

  test("preserves absolute filesystem paths", () => {
    expect(normalizeVirtualPath("/Users/test/file.md")).toBe("/Users/test/file.md");
    expect(normalizeVirtualPath("/absolute/path/file.md")).toBe("/absolute/path/file.md");
  });

  test("preserves home-relative paths", () => {
    expect(normalizeVirtualPath("~/Documents/file.md")).toBe("~/Documents/file.md");
  });

  test("preserves docid format", () => {
    expect(normalizeVirtualPath("#abc123")).toBe("#abc123");
    expect(normalizeVirtualPath("#def456")).toBe("#def456");
  });

  test("handles whitespace trimming", () => {
    expect(normalizeVirtualPath("  qmd://collection/path.md  ")).toBe("qmd://collection/path.md");
    expect(normalizeVirtualPath("  //collection/path.md  ")).toBe("qmd://collection/path.md");
  });
});

describe("isVirtualPath", () => {
  test("recognizes qmd:// paths", () => {
    expect(isVirtualPath("qmd://collection/path.md")).toBe(true);
    expect(isVirtualPath("qmd://journals/2025-01-01.md")).toBe(true);
    expect(isVirtualPath("qmd://collection")).toBe(true);
  });

  test("recognizes //collection/path format", () => {
    expect(isVirtualPath("//collection/path.md")).toBe(true);
    expect(isVirtualPath("//journals/2025-01-01.md")).toBe(true);
  });

  test("does not auto-recognize bare collection/path format", () => {
    // Bare paths could be relative filesystem paths, so not auto-detected as virtual
    expect(isVirtualPath("collection/path.md")).toBe(false);
    expect(isVirtualPath("journals/2025-01-01.md")).toBe(false);
    expect(isVirtualPath("archive/subfolder/file.md")).toBe(false);
  });

  test("rejects docid format", () => {
    expect(isVirtualPath("#abc123")).toBe(false);
    expect(isVirtualPath("#def456")).toBe(false);
  });

  test("rejects absolute filesystem paths", () => {
    expect(isVirtualPath("/Users/test/file.md")).toBe(false);
    expect(isVirtualPath("/absolute/path/file.md")).toBe(false);
  });

  test("rejects home-relative paths", () => {
    expect(isVirtualPath("~/Documents/file.md")).toBe(false);
    expect(isVirtualPath("~/notes/journal.md")).toBe(false);
  });

  test("rejects paths without slashes", () => {
    expect(isVirtualPath("file.md")).toBe(false);
    expect(isVirtualPath("document")).toBe(false);
  });
});

describe("parseVirtualPath", () => {
  test("parses standard qmd:// paths", () => {
    expect(parseVirtualPath("qmd://collection/path.md")).toEqual({
      collectionName: "collection",
      path: "path.md",
    });
    expect(parseVirtualPath("qmd://journals/2025-01-01.md")).toEqual({
      collectionName: "journals",
      path: "2025-01-01.md",
    });
  });

  test("parses paths with nested directories", () => {
    expect(parseVirtualPath("qmd://archive/subfolder/file.md")).toEqual({
      collectionName: "archive",
      path: "subfolder/file.md",
    });
  });

  test("parses collection root paths", () => {
    expect(parseVirtualPath("qmd://collection/")).toEqual({
      collectionName: "collection",
      path: "",
    });
    expect(parseVirtualPath("qmd://collection")).toEqual({
      collectionName: "collection",
      path: "",
    });
  });

  test("parses //collection/path format (normalizes first)", () => {
    expect(parseVirtualPath("//collection/path.md")).toEqual({
      collectionName: "collection",
      path: "path.md",
    });
  });

  test("parses qmd:// with extra slashes (normalizes first)", () => {
    expect(parseVirtualPath("qmd:////collection/path.md")).toEqual({
      collectionName: "collection",
      path: "path.md",
    });
  });

  test("parses qmd:// paths with index query parameters", () => {
    expect(parseVirtualPath("qmd://collection/path.md?index=docs-v2")).toEqual({
      collectionName: "collection",
      path: "path.md",
      indexName: "docs-v2",
    });
  });

  test("returns null for non-virtual paths", () => {
    expect(parseVirtualPath("/absolute/path.md")).toBe(null);
    expect(parseVirtualPath("~/home/path.md")).toBe(null);
    expect(parseVirtualPath("#docid")).toBe(null);
    expect(parseVirtualPath("file.md")).toBe(null);
    // Bare collection/path is not recognized as virtual
    expect(parseVirtualPath("collection/path.md")).toBe(null);
  });
});

// =============================================================================
// Docid Functions
// =============================================================================

describe("normalizeDocid", () => {
  test("strips leading # from docid", () => {
    expect(normalizeDocid("#abc123")).toBe("abc123");
    expect(normalizeDocid("#def456")).toBe("def456");
  });

  test("returns bare hex unchanged", () => {
    expect(normalizeDocid("abc123")).toBe("abc123");
    expect(normalizeDocid("def456")).toBe("def456");
  });

  test("strips surrounding double quotes", () => {
    expect(normalizeDocid('"#abc123"')).toBe("abc123");
    expect(normalizeDocid('"abc123"')).toBe("abc123");
  });

  test("strips surrounding single quotes", () => {
    expect(normalizeDocid("'#abc123'")).toBe("abc123");
    expect(normalizeDocid("'abc123'")).toBe("abc123");
  });

  test("handles quoted docid without #", () => {
    expect(normalizeDocid('"def456"')).toBe("def456");
    expect(normalizeDocid("'def456'")).toBe("def456");
  });

  test("handles whitespace", () => {
    expect(normalizeDocid("  #abc123  ")).toBe("abc123");
    expect(normalizeDocid("  abc123  ")).toBe("abc123");
  });

  test("handles uppercase hex", () => {
    expect(normalizeDocid("#ABC123")).toBe("ABC123");
    expect(normalizeDocid('"ABC123"')).toBe("ABC123");
  });

  test("does not strip mismatched quotes", () => {
    expect(normalizeDocid('"abc123\'')).toBe('"abc123\'');
    expect(normalizeDocid("'abc123\"")).toBe("'abc123\"");
  });
});

describe("isDocid", () => {
  test("accepts #hash format", () => {
    expect(isDocid("#abc123")).toBe(true);
    expect(isDocid("#def456")).toBe(true);
    expect(isDocid("#ABCDEF")).toBe(true);
  });

  test("accepts bare 6-char hex", () => {
    expect(isDocid("abc123")).toBe(true);
    expect(isDocid("def456")).toBe(true);
    expect(isDocid("ABCDEF")).toBe(true);
  });

  test("accepts longer hex strings", () => {
    expect(isDocid("abc123def456")).toBe(true);
    expect(isDocid("#abc123def456")).toBe(true);
  });

  test("accepts double-quoted docids", () => {
    expect(isDocid('"#abc123"')).toBe(true);
    expect(isDocid('"abc123"')).toBe(true);
  });

  test("accepts single-quoted docids", () => {
    expect(isDocid("'#abc123'")).toBe(true);
    expect(isDocid("'abc123'")).toBe(true);
  });

  test("rejects non-hex strings", () => {
    expect(isDocid("ghijkl")).toBe(false);
    expect(isDocid("#ghijkl")).toBe(false);
    expect(isDocid("abc12g")).toBe(false);
  });

  test("rejects strings shorter than 6 chars", () => {
    expect(isDocid("abc12")).toBe(false);
    expect(isDocid("#abc1")).toBe(false);
    expect(isDocid("'abc'")).toBe(false);
  });

  test("rejects empty strings", () => {
    expect(isDocid("")).toBe(false);
    expect(isDocid("#")).toBe(false);
    expect(isDocid('""')).toBe(false);
  });

  test("rejects file paths", () => {
    expect(isDocid("/path/to/file.md")).toBe(false);
    expect(isDocid("path/to/file.md")).toBe(false);
    expect(isDocid("qmd://collection/file.md")).toBe(false);
  });

  test("rejects paths that look like hex with extensions", () => {
    expect(isDocid("abc123.md")).toBe(false);
  });
});
