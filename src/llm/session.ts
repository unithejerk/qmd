/**
 * LLM Session Management Layer
 *
 * Provides scoped sessions with reference counting, abort handling,
 * and automatic lifecycle management. Coordinates with LlamaCpp idle
 * timeout to prevent disposal during active sessions.
 */

import { getDefaultLlamaCpp } from "../llm/singleton.js";
import type { LLM, ILLMSession, LLMSessionOptions, EmbedOptions, EmbeddingResult, RerankOptions, RerankResult, RerankDocument, Queryable } from "../llm.js";

// =============================================================================
// LLMSessionManager
// =============================================================================

/**
 * Reference-counted session manager for an LLM instance.
 *
 * Tracks active sessions and in-flight operations to coordinate with the
 * LlamaCpp inactivity timer. When active sessions exist, canUnload()
 * returns false, preventing LlamaCpp from disposing contexts that are
 * currently in use.
 *
 * This indirection exists because the inactivity timer (in llama-cpp.ts)
 * and session management (here) are in different modules — the timer needs
 * a single source of truth for "is anything using the LLM right now?"
 *
 * Reference counting strategy:
 *   - acquire() / release() track session leases (+1 on create, -1 on release)
 *   - operationStart() / operationEnd() track in-flight operations
 *   - canUnload() returns true only when both counts are 0
 */
class LLMSessionManager {
  private llm: LLM;
  private _activeSessionCount = 0;
  private _inFlightOperations = 0;

  constructor(llm: LLM) {
    this.llm = llm;
  }

  get activeSessionCount(): number {
    return this._activeSessionCount;
  }

  get inFlightOperations(): number {
    return this._inFlightOperations;
  }

  canUnload(): boolean {
    return this._activeSessionCount === 0 && this._inFlightOperations === 0;
  }

  acquire(): void {
    this._activeSessionCount++;
  }

  release(): void {
    this._activeSessionCount = Math.max(0, this._activeSessionCount - 1);
  }

  operationStart(): void {
    this._inFlightOperations++;
  }

  operationEnd(): void {
    this._inFlightOperations = Math.max(0, this._inFlightOperations - 1);
  }

  getLlamaCpp(): LLM {
    return this.llm;
  }
}

// =============================================================================
// SessionReleasedError
// =============================================================================

/**
 * Thrown when an operation is attempted on an LLM session that has been
 * released or aborted.
 *
 * This can happen in three scenarios:
 *   1. The session was explicitly released (via session.release()).
 *   2. The external AbortSignal (passed via LLMSessionOptions) fired.
 *   3. The max-duration timer expired (default 10 minutes).
 *
 * Callers should catch this error and handle it gracefully (e.g. by
 * creating a new session or abandoning the operation).
 */
export class SessionReleasedError extends Error {
  constructor(message = "LLM session has been released or aborted") {
    super(message);
    this.name = "SessionReleasedError";
  }
}

// =============================================================================
// LLMSession
// =============================================================================

/**
 * Concrete session implementation wrapping an LLMSessionManager.
 *
 * Created by withLLMSession() / withLLMSessionForLlm(). Acquires a
 * reference on the manager in the constructor and releases it in release().
 * All LLM operations (embed, embedBatch, etc.) are guarded by
 * withOperation() which checks isValid first and tracks in-flight ops.
 *
 * On creation, links an optional external AbortSignal and sets a max-duration
 * timer (default 10 min). When either fires, the internal AbortController
 * is aborted and subsequent operations throw SessionReleasedError.
 */
class LLMSession implements ILLMSession {
  private manager: LLMSessionManager;
  private released = false;
  private abortController: AbortController;
  private maxDurationTimer: ReturnType<typeof setTimeout> | null = null;
  private name: string;

  constructor(manager: LLMSessionManager, options: LLMSessionOptions = {}) {
    this.manager = manager;
    this.name = options.name || "unnamed";
    this.abortController = new AbortController();

    // Link external abort signal if provided
    if (options.signal) {
      if (options.signal.aborted) {
        this.abortController.abort(options.signal.reason);
      } else {
        options.signal.addEventListener("abort", () => {
          this.abortController.abort(options.signal!.reason);
        }, { once: true });
      }
    }

    // Set up max duration timer
    const maxDuration = options.maxDuration ?? 10 * 60 * 1000; // Default 10 minutes
    if (maxDuration > 0) {
      this.maxDurationTimer = setTimeout(() => {
        this.abortController.abort(new Error(`Session "${this.name}" exceeded max duration of ${maxDuration}ms`));
      }, maxDuration);
      this.maxDurationTimer.unref(); // Don't keep process alive
    }

    // Acquire session lease
    this.manager.acquire();
  }

