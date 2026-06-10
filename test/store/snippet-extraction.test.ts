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
// Snippet Extraction Tests
// =============================================================================

describe("Snippet Extraction", () => {
  test("extractSnippet finds query terms", () => {
    const body = "First line.\nSecond line with keyword.\nThird line.\nFourth line.";
    const { line, snippet } = extractSnippet(body, "keyword", 500);

    expect(line).toBe(2); // Line 2 contains "keyword"
    expect(snippet).toContain("keyword");
  });

  test("extractSnippet includes context lines", () => {
    const body = "Line 1\nLine 2\nLine 3 has keyword\nLine 4\nLine 5";
    const { snippet } = extractSnippet(body, "keyword", 500);

    expect(snippet).toContain("Line 2"); // Context before
    expect(snippet).toContain("Line 3 has keyword");
    expect(snippet).toContain("Line 4"); // Context after
  });

  test("extractSnippet respects maxLen for content", () => {
    const body = "A".repeat(1000);
    const result = extractSnippet(body, "query", 100);

    // Snippet includes header + content, content should be truncated
    expect(result.snippet).toContain("@@"); // Has diff header
    expect(result.snippet).toContain("..."); // Content was truncated
  });

  test("extractSnippet uses chunkPos hint", () => {
    const body = "First section...\n".repeat(50) + "Target keyword here\n" + "More content...".repeat(50);
    const chunkPos = body.indexOf("Target keyword");

    const { snippet } = extractSnippet(body, "Target", 200, chunkPos);
    expect(snippet).toContain("Target keyword");
  });

  test("extractSnippet returns beginning when no match", () => {
    const body = "First line\nSecond line\nThird line";
    const { line, snippet } = extractSnippet(body, "nonexistent", 500);

    expect(line).toBe(1);
    expect(snippet).toContain("First line");
  });

  test("extractSnippet includes diff-style header", () => {
    const body = "Line 1\nLine 2\nLine 3 has keyword\nLine 4\nLine 5";
    const { snippet, linesBefore, linesAfter, snippetLines } = extractSnippet(body, "keyword", 500);

    // Header should show line position and context info
    expect(snippet).toMatch(/^@@ -\d+,\d+ @@ \(\d+ before, \d+ after\)/);
    expect(linesBefore).toBe(1); // Line 1 comes before
    expect(linesAfter).toBe(0);  // Snippet includes to end (lines 2-5)
    expect(snippetLines).toBe(4); // Lines 2, 3, 4, 5
  });

  test("extractSnippet calculates linesBefore and linesAfter correctly", () => {
    const body = "L1\nL2\nL3\nL4 match\nL5\nL6\nL7\nL8\nL9\nL10";
    const { linesBefore, linesAfter, snippetLines, line } = extractSnippet(body, "match", 500);

    expect(line).toBe(4); // "L4 match" is line 4
    expect(linesBefore).toBe(2); // L1, L2 before snippet (snippet starts at L3)
    expect(snippetLines).toBe(4); // L3, L4, L5, L6
    expect(linesAfter).toBe(4); // L7, L8, L9, L10 after snippet
  });

  test("extractSnippet header format matches diff style", () => {
    const body = "A\nB\nC keyword\nD\nE\nF\nG\nH";
    const { snippet } = extractSnippet(body, "keyword", 500);

    // Should start with @@ -line,count @@ (N before, M after)
    const headerMatch = snippet.match(/^@@ -(\d+),(\d+) @@ \((\d+) before, (\d+) after\)/);
    expect(headerMatch).not.toBeNull();

    const [, startLine, count, before, after] = headerMatch!;
    expect(parseInt(startLine!)).toBe(2); // Snippet starts at line 2 (B)
    expect(parseInt(count!)).toBe(4);     // 4 lines: B, C keyword, D, E
    expect(parseInt(before!)).toBe(1);    // A is before
    expect(parseInt(after!)).toBe(3);     // F, G, H are after
  });

  test("extractSnippet at document start shows 0 before", () => {
    const body = "First line keyword\nSecond\nThird\nFourth\nFifth";
    const { linesBefore, linesAfter, snippetLines, line } = extractSnippet(body, "keyword", 500);

    expect(line).toBe(1);         // Keyword on first line
    expect(linesBefore).toBe(0);  // Nothing before
    expect(snippetLines).toBe(3); // First, Second, Third (bestLine-1 to bestLine+3, clamped)
    expect(linesAfter).toBe(2);   // Fourth, Fifth
  });

  test("extractSnippet with leading blank/frontmatter lines reports 1 before, not 0", () => {
    // Regression: a user looked at `@@ -2,4 @@ (1 before, 72 after)` and
    // suspected "1 before" was wrong because the match appeared to be the
    // topmost visible line. The math takes "before" from the absolute file
    // line, not from the visible portion of the snippet — so when the
    // snippet starts at line 2, "1 before" is the correct count. Lock that
    // in with a 77-line document whose match sits on line 3.
    const otherLines = Array.from({ length: 72 }, (_, i) => `body line ${i + 6}`).join("\n");
    const body = `---\ntitle: Notes\n# Heading with keyword\nIntro paragraph.\nMore intro lines.\n${otherLines}`;

    const { line, linesBefore, snippetLines, linesAfter, snippet } =
      extractSnippet(body, "keyword", 500);

    expect(line).toBe(3);             // match is on line 3
    expect(linesBefore).toBe(1);      // exactly one line above the 4-line snippet window
    expect(snippetLines).toBe(4);     // lines 2..5 form the snippet
    expect(linesAfter).toBe(72);      // remaining body
    expect(snippet).toContain("@@ -2,4 @@ (1 before, 72 after)");
  });

  test("extractSnippet at document end shows 0 after", () => {
    const body = "First\nSecond\nThird\nFourth\nFifth keyword";
    const { linesBefore, linesAfter, snippetLines, line } = extractSnippet(body, "keyword", 500);

    expect(line).toBe(5);         // Keyword on last line
    expect(linesBefore).toBe(3);  // First, Second, Third before snippet
    expect(snippetLines).toBe(2); // Fourth, Fifth keyword (bestLine-1 to bestLine+3, clamped)
    expect(linesAfter).toBe(0);   // Nothing after
  });

  test("extractSnippet with single line document", () => {
    const body = "Single line with keyword";
    const { linesBefore, linesAfter, snippetLines, snippet } = extractSnippet(body, "keyword", 500);

    expect(linesBefore).toBe(0);
    expect(linesAfter).toBe(0);
    expect(snippetLines).toBe(1);
    expect(snippet).toContain("@@ -1,1 @@ (0 before, 0 after)");
    expect(snippet).toContain("Single line with keyword");
  });

  test("extractSnippet with chunkPos adjusts line numbers correctly", () => {
    // 50 lines of padding, then keyword, then more content
    const padding = "Padding line\n".repeat(50);
    const body = padding + "Target keyword here\nMore content\nEven more";
    const chunkPos = padding.length; // Position of "Target keyword"

    const { line, linesBefore, linesAfter } = extractSnippet(body, "keyword", 200, chunkPos);

    expect(line).toBe(51); // "Target keyword" is line 51
    expect(linesBefore).toBeGreaterThan(40); // Many lines before
  });

  test("extractSnippet anchors on chunkPos when lexical scoring finds no match", () => {
    // The snippet tokenizer does not strip FTS5 syntax, so a quoted-phrase query
    // tokenises into terms with embedded quotes that never appear in body text.
    // bestScore stays at 0 even though the reranker correctly identified a chunk;
    // the fallback should anchor on chunkPos rather than defaulting to line 1.
    const padLine = "Lorem ipsum dolor sit amet\n";
    const padding = padLine.repeat(100);
    const body = padding + "chunk content here\nmore chunk content\n" + padding;
    const chunkPos = padding.length;

    const { line } = extractSnippet(body, '"unrelated quoted phrase"', 200, chunkPos);

    expect(line).toBeGreaterThan(50);
    expect(line).toBeLessThan(110);
  });

  test("extractSnippet with chunkPos=0 falls back to full-body scan when chunk has no match", () => {
    // chunkPos=0 may be the chunk selector's bestIdx=0 default rather than a real
    // first-chunk hit, so the fallback must consider matches outside chunk 0.
    const padding = "Lorem ipsum dolor sit amet\n".repeat(200);
    const body = padding + "TARGET_KEYWORD line content\ntail line\n";

    const { line } = extractSnippet(body, "TARGET_KEYWORD", 200, 0);

    expect(line).toBe(201);
  });
});

// =============================================================================
// Reciprocal Rank Fusion Tests
// =============================================================================

