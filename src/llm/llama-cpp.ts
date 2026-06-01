/**
 * llm/llama-cpp.ts - LlamaCpp implementation of the LLM interface
 *
 * Provides embeddings, text generation, and reranking using local GGUF models
 * via node-llama-cpp bindings.
 */

import type {
  Llama,
  LlamaModel,
  LlamaEmbeddingContext,
  Token as LlamaToken,
} from "node-llama-cpp";
import type {
  LLM,
  EmbedOptions,
  EmbeddingResult,
  GenerateOptions,
  GenerateResult,
  ModelInfo,
  QueryType,
  Queryable,
  RerankOptions,
  RerankResult,
  RerankDocument,
  RerankDocumentResult,
  LlamaCppConfig,
  LlamaGpuMode,
} from "./types.js";
import { existsSync, mkdirSync } from "fs";
import {
  validateGgufFile,
  DEFAULT_MODEL_CACHE_DIR as MODEL_CACHE_DIR,
  resolveEmbedModel,
  resolveGenerateModel,
  resolveRerankModel,
} from "./model-cache.js";

// =============================================================================
// Internal Types
// =============================================================================

type StdoutChunk = string | Uint8Array;
type WriteCallback = (err?: Error | null) => void;

type NodeLlamaCppModule = {
  getLlama: (options: Record<string, unknown>) => Promise<Llama>;
  getLlamaGpuTypes?: (include?: "supported" | "allValid") => Promise<LlamaGpuMode[]>;
  resolveModelFile: (model: string, cacheDir: string) => Promise<string>;
  LlamaChatSession: new (options: { contextSequence: unknown }) => {
    prompt: (prompt: string, options?: Record<string, unknown>) => Promise<string>;
  };
  LlamaLogLevel: { error: unknown };
};

type StdoutWrite = typeof process.stdout.write;

type ParallelismOptions = {
  gpu: string | false;
  platform?: NodeJS.Platform;
  computed: number;
  envValue?: string;
};

// =============================================================================
// Module-level State
// =============================================================================

let nodeLlamaCppImport: Promise<NodeLlamaCppModule> | null = null;
export async function loadNodeLlamaCpp(): Promise<NodeLlamaCppModule> {
  nodeLlamaCppImport ??= withNativeStdoutRedirectedToStderr(
    () => import("node-llama-cpp") as Promise<NodeLlamaCppModule>
  );
  return nodeLlamaCppImport;
}

export function setNodeLlamaCppModuleForTest(module: NodeLlamaCppModule | null): void {
  nodeLlamaCppImport = module ? Promise.resolve(module) : null;
  failedGpuInitModes.clear();
  noGpuAccelerationWarningShown = false;
  cpuForcedPrebuiltFallbackWarningShown = false;
}

let nativeStdoutRedirectDepth = 0;
let originalStdoutWrite: StdoutWrite | null = null;

/**
 * Some node-llama-cpp native build/probe paths write library noise to stdout.
 * JSON APIs must reserve stdout for machine-readable payloads, so route that
 * noise to stderr while native llama initialization is in progress.
 */
export async function withNativeStdoutRedirectedToStderr<T>(fn: () => Promise<T>): Promise<T> {
  if (nativeStdoutRedirectDepth === 0) {
    originalStdoutWrite = process.stdout.write.bind(process.stdout) as StdoutWrite;
    process.stdout.write = ((chunk: StdoutChunk, encodingOrCallback?: BufferEncoding | WriteCallback, callback?: WriteCallback) => {
      if (typeof encodingOrCallback === "function") {
        return process.stderr.write(chunk, encodingOrCallback);
      }
      return process.stderr.write(chunk, encodingOrCallback, callback);
    }) as StdoutWrite;
  }
  nativeStdoutRedirectDepth++;
  try {
    return await fn();
  } finally {
    nativeStdoutRedirectDepth--;
    if (nativeStdoutRedirectDepth === 0 && originalStdoutWrite) {
      process.stdout.write = originalStdoutWrite;
      originalStdoutWrite = null;
    }
  }
}

// =============================================================================
// Helper Functions
// =============================================================================

export function resolveParallelismOverride(envValue = process.env.QMD_EMBED_PARALLELISM): number | undefined {
  const normalized = envValue?.trim() ?? "";
  if (!normalized) return undefined;

  const parsed = Number(normalized);
  if (!Number.isInteger(parsed) || parsed < 1) {
    process.stderr.write(`QMD Warning: invalid QMD_EMBED_PARALLELISM="${envValue}", using automatic parallelism.\n`);
    return undefined;
  }

  return Math.min(8, parsed);
}

export function resolveSafeParallelism(options: ParallelismOptions): number {
  const override = resolveParallelismOverride(options.envValue);
  if (override !== undefined) return override;

  // node-llama-cpp/llama.cpp CUDA on Windows is unstable with multiple
  // simultaneous contexts (ggml-cuda.cu:98 in #519). Vulkan and CPU do not
  // show the same failure mode, so only serialize Windows CUDA by default.
  if ((options.platform ?? process.platform) === "win32" && options.gpu === "cuda") {
    return 1;
  }

  return Math.max(1, options.computed);
}

export function resolveLlamaGpuMode(
  envValue = process.env.QMD_LLAMA_GPU,
  forceCpuValue = process.env.QMD_FORCE_CPU
): LlamaGpuMode {
  const forceCpu = forceCpuValue?.trim().toLowerCase() ?? "";
  if (forceCpu && !["false", "off", "none", "disable", "disabled", "0"].includes(forceCpu)) {
    return false;
  }

  const normalized = envValue?.trim().toLowerCase() ?? "";
  if (!normalized) return "auto";
  if (["false", "off", "none", "disable", "disabled", "0"].includes(normalized)) return false;
  if (normalized === "metal" || normalized === "vulkan" || normalized === "cuda") return normalized;

  process.stderr.write(`QMD Warning: invalid QMD_LLAMA_GPU="${envValue}", using auto GPU selection.\n`);
  return "auto";
}

