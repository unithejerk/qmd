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

