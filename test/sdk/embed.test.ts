/**
 * Auto-generated split from test/sdk.test.ts
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import YAML from "yaml";
import {
  createStore,
  type QMDStore,
  type CollectionConfig,
  type StoreOptions,
} from "../../src/index.js";
import { setDefaultLlamaCpp } from "../../src/llm.js";
let testDir: string;
let docsDir: string;
let notesDir: string;

beforeAll(async () => {
  testDir = await mkdtemp(join(tmpdir(), "qmd-sdk-test-"));
  docsDir = join(testDir, "docs");
  notesDir = join(testDir, "notes");
  await mkdir(docsDir, { recursive: true });
  await mkdir(notesDir, { recursive: true });
  await writeFile(join(docsDir, "readme.md"), "# Getting Started\n\nThis is the getting started guide for the project.\n");
  await writeFile(join(docsDir, "auth.md"), "# Authentication\n\nAuthentication uses JWT tokens for session management.\nUsers log in with email and password.\n");
  await writeFile(join(docsDir, "api.md"), "# API Reference\n\n## Endpoints\n\n### POST /login\nAuthenticate a user.\n\n### GET /users\nList all users.\n");
  await writeFile(join(notesDir, "meeting-2025-01.md"), "# January Planning Meeting\n\nDiscussed Q1 roadmap and resource allocation.\n");
  await writeFile(join(notesDir, "meeting-2025-02.md"), "# February Standup\n\nReviewed sprint progress. Authentication feature is on track.\n");
  await writeFile(join(notesDir, "ideas.md"), "# Project Ideas\n\n- Build a search engine\n- Create a knowledge base\n- Implement vector search\n");
});

afterAll(async () => {
  try { await rm(testDir, { recursive: true, force: true }); } catch {}
});

function freshDbPath(): string {
  return join(testDir, `test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
}


describe("embed", () => {
  function createFakeTokenizer() {
    return {
      async tokenize(text: string) {
        return new Array(Math.max(1, Math.ceil(text.length / 16))).fill(1);
      },
    };
  }

  function createFakeEmbedLlm() {
    const embedBatchCalls: string[][] = [];
    return {
      embedBatchCalls,
      async embed(_text: string) {
        return { embedding: [0.1, 0.2, 0.3], model: "fake-embed" };
      },
      async embedBatch(texts: string[]) {
        embedBatchCalls.push([...texts]);
        return texts.map((_text, index) => ({
          embedding: [index + 1, index + 2, index + 3],
          model: "fake-embed",
        }));
      },
    };
  }

  test("store.embed forwards batch limit options", async () => {
    const store = await createStore({
      dbPath: freshDbPath(),
      config: {
        collections: {
          docs: { path: docsDir, pattern: "**/*.md" },
        },
      },
    });

    const fakeLlm = createFakeEmbedLlm();
    setDefaultLlamaCpp(createFakeTokenizer() as any);
    store.internal.llm = fakeLlm as any;

    try {
      await store.update();
      const result = await store.embed({
        maxDocsPerBatch: 1,
        maxBatchBytes: 1024 * 1024,
      });

      expect(fakeLlm.embedBatchCalls).toHaveLength(3);
      expect(fakeLlm.embedBatchCalls.map(call => call.length)).toEqual([1, 1, 1]);
      expect(result.docsProcessed).toBe(3);
      expect(result.chunksEmbedded).toBe(3);
    } finally {
      setDefaultLlamaCpp(null);
      await store.close();
    }
  });

  test("store.embed scopes pending documents to the requested collection", async () => {
    const store = await createStore({
      dbPath: freshDbPath(),
      config: {
        collections: {
          docs: { path: docsDir, pattern: "**/*.md" },
          notes: { path: notesDir, pattern: "**/*.md" },
        },
      },
    });

    const fakeLlm = createFakeEmbedLlm();
    setDefaultLlamaCpp(createFakeTokenizer() as any);
    store.internal.llm = fakeLlm as any;

    try {
      await store.update();
      const result = await store.embed({ collection: "docs" });

      const vectorCounts = store.internal.db.prepare(`
        SELECT d.collection, COUNT(DISTINCT v.hash) AS count
        FROM documents d
        LEFT JOIN content_vectors v ON v.hash = d.hash AND v.seq = 0
        WHERE d.active = 1
        GROUP BY d.collection
        ORDER BY d.collection
      `).all() as Array<{ collection: string; count: number }>;

      expect(result.docsProcessed).toBe(3);
      expect(result.chunksEmbedded).toBe(3);
      expect(vectorCounts).toEqual([
        { collection: "docs", count: 3 },
        { collection: "notes", count: 0 },
      ]);
    } finally {
      setDefaultLlamaCpp(null);
      await store.close();
    }
  });

  test("store.embed with force only clears the requested collection", async () => {
    const store = await createStore({
      dbPath: freshDbPath(),
      config: {
        collections: {
          docs: { path: docsDir, pattern: "**/*.md" },
          notes: { path: notesDir, pattern: "**/*.md" },
        },
      },
    });

    const fakeLlm = createFakeEmbedLlm();
    setDefaultLlamaCpp(createFakeTokenizer() as any);
    store.internal.llm = fakeLlm as any;

    const vectorCounts = () => store.internal.db.prepare(`
      SELECT d.collection, COUNT(DISTINCT v.hash) AS count
      FROM documents d
      LEFT JOIN content_vectors v ON v.hash = d.hash AND v.seq = 0
      WHERE d.active = 1
      GROUP BY d.collection
      ORDER BY d.collection
    `).all() as Array<{ collection: string; count: number }>;

    try {
      await store.update();
      await store.embed();
      expect(vectorCounts()).toEqual([
        { collection: "docs", count: 3 },
        { collection: "notes", count: 3 },
      ]);

      const result = await store.embed({ force: true, collection: "docs" });

      expect(result.docsProcessed).toBe(3);
      expect(result.chunksEmbedded).toBe(3);
      expect(vectorCounts()).toEqual([
        { collection: "docs", count: 3 },
        { collection: "notes", count: 3 },
      ]);
    } finally {
      setDefaultLlamaCpp(null);
      await store.close();
    }
  });

  test("store.embed rejects invalid batch limits", async () => {
    const store = await createStore({
      dbPath: freshDbPath(),
      config: { collections: {} },
    });

    try {
      await expect(store.embed({ maxDocsPerBatch: 0 })).rejects.toThrow("maxDocsPerBatch");
      await expect(store.embed({ maxBatchBytes: 0 })).rejects.toThrow("maxBatchBytes");
    } finally {
      setDefaultLlamaCpp(null);
      await store.close();
    }
  });
});

// =============================================================================
// Lifecycle Tests
// =============================================================================

