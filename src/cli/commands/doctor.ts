import { isBun } from "../../db.js";
import type { Database } from "../../db.js";
import { readFileSync, readdirSync, statSync, existsSync, realpathSync, unlinkSync } from "fs";
import { join as pathJoin, dirname, resolve as pathResolve } from "path";
import { fileURLToPath } from "url";

// ─────────────────────────────────────────────────────────────────────────────
// Store dependencies (re-exported via store.js)
// ─────────────────────────────────────────────────────────────────────────────
import type { Store } from "../../store.js";
import {
  getIndexHealth,
  getHashesNeedingEmbedding,
  getEmbeddingFingerprint,
  chunkDocumentByTokens,
  extractTitle,
  formatDocForEmbedding,
  maybeAdoptLegacyEmbeddingFingerprint,
  homedir,
  DEFAULT_EMBED_MODEL,
  DEFAULT_QUERY_MODEL,
  DEFAULT_RERANK_MODEL,
} from "../../store.js";

// ─────────────────────────────────────────────────────────────────────────────
// LLM dependencies
// ─────────────────────────────────────────────────────────────────────────────
import {
  getDefaultLlamaCpp,
  DEFAULT_MODEL_CACHE_DIR,
  inspectGgufFile,
  isDarwinMetalMitigationActive,
  withLLMSession,
} from "../../llm.js";

// ─────────────────────────────────────────────────────────────────────────────
// Remote endpoint probe dependencies
// ─────────────────────────────────────────────────────────────────────────────
import { buildBearerHeaders, nodeGet, nodePost } from "../../remote/transport.js";

// ─────────────────────────────────────────────────────────────────────────────
// YAML collection config dependencies
// ─────────────────────────────────────────────────────────────────────────────
import { loadConfig, getConfigPath } from "../../collections.js";
import type { ModelsConfig, CollectionConfig } from "../../collections.js";

// ─────────────────────────────────────────────────────────────────────────────
// Terminal colours (respects NO_COLOR env)
// ─────────────────────────────────────────────────────────────────────────────
const useColor = !process.env.NO_COLOR && process.stdout.isTTY;
const c = {
  reset: useColor ? "\x1b[0m" : "",
  dim: useColor ? "\x1b[2m" : "",
  bold: useColor ? "\x1b[1m" : "",
  cyan: useColor ? "\x1b[36m" : "",
  yellow: useColor ? "\x1b[33m" : "",
  green: useColor ? "\x1b[32m" : "",
  magenta: useColor ? "\x1b[35m" : "",
  blue: useColor ? "\x1b[34m" : "",
};

// =============================================================================
// Type definitions
// =============================================================================

export type ModelEndpoint = "embed" | "expand" | "rerank" | "generate";

export type ResolvedModelEndpoint = {
  model: string;
  provider: string;
  source: string;
  baseUrl: string;
  apiKey: string;
  format: string;
};

export type RemoteConnectionStatus = {
  state: "ok" | "error";
  detail: string;
  latencyMs?: number;
};

type DoctorVectorSampleResult = {
  ok: boolean;
  details: string;
};

type CachedModelInspection = {
  path: string | null;
  invalid: string[];
};

export type EnvOverride = {
  name: string;
  value: string;
  consequence: string;
};

type DoctorConfigCheck = {
  config: CollectionConfig | null;
  valid: boolean;
};

// =============================================================================
// Generic utility helpers
// =============================================================================

export function formatETA(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

export function checkIndexHealth(db: Database, model: string): void {
  const { needsEmbedding, totalDocs, daysStale } = getIndexHealth(db, model);

  if (needsEmbedding > 0) {
    const pct = Math.round((needsEmbedding / totalDocs) * 100);
    if (pct >= 10) {
      process.stderr.write(`${c.yellow}Warning: ${needsEmbedding} documents (${pct}%) need embeddings. Run 'qmd embed' for better results.${c.reset}\n`);
    } else {
      process.stderr.write(`${c.dim}Tip: ${needsEmbedding} documents need embeddings. Run 'qmd embed' to index them.${c.reset}\n`);
    }
  }

  if (daysStale !== null && daysStale >= 14) {
    process.stderr.write(`${c.dim}Tip: Index last updated ${daysStale} days ago. Run 'qmd update' to refresh.${c.reset}\n`);
  }
}

export function computeDisplayPath(
  filepath: string,
  collectionPath: string,
  existingPaths: Set<string>
): string {
  const collectionDir = collectionPath.replace(/\/$/, "");
  const collectionName = collectionDir.split("/").pop() || "";

  let relativePath: string;
  if (filepath.startsWith(collectionDir + "/")) {
    relativePath = collectionName + filepath.slice(collectionDir.length);
  } else {
    relativePath = filepath;
  }

  const parts = relativePath.split("/").filter(p => p.length > 0);

  const minParts = Math.min(2, parts.length);
  for (let i = parts.length - minParts; i >= 0; i--) {
    const candidate = parts.slice(i).join("/");
    if (!existingPaths.has(candidate)) {
      return candidate;
    }
  }

  return filepath;
}

export function formatTimeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function sameDirectory(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return pathResolve(a) === pathResolve(b);
  }
}

export function isForceCpuEnabled(): boolean {
  const value = process.env.QMD_FORCE_CPU;
  return !!value && !["false", "off", "none", "disable", "disabled", "0"].includes(value.trim().toLowerCase());
}