async function disposeWithTimeout(resourceName: string, dispose: () => Promise<void>, timeoutMs = 1000): Promise<void> {
  const timeoutPromise = new Promise<"timeout">((resolve) => {
    setTimeout(() => resolve("timeout"), timeoutMs).unref();
  });

  try {
    const result = await Promise.race([dispose(), timeoutPromise]);
    if (result === "timeout") {
      process.stderr.write(`QMD Warning: timed out disposing ${resourceName}; continuing shutdown.\n`);
    }
  } catch (error) {
    process.stderr.write(
      `QMD Warning: failed to dispose ${resourceName} (${error instanceof Error ? error.message : String(error)}); continuing shutdown.\n`
    );
  }
}

function resolveExpandContextSize(configValue?: number): number {
  if (configValue !== undefined) {
    if (!Number.isInteger(configValue) || configValue <= 0) {
      throw new Error(`Invalid expandContextSize: ${configValue}. Must be a positive integer.`);
    }
    return configValue;
  }

  const envValue = process.env.QMD_EXPAND_CONTEXT_SIZE?.trim();
  if (!envValue) return DEFAULT_EXPAND_CONTEXT_SIZE;

  const parsed = Number.parseInt(envValue, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    process.stderr.write(
      `QMD Warning: invalid QMD_EXPAND_CONTEXT_SIZE="${envValue}", using default ${DEFAULT_EXPAND_CONTEXT_SIZE}.\n`
    );
    return DEFAULT_EXPAND_CONTEXT_SIZE;
  }
  return parsed;
}

const failedGpuInitModes = new Set<LlamaGpuMode>();
let noGpuAccelerationWarningShown = false;
let cpuForcedPrebuiltFallbackWarningShown = false;

function isCpuModeRequested(): boolean {
  return resolveLlamaGpuMode() === false;
}

// =============================================================================
// Constants
// =============================================================================

// Default inactivity timeout: 5 minutes (keep models warm during typical search sessions)
const DEFAULT_INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_EXPAND_CONTEXT_SIZE = 2048;

// =============================================================================
// LlamaCpp Class
// =============================================================================

export class LlamaCpp implements LLM {
  private readonly _ciMode = !!process.env.CI;
  private llama: Llama | null = null;
  private embedModel: LlamaModel | null = null;
  private embedContexts: LlamaEmbeddingContext[] = [];
  private generateModel: LlamaModel | null = null;
  private rerankModel: LlamaModel | null = null;
  private rerankContexts: Awaited<ReturnType<LlamaModel["createRankingContext"]>>[] = [];

  private embedModelUri: string;
  private generateModelUri: string;
  private rerankModelUri: string;
  private modelCacheDir: string;
  private expandContextSize: number;

  // Ensure we don't load the same model/context concurrently (which can allocate duplicate VRAM).
  private embedModelLoadPromise: Promise<LlamaModel> | null = null;
  private generateModelLoadPromise: Promise<LlamaModel> | null = null;
  private rerankModelLoadPromise: Promise<LlamaModel> | null = null;

  // Inactivity timer for auto-unloading models
  private inactivityTimer: ReturnType<typeof setTimeout> | null = null;
  private inactivityTimeoutMs: number;
  private disposeModelsOnInactivity: boolean;

  // Track disposal state to prevent double-dispose
  private disposed = false;


  constructor(config: LlamaCppConfig = {}) {
    // STRUCTURAL INVARIANT: the launcher (bin/qmd) sets GGML_METAL_NO_RESIDENCY=1
    // on darwin BEFORE the native binding loads, which prevents the libggml-metal
    // static destructor assertion at process exit (ggml-org/llama.cpp#22593).
    // See isDarwinMetalMitigationActive() for the runtime check exposed to
    // diagnostics. No constructor-time guard installation is needed.

    this.embedModelUri = resolveEmbedModel({ embed: config.embedModel });
    this.generateModelUri = resolveGenerateModel({ generate: config.generateModel });
    this.rerankModelUri = resolveRerankModel({ rerank: config.rerankModel });
    this.modelCacheDir = config.modelCacheDir || MODEL_CACHE_DIR;
    this.expandContextSize = resolveExpandContextSize(config.expandContextSize);
    this.inactivityTimeoutMs = config.inactivityTimeoutMs ?? DEFAULT_INACTIVITY_TIMEOUT_MS;
    this.disposeModelsOnInactivity = config.disposeModelsOnInactivity ?? false;
  }

  get embedModelName(): string {
    return this.embedModelUri;
  }

  get generateModelName(): string {
    return this.generateModelUri;
  }

  get rerankModelName(): string {
    return this.rerankModelUri;
  }

