/**
 * Model cache — download, inspect, and resolve local GGUF model files.
 *
 * Provides:
 *  - HF URI parsing and ETag-based cache refresh
 *  - GGUF file inspection (magic bytes, validity)
 *  - Model download via node-llama-cpp resolveModelFile
 *  - Default model URI constants and resolution helpers
 */

import { homedir } from "os";
import { join } from "path";
import { existsSync, mkdirSync, statSync, unlinkSync, readdirSync, readFileSync, writeFileSync, openSync, readSync, closeSync } from "fs";

// =============================================================================
// Default model URIs
// =============================================================================

const DEFAULT_EMBED_MODEL = "hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf";
const DEFAULT_RERANK_MODEL = "hf:ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF/qwen3-reranker-0.6b-q8_0.gguf";
const DEFAULT_GENERATE_MODEL = "hf:tobil/qmd-query-expansion-1.7B-gguf/qmd-query-expansion-1.7B-q4_k_m.gguf";

export const LFM2_GENERATE_MODEL = "hf:LiquidAI/LFM2-1.2B-GGUF/LFM2-1.2B-Q4_K_M.gguf";
export const LFM2_INSTRUCT_MODEL = "hf:LiquidAI/LFM2.5-1.2B-Instruct-GGUF/LFM2.5-1.2B-Instruct-Q4_K_M.gguf";

export const DEFAULT_EMBED_MODEL_URI = DEFAULT_EMBED_MODEL;
export const DEFAULT_RERANK_MODEL_URI = DEFAULT_RERANK_MODEL;
export const DEFAULT_GENERATE_MODEL_URI = DEFAULT_GENERATE_MODEL;

// =============================================================================
// Model resolution
// =============================================================================

export type ModelResolutionConfig = {
  embed?: string;
  generate?: string;
  rerank?: string;
};

export function resolveEmbedModel(config?: ModelResolutionConfig): string {
  return config?.embed || process.env.QMD_EMBED_MODEL || DEFAULT_EMBED_MODEL;
}

export function resolveGenerateModel(config?: ModelResolutionConfig): string {
  return config?.generate || process.env.QMD_GENERATE_MODEL || DEFAULT_GENERATE_MODEL;
}

export function resolveRerankModel(config?: ModelResolutionConfig): string {
  return config?.rerank || process.env.QMD_RERANK_MODEL || DEFAULT_RERANK_MODEL;
}

export function resolveModels(config?: ModelResolutionConfig): Required<ModelResolutionConfig> {
  return {
    embed: resolveEmbedModel(config),
    generate: resolveGenerateModel(config),
    rerank: resolveRerankModel(config),
  };
}

// =============================================================================
// Model cache directory
// =============================================================================

const MODEL_CACHE_DIR = process.env.XDG_CACHE_HOME
  ? join(process.env.XDG_CACHE_HOME, "qmd", "models")
  : join(homedir(), ".cache", "qmd", "models");
export const DEFAULT_MODEL_CACHE_DIR = MODEL_CACHE_DIR;

// =============================================================================
// Pull result
// =============================================================================

export type PullResult = {
  model: string;
  path: string;
  sizeBytes: number;
  refreshed: boolean;
};

// =============================================================================
// HF URI parsing
// =============================================================================

type HfRef = {
  repo: string;
  file: string;
};

function parseHfUri(model: string): HfRef | null {
  if (!model.startsWith("hf:")) return null;
  const without = model.slice(3);
  const parts = without.split("/");
  if (parts.length < 3) return null;
  const repo = parts.slice(0, 2).join("/");
  const file = parts.slice(2).join("/");
  return { repo, file };
}

async function getRemoteEtag(ref: HfRef): Promise<string | null> {
  const url = `https://huggingface.co/${ref.repo}/resolve/main/${ref.file}`;
  try {
    const resp = await fetch(url, { method: "HEAD" });
    if (!resp.ok) return null;
    const etag = resp.headers.get("etag");
    return etag || null;
  } catch {
    return null;
  }
}

// =============================================================================
// GGUF file inspection
// =============================================================================

const GGUF_MAGIC = Buffer.from("GGUF");

export type GgufFileInspection = {
  exists: boolean;
  valid: boolean;
  kind: "missing" | "gguf" | "html" | "invalid";
  sizeBytes?: number;
  magic?: string;
  details: string;
};

function formatModelFileSize(sizeBytes: number): string {
  return `${(sizeBytes / 1024).toFixed(0)} KB`;
}

function printableMagic(header: Buffer): string {
  const text = header.toString("utf-8");
  return /^[\x20-\x7e]{1,4}$/.test(text) ? text : `0x${header.toString("hex")}`;
}

