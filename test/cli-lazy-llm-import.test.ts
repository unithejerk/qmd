import { describe, expect, test } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

describe("LLM module loading", () => {
  test("node-llama-cpp is only dynamically imported by LLM operations", () => {
    // The lazy-load guarantee now lives in src/llm/llama-cpp.ts where
    // loadNodeLlamaCpp() dynamically imports node-llama-cpp at runtime.
    const source = readFileSync(join(process.cwd(), "src", "llm", "llama-cpp.ts"), "utf-8");

    expect(source).not.toMatch(/import\s+(?!type\b)[\s\S]*?from\s+["']node-llama-cpp["']/);
    expect(source).toContain('import("node-llama-cpp")');
  });

  test("importing the CLI for lightweight commands succeeds", async () => {
    const mod = await import("../src/cli/qmd.ts");
    expect(mod).toMatchObject({
      buildEditorUri: expect.any(Function),
      termLink: expect.any(Function),
    });
  });
});