  /**
   * Reset the inactivity timer. Called after each model operation.
   * When timer fires, models are unloaded to free memory (if no active sessions).
   */
  private touchActivity(): void {
    // Clear existing timer
    if (this.inactivityTimer) {
      clearTimeout(this.inactivityTimer);
      this.inactivityTimer = null;
    }

    // Only set timer if we have disposable contexts and timeout is enabled
    if (this.inactivityTimeoutMs > 0 && this.hasLoadedContexts()) {
      this.inactivityTimer = setTimeout(async () => {
        // Check if session manager allows unloading
        // canUnloadLLM is defined in session.ts — use dynamic import to avoid circular dependency
        const { canUnloadLLM } = await import("./session.js");
        if (typeof canUnloadLLM === 'function' && !canUnloadLLM()) {
          // Active sessions/operations - reschedule timer
          this.touchActivity();
          return;
        }
        this.unloadIdleResources().catch(err => {
          console.error("Error unloading idle resources:", err);
        });
      }, this.inactivityTimeoutMs);
      // Don't keep process alive just for this timer
      this.inactivityTimer.unref();
    }
  }

  /**
   * Check if any contexts are currently loaded (and therefore worth unloading on inactivity).
   */
  private hasLoadedContexts(): boolean {
    return !!(this.embedContexts.length > 0 || this.rerankContexts.length > 0);
  }

  /**
   * Unload idle resources but keep the instance alive for future use.
   *
   * By default, this disposes contexts (and their dependent sequences), while keeping models loaded.
   * This matches the intended lifecycle: model → context → sequence, where contexts are per-session.
   */
  async unloadIdleResources(): Promise<void> {
    // Don't unload if already disposed
    if (this.disposed) {
      return;
    }

    // Clear timer
    if (this.inactivityTimer) {
      clearTimeout(this.inactivityTimer);
      this.inactivityTimer = null;
    }

    // Dispose contexts first
    for (const ctx of this.embedContexts) {
      await ctx.dispose();
    }
    this.embedContexts = [];
    for (const ctx of this.rerankContexts) {
      await ctx.dispose();
    }
    this.rerankContexts = [];

    // Optionally dispose models too (opt-in)
    if (this.disposeModelsOnInactivity) {
      if (this.embedModel) {
        await this.embedModel.dispose();
        this.embedModel = null;
      }
      if (this.generateModel) {
        await this.generateModel.dispose();
        this.generateModel = null;
      }
      if (this.rerankModel) {
        await this.rerankModel.dispose();
        this.rerankModel = null;
      }
      // Reset load promises so models can be reloaded later
      this.embedModelLoadPromise = null;
      this.generateModelLoadPromise = null;
      this.rerankModelLoadPromise = null;
    }

    // Note: We keep llama instance alive - it's lightweight
  }

  /**
   * Ensure model cache directory exists
   */
  private ensureModelCacheDir(): void {
    if (!existsSync(this.modelCacheDir)) {
      mkdirSync(this.modelCacheDir, { recursive: true });
    }
  }

  /**
   * Initialize the llama instance (lazy)
   */
  private async ensureLlama(allowBuild = true): Promise<Llama> {
    if (!this.llama) {
      const gpuMode = resolveLlamaGpuMode();

      const { getLlama, getLlamaGpuTypes, LlamaLogLevel } = await loadNodeLlamaCpp();
      const loadLlama = async (gpu: LlamaGpuMode, sourceBuildAllowed = allowBuild, buildOverride?: "auto" | "never") =>
        await withNativeStdoutRedirectedToStderr(() => getLlama({
          // Prefer packaged prebuilt bindings before compiling llama.cpp locally.
          // node-llama-cpp documents gpu:"auto" as the best default: Metal on
          // Apple Silicon, CUDA when fully available, Vulkan where available,
          // then CPU. Use build:"auto" for normal loads and build:"never" for
          // diagnostic/probe paths that must not compile llama.cpp.
          build: buildOverride ?? (sourceBuildAllowed ? "auto" : "never"),
          logLevel: LlamaLogLevel.error,
          gpu,
          progressLogs: false,
          skipDownload: !sourceBuildAllowed,
        }));
      const loadCpuCompatibleLlama = async () => {
        try {
          return await loadLlama(false, false);
        } catch (err) {
          // Some platforms, notably Apple Silicon, ship a Metal prebuilt but no
          // CPU-only prebuilt. Do a fast no-build lookup for an actual CPU
          // binding first; if it does not exist, use the packaged auto/Metal
          // binding and disable model offloading via gpuLayers: 0.
          if (!cpuForcedPrebuiltFallbackWarningShown) {
            cpuForcedPrebuiltFallbackWarningShown = true;
            process.stderr.write(
              `QMD Warning: CPU-only llama.cpp prebuilt not available (${err instanceof Error ? err.message : String(err)}); using packaged backend with GPU offloading disabled.\n`
            );
          }
          return await loadLlama("auto", false);
        }
      };

      let llama: Llama;
      if (gpuMode === false) {
        llama = await loadCpuCompatibleLlama();
      } else if (failedGpuInitModes.has(gpuMode)) {
        process.stderr.write(
          `QMD Warning: skipping previously failed GPU init${gpuMode === "auto" ? "" : ` for QMD_LLAMA_GPU=${gpuMode}`}, using CPU.\n`
        );
        llama = await loadCpuCompatibleLlama();
      } else {
        try {
          llama = await loadLlama(gpuMode);

          // If node-llama-cpp auto-detection chose CPU, do one no-build pass
          // over all OS-valid packaged GPU backends. This preserves the
          // documented auto mode for Metal/CUDA/Vulkan while recovering on
          // systems where a packaged backend can load but detection is too
          // conservative. Never compile during these extra probes.
          if (gpuMode === "auto" && llama.gpu === false && getLlamaGpuTypes) {
            const candidates = (await getLlamaGpuTypes("allValid"))
              .filter((candidate): candidate is Exclude<LlamaGpuMode, "auto" | false> => candidate !== false && candidate !== "auto");
            for (const candidate of candidates) {
              if (failedGpuInitModes.has(candidate)) continue;
              try {
                const gpuLlama = await loadLlama(candidate, false, "never");
                if (gpuLlama.gpu !== false) {
                  await disposeWithTimeout("CPU llama runtime", () => llama.dispose());
                  llama = gpuLlama;
                  break;
                }
                await disposeWithTimeout(`${candidate} probe runtime`, () => gpuLlama.dispose());
              } catch {
                failedGpuInitModes.add(candidate);
              }
            }
          }
        } catch (err) {
          // GPU backend (e.g. Vulkan/CUDA on headless/driverless machines) can throw at init.
          // Fall back to CPU so qmd still works, and cache the failure to avoid repeated
          // expensive native build/probe attempts in this process.
          failedGpuInitModes.add(gpuMode);
          process.stderr.write(
            `QMD Warning: GPU init failed${gpuMode === "auto" ? "" : ` for QMD_LLAMA_GPU=${gpuMode}`} (${err instanceof Error ? err.message : String(err)}), falling back to CPU.\n`
          );
          llama = await loadCpuCompatibleLlama();
        }
      }

      if (llama.gpu === false && !noGpuAccelerationWarningShown) {
        noGpuAccelerationWarningShown = true;
        process.stderr.write(
          "QMD Warning: no GPU acceleration, running on CPU (slow). Run 'qmd doctor' for device diagnostics.\n"
        );
      }
      this.llama = llama;
    }
    return this.llama;
  }

