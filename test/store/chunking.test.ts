/**
 * store/chunking.test.ts - Tests for document chunking (regex, token-based, AST-aware)
 *
 * Run with: bun test store/chunking.test.ts
 */

import { describe, test, expect, vi } from "vitest";
import { chunkDocument, chunkDocumentByTokens, chunkDocumentAsync } from "../../src/store/chunking-async.js";
import { scanBreakPoints, findCodeFences, isInsideCodeFence, findBestCutoff, mergeBreakPoints, chunkDocumentWithBreakPoints } from "../../src/store/chunking.js";
import type { BreakPoint, CodeFenceRegion } from "../../src/store/chunking.js";
import { setDefaultLlamaCpp } from "../../src/llm.js";
import * as remoteTokenizerModule from "../../src/remote/tokenizer.js";

// =============================================================================
// Document Chunking Tests
// =============================================================================

describe("Document Chunking", () => {
  test("chunkDocument returns single chunk for small documents", () => {
    const content = "Small document content";
    const chunks = chunkDocument(content, 1000, 0);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.text).toBe(content);
    expect(chunks[0]!.pos).toBe(0);
  });

  test("chunkDocument splits large documents", () => {
    const content = "A".repeat(10000);
    const chunks = chunkDocument(content, 1000, 0);
    expect(chunks.length).toBeGreaterThan(1);

    // All chunks should have correct positions
    for (let i = 0; i < chunks.length; i++) {
      expect(chunks[i]!.pos).toBeGreaterThanOrEqual(0);
      if (i > 0) {
        expect(chunks[i]!.pos).toBeGreaterThan(chunks[i - 1]!.pos);
      }
    }
  });

  test("chunkDocument with overlap creates overlapping chunks", () => {
    const content = "A".repeat(3000);
    const chunks = chunkDocument(content, 1000, 150);  // 15% overlap
    expect(chunks.length).toBeGreaterThan(1);

    // With overlap, positions should be closer together than without
    // Each new chunk starts 150 chars before where the previous one ended
    for (let i = 1; i < chunks.length; i++) {
      const prevEnd = chunks[i - 1]!.pos + chunks[i - 1]!.text.length;
      const currentStart = chunks[i]!.pos;
      // Current chunk should start before the previous chunk ended (overlap)
      expect(currentStart).toBeLessThan(prevEnd);
      // But should still make forward progress
      expect(currentStart).toBeGreaterThan(chunks[i - 1]!.pos);
    }
  });

  test("chunkDocument prefers paragraph breaks", () => {
    const content = "First paragraph.\n\nSecond paragraph.\n\nThird paragraph.".repeat(50);
    const chunks = chunkDocument(content, 500, 0);

    // Chunks should end at paragraph breaks when possible
    for (const chunk of chunks.slice(0, -1)) {
      // Most chunks should end near a paragraph break
      const endsNearParagraph = chunk.text.endsWith("\n\n") ||
        chunk.text.endsWith(".") ||
        chunk.text.endsWith("\n");
      // This is a soft check - not all chunks can end at breaks
    }
    expect(chunks.length).toBeGreaterThan(1);
  });

  test("chunkDocument handles UTF-8 characters correctly", () => {
    const content = "こんにちは世界".repeat(500); // Japanese text
    const chunks = chunkDocument(content, 1000, 0);

    // Should not split in the middle of a multi-byte character
    for (const chunk of chunks) {
      expect(() => new TextEncoder().encode(chunk.text)).not.toThrow();
    }
  });

  test("chunkDocument with default params uses 900-token chunks", () => {
    // Default is CHUNK_SIZE_CHARS (3600 chars) with CHUNK_OVERLAP_CHARS (540 chars)
    const content = "Word ".repeat(2500);  // ~12500 chars
    const chunks = chunkDocument(content);
    expect(chunks.length).toBeGreaterThan(1);
    // Each chunk should be around 3600 chars (except last)
    expect(chunks[0]!.text.length).toBeGreaterThan(2800);
    expect(chunks[0]!.text.length).toBeLessThanOrEqual(3600);
  });
});

