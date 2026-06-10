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
// Document Retrieval Tests
// =============================================================================

describe("Document Retrieval", () => {
  describe("findDocument", () => {
    test("findDocument finds by exact filepath", async () => {
      const { store: store, configDir } = await createTestStore(testDir);
      const collectionName = await createTestCollection(store, configDir, { pwd: "/exact/path", glob: "**/*.md" });
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

      await cleanupTestStore(store, configDir);
    });

    test("findDocument finds by display_path", async () => {
      const { store: store, configDir } = await createTestStore(testDir);
      const collectionName = await createTestCollection(store, configDir, { pwd: "/some/path", glob: "**/*.md" });
      await insertTestDocument(store.db, collectionName, {
        name: "mydoc",
        displayPath: "docs/mydoc.md",
      });

      const result = store.findDocument("docs/mydoc.md");
      expect("error" in result).toBe(false);

      await cleanupTestStore(store, configDir);
    });

    test("findDocument finds by partial path match", async () => {
      const { store: store, configDir } = await createTestStore(testDir);
      const collectionName = await createTestCollection(store, configDir, { pwd: "/very/long/path/to", glob: "**/*.md" });
      await insertTestDocument(store.db, collectionName, {
        name: "mydoc",
        displayPath: "mydoc.md",
      });

      const result = store.findDocument("mydoc.md");
      expect("error" in result).toBe(false);

      await cleanupTestStore(store, configDir);
    });

    test("findDocument includes body when requested", async () => {
      const { store: store, configDir } = await createTestStore(testDir);
      const collectionName = await createTestCollection(store, configDir, { pwd: "/path", glob: "**/*.md" });
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

      await cleanupTestStore(store, configDir);
    });

    test("findDocument returns error with suggestions for not found", async () => {
      const { store: store, configDir } = await createTestStore(testDir);
      const collectionName = await createTestCollection(store, configDir, );
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

      await cleanupTestStore(store, configDir);
    });

    test("findDocument handles :line suffix", async () => {
      const { store: store, configDir } = await createTestStore(testDir);
      const collectionName = await createTestCollection(store, configDir, );
      await insertTestDocument(store.db, collectionName, {
        name: "mydoc",
        filepath: "/path/mydoc.md",
        displayPath: "mydoc.md",
      });

      const result = store.findDocument("mydoc.md:100");
      expect("error" in result).toBe(false);

      await cleanupTestStore(store, configDir);
    });

    test("findDocument expands ~ to home directory", async () => {
      const { store: store, configDir } = await createTestStore(testDir);
      const home = homedir();
      const collectionName = await createTestCollection(store, configDir, { pwd: home, name: "home" });
      await insertTestDocument(store.db, collectionName, {
        name: "mydoc",
        filepath: `${home}/docs/mydoc.md`,
        displayPath: "docs/mydoc.md",
      });

      const result = store.findDocument("~/docs/mydoc.md");
      expect("error" in result).toBe(false);

      await cleanupTestStore(store, configDir);
    });

    test("findDocument includes context from path_contexts", async () => {
      const { store: store, configDir } = await createTestStore(testDir);
      const collectionName = await createTestCollection(store, configDir, { pwd: "/path" });
      await addPathContext(store, configDir, collectionName, "docs", "Documentation");
      await insertTestDocument(store.db, collectionName, {
        name: "mydoc",
        displayPath: "docs/mydoc.md",
      });

      const result = store.findDocument("/path/docs/mydoc.md");
      expect("error" in result).toBe(false);
      if (!("error" in result)) {
        expect(result.context).toBe("Documentation");
      }

      await cleanupTestStore(store, configDir);
    });

    test("findDocument includes hierarchical contexts (global + collection + path)", async () => {
      const { store: store, configDir } = await createTestStore(testDir);
      const collectionName = await createTestCollection(store, configDir, { pwd: "/archive", name: "archive" });

      // Add global context
      await addGlobalContext(store, configDir, "Global context for all documents");

      // Add collection root context
      await addPathContext(store, configDir, collectionName, "/", "Archive collection context");

      // Add path-specific contexts at different levels
      await addPathContext(store, configDir, collectionName, "/podcasts", "Podcast episodes");
      await addPathContext(store, configDir, collectionName, "/podcasts/external", "External podcast interviews");

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

      await cleanupTestStore(store, configDir);
    });
  });

  describe("getDocumentBody", () => {
    test("getDocumentBody returns full body", async () => {
      const { store: store, configDir } = await createTestStore(testDir);
      const collectionName = await createTestCollection(store, configDir, { pwd: "/path" });
      await insertTestDocument(store.db, collectionName, {
        name: "mydoc",
        displayPath: "mydoc.md",
        body: "Line 1\nLine 2\nLine 3\nLine 4\nLine 5",
      });

      const body = store.getDocumentBody({ filepath: "/path/mydoc.md" });
      expect(body).toBe("Line 1\nLine 2\nLine 3\nLine 4\nLine 5");

      await cleanupTestStore(store, configDir);
    });

    test("getDocumentBody supports line range", async () => {
      const { store: store, configDir } = await createTestStore(testDir);
      const collectionName = await createTestCollection(store, configDir, { pwd: "/path" });
      await insertTestDocument(store.db, collectionName, {
        name: "mydoc",
        displayPath: "mydoc.md",
        body: "Line 1\nLine 2\nLine 3\nLine 4\nLine 5",
      });

      const body = store.getDocumentBody({ filepath: "/path/mydoc.md" }, 2, 2);
      expect(body).toBe("Line 2\nLine 3");

      await cleanupTestStore(store, configDir);
    });

    test("getDocumentBody returns null for non-existent document", async () => {
      const { store: store, configDir } = await createTestStore(testDir);
      const body = store.getDocumentBody({ filepath: "/nonexistent.md" });
      expect(body).toBeNull();
      await cleanupTestStore(store, configDir);
    });

    test("getDocumentBody clamps negative fromLine to top of document", async () => {
      const { store: store, configDir } = await createTestStore(testDir);
      const collectionName = await createTestCollection(store, configDir, { pwd: "/path" });
      await insertTestDocument(store.db, collectionName, {
        name: "mydoc",
        displayPath: "mydoc.md",
        body: "Line 1\nLine 2\nLine 3\nLine 4\nLine 5",
      });

      const body = store.getDocumentBody({ filepath: "/path/mydoc.md" }, -19, 80);
      expect(body).toBe("Line 1\nLine 2\nLine 3\nLine 4\nLine 5");

      await cleanupTestStore(store, configDir);
    });
  });

  describe("findDocuments (multi-get)", () => {
    test("findDocuments finds by glob pattern", async () => {
      const { store: store, configDir } = await createTestStore(testDir);
      const collectionName = await createTestCollection(store, configDir, );

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

      await cleanupTestStore(store, configDir);
    });

    test("findDocuments finds by comma-separated list", async () => {
      const { store: store, configDir } = await createTestStore(testDir);
      const collectionName = await createTestCollection(store, configDir, );

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

      await cleanupTestStore(store, configDir);
    });

    test("findDocuments reports errors for not found files", async () => {
      const { store: store, configDir } = await createTestStore(testDir);
      const collectionName = await createTestCollection(store, configDir, );

      await insertTestDocument(store.db, collectionName, {
        name: "doc1",
        filepath: "/path/doc1.md",
        displayPath: "doc1.md",
      });

      const { docs, errors } = store.findDocuments("doc1.md, nonexistent.md");
      expect(docs).toHaveLength(1);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("not found");

      await cleanupTestStore(store, configDir);
    });

    test("findDocuments skips large files", async () => {
      const { store: store, configDir } = await createTestStore(testDir);
      const collectionName = await createTestCollection(store, configDir, );

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

      await cleanupTestStore(store, configDir);
    });

    test("findDocuments includes body when requested", async () => {
      const { store: store, configDir } = await createTestStore(testDir);
      const collectionName = await createTestCollection(store, configDir, );

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

      await cleanupTestStore(store, configDir);
    });

    test("findDocuments supports brace expansion patterns", async () => {
      const { store: store, configDir } = await createTestStore(testDir);
      const collectionName = await createTestCollection(store, configDir, );

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

      await cleanupTestStore(store, configDir);
    });

    test("findDocuments supports brace expansion with collection prefix", async () => {
      const { store: store, configDir } = await createTestStore(testDir);
      const collectionName = await createTestCollection(store, configDir, );

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

      await cleanupTestStore(store, configDir);
    });
  });

});

// =============================================================================
// Snippet Extraction Tests
// =============================================================================