export function configuredGpuModeLabel(): string {
  return isForceCpuEnabled()
    ? "CPU forced (QMD_FORCE_CPU)"
    : (process.env.QMD_LLAMA_GPU?.trim() || "auto");
}

export function summarizeDeviceNames(names: string[]): string {
  const counts = new Map<string, number>();
  for (const name of names) {
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([name, count]) => count > 1 ? `${count}× ${name}` : name)
    .join(", ");
}

export function sanitizeDiagnosticMessage(message: string): string {
  const home = homedir();
  return message
    .replaceAll(home, "~")
    .replaceAll(process.cwd(), ".")
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean)
    .slice(0, 3)
    .join("; ");
}

export function isStatusVerbose(): boolean {
  const raw = process.env.QMD_STATUS_VERBOSE?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

export function trimTrailingSlashes(url: string): string {
  return url.replace(/\/+$/, "");
}

export function appendPath(baseUrl: string, suffix: string): string {
  return `${trimTrailingSlashes(baseUrl)}${suffix}`;
}

export function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}

// =============================================================================
// Remote endpoint probe helpers
// =============================================================================

export function buildMetadataProbeCandidates(baseUrl: string, format: string): string[] {
  const trimmed = trimTrailingSlashes(baseUrl);
  const lowerFormat = format.toLowerCase();
  const ollamaLike = lowerFormat.startsWith("ollama_") || trimmed.includes(":11434") || trimmed.includes("/api");

  const modelsCandidates = [appendPath(trimmed, "/models")];
  if (trimmed.endsWith("/v1")) {
    modelsCandidates.push(`${trimmed.slice(0, -3)}/models`);
  }

  const tagsCandidates = [
    appendPath(trimmed, "/api/tags"),
    appendPath(trimmed, "/tags"),
  ];
  if (trimmed.endsWith("/v1")) {
    tagsCandidates.push(`${trimmed.slice(0, -3)}/api/tags`);
  }

  return ollamaLike
    ? uniqueStrings([...tagsCandidates, ...modelsCandidates])
    : uniqueStrings([...modelsCandidates, ...tagsCandidates]);
}

export function buildRerankProbeCandidates(baseUrl: string): string[] {
  const trimmed = trimTrailingSlashes(baseUrl);
  const candidates = [appendPath(trimmed, "/rerank")];
  if (trimmed.endsWith("/v1")) {
    candidates.push(`${trimmed.slice(0, -3)}/rerank`);
  } else {
    candidates.push(appendPath(trimmed, "/v1/rerank"));
  }
  return uniqueStrings(candidates);
}

export function extractModelIdsFromProbeResponse(data: unknown): string[] {
  if (!data || typeof data !== "object") return [];
  const record = data as Record<string, unknown>;

  const dataRows = Array.isArray(record.data) ? record.data : null;
  if (dataRows) {
    const ids = dataRows
      .map((item) => (item && typeof item === "object" ? (item as Record<string, unknown>).id : undefined))
      .filter((id): id is string => typeof id === "string" && id.length > 0);
    if (ids.length > 0) return ids;
  }

  const models = Array.isArray(record.models) ? record.models : null;
  if (models) {
    const ids = models.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const row = item as Record<string, unknown>;
      const out: string[] = [];
      if (typeof row.name === "string" && row.name.length > 0) out.push(row.name);
      if (typeof row.model === "string" && row.model.length > 0) out.push(row.model);
      return out;
    });
    if (ids.length > 0) return ids;
  }

  return [];
}

export function hasRerankResults(data: unknown): boolean {
  if (!data || typeof data !== "object") return false;
  const record = data as Record<string, unknown>;
  return Array.isArray(record.results) || Array.isArray(record.data);
}

export async function probeRerankRequest(
  resolved: ResolvedModelEndpoint,
  timeoutMs: number,
): Promise<RemoteConnectionStatus> {
  const verbose = isStatusVerbose();
  const candidates = buildRerankProbeCandidates(resolved.baseUrl);
  const headers = buildBearerHeaders(resolved.apiKey);
  const body = {
    model: resolved.model,
    query: "qmd status probe",
    documents: ["qmd status probe document"],
    top_n: 1,
  };
  let lastError = "rerank endpoint unreachable";

  for (const endpoint of candidates) {
    const start = Date.now();
    try {
      const response = await nodePost(endpoint, headers, body, timeoutMs);
      const latencyMs = Date.now() - start;
      if (!hasRerankResults(response)) {
        return {
          state: "error",
          detail: verbose ? `${endpoint} responded without rerank results` : "rerank probe malformed response",
          latencyMs,
        };
      }
      return {
        state: "ok",
        detail: verbose ? `${endpoint} accepted rerank request` : "rerank probe ok",
        latencyMs,
      };
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      lastError = sanitizeDiagnosticMessage(raw);
    }
  }

  return { state: "error", detail: lastError };
}

export function modelNameMatches(availableId: string, configuredModel: string): boolean {
  const a = availableId.trim();
  const b = configuredModel.trim();
  if (!a || !b) return false;
  if (a === b) return true;
  // Ollama tags: "model" in config can match "model:latest" from /api/tags.
  if (a.startsWith(`${b}:`) || b.startsWith(`${a}:`)) return true;
  return false;
}