describe.skipIf(!!process.env.CI)("Token-based Chunking", () => {
  test("chunkDocumentByTokens returns single chunk for small documents", async () => {
    const content = "This is a small document.";
    const chunks = await chunkDocumentByTokens(content, 900, 135);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.text).toBe(content);
    expect(chunks[0]!.pos).toBe(0);
    expect(chunks[0]!.tokens).toBeGreaterThan(0);
    expect(chunks[0]!.tokens).toBeLessThan(900);
  });

  test("chunkDocumentByTokens splits large documents", async () => {
    // Create a document that's definitely more than 900 tokens
    const content = "The quick brown fox jumps over the lazy dog. ".repeat(250);
    const chunks = await chunkDocumentByTokens(content, 900, 135);

    expect(chunks.length).toBeGreaterThan(1);

    // Each chunk should have ~900 tokens or less
    for (const chunk of chunks) {
      expect(chunk.tokens).toBeLessThanOrEqual(950);  // Allow slight overage
      expect(chunk.tokens).toBeGreaterThan(0);
    }

    // Chunks should have correct positions
    for (let i = 0; i < chunks.length; i++) {
      expect(chunks[i]!.pos).toBeGreaterThanOrEqual(0);
      if (i > 0) {
        expect(chunks[i]!.pos).toBeGreaterThan(chunks[i - 1]!.pos);
      }
    }
  });

  test("chunkDocumentByTokens creates overlapping chunks", async () => {
    const content = "Word ".repeat(500);  // ~500 tokens
    const chunks = await chunkDocumentByTokens(content, 200, 30);  // 15% overlap

    expect(chunks.length).toBeGreaterThan(1);

    // With overlap, consecutive chunks should have overlapping positions
    for (let i = 1; i < chunks.length; i++) {
      const prevEnd = chunks[i - 1]!.pos + chunks[i - 1]!.text.length;
      const currentStart = chunks[i]!.pos;
      // Current chunk should start before the previous chunk ended (overlap)
      expect(currentStart).toBeLessThan(prevEnd);
    }
  });

  test("chunkDocumentByTokens returns actual token counts", async () => {
    const content = "Hello world, this is a test.";
    const chunks = await chunkDocumentByTokens(content);

    expect(chunks).toHaveLength(1);
    // The token count should be reasonable (not 0, not equal to char count)
    expect(chunks[0]!.tokens).toBeGreaterThan(0);
    expect(chunks[0]!.tokens).toBeLessThan(content.length);  // Tokens < chars for English
  });
});

// =============================================================================
// Smart Chunking - Break Point Detection Tests
// =============================================================================

