/**
 * singleton.ts - Singleton LLM instance and remote stub management
 *
 * Provides the global default LLM instance lifecycle (get/set/has/dispose),
 * the NoopLlamaCpp stub for remote mode, the isRemoteConfigured() check,
 * and Darwin Metal exit-crash mitigation helpers.
 *
 * This module intentionally imports from ../llm.js (creating a circular
 * dependency at the module graph level) because all cross-references are
 * guarded by runtime access — the LlamaCpp class binding is not touched
 * until getDefaultLlamaCpp() is called, by which point both modules have
 * fully evaluated.
 */

import type { LLM, EmbeddingResult, GenerateResult, Queryable, RerankResult, ModelInfo } from "../llm.js";
import { LlamaCpp } from "../llm.js";
import type { ModelsConfig } from "../collections.js";

// =============================================================================
// Darwin Metal exit-crash mitigation
// =============================================================================
//
// libggml-metal on macOS keeps allocated model memory wired via "residency
// sets" with a 180-second keep_alive timer (added in ggml-org/llama.cpp#11427).
// The process-static `std::vector<std::unique_ptr<ggml_metal_device>>`
// destructor fires during libc `exit()` -> `__cxa_finalize_ranges` and asserts
// `[rsets->data count] == 0` — but the keep_alive hasn't expired, so the
// assertion fails and `ggml_abort` dumps a multi-kilobyte stack trace to
// stderr after the user-visible output. See ggml-org/llama.cpp#22593.
//
// No JS-side dispose call (`llama.dispose()`, `model.dispose()`, etc.) can
// prevent it: the static destructor runs after every JS-reachable cleanup,
// and `process.reallyExit` on Node calls libc `exit()` not `_exit()` (it
// does NOT skip C++ static destructors — verified in
// node/src/api/environment.cc).
//
// The actual fix is to disable residency sets via `GGML_METAL_NO_RESIDENCY=1`,
// which we set from `bin/qmd` before Node loads the native binding. For QMD's
// short-lived CLI workflow this has no measurable cost (subsequent calls
// don't reuse the warm mapping). The functions below report whether that
// mitigation is in effect — kept here, in the module that depends on the
// underlying resource, so doctor can answer "is the protection active?"
// without reaching into env handling directly.
//
// Setting `QMD_METAL_KEEP_RESIDENCY=1` opts back into residency sets (with
// the visible-noise consequences). The legacy `QMD_DISABLE_DARWIN_SAFE_EXIT`
// env var is accepted as a no-op alias for back-compat; it had no effect on
// Node prior to this fix.

/**
 * Whether QMD's darwin Metal exit-crash mitigation is active in this process:
 *   true  -> residency sets disabled, process exit completes silently
 *   false -> either non-darwin, or `QMD_METAL_KEEP_RESIDENCY=1` overrode it,
 *            in which case the libggml-metal teardown assertion may fire
 */
export function isDarwinMetalMitigationActive(): boolean {
  if (process.platform !== "darwin") return false;
  if (process.env.QMD_METAL_KEEP_RESIDENCY === "1") return false;
  return process.env.GGML_METAL_NO_RESIDENCY === "1";
}

/**
 * Compatibility shim: previous releases installed a `process.on('exit')` hook
 * that tried to skip the C++ static destructor by calling `process.reallyExit`.
 * That mechanism didn't work on Node (Environment::Exit still calls libc
 * `exit()`), so it was replaced by `GGML_METAL_NO_RESIDENCY=1` from bin/qmd.
 * Kept as a no-op for code paths that still call it; safe to remove once no
 * production launcher predates the residency-set fix.
 */
export function installDarwinExitGuard(): void {
  // Intentional no-op. See isDarwinMetalMitigationActive() for the real check.
}

/** @deprecated Replaced by isDarwinMetalMitigationActive. */
export function isDarwinExitGuardInstalled(): boolean {
  return isDarwinMetalMitigationActive();
}

// =============================================================================
// NoopLlamaCpp — stub that throws helpful errors when remote is configured
// =============================================================================

/**
 * No-op LLM stub returned by getDefaultLlamaCpp() when a remote LLM provider
 * is configured. This prevents accidental native llama.cpp compilation.
 *
 * Embed methods throw descriptive errors directing the user to use RemoteLLM.
 * Query expansion and reranking return empty results (no-op).
 * generate() returns null — text generation is not available without a local model.
 *
 * This class is never used directly by application code. It exists solely as a
 * safety net: if any code path bypasses the isRemoteConfigured() guards and calls
 * getDefaultLlamaCpp(), it gets a clear error instead of a native build.
 */
export class NoopLlamaCpp implements LLM {
  static readonly instance = new NoopLlamaCpp();
  readonly embedModelName = 'noop-remote';

  async embed(): Promise<EmbeddingResult | null> {
    throw new Error(
      'Remote LLM configured — no local embed model available. ' +
      'Use RemoteLLM or configure the store with an LLM instance.'
    );
  }

