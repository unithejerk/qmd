/**
 * store/document-ops.test.ts - Tests for document helpers and content-addressable storage
 *
 * Run with: bun test store/document-ops.test.ts
 */

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { createStore, syncConfigToDb } from "../../src/store.js";
import { hashContent, extractTitle, insertContent, insertDocument, findActiveDocument, findOrMigrateLegacyDocument } from "../../src/store/document-ops.js";
import { handelize } from "../../src/store/retrieval-paths.js";
import type { Database } from "../../src/db.js";
import type { Store, CollectionConfig } from "../../src/store.js";
import { unlink, mkdtemp, rmdir, writeFile, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { disposeDefaultLlamaCpp } from "../../src/llm.js";

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
// Document Hashing & Title Extraction Tests
// =============================================================================

describe("Document Helpers", () => {
  test("hashContent produces consistent SHA256 hashes", async () => {
    const content = "Hello, World!";
    const hash1 = await hashContent(content);
    const hash2 = await hashContent(content);
    expect(hash1).toBe(hash2);
    expect(hash1).toMatch(/^[a-f0-9]{64}$/);
  });

  test("hashContent produces different hashes for different content", async () => {
    const hash1 = await hashContent("Hello");
    const hash2 = await hashContent("World");
    expect(hash1).not.toBe(hash2);
  });

  test("extractTitle extracts H1 heading", () => {
    const content = "# My Title\n\nSome content here.";
    expect(extractTitle(content, "file.md")).toBe("My Title");
  });

  test("extractTitle extracts H2 heading if no H1", () => {
    const content = "## My Subtitle\n\nSome content here.";
    expect(extractTitle(content, "file.md")).toBe("My Subtitle");
  });

  test("extractTitle falls back to filename", () => {
    const content = "Just some plain text without headings.";
    expect(extractTitle(content, "my-document.md")).toBe("my-document");
  });

  test("extractTitle skips generic 'Notes' heading", () => {
    const content = "# Notes\n\n## Actual Title\n\nContent";
    expect(extractTitle(content, "file.md")).toBe("Actual Title");
  });

  test("extractTitle handles 📝 Notes heading", () => {
    const content = "# 📝 Notes\n\n## Meeting Summary\n\nContent";
    expect(extractTitle(content, "file.md")).toBe("Meeting Summary");
  });
});

// =============================================================================
// Content-Addressable Storage Tests
// =============================================================================

describe("Content-Addressable Storage", () => {
  test("same content gets same hash from multiple collections", async () => {
    const store = await createTestStore();

    // Create two collections
    const collection1 = await createTestCollection({ pwd: "/path/collection1", name: "collection1" });
    const collection2 = await createTestCollection({ pwd: "/path/collection2", name: "collection2" });

    // Add same content to both collections
    const content = "# Same Content\n\nThis is the same content in two places.";
    const hash1 = await hashContent(content);

    const doc1 = await insertTestDocument(store.db, collection1, {
      name: "doc1",
      body: content,
      displayPath: "doc1.md",
    });

    const doc2 = await insertTestDocument(store.db, collection2, {
      name: "doc2",
      body: content,
      displayPath: "doc2.md",
    });

    // Both should have the same hash
    const hash1Db = store.db.prepare(`SELECT hash FROM documents WHERE id = ?`).get(doc1) as { hash: string };
    const hash2Db = store.db.prepare(`SELECT hash FROM documents WHERE id = ?`).get(doc2) as { hash: string };

    expect(hash1Db.hash).toBe(hash2Db.hash);
    expect(hash1Db.hash).toBe(hash1);

    // There should only be one entry in the content table
    const contentCount = store.db.prepare(`SELECT COUNT(*) as count FROM content WHERE hash = ?`).get(hash1) as { count: number };
    expect(contentCount.count).toBe(1);

    await cleanupTestDb(store);
  });

  test("removing one collection preserves content used by another", async () => {
    const store = await createTestStore();

    // Create two collections
    const collection1 = await createTestCollection({ pwd: "/path/collection1", name: "collection1" });
    const collection2 = await createTestCollection({ pwd: "/path/collection2", name: "collection2" });

    // Add same content to both collections
    const sharedContent = "# Shared Content\n\nThis is shared.";
    const sharedHash = await hashContent(sharedContent);

    await insertTestDocument(store.db, collection1, {
      name: "shared1",
      body: sharedContent,
      displayPath: "shared1.md",
    });

    await insertTestDocument(store.db, collection2, {
      name: "shared2",
      body: sharedContent,
      displayPath: "shared2.md",
    });

    // Add unique content to collection1
    const uniqueContent = "# Unique Content\n\nThis is unique to collection1.";
    const uniqueHash = await hashContent(uniqueContent);

    await insertTestDocument(store.db, collection1, {
      name: "unique",
      body: uniqueContent,
      displayPath: "unique.md",
    });

    // Verify both hashes exist in content table
    const sharedExists1 = store.db.prepare(`SELECT hash FROM content WHERE hash = ?`).get(sharedHash);
    const uniqueExists1 = store.db.prepare(`SELECT hash FROM content WHERE hash = ?`).get(uniqueHash);
    expect(sharedExists1).toBeTruthy();
    expect(uniqueExists1).toBeTruthy();

    // Remove collection1 documents (collections are in YAML now)
    store.db.prepare(`DELETE FROM documents WHERE collection = ?`).run(collection1);

    // Clean up orphaned content (mimics what the CLI does)
    store.db.prepare(`
      DELETE FROM content
      WHERE hash NOT IN (SELECT DISTINCT hash FROM documents WHERE active = 1)
    `).run();

    // Shared content should still exist (used by collection2)
    const sharedExists2 = store.db.prepare(`SELECT hash FROM content WHERE hash = ?`).get(sharedHash);
    expect(sharedExists2).toBeTruthy();

    // Unique content should be removed (only used by collection1)
    const uniqueExists2 = store.db.prepare(`SELECT hash FROM content WHERE hash = ?`).get(uniqueHash);
    expect(uniqueExists2).toBeFalsy();

    await cleanupTestDb(store);
  });

  test("deduplicates content across many collections", async () => {
    const store = await createTestStore();

    const sharedContent = "# Common Header\n\nThis appears everywhere.";
    const sharedHash = await hashContent(sharedContent);

    // Create 5 collections with the same content
    const collectionNames = [];
    for (let i = 0; i < 5; i++) {
      const collName = await createTestCollection({ pwd: `/path/collection${i}`, name: `collection${i}` });
      collectionNames.push(collName);

      await insertTestDocument(store.db, collName, {
        name: `doc${i}`,
        body: sharedContent,
        displayPath: `doc${i}.md`,
      });
    }

    // Should have 5 documents
    const docCount = store.db.prepare(`SELECT COUNT(*) as count FROM documents WHERE active = 1`).get() as { count: number };
    expect(docCount.count).toBe(5);

    // But only 1 content entry
    const contentCount = store.db.prepare(`SELECT COUNT(*) as count FROM content WHERE hash = ?`).get(sharedHash) as { count: number };
    expect(contentCount.count).toBe(1);

    // All documents should point to the same hash
    const hashes = store.db.prepare(`SELECT DISTINCT hash FROM documents WHERE active = 1`).all() as { hash: string }[];
    expect(hashes).toHaveLength(1);
    expect(hashes[0]!.hash).toBe(sharedHash);

    await cleanupTestDb(store);
  });

  test("different content gets different hashes", async () => {
    const store = await createTestStore();
    const collectionName = await createTestCollection();

    const content1 = "# Content One";
    const content2 = "# Content Two";
    const hash1 = await hashContent(content1);
    const hash2 = await hashContent(content2);

    // Hashes should be different
    expect(hash1).not.toBe(hash2);

    const doc1 = await insertTestDocument(store.db, collectionName, {
      name: "doc1",
      body: content1,
      displayPath: "doc1.md",
    });

    const doc2 = await insertTestDocument(store.db, collectionName, {
      name: "doc2",
      body: content2,
      displayPath: "doc2.md",
    });

    // Both hashes should exist in content table
    const hash1Db = store.db.prepare(`SELECT hash FROM documents WHERE id = ?`).get(doc1) as { hash: string };
    const hash2Db = store.db.prepare(`SELECT hash FROM documents WHERE id = ?`).get(doc2) as { hash: string };

    expect(hash1Db.hash).toBe(hash1);
    expect(hash2Db.hash).toBe(hash2);
    expect(hash1Db.hash).not.toBe(hash2Db.hash);

    // Should have 2 entries in content table
    const contentCount = store.db.prepare(`SELECT COUNT(*) as count FROM content`).get() as { count: number };
    expect(contentCount.count).toBe(2);

    await cleanupTestDb(store);
  });

  test("re-indexing a previously deactivated path reactivates instead of violating UNIQUE", async () => {
    const store = await createTestStore();
    const collectionName = await createTestCollection();
    const now = new Date().toISOString();

    const oldContent = "# First Version";
    const oldHash = await hashContent(oldContent);
    store.insertContent(oldHash, oldContent, now);
    store.insertDocument(collectionName, "docs/foo.md", "foo", oldHash, now, now);

    // Simulate file removal during update pass.
    store.deactivateDocument(collectionName, "docs/foo.md");
    expect(store.findActiveDocument(collectionName, "docs/foo.md")).toBeNull();

    // Simulate file coming back in a later update pass.
    const newContent = "# Second Version";
    const newHash = await hashContent(newContent);
    store.insertContent(newHash, newContent, now);

    expect(() => {
      store.insertDocument(collectionName, "docs/foo.md", "foo", newHash, now, now);
    }).not.toThrow();

    const rows = store.db.prepare(`
      SELECT id, hash, active FROM documents
      WHERE collection = ? AND path = ?
    `).all(collectionName, "docs/foo.md") as { id: number; hash: string; active: number }[];

    expect(rows).toHaveLength(1);
    expect(rows[0]!.active).toBe(1);
    expect(rows[0]!.hash).toBe(newHash);

    await cleanupTestDb(store);
  });

  test("findOrMigrateLegacyDocument renames lowercase path to case-preserved", async () => {
    const store = await createTestStore();
    const collectionName = await createTestCollection();
    const now = new Date().toISOString();

    const content = "# My Skill";
    const hash = await hashContent(content);
    store.insertContent(hash, content, now);
    // Simulate legacy index: path stored as lowercase
    store.insertDocument(collectionName, "skills/skill.md", "My Skill", hash, now, now);

    // Migration: look up case-preserved path, expect rename
    const result = store.findOrMigrateLegacyDocument(collectionName, "skills/SKILL.md");
    expect(result).not.toBeNull();
    expect(result!.hash).toBe(hash);

    // Old lowercase path should no longer be findable
    expect(store.findActiveDocument(collectionName, "skills/skill.md")).toBeNull();
    // New case-preserved path should be active
    const migrated = store.findActiveDocument(collectionName, "skills/SKILL.md");
    expect(migrated).not.toBeNull();
    expect(migrated!.hash).toBe(hash);

    // FTS should reflect the new path (documents_au trigger)
    const ftsRow = store.db.prepare(
      `SELECT filepath FROM documents_fts WHERE rowid = ?`
    ).get(result!.id) as { filepath: string } | undefined;
    expect(ftsRow).toBeDefined();
    expect(ftsRow!.filepath).toContain("SKILL.md");

    await cleanupTestDb(store);
  });

  test("findOrMigrateLegacyDocument returns null when path is already lowercase", async () => {
    const store = await createTestStore();
    const collectionName = await createTestCollection();

    // No document exists at all
    const result = store.findOrMigrateLegacyDocument(collectionName, "readme.md");
    expect(result).toBeNull();

    await cleanupTestDb(store);
  });

  test("findOrMigrateLegacyDocument returns existing doc when canonical path already present", async () => {
    const store = await createTestStore();
    const collectionName = await createTestCollection();
    const now = new Date().toISOString();

    const content = "# Content";
    const hash = await hashContent(content);
    store.insertContent(hash, content, now);
    // Both lowercase and case-preserved paths exist (edge case from prior partial migration)
    store.insertDocument(collectionName, "readme.md", "Readme", hash, now, now);
    store.insertDocument(collectionName, "README.md", "README", hash, now, now);

    // Should return the canonical-path document directly (fast path)
    // The legacy "readme.md" row is untouched — no rename attempted.
    const result = store.findOrMigrateLegacyDocument(collectionName, "README.md");
    expect(result).not.toBeNull();
    expect(result!.hash).toBe(hash);

    // Both rows still exist (legacy row not migrated, not deactivated here)
    expect(store.findActiveDocument(collectionName, "readme.md")).not.toBeNull();
    expect(store.findActiveDocument(collectionName, "README.md")).not.toBeNull();

    await cleanupTestDb(store);
  });

  test("findOrMigrateLegacyDocument migrates a handelized legacy path to the literal path", async () => {
    const store = await createTestStore();
    const collectionName = await createTestCollection();
    const now = new Date().toISOString();

    const content = "# Budget\n\nQuarterly numbers.";
    const hash = await hashContent(content);
    const literalPath = "Budget & Revenue (Q4) [2024].md";
    const legacyPath = handelize(literalPath);

    insertContent(store.db, hash, content, now);
    insertDocument(store.db, collectionName, legacyPath, "Budget", hash, now, now);

    const result = findOrMigrateLegacyDocument(store.db, collectionName, literalPath);
    expect(result).not.toBeNull();
    expect(result!.hash).toBe(hash);

    expect(findActiveDocument(store.db, collectionName, legacyPath)).toBeNull();
    const migrated = findActiveDocument(store.db, collectionName, literalPath);
    expect(migrated).not.toBeNull();
    expect(migrated!.hash).toBe(hash);

    await cleanupTestDb(store);
  });
});