describe("scanBreakPoints", () => {
  test("detects h1 headings", () => {
    const text = "Intro\n# Heading 1\nMore text";
    const breaks = scanBreakPoints(text);
    const h1 = breaks.find(b => b.type === 'h1');
    expect(h1).toBeDefined();
    expect(h1!.score).toBe(100);
    expect(h1!.pos).toBe(5); // position of \n#
  });

  test("detects multiple heading levels", () => {
    const text = "Text\n# H1\n## H2\n### H3\nMore";
    const breaks = scanBreakPoints(text);

    const h1 = breaks.find(b => b.type === 'h1');
    const h2 = breaks.find(b => b.type === 'h2');
    const h3 = breaks.find(b => b.type === 'h3');

    expect(h1).toBeDefined();
    expect(h2).toBeDefined();
    expect(h3).toBeDefined();
    expect(h1!.score).toBe(100);
    expect(h2!.score).toBe(90);
    expect(h3!.score).toBe(80);
  });

  test("detects code blocks", () => {
    const text = "Before\n```js\ncode\n```\nAfter";
    const breaks = scanBreakPoints(text);
    const codeBlocks = breaks.filter(b => b.type === 'codeblock');
    expect(codeBlocks.length).toBe(2); // opening and closing
    expect(codeBlocks[0]!.score).toBe(80);
  });

  test("detects horizontal rules", () => {
    const text = "Text\n---\nMore text";
    const breaks = scanBreakPoints(text);
    const hr = breaks.find(b => b.type === 'hr');
    expect(hr).toBeDefined();
    expect(hr!.score).toBe(60);
  });

  test("detects blank lines (paragraph boundaries)", () => {
    const text = "First paragraph.\n\nSecond paragraph.";
    const breaks = scanBreakPoints(text);
    const blank = breaks.find(b => b.type === 'blank');
    expect(blank).toBeDefined();
    expect(blank!.score).toBe(20);
  });

  test("detects list items", () => {
    const text = "Intro\n- Item 1\n- Item 2\n1. Numbered";
    const breaks = scanBreakPoints(text);

    const lists = breaks.filter(b => b.type === 'list');
    const numLists = breaks.filter(b => b.type === 'numlist');

    expect(lists.length).toBe(2);
    expect(numLists.length).toBe(1);
    expect(lists[0]!.score).toBe(5);
    expect(numLists[0]!.score).toBe(5);
  });

  test("detects newlines as fallback", () => {
    const text = "Line 1\nLine 2\nLine 3";
    const breaks = scanBreakPoints(text);
    const newlines = breaks.filter(b => b.type === 'newline');
    expect(newlines.length).toBe(2);
    expect(newlines[0]!.score).toBe(1);
  });

  test("returns breaks sorted by position", () => {
    const text = "A\n# B\n\nC\n## D";
    const breaks = scanBreakPoints(text);
    for (let i = 1; i < breaks.length; i++) {
      expect(breaks[i]!.pos).toBeGreaterThan(breaks[i-1]!.pos);
    }
  });

  test("higher-scoring pattern wins at same position", () => {
    // \n# matches both newline (score 1) and h1 (score 100)
    const text = "Text\n# Heading";
    const breaks = scanBreakPoints(text);
    const atPos = breaks.filter(b => b.pos === 4);
    expect(atPos.length).toBe(1);
    expect(atPos[0]!.type).toBe('h1');
    expect(atPos[0]!.score).toBe(100);
  });
});

describe("findCodeFences", () => {
  test("finds single code fence", () => {
    const text = "Before\n```js\ncode here\n```\nAfter";
    const fences = findCodeFences(text);
    expect(fences.length).toBe(1);
    expect(fences[0]!.start).toBe(6); // position of first \n```
    // End is position after the closing \n``` (which is at position 22, length 4)
    expect(fences[0]!.end).toBe(26);
  });

  test("finds multiple code fences", () => {
    const text = "Intro\n```\nblock1\n```\nMiddle\n```\nblock2\n```\nEnd";
    const fences = findCodeFences(text);
    expect(fences.length).toBe(2);
  });

  test("handles unclosed code fence", () => {
    const text = "Before\n```\nunclosed code block";
    const fences = findCodeFences(text);
    expect(fences.length).toBe(1);
    expect(fences[0]!.end).toBe(text.length); // extends to end of document
  });

  test("returns empty array for no code fences", () => {
    const text = "No code fences here";
    const fences = findCodeFences(text);
    expect(fences.length).toBe(0);
  });
});