  private isCpuOffloadForced(): boolean {
    return isCpuModeRequested();
  }

  private modelLoadOptions(modelPath: string): { modelPath: string; gpuLayers?: number } {
    return {
      modelPath,
      ...(this.isCpuOffloadForced() ? { gpuLayers: 0 } : {}),
    };
  }

  /**
   * Resolve a model URI to a local path, downloading if needed.
   * Validates the downloaded file is actually a GGUF model (not an HTML error page
   * from a proxy or firewall).
   */
  private async resolveModel(modelUri: string): Promise<string> {
    this.ensureModelCacheDir();
    // resolveModelFile handles HF URIs and downloads to the cache dir
    const { resolveModelFile } = await loadNodeLlamaCpp();
    const modelPath = await resolveModelFile(modelUri, this.modelCacheDir);
    validateGgufFile(modelPath, modelUri);
    return modelPath;
  }

  /**
   * Load embedding model (lazy)
   */
  private async ensureEmbedModel(): Promise<LlamaModel> {
    if (this.embedModel) {
      return this.embedModel;
    }
    if (this.embedModelLoadPromise) {
      return await this.embedModelLoadPromise;
    }

    this.embedModelLoadPromise = (async () => {
      const llama = await this.ensureLlama();
      const modelPath = await this.resolveModel(this.embedModelUri);
      const model = await llama.loadModel(this.modelLoadOptions(modelPath));
      this.embedModel = model;
      // Model loading counts as activity - ping to keep alive
      this.touchActivity();
      return model;
    })();

    try {
      return await this.embedModelLoadPromise;
    } finally {
      // Keep the resolved model cached; clear only the in-flight promise.
      this.embedModelLoadPromise = null;
    }
  }

  /**
   * Compute how many parallel contexts to create.
   *
   * GPU: constrained by VRAM (25% of free, capped at 8).
   * CPU: constrained by cores. Splitting threads across contexts enables
   *      true parallelism (each context runs on its own cores). Use at most
   *      half the math cores, with at least 4 threads per context.
   */
  private async computeParallelism(perContextMB: number): Promise<number> {
    const llama = await this.ensureLlama();

    if (!this.isCpuOffloadForced() && llama.gpu) {
      try {
        const vram = await llama.getVramState();
        const freeMB = vram.free / (1024 * 1024);
        const maxByVram = Math.floor((freeMB * 0.25) / perContextMB);
        const computed = Math.max(1, Math.min(8, maxByVram));
        return resolveSafeParallelism({ gpu: llama.gpu, computed });
      } catch {
        return resolveSafeParallelism({ gpu: llama.gpu, computed: 2 });
      }
    }

    // CPU: split cores across contexts. At least 4 threads per context.
    const cores = llama.cpuMathCores || 4;
    const maxContexts = Math.floor(cores / 4);
    const computed = Math.max(1, Math.min(4, maxContexts));
    return resolveSafeParallelism({ gpu: false, computed });
  }

  /**
   * Get the number of threads each context should use, given N parallel contexts.
   * Splits available math cores evenly across contexts.
   */
  private async threadsPerContext(parallelism: number): Promise<number> {
    const llama = await this.ensureLlama();
    if (!this.isCpuOffloadForced() && llama.gpu) return 0; // GPU: let the library decide
    const cores = llama.cpuMathCores || 4;
    return Math.max(1, Math.floor(cores / parallelism));
  }

  /**
   * Load embedding contexts (lazy). Creates multiple for parallel embedding.
   * Uses promise guard to prevent concurrent context creation race condition.
   */
  private embedContextsCreatePromise: Promise<LlamaEmbeddingContext[]> | null = null;