export async function probeRemoteModelEndpoint(
  endpointRole: ModelEndpoint,
  resolved: ResolvedModelEndpoint,
): Promise<RemoteConnectionStatus> {
  const timeoutMs = parseInt(process.env.QMD_STATUS_REMOTE_TIMEOUT_MS || "2500", 10);
  const verbose = isStatusVerbose();
  const candidates = buildMetadataProbeCandidates(resolved.baseUrl, resolved.format);
  let lastError = "unreachable";

  for (const endpoint of candidates) {
    const start = Date.now();
    try {
      const response = await nodeGet(endpoint, buildBearerHeaders(resolved.apiKey), timeoutMs);
      const latencyMs = Date.now() - start;
      const availableIds = extractModelIdsFromProbeResponse(response);
      if (availableIds.length === 0) {
        return { state: "ok", detail: verbose ? `${endpoint} reachable` : "metadata reachable", latencyMs };
      }
      const exists = availableIds.some((id) => modelNameMatches(id, resolved.model));
      if (!exists && endpointRole === "rerank") {
        const rerankProbe = await probeRerankRequest(resolved, timeoutMs);
        if (rerankProbe.state === "ok") {
          return {
            state: "ok",
            detail: verbose
              ? `${endpoint} reachable; model not listed in metadata, but ${rerankProbe.detail}`
              : `metadata miss; ${rerankProbe.detail}`,
            latencyMs: rerankProbe.latencyMs ?? latencyMs,
          };
        }
        return {
          state: "error",
          detail: verbose
            ? `${endpoint} reachable; model not listed; ${rerankProbe.detail}`
            : `metadata miss; ${rerankProbe.detail}`,
          latencyMs: rerankProbe.latencyMs ?? latencyMs,
        };
      }
      return {
        state: exists ? "ok" : "error",
        detail: exists
          ? (verbose ? `${endpoint} reachable; model found` : "metadata lists model")
          : (verbose ? `${endpoint} reachable; model not listed` : "metadata miss (model not listed)"),
        latencyMs,
      };
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      lastError = sanitizeDiagnosticMessage(raw);
    }
  }

  return { state: "error", detail: lastError };
}

// =============================================================================
// Doctor check output helpers
// =============================================================================

export function doctorCheck(label: string, ok: boolean, details: string): void {
  const mark = ok ? `${c.green}✓${c.reset}` : `${c.yellow}⚠${c.reset}`;
  console.log(`${mark} ${label}: ${details}`);
}

export function formatCount(n: number): string {
  return n.toLocaleString("en-US");
}

export function shortModelName(model: string): string {
  if (model.startsWith("hf:")) {
    return model.split("/").pop() || model;
  }
  return model.length > 56 ? `${model.slice(0, 53)}...` : model;
}

function normalizedDoctorNextSteps(steps: string[]): string[] {
  const unique = Array.from(new Set(steps));
  const hasForceEmbed = unique.some(step => step.includes("qmd embed --force"));
  if (!hasForceEmbed) return unique;
  return unique.filter(step => !step.includes("qmd embed") || step.startsWith("Run `qmd embed --force`"));
}

function shortHashSeq(hashSeq: string): string {
  const idx = hashSeq.lastIndexOf("_");
  if (idx < 0) return hashSeq.length > 18 ? `${hashSeq.slice(0, 18)}...` : hashSeq;
  return `${hashSeq.slice(0, 12)}_${hashSeq.slice(idx + 1)}`;
}

function decodeStoredEmbedding(bytes: Uint8Array): Float32Array {
  return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

function cosineDistance(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length || a.length === 0) return Number.POSITIVE_INFINITY;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  if (normA === 0 || normB === 0) return Number.POSITIVE_INFINITY;
  return 1 - (dot / (Math.sqrt(normA) * Math.sqrt(normB)));
}

function formatModelDiagnosticPath(path: string): string {
  return sanitizeDiagnosticMessage(path);
}

function findCachedModelInspection(model: string): CachedModelInspection {
  const invalid: string[] = [];
  if (model.startsWith("hf:")) {
    const filename = model.split("/").pop();
    if (!filename || !existsSync(DEFAULT_MODEL_CACHE_DIR)) return { path: null, invalid };
    const entries = readdirSync(DEFAULT_MODEL_CACHE_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.includes(filename)) continue;
      const candidate = pathJoin(DEFAULT_MODEL_CACHE_DIR, entry.name);
      const inspection = inspectGgufFile(candidate);
      if (inspection.valid) return { path: candidate, invalid };
      invalid.push(`${formatModelDiagnosticPath(candidate)}: ${inspection.details}`);
    }
    return { path: null, invalid };
  }

  const inspection = inspectGgufFile(model);
  if (inspection.valid) return { path: model, invalid };
  if (inspection.exists) invalid.push(`${formatModelDiagnosticPath(model)}: ${inspection.details}`);
  return { path: null, invalid };
}

function envValueForDisplay(value: string): string {
  const sanitized = sanitizeDiagnosticMessage(value);
  return sanitized.length > 96 ? `${sanitized.slice(0, 93)}...` : sanitized;
}

