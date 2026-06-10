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
import { MockLLM } from "../helpers/mock-llm.js";

let testDir: string;
let docsDir: string;
let notesDir: string;

beforeAll(async () => {
  setDefaultLlamaCpp(new MockLLM() as any);
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
  setDefaultLlamaCpp(null);
  try { await rm(testDir, { recursive: true, force: true }); } catch {}
});

function freshDbPath(): string {
  return join(testDir, `test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
}


// =============================================================================
// Unified search() API Tests
// =============================================================================

describe("search (unified API)", () => {
  let store: QMDStore;

  beforeAll(async () => {
    store = await createStore({
      dbPath: join(testDir, "unified-search-test.sqlite"),
      config: {
        collections: {
          docs: { path: docsDir, pattern: "**/*.md" },
          notes: { path: notesDir, pattern: "**/*.md" },
        },
      },
    });
    await store.update();
  });

  afterAll(async () => {
    await store.close();
  });

  test("search() requires query or queries", async () => {
    await expect(store.search({} as SearchOptions)).rejects.toThrow("requires either 'query' or 'queries'");
  });

  test("search() with pre-expanded queries and rerank:false", async () => {
    const results = await store.search({
      queries: [
        { type: "lex", query: "authentication JWT" },
        { type: "lex", query: "login session" },
      ],
      rerank: false,
    });
    expect(results.length).toBeGreaterThan(0);
  });

  test("search() forwards candidateLimit to structured search", async () => {
    const results = await store.search({
      queries: [
        { type: "lex", query: "authentication" },
        { type: "lex", query: "meeting" },
      ],
      limit: 5,
      candidateLimit: 1,
      rerank: false,
    });

    expect(results).toHaveLength(1);
  });

  // Tests below use search({ query: ... }) which triggers LLM query expansion
  describe.skipIf(!!process.env.CI)("with LLM query expansion", () => {
    test("search() with query and rerank:false returns results", async () => {
      const results = await store.search({ query: "authentication", rerank: false });
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]).toHaveProperty("file");
      expect(results[0]).toHaveProperty("score");
      expect(results[0]).toHaveProperty("title");
      expect(results[0]).toHaveProperty("bestChunk");
      expect(results[0]).toHaveProperty("docid");
    }, 90000);

    test("search() with intent and rerank:false returns results", async () => {
      const results = await store.search({
        query: "meeting",
        intent: "quarterly planning and roadmap",
        rerank: false,
      });
      expect(results.length).toBeGreaterThan(0);
    }, 60000);

    test("search() with collection filter", async () => {
      const results = await store.search({
        query: "authentication",
        collection: "docs",
        rerank: false,
      });
      for (const r of results) {
        expect(r.file).toMatch(/^qmd:\/\/docs\//);
      }
    });

    test("search() with collections filter", async () => {
      const results = await store.search({
        query: "authentication",
        collections: ["docs"],
        rerank: false,
      });
      for (const r of results) {
        expect(r.file).toMatch(/^qmd:\/\/docs\//);
      }
    });

    test("search() with limit", async () => {
      const results = await store.search({ query: "meeting", limit: 1, rerank: false });
      expect(results.length).toBeLessThanOrEqual(1);
    });

    test("search() returns empty for non-matching query", async () => {
      const results = await store.search({ query: "xyznonexistentterm123", rerank: false });
      expect(results).toHaveLength(0);
    });
  });
});

// =============================================================================
// Document Retrieval Tests
// =============================================================================