export function inspectGgufFile(filePath: string): GgufFileInspection {
  if (!existsSync(filePath)) {
    return { exists: false, valid: false, kind: "missing", details: "file does not exist" };
  }

  let sizeBytes = 0;
  try {
    sizeBytes = statSync(filePath).size;
    const fd = openSync(filePath, "r");
    const sniff = Buffer.alloc(512);
    try {
      readSync(fd, sniff, 0, 512, 0);
    } finally {
      closeSync(fd);
    }

    const header = sniff.subarray(0, 4);
    if (header.equals(GGUF_MAGIC)) {
      return {
        exists: true,
        valid: true,
        kind: "gguf",
        sizeBytes,
        magic: "GGUF",
        details: `valid GGUF (${formatModelFileSize(sizeBytes)})`,
      };
    }

    const magic = printableMagic(header);
    const text = sniff.toString("utf-8").toLowerCase();
    const isHtml = text.includes("<!doctype") || text.includes("<html");
    if (isHtml) {
      return {
        exists: true,
        valid: false,
        kind: "html",
        sizeBytes,
        magic,
        details: `HTML page, not a GGUF model (${formatModelFileSize(sizeBytes)}); likely proxy/firewall/captive portal response`,
      };
    }

    return {
      exists: true,
      valid: false,
      kind: "invalid",
      sizeBytes,
      magic,
      details: `not valid GGUF (expected magic "GGUF", got "${magic}", ${formatModelFileSize(sizeBytes)})`,
    };
  } catch (error) {
    return {
      exists: true,
      valid: false,
      kind: "invalid",
      sizeBytes,
      details: `cannot read model file: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function validateGgufFile(filePath: string, modelUri: string): void {
  const inspection = inspectGgufFile(filePath);
  if (!inspection.exists || inspection.valid) return;

  try {
    unlinkSync(filePath);
  } catch { /* best effort */ }

  if (inspection.kind === "html") {
    throw new Error(
      `Downloaded model file is an HTML page, not a GGUF model (${formatModelFileSize(inspection.sizeBytes ?? 0)}).\n` +
      `Something is intercepting the download from huggingface.co (a proxy, firewall, or captive portal).\n\n` +
      `Model: ${modelUri}\n` +
      `Path:  ${filePath}\n\n` +
      `To fix this, either:\n` +
      `  1. Try a HuggingFace mirror:  HF_ENDPOINT=https://hf-mirror.com qmd embed\n` +
      `  2. Download the model manually and set the env var, e.g.:\n` +
      `       QMD_EMBED_MODEL=/path/to/model.gguf qmd embed\n\n` +
      `Note: 'qmd search' works without any model downloads.`
    );
  }

  throw new Error(
    `Model file is not valid GGUF (expected magic "GGUF", got "${inspection.magic ?? "unknown"}", file is ${formatModelFileSize(inspection.sizeBytes ?? 0)}).\n` +
    `Model: ${modelUri}\n` +
    `Path:  ${filePath}\n\n` +
    `The file has been removed. Run the command again to re-download.`
  );
}

// =============================================================================
// Model download
// =============================================================================

/**
 * Export the validate function for use by the pullModels entry point
 * and for re-export by llm.ts.
 */
export { validateGgufFile };

/**
 * Download/cache models via node-llama-cpp. The nodeLlamaCpp import is
 * provided by the caller to avoid static coupling with the native binding.
 */
export async function pullModels(
  models: string[],
  loadNodeLlamaCpp: () => Promise<{
    resolveModelFile: (model: string, cacheDir: string) => Promise<string>;
  }>,
  options: { refresh?: boolean; cacheDir?: string } = {}
): Promise<PullResult[]> {
  const cacheDir = options.cacheDir || MODEL_CACHE_DIR;
  if (!existsSync(cacheDir)) {
    mkdirSync(cacheDir, { recursive: true });
  }

  const results: PullResult[] = [];
  for (const model of models) {
    let refreshed = false;
    const hfRef = parseHfUri(model);
    const filename = model.split("/").pop();
    const entries = readdirSync(cacheDir, { withFileTypes: true });
    const cached = filename
      ? entries
          .filter((entry) => entry.isFile() && entry.name.includes(filename))
          .map((entry) => join(cacheDir, entry.name))
      : [];

    if (hfRef && filename) {
      const etagPath = join(cacheDir, `${filename}.etag`);
      const remoteEtag = await getRemoteEtag(hfRef);
      const localEtag = existsSync(etagPath)
        ? readFileSync(etagPath, "utf-8").trim()
        : null;
      const shouldRefresh =
        options.refresh || !remoteEtag || remoteEtag !== localEtag || cached.length === 0;

      if (shouldRefresh) {
        for (const candidate of cached) {
          if (existsSync(candidate)) unlinkSync(candidate);
        }
        if (existsSync(etagPath)) unlinkSync(etagPath);
        refreshed = cached.length > 0;
      }
    } else if (options.refresh && filename) {
      for (const candidate of cached) {
        if (existsSync(candidate)) unlinkSync(candidate);
        refreshed = true;
      }
    }

    const { resolveModelFile } = await loadNodeLlamaCpp();
    const path = await resolveModelFile(model, cacheDir);
    validateGgufFile(path, model);
    const sizeBytes = existsSync(path) ? statSync(path).size : 0;
    if (hfRef && filename) {
      const remoteEtag = await getRemoteEtag(hfRef);
      if (remoteEtag) {
        const etagPath = join(cacheDir, `${filename}.etag`);
        writeFileSync(etagPath, remoteEtag + "\n", "utf-8");
      }
    }
    results.push({ model, path, sizeBytes, refreshed });
  }
  return results;
}