export function collectEnvironmentOverrides(activeModels: { embed: string; generate: string; rerank: string }, configModels: ModelsConfig = {}): EnvOverride[] {
  const overrides: EnvOverride[] = [];
  const add = (name: string, consequence: string) => {
    const raw = process.env[name]?.trim();
    if (!raw) return;
    overrides.push({ name, value: envValueForDisplay(raw), consequence });
  };
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const addModel = (name: string, key: "embed" | "generate" | "rerank", active: string) => {
    const raw = process.env[name]?.trim();
    if (!raw) return;
    const configured = configModels[key];
    const consequence = configured && configured !== raw
      ? `set but ignored because index models.${key} is configured as ${configured}`
      : `sets the active ${key} model to ${active}; changes embedding/search semantics and may require \`qmd pull\` plus \`qmd embed\``;
    overrides.push({ name, value: envValueForDisplay(raw), consequence });
  };

  add("INDEX_PATH", "overrides the SQLite index path; QMD reads/writes a different database");
  add("QMD_CONFIG_DIR", "overrides the QMD config directory and takes precedence over XDG_CONFIG_HOME");
  add("XDG_CONFIG_HOME", "moves QMD config to $XDG_CONFIG_HOME/qmd when QMD_CONFIG_DIR is not set");
  add("XDG_CACHE_HOME", "moves the default index cache, model cache, and MCP daemon PID files");
  addModel("QMD_EMBED_MODEL", "embed", activeModels.embed);
  addModel("QMD_GENERATE_MODEL", "generate", activeModels.generate);
  addModel("QMD_RERANK_MODEL", "rerank", activeModels.rerank);
  add("QMD_FORCE_CPU", "forces llama.cpp to bypass GPU backends; embeddings/query will be slower but GPU crashes are avoided");
  add("QMD_LLAMA_GPU", "selects llama.cpp GPU backend (metal/cuda/vulkan) or disables GPU when set to false/off/0");
  add("QMD_DOCTOR_DEVICE_PROBE", "controls qmd doctor native device probing; 0/off skips GPU probing");
  add("QMD_EMBED_PARALLELISM", "overrides embedding parallel context count; too high can exhaust RAM/VRAM");
  add("QMD_EXPAND_CONTEXT_SIZE", "overrides query expansion context size; larger values use more memory");
  add("QMD_RERANK_CONTEXT_SIZE", "overrides reranker context size; larger values use more memory");
  add("QMD_EMBED_CONTEXT_SIZE", "overrides embed context size; larger values use more memory");
  add("QMD_STATUS_VERBOSE", "shows full per-endpoint diagnostics in `qmd status` model connection output");
  add("QMD_EDITOR_URI", "overrides clickable editor link template in terminal output");
  add("QMD_SKILLS_DIR", "overrides where qmd skills are discovered from");
  add("QMD_METAL_KEEP_RESIDENCY", "opts back into libggml-metal residency sets on darwin; restores ~0ms perf wins for long-lived processes but re-exposes the static-destructor backtrace dump at process exit (ggml-org/llama.cpp#22593)");
  add("GGML_METAL_NO_RESIDENCY", "set automatically by the launcher on darwin to disable Metal residency sets (avoids ggml-org/llama.cpp#22593); override via QMD_METAL_KEEP_RESIDENCY=1");
  add("NO_COLOR", "disables colored terminal output");
  add("CI", "disables real LLM operations inside QMD's LlamaCpp wrapper");
  add("HF_ENDPOINT", "changes Hugging Face download endpoint used when pulling models");
  add("QMD_WRAPPER_CAPTURE", "test/debug hook for the qmd shell wrapper; should not be set in normal use");
  add("WSL_DISTRO_NAME", "enables WSL path handling heuristics");
  add("WSL_INTEROP", "enables WSL path handling heuristics");
  return overrides;
}

function checkDoctorIndexConfig(nextSteps: string[]): DoctorConfigCheck {
  try {
    const config = loadConfig();
    const collectionCount = Object.keys(config.collections ?? {}).length;
    if (collectionCount === 0) {
      doctorCheck("index config", false, "no collections configured. Next: `qmd collection add .`");
      nextSteps.push("Run `qmd collection add . --name <name>` from the folder you want to index, or edit .qmd/index.yml manually.");
    } else {
      doctorCheck("index config", true, `${formatCount(collectionCount)} ${collectionCount === 1 ? "collection" : "collections"} configured`);
    }
    return { config, valid: true };
  } catch (error) {
    const message = error instanceof Error ? sanitizeDiagnosticMessage(error.message) : sanitizeDiagnosticMessage(String(error));
    const configPath = getConfigPath();
    doctorCheck("index config", false, `invalid index.yml at ${configPath}: ${message}. Next: fix the YAML and rerun \`qmd doctor\``);
    nextSteps.push(`Fix invalid YAML in ${configPath}, then rerun \`qmd doctor\`.`);
    return { config: null, valid: false };
  }
}

function checkEnvironmentOverrides(activeModels: { embed: string; generate: string; rerank: string }, configModels: ModelsConfig = {}): void {
  const overrides = collectEnvironmentOverrides(activeModels, configModels);
  if (overrides.length === 0) {
    doctorCheck("environment overrides", true, "none");
    return;
  }

  doctorCheck("environment overrides", false, `${overrides.length} set`);
  for (const override of overrides) {
    console.log(`  - ${override.name}=${override.value}: ${override.consequence}`);
  }
}