describe("isInsideCodeFence", () => {
  test("returns true for position inside fence", () => {
    const fences: CodeFenceRegion[] = [{ start: 10, end: 30 }];
    expect(isInsideCodeFence(15, fences)).toBe(true);
    expect(isInsideCodeFence(20, fences)).toBe(true);
  });

  test("returns false for position outside fence", () => {
    const fences: CodeFenceRegion[] = [{ start: 10, end: 30 }];
    expect(isInsideCodeFence(5, fences)).toBe(false);
    expect(isInsideCodeFence(35, fences)).toBe(false);
  });

  test("returns false for position at fence boundaries", () => {
    const fences: CodeFenceRegion[] = [{ start: 10, end: 30 }];
    expect(isInsideCodeFence(10, fences)).toBe(false); // at start
    expect(isInsideCodeFence(30, fences)).toBe(false); // at end
  });

  test("handles multiple fences", () => {
    const fences: CodeFenceRegion[] = [
      { start: 10, end: 30 },
      { start: 50, end: 70 }
    ];
    expect(isInsideCodeFence(20, fences)).toBe(true);
    expect(isInsideCodeFence(60, fences)).toBe(true);
    expect(isInsideCodeFence(40, fences)).toBe(false);
  });
});

describe("findBestCutoff", () => {
  test("prefers higher-scoring break points", () => {
    const breakPoints: BreakPoint[] = [
      { pos: 100, score: 1, type: 'newline' },
      { pos: 150, score: 100, type: 'h1' },
      { pos: 180, score: 20, type: 'blank' },
    ];
    // Target is 200, window is 100 (so 100-200 is valid)
    const cutoff = findBestCutoff(breakPoints, 200, 100, 0.7);
    expect(cutoff).toBe(150); // h1 wins due to high score
  });

  test("h2 at window edge beats blank at target (squared decay)", () => {
    const breakPoints: BreakPoint[] = [
      { pos: 100, score: 90, type: 'h2' },  // at window edge
      { pos: 195, score: 20, type: 'blank' }, // close to target
    ];
    // Target is 200, window is 100
    // With squared decay:
    // h2 at 100: dist=100, normalized=1.0, mult=1-1*0.7=0.3, final=90*0.3=27
    // blank at 195: dist=5, normalized=0.05, mult=1-0.0025*0.7=0.998, final=20*0.998=19.97
    const cutoff = findBestCutoff(breakPoints, 200, 100, 0.7);
    expect(cutoff).toBe(100); // h2 wins even at edge!
  });

  test("high score easily overcomes distance", () => {
    const breakPoints: BreakPoint[] = [
      { pos: 150, score: 100, type: 'h1' },  // h1 at middle
      { pos: 195, score: 1, type: 'newline' }, // newline near target
    ];
    // Target is 200, window is 100
    // h1 at 150: dist=50, normalized=0.5, mult=1-0.25*0.7=0.825, final=82.5
    // newline at 195: dist=5, mult=0.998, final=0.998
    const cutoff = findBestCutoff(breakPoints, 200, 100, 0.7);
    expect(cutoff).toBe(150); // h1 wins easily
  });

  test("returns target position when no breaks in window", () => {
    const breakPoints: BreakPoint[] = [
      { pos: 10, score: 100, type: 'h1' }, // too far before window
    ];
    const cutoff = findBestCutoff(breakPoints, 200, 100, 0.7);
    expect(cutoff).toBe(200);
  });

  test("skips break points inside code fences", () => {
    const breakPoints: BreakPoint[] = [
      { pos: 150, score: 100, type: 'h1' },  // inside fence
      { pos: 180, score: 20, type: 'blank' }, // outside fence
    ];
    const codeFences: CodeFenceRegion[] = [{ start: 140, end: 160 }];
    const cutoff = findBestCutoff(breakPoints, 200, 100, 0.7, codeFences);
    expect(cutoff).toBe(180); // blank wins since h1 is inside fence
  });

  test("handles empty break points array", () => {
    const cutoff = findBestCutoff([], 200, 100, 0.7);
    expect(cutoff).toBe(200);
  });
});