  async embedBatch(): Promise<(EmbeddingResult | null)[]> {
    throw new Error(
      'Remote LLM configured — no local embed model available. ' +
      'Use RemoteLLM or configure the store with an LLM instance.'
    );
  }

  async generate(): Promise<GenerateResult | null> {
    return null;
  }

  async modelExists(): Promise<ModelInfo> {
    return { name: 'remote', exists: true };
  }

  async expandQuery(): Promise<Queryable[]> {
    return [];
  }

  async rerank(): Promise<RerankResult> {
    return { results: [], model: 'remote' };
  }

  async dispose() {}
}

// =============================================================================
// Remote detection
// =============================================================================

/**
 * Check whether any remote LLM endpoint is configured.
 *
 * Examines environment variables and YAML models config to determine if
 * the user intends to use remote endpoints instead of local GGUF models.
 * Used by getDefaultLlamaCpp() to decide whether to return a NoopLlamaCpp
 * stub, and by chunkDocumentByTokens() to select the tokenization strategy.
 *
 * Detection triggers (any one suffices):
 *   - Env vars: OPENAI_BASE_URL, QMD_EMBED_PROVIDER=remote, QMD_EMBED_BASE_URL,
 *     QMD_EXPAND_BASE_URL, QMD_RERANK_BASE_URL, QMD_GENERATE_BASE_URL
 *   - YAML config: embed_api_url, expand_api_url, rerank_api_url, generate_api_url
 *
 * @param models - Optional YAML models config from loadConfig()
 * @returns true if any remote endpoint is configured
 */
export function isRemoteConfigured(models?: ModelsConfig): boolean {
  return !!(
    process.env.OPENAI_BASE_URL ||
    process.env.QMD_EMBED_PROVIDER === 'remote' ||
    process.env.QMD_EMBED_BASE_URL ||
    process.env.QMD_EXPAND_BASE_URL ||
    process.env.QMD_RERANK_BASE_URL ||
    process.env.QMD_GENERATE_BASE_URL ||
    models?.embed_api_url ||
    models?.expand_api_url ||
    models?.rerank_api_url ||
    models?.generate_api_url
  );
}

// =============================================================================
// Singleton for default LLM instance
// =============================================================================

/**
 * Global singleton LLM instance.
 *
 * Lifecycle: Set once during store creation (by createStore or CLI getStore).
 * May be a LlamaCpp (local), RemoteLLM (remote), or NoopLlamaCpp (stub).
 * Callers should use getDefaultLlamaCpp() which handles lazy initialization
 * and remote-fallback logic.
 */
let defaultLlamaCpp: LLM | null = null;

/**
 * Get the default LLM instance (creates a LlamaCpp if none is set).
 *
 * When a remote LLM is configured (detected via isRemoteConfigured()),
 * returns a NoopLlamaCpp stub that throws descriptive errors instead of
 * building a local llama.cpp instance. This prevents accidental native
 * compilation when a remote provider is in use.
 *
 * Return type is `LlamaCpp` for backward compatibility — callers that
 * use LlamaCpp-specific methods (like tokenize()) are guarded by
 * isRemoteConfigured() checks at each call site.
 *
 * @returns The active LLM instance (never null — throws if uninitialized)
 */
export function getDefaultLlamaCpp(): LlamaCpp {
  // When a remote LLM is configured, skip local model entirely
  if (isRemoteConfigured()) {
    return NoopLlamaCpp.instance as unknown as LlamaCpp;
  }
  if (!defaultLlamaCpp) {
    defaultLlamaCpp = new LlamaCpp();
  }
  return defaultLlamaCpp as LlamaCpp;
}

/**
 * Set the global default LLM instance.
 *
 * Accepts any LLM implementation — LlamaCpp (local), RemoteLLM (remote),
 * or null to clear. Used by CLI getStore() to inject a RemoteLLM, and
 * by LocalEmbeddingProvider to register itself as the default.
 *
 * @param llm - The LLM instance to set as default, or null to clear
 */
export function setDefaultLlamaCpp(llm: LLM | null): void {
  if (llm !== null) installDarwinExitGuard();
  defaultLlamaCpp = llm;
}

/**
 * Peek at the default LLM instance without instantiating one. Used by
 * doctor and lifecycle diagnostics.
 */
export function hasDefaultLlamaCpp(): boolean {
  return defaultLlamaCpp !== null;
}

/**
 * Dispose the default LLM instance if it exists.
 *
 * Call this before process exit to prevent NAPI crashes from native
 * llama.cpp backends. For RemoteLLM, dispose() is a no-op.
 *
 * @returns Promise that resolves when disposal is complete
 */
export async function disposeDefaultLlamaCpp(): Promise<void> {
  if (defaultLlamaCpp) {
    await defaultLlamaCpp.dispose();
    defaultLlamaCpp = null;
  }
}
