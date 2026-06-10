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
// Inline Config Isolation Tests
// =============================================================================

describe("inline config isolation", () => {
  test("inline config does not write any files to disk", async () => {
    const configDir = join(testDir, "should-not-exist");
    const store = await createStore({
      dbPath: freshDbPath(),
      config: {
        collections: {
          docs: { path: docsDir, pattern: "**/*.md" },
        },
      },
    });

    await store.addCollection("notes", { path: notesDir, pattern: "**/*.md" });
    await store.addContext("docs", "/", "Documentation");

    expect(existsSync(configDir)).toBe(false);
    await store.close();
  });

  test("inline config mutations persist within session", async () => {
    const store = await createStore({
      dbPath: freshDbPath(),
      config: { collections: {} },
    });

    await store.addCollection("docs", { path: docsDir, pattern: "**/*.md" });
    await store.addContext("docs", "/", "My docs");

    // Verify the mutations are visible
    const collections = await store.listCollections();
    expect(collections.map(c => c.name)).toContain("docs");

    const contexts = await store.listContexts();
    expect(contexts).toContainEqual({
      collection: "docs",
      path: "/",
      context: "My docs",
    });

    await store.close();
  });

  test("two stores with different inline configs are independent", async () => {
    const store1 = await createStore({
      dbPath: freshDbPath(),
      config: {
        collections: {
          docs: { path: docsDir, pattern: "**/*.md" },
        },
      },
    });

    // Close first store (resets config source)
    await store1.close();

    const store2 = await createStore({
      dbPath: freshDbPath(),
      config: {
        collections: {
          notes: { path: notesDir, pattern: "**/*.md" },
        },
      },
    });

    const names = (await store2.listCollections()).map(c => c.name);
    expect(names).toContain("notes");
    expect(names).not.toContain("docs");

    await store2.close();
  });
});

// =============================================================================
// YAML Config File Tests
// =============================================================================