  private async ensureEmbedContexts(): Promise<LlamaEmbeddingContext[]> {
    if (this.embedContexts.length > 0) {
      this.touchActivity();
      return this.embedContexts;
    }

    if (this.embedContextsCreatePromise) {
      return await this.embedContextsCreatePromise;
    }

    this.embedContextsCreatePromise = (async () => {
      const model = await this.ensureEmbedModel();
      // Embed contexts are ~143 MB each (nomic-embed 2048 ctx)
      const n = await this.computeParallelism(150);
      const threads = await this.threadsPerContext(n);
      for (let i = 0; i < n; i++) {
        try {
          this.embedContexts.push(await model.createEmbeddingContext({
            contextSize: LlamaCpp.EMBED_CONTEXT_SIZE,
            ...(threads > 0 ? { threads } : {}),
          }));
        } catch {
          if (this.embedContexts.length === 0) throw new Error("Failed to create any embedding context");
          break;
        }
      }
      this.touchActivity();
      return this.embedContexts;
    })();

    try {
      return await this.embedContextsCreatePromise;
    } finally {
      this.embedContextsCreatePromise = null;
    }
  }

  /**
   * Get a single embed context (for single-embed calls). Uses first from pool.
   */
  private async ensureEmbedContext(): Promise<LlamaEmbeddingContext> {
    const contexts = await this.ensureEmbedContexts();
    return contexts[0]!;
  }

  /**
   * Load generation model (lazy) - context is created fresh per call
   */
  private async ensureGenerateModel(): Promise<LlamaModel> {
    if (!this.generateModel) {
      if (this.generateModelLoadPromise) {
        return await this.generateModelLoadPromise;
      }

      this.generateModelLoadPromise = (async () => {
        const llama = await this.ensureLlama();
        const modelPath = await this.resolveModel(this.generateModelUri);
        const model = await llama.loadModel(this.modelLoadOptions(modelPath));
        this.generateModel = model;
        return model;
      })();

      try {
        await this.generateModelLoadPromise;
      } finally {
        this.generateModelLoadPromise = null;
      }
    }
    this.touchActivity();
    if (!this.generateModel) {
      throw new Error("Generate model not loaded");
    }
    return this.generateModel;
  }

  /**
   * Load rerank model (lazy)
   */
  private async ensureRerankModel(): Promise<LlamaModel> {
    if (this.rerankModel) {
      return this.rerankModel;
    }
    if (this.rerankModelLoadPromise) {
      return await this.rerankModelLoadPromise;
    }

    this.rerankModelLoadPromise = (async () => {
      const llama = await this.ensureLlama();
      const modelPath = await this.resolveModel(this.rerankModelUri);
      const model = await llama.loadModel(this.modelLoadOptions(modelPath));
      this.rerankModel = model;
      // Model loading counts as activity - ping to keep alive
      this.touchActivity();
      return model;
    })();

    try {
      return await this.rerankModelLoadPromise;
    } finally {
      this.rerankModelLoadPromise = null;
    }
  }

  /**
   * Load rerank contexts (lazy). Creates multiple contexts for parallel ranking.
   * Each context has its own sequence, so they can evaluate independently.
   *
   * Tuning choices:
   * - contextSize 1024: reranking chunks are ~800 tokens max, 1024 is plenty
   * - flashAttention: ~20% less VRAM per context (568 vs 711 MB)
   * - Combined: drops from 11.6 GB (auto, no flash) to 568 MB per context (20x)
   */
  // Qwen3 reranker template adds ~200 tokens overhead (system prompt, tags, etc.)
  // Default 2048 was too small for longer documents (e.g. session transcripts,
  // CJK text, or large markdown files) — callers hit "input lengths exceed
  // context size" errors even after truncation because the overhead estimate
  // was insufficient.  4096 comfortably fits the largest real-world chunks
  // while staying well below the 40 960-token auto size.
  // Override with QMD_RERANK_CONTEXT_SIZE env var if you need more headroom.
  private static readonly RERANK_CONTEXT_SIZE: number = (() => {
    const v = parseInt(process.env.QMD_RERANK_CONTEXT_SIZE ?? "", 10);
    return Number.isFinite(v) && v > 0 ? v : 4096;
  })();

  private static readonly EMBED_CONTEXT_SIZE: number = (() => {
    const v = parseInt(process.env.QMD_EMBED_CONTEXT_SIZE ?? "", 10);
    return Number.isFinite(v) && v > 0 ? v : 2048;
  })();
  private async ensureRerankContexts(): Promise<Awaited<ReturnType<LlamaModel["createRankingContext"]>>[]> {
    if (this.rerankContexts.length === 0) {
      const model = await this.ensureRerankModel();
      // ~960 MB per context with flash attention at contextSize 2048
      const n = Math.min(await this.computeParallelism(1000), 4);
      const threads = await this.threadsPerContext(n);
      for (let i = 0; i < n; i++) {
        try {
          this.rerankContexts.push(await model.createRankingContext({
            contextSize: LlamaCpp.RERANK_CONTEXT_SIZE,
            ...(threads > 0 ? { threads } : {}),
          }));
        } catch {
          if (this.rerankContexts.length === 0) {
            // Flash attention might not be supported — retry without it
            try {
              this.rerankContexts.push(await model.createRankingContext({
                contextSize: LlamaCpp.RERANK_CONTEXT_SIZE,
                ...(threads > 0 ? { threads } : {}),
              }));
            } catch {
              throw new Error("Failed to create any rerank context");
            }
          }
          break;
        }
      }
    }
    this.touchActivity();
    return this.rerankContexts;
  }

  // ==========================================================================
  // Tokenization
  // ==========================================================================

  /**
   * Tokenize text using the embedding model's tokenizer
   * Returns tokenizer tokens (opaque type from node-llama-cpp)
   */
  async tokenize(text: string): Promise<readonly LlamaToken[]> {
    await this.ensureEmbedContext();  // Ensure model is loaded
    if (!this.embedModel) {
      throw new Error("Embed model not loaded");
    }
    return this.embedModel.tokenize(text);
  }