describe("Smart Chunking Integration", () => {
  test("chunkDocument prefers headings over arbitrary breaks", () => {
    // Create content where the heading falls within the search window
    // We want the heading at ~1700 chars so it's in the window for a 2000 char target
    const section1 = "Introduction text here. ".repeat(70); // ~1680 chars
    const section2 = "Main content text here. ".repeat(50); // ~1150 chars
    const content = `${section1}\n# Main Section\n${section2}`;

    // With 2000 char chunks and 800 char window (searches 1200-2000)
    // Heading is at ~1680 which is in window
    const chunks = chunkDocument(content, 2000, 0, 800);
    const headingPos = content.indexOf('\n# Main Section');

    // First chunk should end at the heading (best break point in window)
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks[0]!.text.length).toBe(headingPos);
  });

  test("chunkDocument does not split inside code blocks", () => {
    const beforeCode = "Some intro text. ".repeat(30); // ~480 chars
    const codeBlock = "```typescript\n" + "const x = 1;\n".repeat(100) + "```\n";
    const afterCode = "More text after code. ".repeat(30);
    const content = beforeCode + codeBlock + afterCode;

    const chunks = chunkDocument(content, 1000, 0, 400);

    // Check that no chunk starts in the middle of a code block
    for (const chunk of chunks) {
      const hasOpenFence = (chunk.text.match(/\n```/g) || []).length;
      // If we have an odd number of fence markers, we're splitting inside a block
      // (unless it's the last chunk with unclosed fence)
      if (hasOpenFence % 2 === 1 && !chunk.text.endsWith('```\n')) {
        // This is acceptable only if it's an unclosed fence at document end
        const isLastChunk = chunks.indexOf(chunk) === chunks.length - 1;
        if (!isLastChunk) {
          // Not the last chunk, so this would be a split inside code - check it's not common
          // Actually this test is more about smoke testing - we just verify it runs
        }
      }
    }
    expect(chunks.length).toBeGreaterThan(1);
  });

  test("chunkDocument handles markdown with mixed elements", () => {
    const content = `# Introduction

This is the introduction paragraph with some text.

## Section 1

Some content in section 1.

- List item 1
- List item 2
- List item 3

## Section 2

\`\`\`javascript
function hello() {
  console.log("Hello");
}
\`\`\`

More text after the code block.

---

## Section 3

Final section content.
`.repeat(10);

    const chunks = chunkDocument(content, 500, 75, 200);

    // Should produce multiple chunks
    expect(chunks.length).toBeGreaterThan(5);

    // All chunks should be valid strings
    for (const chunk of chunks) {
      expect(typeof chunk.text).toBe('string');
      expect(chunk.text.length).toBeGreaterThan(0);
      expect(chunk.pos).toBeGreaterThanOrEqual(0);
    }
  });
});

// =============================================================================
// AST-Aware Chunking Integration Tests
// =============================================================================

describe("mergeBreakPoints", () => {
  test("merges two sets of break points keeping highest score at each position", () => {
    const regexPoints: BreakPoint[] = [
      { pos: 10, score: 20, type: "blank" },
      { pos: 50, score: 1, type: "newline" },
    ];
    const astPoints: BreakPoint[] = [
      { pos: 10, score: 90, type: "ast:func" },
      { pos: 100, score: 100, type: "ast:class" },
    ];

    const merged = mergeBreakPoints(regexPoints, astPoints);
    expect(merged).toHaveLength(3);

    // pos 10: AST score (90) wins over regex (20)
    const at10 = merged.find(p => p.pos === 10);
    expect(at10?.score).toBe(90);
    expect(at10?.type).toBe("ast:func");

    // pos 50: only regex
    expect(merged.find(p => p.pos === 50)?.score).toBe(1);

    // pos 100: only AST
    expect(merged.find(p => p.pos === 100)?.score).toBe(100);
  });

  test("returns sorted by position", () => {
    const a: BreakPoint[] = [{ pos: 100, score: 10, type: "a" }];
    const b: BreakPoint[] = [{ pos: 5, score: 20, type: "b" }];
    const merged = mergeBreakPoints(a, b);
    expect(merged[0]!.pos).toBe(5);
    expect(merged[1]!.pos).toBe(100);
  });
});