  get isValid(): boolean {
    return !this.released && !this.abortController.signal.aborted;
  }

  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  release(): void {
    if (this.released) return;
    this.released = true;

    if (this.maxDurationTimer) {
      clearTimeout(this.maxDurationTimer);
      this.maxDurationTimer = null;
    }

    this.abortController.abort(new Error("Session released"));
    this.manager.release();
  }

  private async withOperation<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.isValid) {
      throw new SessionReleasedError();
    }

    this.manager.operationStart();
    try {
      if (this.abortController.signal.aborted) {
        throw new SessionReleasedError(
          this.abortController.signal.reason?.message || "Session aborted"
        );
      }
      return await fn();
    } finally {
      this.manager.operationEnd();
    }
  }

  async embed(text: string, options?: EmbedOptions): Promise<EmbeddingResult | null> {
    return this.withOperation(() => this.manager.getLlamaCpp().embed(text, options));
  }

  async embedBatch(texts: string[], options?: EmbedOptions): Promise<(EmbeddingResult | null)[]> {
    return this.withOperation(() => this.manager.getLlamaCpp().embedBatch(texts, options));
  }

  async expandQuery(
    query: string,
    options?: { context?: string; includeLexical?: boolean }
  ): Promise<Queryable[]> {
    return this.withOperation(() => this.manager.getLlamaCpp().expandQuery(query, options));
  }

  async rerank(
    query: string,
    documents: RerankDocument[],
    options?: RerankOptions
  ): Promise<RerankResult> {
    return this.withOperation(() => this.manager.getLlamaCpp().rerank(query, documents, options));
  }
}

// =============================================================================
// Session management
// =============================================================================

let defaultSessionManager: LLMSessionManager | null = null;

function getSessionManager(): LLMSessionManager {
  const llm = getDefaultLlamaCpp();
  if (!defaultSessionManager || defaultSessionManager.getLlamaCpp() !== llm) {
    defaultSessionManager = new LLMSessionManager(llm);
  }
  return defaultSessionManager;
}

/**
 * Execute a function within a scoped LLM session.
 *
 * Creates a session against the default LLM instance (from getDefaultLlamaCpp()),
 * calls the callback with the session, and guarantees release in the finally
 * block. The session's reference count prevents the LlamaCpp inactivity timer
 * from unloading contexts while the function runs.
 *
 * Usage:
 *   const result = await withLLMSession(async (session) => {
 *     const emb = await session.embed("text");
 *     return emb.embedding;
 *   });
 *
 * @param fn - Callback that receives the session
 * @param options.maxDuration - Max session lifetime in ms (default 600000 = 10 min)
 * @param options.signal - Optional external AbortSignal
 * @param options.name - Debug name for logging
 * @returns The return value of fn
 * @throws {SessionReleasedError} If the session is released or aborted mid-operation
 */
export async function withLLMSession<T>(
  fn: (session: ILLMSession) => Promise<T>,
  options?: LLMSessionOptions
): Promise<T> {
  const manager = getSessionManager();
  const session = new LLMSession(manager, options);

  try {
    return await fn(session);
  } finally {
    session.release();
  }
}

/**
 * Execute a function within a scoped LLM session for a specific LLM instance.
 *
 * Unlike withLLMSession() which uses the global default, this creates a
 * dedicated session manager for the given LLM instance. Useful when you
 * need to use a specific backend (RemoteLLM, test mock) rather than the
 * default LlamaCpp.
 *
 * @param llm - The LLM instance to wrap in a session
 * @param fn - Callback that receives the session
 * @param options.maxDuration - Max session lifetime in ms (default 600000 = 10 min)
 * @param options.signal - Optional external AbortSignal
 * @param options.name - Debug name for logging
 * @returns The return value of fn
 * @throws {SessionReleasedError} If the session is released or aborted mid-operation
 */
export async function withLLMSessionForLlm<T>(
  llm: LLM,
  fn: (session: ILLMSession) => Promise<T>,
  options?: LLMSessionOptions
): Promise<T> {
  const manager = new LLMSessionManager(llm);
  const session = new LLMSession(manager, options);

  try {
    return await fn(session);
  } finally {
    session.release();
  }
}

/**
 * Check whether the default LLM instance can safely unload idle resources.
 *
 * Returns false when any session is active or any operation is in-flight,
 * preventing the LlamaCpp inactivity timer from disposing contexts that
 * are currently in use. When no default session manager exists (no sessions
 * ever created), returns true (safe to unload).
 *
 * Called by LlamaCpp.touchActivity() via a dynamic import to avoid circular
 * dependency — see the module-level comment in singleton.ts.
 *
 * @returns true if no sessions are active and no operations are in-flight
 */
export function canUnloadLLM(): boolean {
  if (!defaultSessionManager) return true;
  return defaultSessionManager.canUnload();
}