function checkModelDefaults(activeModels: { embed: string; generate: string; rerank: string }, configModels: ModelsConfig = {}): void {
  const checks = [
    { role: "embedding", key: "embed" as const, active: activeModels.embed, configured: configModels.embed, defaultModel: DEFAULT_EMBED_MODEL, envName: "QMD_EMBED_MODEL", envValue: process.env.QMD_EMBED_MODEL },
    { role: "generation", key: "generate" as const, active: activeModels.generate, configured: configModels.generate, defaultModel: DEFAULT_QUERY_MODEL, envName: "QMD_GENERATE_MODEL", envValue: process.env.QMD_GENERATE_MODEL },
    { role: "reranking", key: "rerank" as const, active: activeModels.rerank, configured: configModels.rerank, defaultModel: DEFAULT_RERANK_MODEL, envName: "QMD_RERANK_MODEL", envValue: process.env.QMD_RERANK_MODEL },
  ];

  const notes: string[] = [];
  for (const check of checks) {
    const envValue = check.envValue?.trim();
    if (envValue && check.active === envValue) {
      notes.push(`${check.role}: env ${check.envName}=${check.active} (default ${check.defaultModel}; might be ok)`);
    } else if (check.configured && check.configured !== check.defaultModel) {
      notes.push(`${check.role}: index ${check.configured} (default ${check.defaultModel}; might be ok)`);
    } else if (envValue && check.active !== envValue) {
      notes.push(`${check.role}: ${check.envName} is set to ${envValue} but index config uses ${check.active}`);
    }
  }

  if (notes.length === 0) {
    doctorCheck("model defaults", true, "using QMD codebase defaults");
    return;
  }

  doctorCheck("model defaults", false, `non-default model configuration: ${notes.join("; ")}`);
}

function checkModelCache(activeModels: { embed: string; generate: string; rerank: string }, nextSteps: string[]): void {
  const models = [
    ["embedding" as const, activeModels.embed],
    ["generation" as const, activeModels.generate],
    ["reranking" as const, activeModels.rerank],
  ] as const;
  const unique = new Map<string, string[]>();
  for (const [role, model] of models) {
    unique.set(model, [...(unique.get(model) ?? []), role]);
  }

  const missing: string[] = [];
  const cached: string[] = [];
  const invalid: string[] = [];
  for (const [model, roles] of unique) {
    const label = `${roles.join("+")}: ${model}`;
    const inspection = findCachedModelInspection(model);
    invalid.push(...inspection.invalid.map(detail => `${label} (${detail})`));
    if (inspection.path) {
      cached.push(label);
    } else {
      missing.push(label);
    }
  }

  if (missing.length === 0 && invalid.length === 0) {
    doctorCheck("model cache", true, `${cached.length} active ${cached.length === 1 ? "model is" : "models are"} downloaded and valid GGUF`);
    return;
  }

  const parts: string[] = [];
  if (invalid.length > 0) parts.push(`invalid ${invalid.length}: ${invalid.join("; ")}`);
  if (missing.length > 0) parts.push(`missing ${missing.length}/${unique.size}: ${missing.join("; ")}`);
  const next = invalid.length > 0
    ? "Next: run `qmd pull --refresh` (or remove the bad cached file)"
    : "Next: run `qmd pull`";
  doctorCheck("model cache", false, `${parts.join("; ")}. ${next}`);
  if (invalid.length > 0) {
    nextSteps.push("Run `qmd pull --refresh` to replace invalid cached model files, or delete the listed file and rerun `qmd pull`.");
  } else {
    nextSteps.push("Run `qmd pull` to download missing embedding/generation/reranking models before `qmd embed` or `qmd query`.");
  }
}

async function checkEmbeddingVectorSamples(db: Database, model: string, fingerprint: string, sampleSize: number = 3): Promise<DoctorVectorSampleResult> {
  const activeDocs = (db.prepare(`SELECT COUNT(*) AS count FROM documents WHERE active = 1`).get() as { count: number }).count;
  if (activeDocs === 0) {
    return { ok: true, details: "no active documents indexed" };
  }

  const vecTableExists = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='vectors_vec'`).get();
  if (!vecTableExists) {
    return { ok: false, details: "no vector table to test; please run qmd embed again" };
  }

  const samples = db.prepare(`
    SELECT cv.hash, cv.seq, c.doc AS body, MIN(d.path) AS path
    FROM content_vectors cv
    JOIN documents d ON d.hash = cv.hash AND d.active = 1
    JOIN content c ON c.hash = cv.hash
    WHERE cv.model = ? AND cv.embed_fingerprint = ?
    GROUP BY cv.hash, cv.seq, c.doc
    ORDER BY random()
    LIMIT ?
  `).all(model, fingerprint, sampleSize) as { hash: string; seq: number; body: string; path: string }[];

  if (samples.length === 0) {
    return { ok: false, details: "no current embedded chunks to test; please run qmd embed again" };
  }

  const threshold = 0.0001;
  const mismatches: string[] = [];

  await withLLMSession(async (session) => {
    for (const sample of samples) {
      const hashSeq = `${sample.hash}_${sample.seq}`;
      const chunks = await chunkDocumentByTokens(sample.body, undefined, undefined, undefined, sample.path, undefined, session.signal);
      const chunk = chunks[sample.seq];
      if (!chunk) {
        mismatches.push(`${shortHashSeq(hashSeq)}: chunk no longer exists`);
        continue;
      }

      const title = extractTitle(sample.body, sample.path);
      const result = await session.embed(formatDocForEmbedding(chunk.text, title, model), { model });
      if (!result) {
        mismatches.push(`${shortHashSeq(hashSeq)}: embedding failed`);
        continue;
      }

      const stored = db.prepare(`SELECT embedding FROM vectors_vec WHERE hash_seq = ?`).get(hashSeq) as { embedding: Uint8Array } | undefined;
      if (!stored) {
        mismatches.push(`${shortHashSeq(hashSeq)}: stored vector missing`);
        continue;
      }

      const distance = cosineDistance(result.embedding, decodeStoredEmbedding(stored.embedding));
      if (distance > threshold) {
        mismatches.push(`${shortHashSeq(hashSeq)}: stored vector distance ${distance.toFixed(6)}`);
      }
    }
  }, { maxDuration: 10 * 60 * 1000, name: "doctorEmbeddingVectorSample" });

  if (mismatches.length > 0) {
    return {
      ok: false,
      details: `${mismatches.length}/${samples.length} sampled chunks differ from stored vectors (${mismatches[0]}). Rebuild with \`qmd embed --force\``,
    };
  }

  return {
    ok: true,
    details: `${samples.length} sampled ${samples.length === 1 ? "chunk" : "chunks"} reproduce stored vectors`,
  };
}

