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
// Update Tests
// =============================================================================

describe("update", () => {
  test("indexes files and returns correct stats", async () => {
    const store = await createStore({
      dbPath: freshDbPath(),
      config: {
        collections: {
          docs: { path: docsDir, pattern: "**/*.md" },
        },
      },
    });

    const result = await store.update();

    expect(result.collections).toBe(1);
    expect(result.indexed).toBe(3); // readme.md, auth.md, api.md
    expect(result.updated).toBe(0);
    expect(result.unchanged).toBe(0);
    expect(result.removed).toBe(0);
    expect(typeof result.needsEmbedding).toBe("number");

    await store.close();
  });

  test("second update shows unchanged files", async () => {
    const store = await createStore({
      dbPath: freshDbPath(),
      config: {
        collections: {
          docs: { path: docsDir, pattern: "**/*.md" },
        },
      },
    });

    await store.update();
    const result = await store.update();

    expect(result.indexed).toBe(0);
    expect(result.unchanged).toBe(3);

    await store.close();
  });

  test("update with onProgress callback fires", async () => {
    const store = await createStore({
      dbPath: freshDbPath(),
      config: {
        collections: {
          docs: { path: docsDir, pattern: "**/*.md" },
        },
      },
    });

    const progress: UpdateProgress[] = [];
    await store.update({
      onProgress: (info) => progress.push(info),
    });

    expect(progress.length).toBeGreaterThan(0);
    expect(progress[0]!.collection).toBe("docs");
    expect(progress[0]!.current).toBeGreaterThanOrEqual(1);
    expect(progress[0]!.total).toBe(3);

    await store.close();
  });

  test("update with collection filter", async () => {
    const store = await createStore({
      dbPath: freshDbPath(),
      config: {
        collections: {
          docs: { path: docsDir, pattern: "**/*.md" },
          notes: { path: notesDir, pattern: "**/*.md" },
        },
      },
    });

    const result = await store.update({ collections: ["docs"] });

    expect(result.collections).toBe(1);
    expect(result.indexed).toBe(3); // Only docs

    await store.close();
  });

  test("update multiple collections", async () => {
    const store = await createStore({
      dbPath: freshDbPath(),
      config: {
        collections: {
          docs: { path: docsDir, pattern: "**/*.md" },
          notes: { path: notesDir, pattern: "**/*.md" },
        },
      },
    });

    const result = await store.update();

    expect(result.collections).toBe(2);
    expect(result.indexed).toBe(6); // 3 docs + 3 notes

    await store.close();
  });

  test("documents are searchable after update", async () => {
    const store = await createStore({
      dbPath: freshDbPath(),
      config: {
        collections: {
          docs: { path: docsDir, pattern: "**/*.md" },
        },
      },
    });

    await store.update();

    const results = await store.searchLex("authentication");
    expect(results.length).toBeGreaterThan(0);

    await store.close();
  });
});