  /**
   * Count tokens in text using the embedding model's tokenizer
   */
  async countTokens(text: string): Promise<number> {
    const tokens = await this.tokenize(text);
    return tokens.length;
  }

  /**
   * Detokenize token IDs back to text
   */
  async detokenize(tokens: readonly LlamaToken[]): Promise<string> {
    await this.ensureEmbedContext();
    if (!this.embedModel) {
      throw new Error("Embed model not loaded");
    }
    return this.embedModel.detokenize(tokens);
  }

  // ==========================================================================
  // Core API methods
  // ==========================================================================

  /**
   * Truncate text to fit within the embedding model's context window.
   * Uses the model's own tokenizer for accurate token counting, then
   * detokenizes back to text if truncation is needed.
   * Returns the (possibly truncated) text and whether truncation occurred.
   */
  private resolveEmbedTokenLimit(): number {
    const trainedContextSize = this.embedModel?.trainContextSize;
    if (typeof trainedContextSize === "number" && Number.isFinite(trainedContextSize) && trainedContextSize > 0) {
      return Math.max(1, Math.min(LlamaCpp.EMBED_CONTEXT_SIZE, trainedContextSize));
    }
    return LlamaCpp.EMBED_CONTEXT_SIZE;
  }

  private async truncateToContextSize(
    text: string
  ): Promise<{ text: string; truncated: boolean; limit: number }> {
    if (!this.embedModel) return { text, truncated: false, limit: LlamaCpp.EMBED_CONTEXT_SIZE };

    const maxTokens = this.resolveEmbedTokenLimit();
    if (maxTokens <= 0) return { text, truncated: false, limit: maxTokens };

    const tokens = this.embedModel.tokenize(text);
    if (tokens.length <= maxTokens) return { text, truncated: false, limit: maxTokens };

    // Leave a small margin (4 tokens) for BOS/EOS overhead
    const safeLimit = Math.max(1, maxTokens - 4);
    const truncatedTokens = tokens.slice(0, safeLimit);
    const truncatedText = this.embedModel.detokenize(truncatedTokens);
    return { text: truncatedText, truncated: true, limit: maxTokens };
  }

  async embed(text: string, options: EmbedOptions = {}): Promise<EmbeddingResult | null> {
    // Ping activity at start to keep models alive during this operation
    this.touchActivity();

    try {
      const context = await this.ensureEmbedContext();

      // Guard: truncate text that exceeds model context window to prevent GGML crash
      const { text: safeText, truncated, limit } = await this.truncateToContextSize(text);
      if (truncated) {
        console.warn(`⚠ Text truncated to fit embedding context (${limit} tokens)`);
      }

      const embedding = await context.getEmbeddingFor(safeText);

      return {
        embedding: Array.from(embedding.vector),
        model: options.model ?? this.embedModelUri,
      };
    } catch (error) {
      console.error("Embedding error:", error);
      return null;
    }
  }

  /**
   * Batch embed multiple texts efficiently
   * Uses Promise.all for parallel embedding - node-llama-cpp handles batching internally
   */
  async embedBatch(texts: string[], options: EmbedOptions = {}): Promise<(EmbeddingResult | null)[]> {
    if (this._ciMode) throw new Error("LLM operations are disabled in CI (set CI=true)");
    // Ping activity at start to keep models alive during this operation
    this.touchActivity();

    if (texts.length === 0) return [];

    try {
      const contexts = await this.ensureEmbedContexts();
      const n = contexts.length;

      if (n === 1) {
        // Single context: sequential (no point splitting)
        const context = contexts[0]!;
        const embeddings: ({ embedding: number[]; model: string } | null)[] = [];
        for (const text of texts) {
          try {
            const { text: safeText, truncated, limit } = await this.truncateToContextSize(text);
            if (truncated) {
              console.warn(`⚠ Batch text truncated to fit embedding context (${limit} tokens)`);
            }
            const embedding = await context.getEmbeddingFor(safeText);
            this.touchActivity();
            embeddings.push({ embedding: Array.from(embedding.vector), model: options.model ?? this.embedModelUri });
          } catch (err) {
            console.error("Embedding error for text:", err);
            embeddings.push(null);
          }
        }
        return embeddings;
      }

      // Multiple contexts: split texts across contexts for parallel evaluation
      const chunkSize = Math.ceil(texts.length / n);
      const chunks = Array.from({ length: n }, (_, i) =>
        texts.slice(i * chunkSize, (i + 1) * chunkSize)
      );

      const chunkResults = await Promise.all(
        chunks.map(async (chunk, i) => {
          const ctx = contexts[i]!;
          const results: (EmbeddingResult | null)[] = [];
          for (const text of chunk) {
            try {
              const { text: safeText, truncated, limit } = await this.truncateToContextSize(text);
              if (truncated) {
                console.warn(`⚠ Batch text truncated to fit embedding context (${limit} tokens)`);
              }
              const embedding = await ctx.getEmbeddingFor(safeText);
              this.touchActivity();
              results.push({ embedding: Array.from(embedding.vector), model: options.model ?? this.embedModelUri });
            } catch (err) {
              console.error("Embedding error for text:", err);
              results.push(null);
            }
          }
          return results;
        })
      );

      return chunkResults.flat();
    } catch (error) {
      console.error("Batch embedding error:", error);
      return texts.map(() => null);
    }
  }