function hasLibraryInDirs(libraryBaseName: string, dirs: string[]): boolean {
  for (const dir of dirs) {
    if (!dir || !existsSync(dir)) continue;
    try {
      for (const entry of readdirSync(dir)) {
        if (entry === libraryBaseName || entry.startsWith(`${libraryBaseName}.`)) return true;
      }
    } catch { /* ignore unreadable system library dirs */ }
  }
  return false;
}

function linuxCudaRuntimeDiagnostic(): string | null {
  if (process.platform !== "linux") return null;

  const dirs = new Set<string>();
  for (const value of [process.env.LD_LIBRARY_PATH, process.env.CUDA_PATH]) {
    for (const part of (value ?? "").split(":")) {
      if (part) dirs.add(part);
    }
  }
  if (process.env.CUDA_PATH) {
    dirs.add(pathJoin(process.env.CUDA_PATH, "lib64"));
    dirs.add(pathJoin(process.env.CUDA_PATH, "targets", "x86_64-linux", "lib"));
  }
  for (const dir of ["/usr/lib", "/usr/lib64", "/usr/lib/x86_64-linux-gnu", "/usr/local/cuda/lib64", "/usr/local/cuda/targets/x86_64-linux/lib"]) {
    dirs.add(dir);
  }
  try {
    for (const entry of readdirSync("/usr/local")) {
      if (!entry.toLowerCase().startsWith("cuda-")) continue;
      const cudaRoot = pathJoin("/usr/local", entry);
      dirs.add(pathJoin(cudaRoot, "lib64"));
      dirs.add(pathJoin(cudaRoot, "targets", "x86_64-linux", "lib"));
    }
  } catch { /* /usr/local may not be readable in restricted environments */ }

  const searchDirs = [...dirs];
  const hasDriver = hasLibraryInDirs("libcuda.so", searchDirs) || hasLibraryInDirs("libnvidia-ml.so", searchDirs);
  if (!hasDriver) return null;

  const cudaLibraries: [library: string, label: string][] = [
    ["libcudart.so", "CUDA runtime"],
    ["libcublas.so", "cuBLAS"],
    ["libcublasLt.so", "cuBLASLt"],
  ];
  const missing = cudaLibraries
    .filter(([library]) => !hasLibraryInDirs(library, searchDirs))
    .map(([, label]) => label);

  if (missing.length === 0) return null;
  return `NVIDIA driver libraries are visible, but CUDA user-space libraries are missing from loader paths (${missing.join(", ")})`;
}