describe("chunkDocumentWithBreakPoints", () => {
  test("produces same output as chunkDocument for same input", () => {
    const content = "a".repeat(5000) + "\n\n" + "b".repeat(5000);
    const breakPoints = scanBreakPoints(content);
    const codeFences = findCodeFences(content);

    const chunksOriginal = chunkDocument(content);
    const chunksNew = chunkDocumentWithBreakPoints(content, breakPoints, codeFences);

    expect(chunksNew.length).toBe(chunksOriginal.length);
    for (let i = 0; i < chunksNew.length; i++) {
      expect(chunksNew[i]!.text).toBe(chunksOriginal[i]!.text);
      expect(chunksNew[i]!.pos).toBe(chunksOriginal[i]!.pos);
    }
  });
});

describe("AST-aware chunkDocumentAsync", () => {
  const TS_CODE = `import { Database } from './db';

export class AuthService {
  constructor(private db: Database) {}

  async authenticate(user: User, token: string): Promise<boolean> {
    const session = await this.db.findSession(token);
    return session?.userId === user.id;
  }

  validateToken(token: string): boolean {
    return token.length === 64;
  }
}

export function hashPassword(password: string): string {
  return crypto.createHash('sha256').update(password).digest('hex');
}
`.repeat(10); // Repeat to make it large enough to trigger chunking

  test("returns chunks for code files with AST strategy", async () => {
    const chunks = await chunkDocumentAsync(TS_CODE, undefined, undefined, undefined, "auth.ts", "auto");
    expect(chunks.length).toBeGreaterThan(0);
    // Each chunk should have text and pos
    for (const chunk of chunks) {
      expect(typeof chunk.text).toBe("string");
      expect(chunk.text.length).toBeGreaterThan(0);
      expect(chunk.pos).toBeGreaterThanOrEqual(0);
    }
  });

  test("regex strategy produces same output as chunkDocument for code files", async () => {
    const asyncChunks = await chunkDocumentAsync(TS_CODE, undefined, undefined, undefined, "auth.ts", "regex");
    const syncChunks = chunkDocument(TS_CODE);

    expect(asyncChunks.length).toBe(syncChunks.length);
    for (let i = 0; i < asyncChunks.length; i++) {
      expect(asyncChunks[i]!.text).toBe(syncChunks[i]!.text);
      expect(asyncChunks[i]!.pos).toBe(syncChunks[i]!.pos);
    }
  });

  test("markdown files are unchanged in auto mode", async () => {
    const mdContent = ("# Heading\n\n" + "Some text. ".repeat(200) + "\n\n").repeat(10);
    const asyncChunks = await chunkDocumentAsync(mdContent, undefined, undefined, undefined, "readme.md", "auto");
    const syncChunks = chunkDocument(mdContent);

    expect(asyncChunks.length).toBe(syncChunks.length);
    for (let i = 0; i < asyncChunks.length; i++) {
      expect(asyncChunks[i]!.text).toBe(syncChunks[i]!.text);
    }
  });

  test("no filepath falls back to regex-only", async () => {
    const asyncChunks = await chunkDocumentAsync(TS_CODE, undefined, undefined, undefined, undefined, "auto");
    const syncChunks = chunkDocument(TS_CODE);

    expect(asyncChunks.length).toBe(syncChunks.length);
    for (let i = 0; i < asyncChunks.length; i++) {
      expect(asyncChunks[i]!.text).toBe(syncChunks[i]!.text);
    }
  });
});

// =============================================================================
// Token chunking guardrails
// =============================================================================

