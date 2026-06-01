/**
 * Store/DB lifecycle — shared state and accessors for the CLI.
 *
 * Extracted from qmd.ts so that search-formatting.ts (which imports these
 * symbols) no longer creates a circular dependency with qmd.ts.
 */

import { realpathSync } from "fs";
import { relative as relativePath, resolve as pathResolve } from "path";
import { type Database } from "../db.js";
import {
  createStore,
  getDefaultDbPath,
  syncConfigToDb,
} from "../store.js";
import {
  loadConfig,
} from "../collections.js";
import {
  resolveModels,
  isRemoteConfigured,
  setDefaultLlamaCpp,
  LlamaCpp,
} from "../llm.js";
import { RemoteLLM, remoteConfigFromEnv } from "../embedding-provider.js";

// =============================================================================
// Module state — no legacy singletons in store.ts
// =============================================================================

let store: ReturnType<typeof createStore> | null = null;
export let storeDbPathOverride: string | undefined;
let currentIndexName = "index";

// =============================================================================
// Model resolution (needed by getStore)
// =============================================================================

function ensureModelsConfiguredForCli(): { embed: string; generate: string; rerank: string } {
  // Read-only resolution: config + env + defaults, no auto-save
  try {
    const config = loadConfig();
    return resolveModels(config.models);
  } catch {
    return resolveModels();
  }
}

export function resolveEmbedModelForCli(): string {
  return ensureModelsConfiguredForCli().embed;
}

export function resolveGenerateModelForCli(): string {
  return ensureModelsConfiguredForCli().generate;
}

export function resolveRerankModelForCli(): string {
  return ensureModelsConfiguredForCli().rerank;
}

export function resolveModelsForCli(): { embed: string; generate: string; rerank: string } {
  return ensureModelsConfiguredForCli();
}

// =============================================================================
// Store/DB access
// =============================================================================

export function setStoreDbPathOverride(path: string | undefined): void {
  storeDbPathOverride = path;
}

export function getStore(): ReturnType<typeof createStore> {
  if (!store) {
    store = createStore(storeDbPathOverride);
    // Sync YAML config into SQLite store_collections so store.ts reads from DB
    try {
      const activeModels = ensureModelsConfiguredForCli();
      const config = loadConfig();
      syncConfigToDb(store.db, config);
      if (isRemoteConfigured(config.models)) {
        // Remote LLM configured via env vars — use RemoteLLM instead of LlamaCpp
        const remoteConfig = remoteConfigFromEnv(config.models);
        const remoteLlm = new RemoteLLM(remoteConfig);
        store.llm = remoteLlm;
        setDefaultLlamaCpp(remoteLlm);
      } else {
        setDefaultLlamaCpp(new LlamaCpp({
          embedModel: activeModels.embed,
          generateModel: activeModels.generate,
          rerankModel: activeModels.rerank,
        }));
      }
    } catch {
      // Config may not exist yet — that's fine, DB works without it
    }
  }
  return store;
}

export function getDb(): Database {
  return getStore().db;
}

/** Re-sync YAML config into SQLite after CLI mutations (add/remove/rename collection, context changes) */
export function resyncConfig(): void {
  const s = getStore();
  try {
    const config = loadConfig();
    // Clear config hash to force re-sync
    s.db.prepare(`DELETE FROM store_config WHERE key = 'config_hash'`).run();
    syncConfigToDb(s.db, config);
  } catch {
    // Config may not exist — that's fine
  }
}

export function closeDb(): void {
  if (store) {
    store.close();
    store = null;
  }
}

export function getDbPath(): string {
  return store?.dbPath ?? storeDbPathOverride ?? getDefaultDbPath();
}

export function getActiveIndexName(): string {
  return currentIndexName;
}

export function setIndexName(name: string | null): void {
  let normalizedName = name;
  // Normalize relative paths to prevent malformed database paths
  if (name && name.includes('/')) {
    const absolutePath = pathResolve(process.cwd(), name);
    // Replace path separators with underscores to create a valid filename
    normalizedName = absolutePath.replace(/\//g, '_').replace(/^_/, '');
  }
  currentIndexName = normalizedName || "index";
  storeDbPathOverride = normalizedName ? getDefaultDbPath(normalizedName) : undefined;
  // Reset open handle so next use opens the new index
  closeDb();
}

export function ensureVecTable(_db: Database, dimensions: number): void {
  // Store owns the DB; ignore `_db` and ensure vec table on the active store
  getStore().ensureVecTable(dimensions);
}

// =============================================================================
// Path rendering
// =============================================================================

/**
 * Render an absolute filesystem path for human display under --full-path.
 *
 * If the path is the current working directory or a subpath of it, return a
 * "./"-prefixed relative path so it is unambiguously a filesystem path (not a
 * bare collection-relative string that could be confused for a `qmd://`
 * fragment). Otherwise return the absolute realpath so symlinks resolve
 * consistently. Returns `null` if the path could not be normalized — callers
 * fall back to whatever they had before.
 */
export function renderFullPath(absolutePath: string, cwd: string = process.cwd()): string {
  let real: string;
  try { real = realpathSync(absolutePath); } catch { real = absolutePath; }
  const cwdReal = (() => { try { return realpathSync(cwd); } catch { return cwd; } })();
  if (real === cwdReal) return "./";
  if (real.startsWith(cwdReal + "/")) {
    const rel = relativePath(cwdReal, real);
    if (rel && !rel.startsWith("..")) return `./${rel}`;
  }
  return real;
}