  async generate(prompt: string, options: GenerateOptions = {}): Promise<GenerateResult | null> {
    if (this._ciMode) throw new Error("LLM operations are disabled in CI (set CI=true)");
    // Ping activity at start to keep models alive during this operation
    this.touchActivity();

    // Ensure model is loaded
    await this.ensureGenerateModel();

    // Create fresh context -> sequence -> session for each call
    const context = await this.generateModel!.createContext();
    const sequence = context.getSequence();
    const { LlamaChatSession } = await loadNodeLlamaCpp();
    const session = new LlamaChatSession({ contextSequence: sequence });

    const maxTokens = options.maxTokens ?? 150;
    // Qwen3 recommends temp=0.7, topP=0.8, topK=20 for non-thinking mode
    // DO NOT use greedy decoding (temp=0) - causes repetition loops
    const temperature = options.temperature ?? 0.7;

    let result = "";
    try {
      await session.prompt(prompt, {
        maxTokens,
        temperature,
        topK: 20,
        topP: 0.8,
        onTextChunk: (text: string) => {
          result += text;
        },
      });

      return {
        text: result,
        model: this.generateModelUri,
        done: true,
      };
    } finally {
      // Dispose context (which disposes dependent sequences/sessions per lifecycle rules)
      await context.dispose();
    }
  }

  async modelExists(modelUri: string): Promise<ModelInfo> {
    // For HuggingFace URIs, we assume they exist
    // For local paths, check if file exists
    if (modelUri.startsWith("hf:")) {
      return { name: modelUri, exists: true };
    }

    const exists = existsSync(modelUri);
    return {
      name: modelUri,
      exists,
      path: exists ? modelUri : undefined,
    };
  }

  // ==========================================================================
  // High-level abstractions
  // ==========================================================================

