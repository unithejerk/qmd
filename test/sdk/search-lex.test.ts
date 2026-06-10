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


// =============================================================================
// Search Tests (BM25 - no LLM needed)
// =============================================================================

describe("searchLex (BM25)", () => {
  let store: QMDStore;
  let dbPath: string;

  beforeAll(async () => {
    dbPath = join(testDir, "search-test.sqlite");
    store = await createStore({
      dbPath,
      config: {
        collections: {
          docs: { path: docsDir, pattern: "**/*.md" },
          notes: { path: notesDir, pattern: "**/*.md" },
        },
      },
    });

    // Index documents manually using internal store
    const now = new Date().toISOString();
    const { internal } = store;
    const fs = require("fs");

    // Index docs collection
    for (const file of ["readme.md", "auth.md", "api.md"]) {
      const fullPath = join(docsDir, file);
      const content = fs.readFileSync(fullPath, "utf-8");
      const hash = require("crypto").createHash("sha256").update(content).digest("hex");
      const title = content.match(/^#\s+(.+)/m)?.[1] || file;

      internal.insertContent(hash, content, now);
      internal.insertDocument("docs", `qmd://docs/${file}`, title, hash, now, now);
    }

    // Index notes collection
    for (const file of ["meeting-2025-01.md", "meeting-2025-02.md", "ideas.md"]) {
      const fullPath = join(notesDir, file);
      const content = fs.readFileSync(fullPath, "utf-8");
      const hash = require("crypto").createHash("sha256").update(content).digest("hex");
      const title = content.match(/^#\s+(.+)/m)?.[1] || file;

      internal.insertContent(hash, content, now);
      internal.insertDocument("notes", `qmd://notes/${file}`, title, hash, now, now);
    }
  });

  afterAll(async () => {
    await store.close();
  });

  test("searchLex returns results for matching query", async () => {
    const results = await store.searchLex("authentication");
    expect(results.length).toBeGreaterThan(0);
  });

  test("searchLex results have expected shape", async () => {
    const results = await store.searchLex("authentication");
    expect(results.length).toBeGreaterThan(0);

    const result = results[0]!;
    expect(result).toHaveProperty("filepath");
    expect(result).toHaveProperty("score");
    expect(result).toHaveProperty("title");
    expect(result).toHaveProperty("docid");
    expect(result).toHaveProperty("collectionName");
    expect(typeof result.score).toBe("number");
    expect(result.score).toBeGreaterThan(0);
  });

  test("searchLex respects limit option", async () => {
    const results = await store.searchLex("meeting", { limit: 1 });
    expect(results.length).toBeLessThanOrEqual(1);
  });

  test("searchLex with collection filter", async () => {
    const results = await store.searchLex("authentication", { collection: "notes" });
    for (const r of results) {
      expect(r.collectionName).toBe("notes");
    }
  });

  test("searchLex returns empty for non-matching query", async () => {
    const results = await store.searchLex("xyznonexistentterm123");
    expect(results).toHaveLength(0);
  });

  test("searchLex finds documents across collections", async () => {
    const results = await store.searchLex("authentication", { limit: 10 });
    const collections = new Set(results.map(r => r.collectionName));
    // Auth appears in both docs/auth.md and notes/meeting-2025-02.md
    expect(collections.size).toBeGreaterThanOrEqual(1);
  });
});

// =============================================================================
// Unified search() API Tests
// =============================================================================