async function runDoctorDeviceChecks(nextSteps: string[]): Promise<void> {
  const mode = configuredGpuModeLabel();
  doctorCheck("device mode", true, mode);

  const skipProbe = ["0", "false", "off", "no", "skip"].includes((process.env.QMD_DOCTOR_DEVICE_PROBE ?? "").trim().toLowerCase());
  if (skipProbe) {
    doctorCheck("device probe", false, "skipped by QMD_DOCTOR_DEVICE_PROBE=0. Next: unset it and rerun `qmd doctor` to verify GPU/CPU acceleration");
    nextSteps.push("Unset `QMD_DOCTOR_DEVICE_PROBE` and rerun `qmd doctor` when you want to verify llama.cpp device acceleration.");
    return;
  }

  const crashHint = "Probing native llama backend now. If qmd crashes here, rerun with `QMD_FORCE_CPU=1 qmd doctor` (or `QMD_DOCTOR_DEVICE_PROBE=0 qmd doctor` to skip this probe).";
  if (process.stdout.isTTY) {
    process.stdout.write(`${c.dim}${crashHint}${c.reset}`);
  }

  try {
    const device = await getDefaultLlamaCpp().getDeviceInfo({ allowBuild: false });
    if (process.stdout.isTTY) {
      process.stdout.write(`\r${" ".repeat(crashHint.length)}\r`);
    }
    if (device.gpu) {
      const gpuLabel = device.gpu === "metal" && process.platform === "darwin"
        ? "metal (macOS Metal backend)"
        : String(device.gpu);
      const parts = [`GPU ${gpuLabel}`, `offloading ${device.gpuOffloading ? "enabled" : "disabled"}`];
      if (device.gpuDevices.length > 0) parts.push(`devices: ${summarizeDeviceNames(device.gpuDevices)}`);
      if (device.vram) parts.push(`VRAM ${formatBytes(device.vram.free)} free / ${formatBytes(device.vram.total)} total`);
      parts.push(`${device.cpuCores} CPU math cores`);
      doctorCheck("device probe", device.gpuOffloading, device.gpuOffloading
        ? parts.join("; ")
        : `${parts.join("; ")}. Next: check QMD_LLAMA_GPU and llama.cpp backend support`);
      if (!device.gpuOffloading) {
        nextSteps.push("GPU was detected but offloading is disabled; check `QMD_LLAMA_GPU=metal|cuda|vulkan` and rerun `qmd doctor`.");
      }

      if (device.gpu === "metal" && process.platform === "darwin") {
        if (isDarwinMetalMitigationActive()) {
          doctorCheck(
            "darwin metal residency",
            true,
            "GGML_METAL_NO_RESIDENCY=1 set by launcher; clean process exit (avoids ggml-org/llama.cpp#22593). Opt back in with QMD_METAL_KEEP_RESIDENCY=1 if you run long-lived qmd processes."
          );
        } else {
          doctorCheck(
            "darwin metal residency",
            false,
            "residency sets active (QMD_METAL_KEEP_RESIDENCY=1 or launcher bypassed); llama-using commands may dump a libggml-metal backtrace at exit (ggml-org/llama.cpp#22593) even when output succeeded."
          );
          nextSteps.push("Unset `QMD_METAL_KEEP_RESIDENCY` so the launcher can disable Metal residency sets; without this, query/vsearch/embed dump a stack trace at exit even on success.");
        }
      }
    } else {
      const cudaDiagnostic = linuxCudaRuntimeDiagnostic();
      const diagnosticSuffix = cudaDiagnostic ? ` ${cudaDiagnostic}.` : "";
      doctorCheck("device probe", false, `running on CPU (${device.cpuCores} math cores).${diagnosticSuffix} Next: install/configure Metal, CUDA, or Vulkan for faster embeddings, or set QMD_FORCE_CPU=1 to make CPU mode explicit`);
      if (cudaDiagnostic) {
        nextSteps.push(`${cudaDiagnostic}; install CUDA runtime/cuBLAS libraries or add their directory to LD_LIBRARY_PATH, then rerun \`qmd doctor\`.`);
      } else {
        nextSteps.push("Vector operations are running on CPU; install/configure Metal, CUDA, or Vulkan if embedding/query performance is too slow.");
      }
    }
  } catch (error) {
    if (process.stdout.isTTY) {
      process.stdout.write(`\r${" ".repeat(crashHint.length)}\r`);
    }
    const message = error instanceof Error ? sanitizeDiagnosticMessage(error.message) : sanitizeDiagnosticMessage(String(error));
    doctorCheck("device probe", false, `probe failed: ${message}. Next: run with QMD_FORCE_CPU=1 to bypass GPU probing, or set QMD_LLAMA_GPU=metal|cuda|vulkan and retry`);
    nextSteps.push("GPU probe failed; try `QMD_FORCE_CPU=1 qmd doctor` to confirm CPU fallback, then fix GPU drivers/backend if acceleration is expected.");
  }
}

// =============================================================================
// Package JSON reader (used for the better-sqlite3 version check)
// =============================================================================