  async expandQuery(query: string, options: { context?: string, includeLexical?: boolean, intent?: string } = {}): Promise<Queryable[]> {
    if (this._ciMode) throw new Error("LLM operations are disabled in CI (set CI=true)");
    // Ping activity at start to keep models alive during this operation
    this.touchActivity();

    const llama = await this.ensureLlama();
    await this.ensureGenerateModel();

    const includeLexical = options.includeLexical ?? true;
    const context = options.context;

    const grammar = await llama.createGrammar({
      grammar: `
        root ::= line+
        line ::= type ": " content "\\n"
        type ::= "lex" | "vec" | "hyde"
        content ::= [^\\n]+
      `
    });

    const intent = options.intent;
    const prompt = intent
      ? `/no_think Expand this search query: ${query}\nQuery intent: ${intent}`
      : `/no_think Expand this search query: ${query}`;

    // Create a bounded context for expansion to prevent large default VRAM allocations.
    const genContext = await this.generateModel!.createContext({
      contextSize: this.expandContextSize,
    });
    const sequence = genContext.getSequence();
    const { LlamaChatSession } = await loadNodeLlamaCpp();
    const session = new LlamaChatSession({ contextSequence: sequence });

    try {
      // Qwen3 recommended settings for non-thinking mode:
      // temp=0.7, topP=0.8, topK=20, presence_penalty for repetition
      // DO NOT use greedy decoding (temp=0) - causes infinite loops
      const result = await session.prompt(prompt, {
        grammar,
        maxTokens: 600,
        temperature: 0.7,
        topK: 20,
        topP: 0.8,
        repeatPenalty: {
          lastTokens: 64,
          presencePenalty: 0.5,
        },
      });

      const lines = result.trim().split("\n");
      const queryLower = query.toLowerCase();
      const queryTerms = queryLower.replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);

      const hasQueryTerm = (text: string): boolean => {
        const lower = text.toLowerCase();
        if (queryTerms.length === 0) return true;
        return queryTerms.some(term => lower.includes(term));
      };

      const queryables: Queryable[] = lines.map(line => {
        const colonIdx = line.indexOf(":");
        if (colonIdx === -1) return null;
        const type = line.slice(0, colonIdx).trim();
        if (type !== 'lex' && type !== 'vec' && type !== 'hyde') return null;
        const text = line.slice(colonIdx + 1).trim();
        if (!hasQueryTerm(text)) return null;
        return { type: type as QueryType, text };
      }).filter((q): q is Queryable => q !== null);

      // Filter out lex entries if not requested
      const filtered = includeLexical ? queryables : queryables.filter(q => q.type !== 'lex');
      if (filtered.length > 0) return filtered;

      const fallback: Queryable[] = [
        { type: 'hyde', text: `Information about ${query}` },
        { type: 'lex', text: query },
        { type: 'vec', text: query },
      ];
      return includeLexical ? fallback : fallback.filter(q => q.type !== 'lex');
    } catch (error) {
      console.error("Structured query expansion failed:", error);
      // Fallback to original query
      const fallback: Queryable[] = [{ type: 'vec', text: query }];
      if (includeLexical) fallback.unshift({ type: 'lex', text: query });
      return fallback;
    } finally {
      await genContext.dispose();
    }
  }

  // Qwen3 reranker chat template overhead (system prompt, tags, separators).
  // Measured at ~350 tokens on real queries; use 512 as a safe upper bound so
  // the truncation budget never lets a document slip past the context limit.
  private static readonly RERANK_TEMPLATE_OVERHEAD = 512;
  private static readonly RERANK_TARGET_DOCS_PER_CONTEXT = 10;

  async rerank(
    query: string,
    documents: RerankDocument[],
    options: RerankOptions = {}
  ): Promise<RerankResult> {
    if (this._ciMode) throw new Error("LLM operations are disabled in CI (set CI=true)");
    // Ping activity at start to keep models alive during this operation
    this.touchActivity();

    const contexts = await this.ensureRerankContexts();
    const model = await this.ensureRerankModel();

    // Truncate documents that would exceed the rerank context size.
    // Budget = contextSize - template overhead - query tokens
    const queryTokens = model.tokenize(query).length;
    const maxDocTokens = LlamaCpp.RERANK_CONTEXT_SIZE - LlamaCpp.RERANK_TEMPLATE_OVERHEAD - queryTokens;
    const truncationCache = new Map<string, string>();

    const truncatedDocs = documents.map((doc) => {
      const cached = truncationCache.get(doc.text);
      if (cached !== undefined) {
        return cached === doc.text ? doc : { ...doc, text: cached };
      }

      const tokens = model.tokenize(doc.text);
      const truncatedText = tokens.length <= maxDocTokens
        ? doc.text
        : model.detokenize(tokens.slice(0, maxDocTokens));
      truncationCache.set(doc.text, truncatedText);

      if (truncatedText === doc.text) return doc;
      return { ...doc, text: truncatedText };
    });

    // Deduplicate identical effective texts before scoring.
    // This avoids redundant work for repeated chunks and fixes collisions where
    // multiple docs map to the same chunk text.
    const textToDocs = new Map<string, { file: string; index: number }[]>();
    truncatedDocs.forEach((doc, index) => {
      const existing = textToDocs.get(doc.text);
      if (existing) {
        existing.push({ file: doc.file, index });
      } else {
        textToDocs.set(doc.text, [{ file: doc.file, index }]);
      }
    });

    // Extract just the text for ranking
    const texts = Array.from(textToDocs.keys());

    // Split documents across contexts for parallel evaluation.
    // Each context has its own sequence with a lock, so parallelism comes
    // from multiple contexts evaluating different chunks simultaneously.
    const activeContextCount = Math.max(
      1,
      Math.min(
        contexts.length,
        Math.ceil(texts.length / LlamaCpp.RERANK_TARGET_DOCS_PER_CONTEXT)
      )
    );
    const activeContexts = contexts.slice(0, activeContextCount);
    const chunkSize = Math.ceil(texts.length / activeContexts.length);
    const chunks = Array.from({ length: activeContexts.length }, (_, i) =>
      texts.slice(i * chunkSize, (i + 1) * chunkSize)
    ).filter(chunk => chunk.length > 0);

    const allScores = await Promise.all(
      chunks.map((chunk, i) => activeContexts[i]!.rankAll(query, chunk))
    );

    // Reassemble scores in original order and sort
    const flatScores = allScores.flat();
    const ranked = texts
      .map((text, i) => ({ document: text, score: flatScores[i]! }))
      .sort((a, b) => b.score - a.score);

    // Map back to our result format.
    const results: RerankDocumentResult[] = [];
    for (const item of ranked) {
      const docInfos = textToDocs.get(item.document) ?? [];
      for (const docInfo of docInfos) {
        results.push({
          file: docInfo.file,
          score: item.score,
          index: docInfo.index,
        });
      }
    }

    return {
      results,
      model: this.rerankModelUri,
    };
  }

  /**
   * Get device/GPU info for status display.
   * Initializes llama if not already done.
   */
  async getDeviceInfo(options: { allowBuild?: boolean } = {}): Promise<{
    gpu: string | false;
    gpuOffloading: boolean;
    gpuDevices: string[];
    vram?: { total: number; used: number; free: number };
    cpuCores: number;
  }> {
    const llama = await this.ensureLlama(options.allowBuild ?? true);
    const cpuForced = this.isCpuOffloadForced();
    const gpuDevices = cpuForced ? [] : await llama.getGpuDeviceNames();
    let vram: { total: number; used: number; free: number } | undefined;
    if (!cpuForced && llama.gpu) {
      try {
        const state = await llama.getVramState();
        vram = { total: state.total, used: state.used, free: state.free };
      } catch { /* no vram info */ }
    }
    return {
      gpu: cpuForced ? false : llama.gpu,
      gpuOffloading: !cpuForced && llama.supportsGpuOffloading,
      gpuDevices,
      vram,
      cpuCores: llama.cpuMathCores,
    };
  }

  async dispose(): Promise<void> {
    // Prevent double-dispose
    if (this.disposed) {
      return;
    }
    this.disposed = true;

    // Clear inactivity timer
    if (this.inactivityTimer) {
      clearTimeout(this.inactivityTimer);
      this.inactivityTimer = null;
    }

    // Explicitly dispose in dependency order: contexts first, then models, then llama.
    // Relying only on llama.dispose() leaves Metal resource sets alive until process
    // finalization on Apple Silicon, where ggml_metal_device_free can abort after
    // otherwise-successful CLI output (#368).
    for (const ctx of this.embedContexts) {
      await disposeWithTimeout("embedding context", () => ctx.dispose());
    }
    this.embedContexts = [];

    for (const ctx of this.rerankContexts) {
      await disposeWithTimeout("rerank context", () => ctx.dispose());
    }
    this.rerankContexts = [];

    if (this.embedModel) {
      await disposeWithTimeout("embedding model", () => this.embedModel!.dispose());
      this.embedModel = null;
    }
    if (this.generateModel) {
      await disposeWithTimeout("generation model", () => this.generateModel!.dispose());
      this.generateModel = null;
    }
    if (this.rerankModel) {
      await disposeWithTimeout("rerank model", () => this.rerankModel!.dispose());
      this.rerankModel = null;
    }

    if (this.llama) {
      await disposeWithTimeout("llama runtime", () => this.llama!.dispose());
      this.llama = null;
    }

    // Clear any in-flight load/create promises
    this.embedModelLoadPromise = null;
    this.embedContextsCreatePromise = null;
    this.generateModelLoadPromise = null;
    this.rerankModelLoadPromise = null;
  }
}
