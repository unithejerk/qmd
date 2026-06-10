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
// Reciprocal Rank Fusion Tests
// =============================================================================

describe("Reciprocal Rank Fusion", () => {
  const makeResult = (file: string, score: number): RankedResult => ({
    file,
    displayPath: file,
    title: file,
    body: "body",
    score,
  });

  test("RRF combines single list correctly", () => {
    const list1 = [
      makeResult("doc1", 0.9),
      makeResult("doc2", 0.8),
      makeResult("doc3", 0.7),
    ];

    const fused = reciprocalRankFusion([list1]);

    // Order should be preserved
    expect(fused[0]!.file).toBe("doc1");
    expect(fused[1]!.file).toBe("doc2");
    expect(fused[2]!.file).toBe("doc3");
  });

  test("RRF merges documents from multiple lists", () => {
    const list1 = [makeResult("doc1", 0.9), makeResult("doc2", 0.8)];
    const list2 = [makeResult("doc2", 0.95), makeResult("doc3", 0.85)];

    const fused = reciprocalRankFusion([list1, list2]);

    // doc2 appears in both lists, should have higher combined score
    expect(fused.find(r => r.file === "doc2")).toBeDefined();
    expect(fused.find(r => r.file === "doc1")).toBeDefined();
    expect(fused.find(r => r.file === "doc3")).toBeDefined();
  });

  test("RRF respects weights", () => {
    const list1 = [makeResult("doc1", 0.9)];
    const list2 = [makeResult("doc2", 0.9)];

    // Give double weight to list1
    const fused = reciprocalRankFusion([list1, list2], [2.0, 1.0]);

    // doc1 should rank higher due to weight
    expect(fused[0]!.file).toBe("doc1");
  });

  test("hybrid RRF weights boost original vector evidence over expansion-only hits", () => {
    const originalFtsOnly = makeResult("original-fts-only.md", 0.95);
    const expansionOnly = makeResult("lex-expansion-only.md", 0.95);
    const originalVector = makeResult("original-vector.md", 0.95);

    // Mirrors hybridQuery's common list order when a lex expansion exists:
    // original FTS, lex expansion FTS, original vector.
    const rankedLists = [
      [originalFtsOnly],
      [expansionOnly],
      [originalVector],
    ];
    const rankedListMeta: RankedListMeta[] = [
      { source: "fts", queryType: "original", query: "user query" },
      { source: "fts", queryType: "lex", query: "lex expansion" },
      { source: "vec", queryType: "original", query: "user query" },
    ];

    const positionBasedWeights = rankedLists.map((_, i) => i < 2 ? 2.0 : 1.0);
    const buggyOrder = reciprocalRankFusion(rankedLists, positionBasedWeights);

    expect(buggyOrder.findIndex(r => r.file === "lex-expansion-only.md"))
      .toBeLessThan(buggyOrder.findIndex(r => r.file === "original-vector.md"));

    const semanticWeights = getHybridRrfWeights(rankedListMeta);
    const fixedOrder = reciprocalRankFusion(rankedLists, semanticWeights);

    expect(semanticWeights).toEqual([2.0, 1.0, 2.0]);
    expect(fixedOrder.findIndex(r => r.file === "original-vector.md"))
      .toBeLessThan(fixedOrder.findIndex(r => r.file === "lex-expansion-only.md"));
  });

  test("RRF adds top-rank bonus", () => {
    // doc1 is #1 in list1, doc2 is #2 in list1
    const list1 = [makeResult("doc1", 0.9), makeResult("doc2", 0.8)];
    const list2 = [makeResult("doc3", 0.85)];

    const fused = reciprocalRankFusion([list1, list2]);

    // doc1 should get +0.05 bonus for being #1
    // doc2 should get +0.02 bonus for being #2-3
    const doc1 = fused.find(r => r.file === "doc1");
    const doc2 = fused.find(r => r.file === "doc2");

    expect(doc1!.score).toBeGreaterThan(doc2!.score);
  });

  test("RRF handles empty lists", () => {
    const fused = reciprocalRankFusion([[], []]);
    expect(fused).toHaveLength(0);
  });

  test("RRF uses k parameter correctly", () => {
    const list = [makeResult("doc1", 0.9)];

    // With different k values, scores should differ
    const fused60 = reciprocalRankFusion([list], [], 60);
    const fused30 = reciprocalRankFusion([list], [], 30);

    // Lower k = higher scores for top ranks
    expect(fused30[0]!.score).toBeGreaterThan(fused60[0]!.score);
  });
});

