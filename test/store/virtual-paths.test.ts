/**
 * Auto-generated split from test/store.test.ts
 */
import { describe, test, expect } from "vitest";
import {
  normalizeVirtualPath,
  isVirtualPath,
  parseVirtualPath,
  normalizeDocid,
  isDocid,
  reciprocalRankFusion,
  extractSnippet,
  getHybridRrfWeights,
  type RankedResult,
  type RankedListMeta,
} from "../../src/store.js";


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