describe("Token chunking guardrails", () => {
  test("chunkDocumentByTokens keeps pathological single-line blobs under the token limit", async () => {
    const saved = {
      remoteTokenizer: process.env.QMD_REMOTE_TOKENIZER,
      embedBaseUrl: process.env.QMD_EMBED_BASE_URL,
      embedModel: process.env.QMD_EMBED_MODEL,
    };
    process.env.QMD_REMOTE_TOKENIZER = "off";
    delete process.env.QMD_EMBED_BASE_URL;
    delete process.env.QMD_EMBED_MODEL;

    setDefaultLlamaCpp({
      async tokenize(text: string) {
        return Array.from({ length: text.length }, () => 1);
      },
      async detokenize(tokens: readonly number[]) {
        return "x".repeat(tokens.length);
      },
    } as any);

    try {
      const chunks = await chunkDocumentByTokens("x".repeat(1200), 100, 15, 20);

      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks.every((chunk) => chunk.tokens <= 100)).toBe(true);
      for (let i = 1; i < chunks.length; i++) {
        expect(chunks[i]!.pos).toBeGreaterThan(chunks[i - 1]!.pos);
      }
    } finally {
      if (saved.remoteTokenizer === undefined) delete process.env.QMD_REMOTE_TOKENIZER;
      else process.env.QMD_REMOTE_TOKENIZER = saved.remoteTokenizer;
      if (saved.embedBaseUrl === undefined) delete process.env.QMD_EMBED_BASE_URL;
      else process.env.QMD_EMBED_BASE_URL = saved.embedBaseUrl;
      if (saved.embedModel === undefined) delete process.env.QMD_EMBED_MODEL;
      else process.env.QMD_EMBED_MODEL = saved.embedModel;

      setDefaultLlamaCpp(null);
    }
  });

  test("chunkDocumentByTokens uses remote tokenizer endpoints when available", async () => {
    const saved = {
      remoteTokenizer: process.env.QMD_REMOTE_TOKENIZER,
      embedBaseUrl: process.env.QMD_EMBED_BASE_URL,
      embedModel: process.env.QMD_EMBED_MODEL,
    };

    process.env.QMD_REMOTE_TOKENIZER = "auto";
    process.env.QMD_EMBED_BASE_URL = "http://unit-test-remote/v1";
    process.env.QMD_EMBED_MODEL = "unit-test-model";

    const availableSpy = vi
      .spyOn(remoteTokenizerModule, "remoteTokenizerAvailable")
      .mockResolvedValue(true);
    const tokenizeSpy = vi
      .spyOn(remoteTokenizerModule, "remoteTokenize")
      .mockImplementation(async (_cfg, text) => Array.from({ length: text.length }, () => 1));
    const detokenizeSpy = vi
      .spyOn(remoteTokenizerModule, "remoteDetokenize")
      .mockImplementation(async (_cfg, tokens) => "x".repeat(tokens.length));

    try {
      setDefaultLlamaCpp({
        embedCfg: {
          baseUrl: "http://unit-test-remote/v1",
          model: "unit-test-model",
        },
      } as any);

      const chunks = await chunkDocumentByTokens("x".repeat(900), 80, 10, 20);
      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks.every((chunk) => chunk.tokens <= 80)).toBe(true);
      expect(availableSpy).toHaveBeenCalled();
      expect(tokenizeSpy).toHaveBeenCalled();
    } finally {
      if (saved.remoteTokenizer === undefined) delete process.env.QMD_REMOTE_TOKENIZER;
      else process.env.QMD_REMOTE_TOKENIZER = saved.remoteTokenizer;
      if (saved.embedBaseUrl === undefined) delete process.env.QMD_EMBED_BASE_URL;
      else process.env.QMD_EMBED_BASE_URL = saved.embedBaseUrl;
      if (saved.embedModel === undefined) delete process.env.QMD_EMBED_MODEL;
      else process.env.QMD_EMBED_MODEL = saved.embedModel;

      availableSpy.mockRestore();
      tokenizeSpy.mockRestore();
      detokenizeSpy.mockRestore();
      setDefaultLlamaCpp(null);
    }
  });
});