type PackageJson = {
  version: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

function readPackageJson(): PackageJson {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const pkgPath = pathResolve(scriptDir, "..", "..", "..", "package.json");
  return JSON.parse(readFileSync(pkgPath, "utf-8"));
}

// =============================================================================
// Main doctor entry point
// =============================================================================

/**
 * Run the full qmd doctor diagnostic checklist.
 *
 * Accepts the database, store, and resolved model parameters explicitly to
 * avoid circular imports with the CLI module (qmd.ts owns getStore/getDb).
 *
 * @param db           - open SQLite database handle
 * @param store        - store instance (needed for maybeAdoptLegacyEmbeddingFingerprint)
 * @param activeModels - resolved model names for embed/generate/rerank
 * @param dbPath       - filesystem path to the active SQLite index (for display)
 * @param configModels - optional index.yml model overrides (from loadConfig().models)
 */
export async function runDoctor(
  db: Database,
  store: Store,
  activeModels: { embed: string; generate: string; rerank: string },
  dbPath: string,
  configModels?: ModelsConfig,
): Promise<void> {
  const embedModel = activeModels.embed;
  const fingerprint = getEmbeddingFingerprint(embedModel);
  const nextSteps: string[] = [];

  // Read package.json for the better-sqlite3 version display
  const pkg = readPackageJson();
  const betterSqliteVersion = pkg.dependencies?.["better-sqlite3"] ?? pkg.devDependencies?.["better-sqlite3"] ?? "not declared";

  console.log(`${c.bold}QMD Doctor${c.reset}\n`);
  console.log(`Index: ${dbPath}`);
  console.log(`Runtime: ${isBun ? "bun:sqlite" : "better-sqlite3"}`);

  // SQLite runtime check
  try {
    const row = db.prepare(`SELECT sqlite_version() AS version`).get() as { version: string };
    doctorCheck("SQLite runtime", true, row.version);
  } catch (error) {
    doctorCheck("SQLite runtime", false, error instanceof Error ? error.message : String(error));
  }

  // better-sqlite3 package check
  doctorCheck("better-sqlite3 package", true, String(betterSqliteVersion));

  // sqlite-vec check
  try {
    const row = db.prepare(`SELECT vec_version() AS version`).get() as { version: string };
    doctorCheck("sqlite-vec", true, row.version);
  } catch (error) {
    doctorCheck("sqlite-vec", false, error instanceof Error ? error.message : String(error));
  }

  // Index config check
  const configCheck = checkDoctorIndexConfig(nextSteps);
  const resolvedConfigModels: ModelsConfig = configModels ?? configCheck.config?.models ?? {};
  checkEnvironmentOverrides(activeModels, resolvedConfigModels);
  checkModelDefaults(activeModels, resolvedConfigModels);
  checkModelCache(activeModels, nextSteps);

  // Device checks
  await runDoctorDeviceChecks(nextSteps);

  // Legacy fingerprint adoption
  try {
    const adoption = await maybeAdoptLegacyEmbeddingFingerprint(store, embedModel);
    if (adoption.checked || adoption.adopted > 0) {
      doctorCheck("legacy fingerprint adoption", adoption.adopted > 0, adoption.adopted > 0 ? `adopted ${adoption.adopted} legacy chunks; ${adoption.reason}` : adoption.reason);
    }
  } catch (error) {
    doctorCheck("legacy fingerprint adoption", false, error instanceof Error ? error.message : String(error));
  }

  // Embedding freshness
  try {
    const pending = getHashesNeedingEmbedding(db, undefined, embedModel);
    doctorCheck("embedding freshness", pending === 0, pending === 0 ? "all active documents match current fingerprint" : `${formatCount(pending)} active documents need embeddings. Next: \`qmd embed\``);
    if (pending > 0) {
      nextSteps.push(`Run \`qmd embed\` to generate ${formatCount(pending)} missing/stale document embeddings.`);
    }
  } catch (error) {
    doctorCheck("embedding freshness", false, error instanceof Error ? error.message : String(error));
  }

  // Embedding fingerprints (content_vectors analysis)
  try {
    const rows = db.prepare(`
      SELECT model, embed_fingerprint AS fingerprint, COUNT(DISTINCT hash) AS docs, COUNT(*) AS chunks
      FROM content_vectors
      GROUP BY model, embed_fingerprint
      ORDER BY chunks DESC, model, embed_fingerprint
    `).all() as { model: string; fingerprint: string; docs: number; chunks: number }[];
    const uniqueFingerprints = new Set(rows.map(row => row.fingerprint));
    const offCurrent = rows.filter(row => row.model === embedModel && row.fingerprint !== fingerprint);
    const ok = rows.length === 0 || (uniqueFingerprints.size === 1 && rows[0]?.fingerprint === fingerprint && offCurrent.length === 0);
    const currentDocs = rows
      .filter(row => row.model === embedModel && row.fingerprint === fingerprint)
      .reduce((sum, row) => sum + row.docs, 0);
    const otherDocs = rows.reduce((sum, row) => sum + row.docs, 0) - currentDocs;
    const groups = rows.map(row => {
      const label = row.fingerprint === fingerprint ? "current" : (row.fingerprint || "legacy");
      return `${shortModelName(row.model)}:${label} ${formatCount(row.docs)} docs/${formatCount(row.chunks)} chunks`;
    }).join("; ");
    const namedFingerprintRows = rows.filter(row => row.fingerprint);
    const namedFingerprints = [...new Set(namedFingerprintRows.map(row => row.fingerprint))];
    if (namedFingerprints.length > 1) {
      const namedGroups = namedFingerprintRows
        .map(row => `${row.fingerprint}${row.fingerprint === fingerprint ? " (current)" : ""}: ${shortModelName(row.model)} ${formatCount(row.docs)} docs/${formatCount(row.chunks)} chunks`)
        .join("; ");
      doctorCheck("mixed named embedding fingerprints", false, `content_vectors contains ${namedFingerprints.length} named fingerprints: ${namedGroups}. Next: \`qmd embed\` or \`qmd embed --force\``);
      nextSteps.push("Run `qmd embed` to converge mixed named embedding fingerprints; use `qmd embed --force` if old named fingerprints or vector sample mismatches remain.");
    }
    const details = rows.length === 0
      ? `no vectors yet; current fingerprint ${fingerprint}`
      : ok
        ? `${formatCount(currentDocs)} docs on current fingerprint (${fingerprint})`
        : `${formatCount(currentDocs)} docs current, ${formatCount(otherDocs)} docs legacy/stale. ${groups}. Next: \`qmd embed\``;
    doctorCheck("embedding fingerprints", ok, details);
    if (!ok) {
      nextSteps.push("Run `qmd embed` to migrate active documents to the current embedding fingerprint; use `qmd embed --force` if vector samples still fail afterward.");
    }
  } catch (error) {
    doctorCheck("embedding fingerprints", false, error instanceof Error ? error.message : String(error));
  }

  // Embedding vector samples
  try {
    const vectorSample = await checkEmbeddingVectorSamples(db, embedModel, fingerprint);
    doctorCheck("embedding vector sample", vectorSample.ok, vectorSample.details);
    if (!vectorSample.ok) {
      nextSteps.push("Run `qmd embed --force` to rebuild existing vectors that no longer reproduce under the current embedding pipeline.");
    }
  } catch (error) {
    const message = error instanceof Error ? sanitizeDiagnosticMessage(error.message) : sanitizeDiagnosticMessage(String(error));
    doctorCheck("embedding vector sample", false, `${message}; rebuild with \`qmd embed --force\``);
    nextSteps.push("Run `qmd embed --force` to rebuild existing vectors, then rerun `qmd doctor`.");
  }

  // Next steps summary
  const steps = normalizedDoctorNextSteps(nextSteps);
  if (steps.length > 0) {
    console.log(`\n${c.bold}Recommended next step${steps.length === 1 ? "" : "s"}${c.reset}`);
    for (const step of steps) {
      console.log(`  - ${step}`);
    }
  }
}
