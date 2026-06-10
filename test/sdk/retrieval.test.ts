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
// Document Retrieval Tests
// =============================================================================

describe("get and multiGet", () => {
  let store: QMDStore;

  beforeAll(async () => {
    store = await createStore({
      dbPath: join(testDir, "get-test.sqlite"),
      config: {
        collections: {
          docs: { path: docsDir, pattern: "**/*.md" },
        },
      },
    });

    // Index documents
    const now = new Date().toISOString();
    const { internal } = store;
    const fs = require("fs");

    for (const file of ["readme.md", "auth.md", "api.md"]) {
      const fullPath = join(docsDir, file);
      const content = fs.readFileSync(fullPath, "utf-8");
      const hash = require("crypto").createHash("sha256").update(content).digest("hex");
      const title = content.match(/^#\s+(.+)/m)?.[1] || file;

      internal.insertContent(hash, content, now);
      internal.insertDocument("docs", `qmd://docs/${file}`, title, hash, now, now);
    }
  });

  afterAll(async () => {
    await store.close();
  });

  test("get retrieves a document by path", async () => {
    const result = await store.get("qmd://docs/auth.md");

    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      expect(result.title).toBe("Authentication");
      expect(result.collectionName).toBe("docs");
    }
  });

  test("get with includeBody returns body content", async () => {
    const result = await store.get("qmd://docs/auth.md", { includeBody: true });

    if (!("error" in result)) {
      expect(result.body).toBeDefined();
      expect(result.body).toContain("JWT tokens");
    }
  });

  test("get returns not_found for missing document", async () => {
    const result = await store.get("qmd://docs/nonexistent.md");

    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toBe("not_found");
    }
  });

  test("get by docid", async () => {
    // First get a document to find its docid
    const doc = await store.get("qmd://docs/readme.md");
    if (!("error" in doc)) {
      const byDocid = await store.get(`#${doc.docid}`);
      expect("error" in byDocid).toBe(false);
      if (!("error" in byDocid)) {
        expect(byDocid.docid).toBe(doc.docid);
      }
    }
  });

  test("multiGet retrieves multiple documents", async () => {
    const { docs, errors } = await store.multiGet("qmd://docs/*.md");
    expect(docs.length).toBeGreaterThan(0);
  });
});

// =============================================================================
// Index Health Tests
// =============================================================================

