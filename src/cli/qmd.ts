import { isBun, openDatabase } from "../db.js";
import type { Database, SQLiteValue } from "../db.js";
import { execSync, spawn as nodeSpawn } from "child_process";
import { fileURLToPath } from "url";
import { basename, dirname, join as pathJoin, relative as relativePath, resolve as pathResolve } from "path";
import { parseArgs } from "util";
import { readFileSync, readdirSync, realpathSync, statSync, existsSync, unlinkSync, writeFileSync, openSync, closeSync, mkdirSync, lstatSync, rmSync, symlinkSync, readlinkSync, copyFileSync } from "fs";
import { createInterface } from "readline/promises";
import {
  getPwd,
  getRealPath,
  homedir,
  resolve,
  enableProductionMode,
  searchFTS,
  extractSnippet,
  getContextForFile,
  getContextForPath,
  listCollections,
  removeCollection,
  renameCollection,
  findSimilarFiles,
  findDocumentByDocid,
  isDocid,
  matchFilesByGlob,
  getHashesNeedingEmbedding,
  clearAllEmbeddings,
  insertEmbedding,
  getStatus,
  clearCache,
  getCacheKey,
  getCachedResult,
  setCachedResult,
  parseVirtualPath,
  buildVirtualPath,
  isVirtualPath,
  resolveVirtualPath,
  toVirtualPath,
  deleteLLMCache,
  deleteInactiveDocuments,
  cleanupOrphanedVectors,
  vacuumDatabase,
  getCollectionsWithoutContext,
  getTopLevelPathsWithoutContext,
  handelize,
  hybridQuery,
  vectorSearchQuery,
  structuredSearch,
  addLineNumbers,
  type ExpandedQuery,
  type HybridQueryExplain,
  DEFAULT_EMBED_MODEL,
  DEFAULT_EMBED_MAX_BATCH_BYTES,
  DEFAULT_EMBED_MAX_DOCS_PER_BATCH,
  DEFAULT_RERANK_MODEL,
  DEFAULT_QUERY_MODEL,
  DEFAULT_GLOB,
  DEFAULT_MULTI_GET_MAX_BYTES,
  createStore,
  getDefaultDbPath,
  reindexCollection,
  generateEmbeddings,
  syncConfigToDb,
  type ReindexResult,
  type ChunkStrategy,
} from "../store.js";
import { detectCollectionFromPath } from "./commands/context.js";
import { disposeDefaultLlamaCpp, getDefaultLlamaCpp, setDefaultLlamaCpp, LlamaCpp, withLLMSession, pullModels, DEFAULT_MODEL_CACHE_DIR, resolveEmbedModel, resolveGenerateModel, resolveRerankModel, resolveModels, isRemoteConfigured } from "../llm.js";
import { RemoteLLM, remoteConfigFromEnv } from "../embedding-provider.js";
import {
  formatSearchResults,
  formatDocuments,
  escapeXml,
  escapeCSV,
  type OutputFormat,
} from "./formatter.js";
import {
  buildFTS5Query,
  normalizeBM25,
  shortPath,
  printEmptySearchResults,
  buildEditorUri,
  termLink,
  outputResults,
  resolveCollectionFilter,
  filterByCollections,
  parseStructuredQuery,
  logExpansionTree,
  type OutputOptions,
  type OutputRow,
  type ParsedStructuredQuery,
} from "./search-formatting.js";
import {
  formatETA,
  checkIndexHealth,
  computeDisplayPath,
  formatTimeAgo,
  formatMs,
  formatBytes,
  sameDirectory,
  shortModelName,
  formatCount,
  probeRemoteModelEndpoint,
  runDoctor,
} from "./commands/doctor.js";
import type {
  ModelEndpoint,
  ResolvedModelEndpoint,
  RemoteConnectionStatus,
} from "./commands/doctor.js";
import {
  closeDb,
  getDb,
  getActiveIndexName,
  renderFullPath,
  setIndexName,
  getDbPath,
  resyncConfig,
  resolveEmbedModelForCli,
  resolveRerankModelForCli,
  resolveGenerateModelForCli,
  resolveModelsForCli,
  setStoreDbPathOverride,
  getStore,
} from "./lifecycle.js";
import { parseCLI, parseChunkStrategy } from "./parse.js";
import {
  runSkillsCommand,
  showSkill,
  installSkill,
  showSkillsHelp,
  outputSkillsJson,
} from "./commands/skills.js";
import {
  getCollection as getCollectionFromYaml,
  listCollections as yamlListCollections,
  getDefaultCollectionNames,
  addContext as yamlAddContext,
  removeContext as yamlRemoveContext,
  removeCollection as yamlRemoveCollectionFn,
  renameCollection as yamlRenameCollectionFn,
  setGlobalContext,
  listAllContexts,
  setConfigIndexName,
  loadConfig,
  saveConfig,
  setConfigSource,
  findLocalConfigPath,
  getLocalDbPath,
  getConfigPath,
  configExists,
  type CollectionConfig,
  type ModelsConfig,
} from "../collections.js";

// NOTE: enableProductionMode() is intentionally NOT called at module scope here.
// Importing this module for its exports (e.g. buildEditorUri, termLink from
// test/cli.test.ts) must not flip the global production flag, as that leaks
// into unrelated tests that rely on the default (development) database path
// resolution. The flag is flipped inside the CLI's main-module guard below so
// it only fires when qmd is actually invoked as a script.

// Re-export search formatting utilities (moved to cli/search-formatting.ts)
export { buildEditorUri, termLink } from "./search-formatting.js";
// Re-export store/DB lifecycle (moved to cli/lifecycle.ts)
export {
  closeDb,
  getDb,
  getActiveIndexName,
  renderFullPath,
  resolveEmbedModelForCli,
  resolveGenerateModelForCli,
  resolveRerankModelForCli,
} from "./lifecycle.js";

// Terminal colors (respects NO_COLOR env)
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

// Terminal cursor control
const cursor = {
  hide() { process.stderr.write('\x1b[?25l'); },
  show() { process.stderr.write('\x1b[?25h'); },
};

type CliLifecycleWritable = {
  write(chunk: string | Uint8Array, callback?: (error?: Error | null) => void): boolean;
};

type FinishSuccessfulCliCommandOptions = {
  command: string;
  format?: OutputFormat;
  cleanup?: () => Promise<void>;
  exit?: (code: number) => void;
  stdout?: CliLifecycleWritable;
  stderr?: CliLifecycleWritable;
};

async function flushWritable(stream: CliLifecycleWritable): Promise<void> {
  await new Promise<void>((resolve) => {
    stream.write("", () => resolve());
  });
}

/**
 * Finish a successful CLI command after output has been flushed.
 *
 * We deliberately do NOT call `process.exit(0)`. `process.exit()` skips
 * Node's `beforeExit` event, and node-llama-cpp registers a `beforeExit` hook
 * that auto-disposes its native handles. On darwin, without that hook firing,
 * libggml-metal's static `ggml_metal_device` destructor asserts on a
 * non-empty residency-set collection during `__cxa_finalize_ranges` and
 * dumps a multi-kB backtrace (upstream ggml-org/llama.cpp#22593, fix open as
 * PR #22595). Empirically, even with explicit `disposeDefaultLlamaCpp()` the
 * direct `process.exit(0)` path still trips the assertion — letting the
 * event loop drain naturally is what actually clears the rsets.
 *
 * So: set `process.exitCode = 0` and return. The main module finishes, the
 * event loop drains, `beforeExit` fires, native resources tear down in
 * order, and the process exits cleanly. The `GGML_METAL_NO_RESIDENCY=1` env
 * var that `bin/qmd` exports is a defense-in-depth safety net for paths
 * that still call `process.exit()` after loading the native binding
 * (signal handlers, error paths, `bun test`).
 *
 * If the caller passes an explicit `exit` for testability, we honor it —
 * the lifecycle tests verify the legacy flush → cleanup → exit ordering.
 * Production callers must not pass `exit`.
 */
export async function finishSuccessfulCliCommand(options: FinishSuccessfulCliCommandOptions): Promise<void> {
  const stderr = options.stderr ?? process.stderr;

  await flushWritable(options.stdout ?? process.stdout);

  try {
    await (options.cleanup ?? disposeDefaultLlamaCpp)();
  } catch (error) {
    stderr.write(
      `QMD Warning: cleanup after successful output failed (${error instanceof Error ? error.message : String(error)}); exiting 0 because command output completed.\n`
    );
  }
  await flushWritable(stderr);

  if (options.exit) {
    options.exit(0);
    return;
  }

  process.exitCode = 0;
}

// Ensure cursor is restored on exit
process.on('SIGINT', () => { cursor.show(); process.exit(130); });
process.on('SIGTERM', () => { cursor.show(); process.exit(143); });

// Terminal progress bar using OSC 9;4 escape sequence (TTY only)
const isTTY = process.stderr.isTTY;
const progress = {
  set(percent: number) {
    if (isTTY) process.stderr.write(`\x1b]9;4;1;${Math.round(percent)}\x07`);
  },
  clear() {
    if (isTTY) process.stderr.write(`\x1b]9;4;0\x07`);
  },
  indeterminate() {
    if (isTTY) process.stderr.write(`\x1b]9;4;3\x07`);
  },
  error() {
    if (isTTY) process.stderr.write(`\x1b]9;4;2\x07`);
  },
};

function initLocalIndex(): void {
  const cwd = getPwd();
  if (sameDirectory(cwd, homedir())) {
    throw new Error("Refusing to initialize a local index in $HOME. The global index is automatically created; run `qmd collection add <path>` for the global index, or run `qmd init` inside a project folder.");
  }

  const qmdDir = pathJoin(cwd, ".qmd");
  const ymlPath = pathJoin(qmdDir, "index.yml");
  const yamlPath = pathJoin(qmdDir, "index.yaml");
  const configPath = existsSync(yamlPath) ? yamlPath : ymlPath;
  const dbPath = pathJoin(qmdDir, "index.sqlite");

  mkdirSync(qmdDir, { recursive: true });
  setConfigSource({ configPath });
  setStoreDbPathOverride(dbPath);
  closeDb();

  if (!existsSync(configPath)) {
    saveConfig({
      collections: {},
      models: resolveModels(),
    });
  } else {
    resolveModelsForCli();
  }

  const localStore = createStore(dbPath);
  syncConfigToDb(localStore.db, loadConfig());
  localStore.close();

  console.log("ready to go with new local index");
}

async function showStatus(): Promise<void> {
  const dbPath = getDbPath();
  const db = getDb();

  // Collections are defined in YAML; no duplicate cleanup needed.
  // Collections are defined in YAML; no duplicate cleanup needed.

  // Index size
  let indexSize = 0;
  try {
    const stat = statSync(dbPath).size;
    indexSize = stat;
  } catch { }

  // Collections info (from YAML + database stats)
  const collections = listCollections(db);

  // Overall stats
  const totalDocs = db.prepare(`SELECT COUNT(*) as count FROM documents WHERE active = 1`).get() as { count: number };
  const vectorCount = db.prepare(`SELECT COUNT(*) as count FROM content_vectors`).get() as { count: number };
  const statusEmbedModel = resolveEmbedModelForCli();
  const needsEmbedding = getHashesNeedingEmbedding(db, undefined, statusEmbedModel);

  // Most recent update across all collections
  const mostRecent = db.prepare(`SELECT MAX(modified_at) as latest FROM documents WHERE active = 1`).get() as { latest: string | null };

  console.log(`${c.bold}QMD Status${c.reset}\n`);
  console.log(`Index: ${dbPath}`);
  console.log(`Size:  ${formatBytes(indexSize)}`);

  // MCP daemon status (check PID file liveness)
  const mcpCacheDir = process.env.XDG_CACHE_HOME
    ? resolve(process.env.XDG_CACHE_HOME, "qmd")
    : resolve(homedir(), ".cache", "qmd");
  const mcpPidPath = resolve(mcpCacheDir, "mcp.pid");
  if (existsSync(mcpPidPath)) {
    const mcpPid = parseInt(readFileSync(mcpPidPath, "utf-8").trim());
    try {
      process.kill(mcpPid, 0);
      console.log(`MCP:   ${c.green}running${c.reset} (PID ${mcpPid})`);
    } catch {
      unlinkSync(mcpPidPath);
      // Stale PID file cleaned up silently
    }
  }
  console.log("");

  console.log(`${c.bold}Documents${c.reset}`);
  console.log(`  Total:    ${totalDocs.count} files indexed`);
  console.log(`  Vectors:  ${vectorCount.count} embedded`);
  if (needsEmbedding > 0) {
    console.log(`  ${c.yellow}Pending:  ${needsEmbedding} need embedding${c.reset} (run 'qmd embed')`);
  }
  if (mostRecent.latest) {
    const lastUpdate = new Date(mostRecent.latest);
    console.log(`  Updated:  ${formatTimeAgo(lastUpdate)}`);
  }

  // Get all contexts grouped by collection (from YAML)
  const allContexts = listAllContexts();
  const contextsByCollection = new Map<string, { path_prefix: string; context: string }[]>();

  for (const ctx of allContexts) {
    // Group contexts by collection name
    if (!contextsByCollection.has(ctx.collection)) {
      contextsByCollection.set(ctx.collection, []);
    }
    contextsByCollection.get(ctx.collection)!.push({
      path_prefix: ctx.path,
      context: ctx.context
    });
  }

  // AST chunking status
  try {
    const { getASTStatus } = await import("../ast.js");
    const ast = await getASTStatus();
    console.log(`\n${c.bold}AST Chunking${c.reset}`);
    if (ast.available) {
      const ok = ast.languages.filter(l => l.available).map(l => l.language);
      const fail = ast.languages.filter(l => !l.available);
      console.log(`  Status:   ${c.green}active${c.reset}`);
      console.log(`  Languages: ${ok.join(", ")}`);
      if (fail.length > 0) {
        for (const f of fail) {
          console.log(`  ${c.yellow}Unavailable: ${f.language} (${f.error})${c.reset}`);
        }
      }
    } else {
      console.log(`  Status:   ${c.yellow}unavailable${c.reset} (falling back to regex chunking)`);
      for (const l of ast.languages) {
        if (l.error) console.log(`  ${c.dim}${l.language}: ${l.error}${c.reset}`);
      }
    }
  } catch {
    console.log(`\n${c.bold}AST Chunking${c.reset}`);
    console.log(`  Status:   ${c.dim}not available${c.reset}`);
  }

  if (collections.length > 0) {
    console.log(`\n${c.bold}Collections${c.reset}`);
    for (const col of collections) {
      const lastMod = col.last_modified ? formatTimeAgo(new Date(col.last_modified)) : "never";
      const contexts = contextsByCollection.get(col.name) || [];

      console.log(`  ${c.cyan}${col.name}${c.reset} ${c.dim}(qmd://${col.name}/)${c.reset}`);
      console.log(`    ${c.dim}Pattern:${c.reset}  ${col.glob_pattern}`);
      console.log(`    ${c.dim}Files:${c.reset}    ${col.active_count} (updated ${lastMod})`);

      if (contexts.length > 0) {
        console.log(`    ${c.dim}Contexts:${c.reset} ${contexts.length}`);
        for (const ctx of contexts) {
          // Handle both empty string and '/' as root context
          const pathDisplay = (ctx.path_prefix === '' || ctx.path_prefix === '/') ? '/' : `/${ctx.path_prefix}`;
          const contextPreview = ctx.context.length > 60
            ? ctx.context.substring(0, 57) + '...'
            : ctx.context;
          console.log(`      ${c.dim}${pathDisplay}:${c.reset} ${contextPreview}`);
        }
      }
    }

    // Show examples of virtual paths
    console.log(`\n${c.bold}Examples${c.reset}`);
    console.log(`  ${c.dim}# List files in a collection${c.reset}`);
    if (collections.length > 0 && collections[0]) {
      console.log(`  qmd ls ${collections[0].name}`);
    }
    console.log(`  ${c.dim}# Get a document${c.reset}`);
    if (collections.length > 0 && collections[0]) {
      console.log(`  qmd get qmd://${collections[0].name}/path/to/file.md`);
    }
    console.log(`  ${c.dim}# Search within a collection${c.reset}`);
    if (collections.length > 0 && collections[0]) {
      console.log(`  qmd search "query" -c ${collections[0].name}`);
    }
  } else {
    console.log(`\n${c.dim}No collections. Run 'qmd collection add .' to index markdown files.${c.reset}`);
  }

  // Models — read config + env vars directly (no auto-save via ensureModelsConfiguredForCli)
  {
    const config = loadConfig();
    const models = config.models ?? {};
    const remoteCfg = remoteConfigFromEnv(models);
    const endpointCfgByRole: Record<ModelEndpoint, { baseUrl: string; model: string; apiKey?: string; format?: string }> = {
      embed: remoteCfg.embed!,
      expand: remoteCfg.expand!,
      rerank: remoteCfg.rerank!,
      generate: remoteCfg.generate!,
    };

    // Env var mapping for each endpoint
    const envMap: Record<ModelEndpoint, { model: string; baseUrl: string; apiKey: string; format: string }> = {
      embed:    { model: 'QMD_EMBED_MODEL',    baseUrl: 'QMD_EMBED_BASE_URL',    apiKey: 'QMD_EMBED_API_KEY',    format: 'QMD_EMBED_API_FORMAT' },
      expand:   { model: 'QMD_EXPAND_MODEL',   baseUrl: 'QMD_EXPAND_BASE_URL',   apiKey: 'QMD_EXPAND_API_KEY',   format: 'QMD_EXPAND_API_FORMAT' },
      rerank:   { model: 'QMD_RERANK_MODEL',   baseUrl: 'QMD_RERANK_BASE_URL',   apiKey: 'QMD_RERANK_API_KEY',   format: 'QMD_RERANK_API_FORMAT' },
      generate: { model: 'QMD_GENERATE_MODEL', baseUrl: 'QMD_GENERATE_BASE_URL', apiKey: 'QMD_GENERATE_API_KEY', format: 'QMD_GENERATE_API_FORMAT' },
    };

    // Config field mapping
    const cfgMap: Record<ModelEndpoint, { model: string; url: string; key: string; format: string; flat?: string }> = {
      embed:    { model: 'embed_api_model',    url: 'embed_api_url',    key: 'embed_api_key',    format: 'embed_api_format',    flat: 'embed' },
      expand:   { model: 'expand_api_model',   url: 'expand_api_url',   key: 'expand_api_key',   format: 'expand_api_format' },
      rerank:   { model: 'rerank_api_model',   url: 'rerank_api_url',   key: 'rerank_api_key',   format: 'rerank_api_format',   flat: 'rerank' },
      generate: { model: 'generate_api_model', url: 'generate_api_url', key: 'generate_api_key', format: 'generate_api_format', flat: 'generate' },
    };

    // Default GGUF models
    const defaults: Record<ModelEndpoint, string> = {
      embed: DEFAULT_EMBED_MODEL,
      expand: DEFAULT_QUERY_MODEL,
      rerank: DEFAULT_RERANK_MODEL,
      generate: DEFAULT_QUERY_MODEL,
    };

    // Determine provider label from URL
    const providerLabel = (url: string): string => {
      if (!url) return 'local (GGUF)';
      try {
        const u = new URL(url);
        const host = u.hostname + (u.port && u.port !== '80' && u.port !== '443' ? `:${u.port}` : '');
        if (u.hostname.includes('openrouter.ai')) return 'OpenRouter';
        if (u.hostname.includes('api.openai.com')) return 'OpenAI';
        if (u.hostname.includes('ollama')) return 'Ollama';
        if (u.hostname.includes('api.x.ai')) return 'xAI';
        return host;
      } catch {
        return url;
      }
    };

    // Resolve each endpoint's model name, provider, and source tag
    const resolveEndpoint = (ep: ModelEndpoint): ResolvedModelEndpoint => {
      const env = envMap[ep];
      const cfg = cfgMap[ep];
      const envModel = process.env[env.model];
      const envUrl = process.env[env.baseUrl];
      const envKey = process.env[env.apiKey];
      const envFormat = process.env[env.format];
      const cfgModel = (models as Record<string, string | undefined>)[cfg.model];
      const cfgUrl = (models as Record<string, string | undefined>)[cfg.url];
      const cfgKey = (models as Record<string, string | undefined>)[cfg.key];
      const cfgFormat = (models as Record<string, string | undefined>)[cfg.format];
      const flatModel = cfg.flat ? (models as Record<string, string | undefined>)[cfg.flat] : undefined;
      const fallback = endpointCfgByRole[ep];
      const baseUrl = (envUrl || cfgUrl || fallback.baseUrl || '').trim();
      const apiKey = (envKey || cfgKey || fallback.apiKey || '').trim();
      const format = (envFormat || cfgFormat || fallback.format || 'auto').trim();
      const provider = providerLabel(baseUrl);

      // Source priority: env var > config (remote or flat) > default
      if (envModel || envUrl) {
        return {
          model: envModel || cfgModel || defaults[ep],
          provider,
          source: `(env ${env.model})`,
          baseUrl,
          apiKey,
          format,
        };
      }
      if (cfgModel || cfgUrl) {
        return {
          model: cfgModel || flatModel || defaults[ep],
          provider,
          source: '(index.yml)',
          baseUrl,
          apiKey,
          format,
        };
      }
      if (flatModel) {
        return {
          model: flatModel,
          provider,
          source: '(index.yml)',
          baseUrl,
          apiKey,
          format,
        };
      }
      return {
        model: defaults[ep],
        provider,
        source: '(default)',
        baseUrl,
        apiKey,
        format,
      };
    };

    const labelWidth = 11; // "Embed:     " = 11 chars
    const eps: { ep: ModelEndpoint; label: string }[] = [
      { ep: 'embed',   label: 'Embed:' },
      { ep: 'expand',  label: 'Expand:' },
      { ep: 'rerank',  label: 'Rerank:' },
      { ep: 'generate', label: 'Generate:' },
    ];
    const resolvedEndpoints = eps.map(({ ep, label }) => ({ ep, label, resolved: resolveEndpoint(ep) }));
    const probePromises = new Map<ModelEndpoint, Promise<RemoteConnectionStatus>>();
    for (const { ep, resolved } of resolvedEndpoints) {
      if (resolved.baseUrl) probePromises.set(ep, probeRemoteModelEndpoint(ep, resolved));
    }

    console.log(`\n${c.bold}Models${c.reset}`);
    for (const { ep, label, resolved } of resolvedEndpoints) {
      const { model, provider, source } = resolved;
      const pad = ' '.repeat(Math.max(0, labelWidth - label.length));
      console.log(`  ${label}${pad} ${c.cyan}${model}${c.reset} → ${c.dim}${provider}${c.reset} ${c.yellow}${source}${c.reset}`);

      if (!resolved.baseUrl) {
        console.log(`  ${' '.repeat(labelWidth)} ${c.dim}Connection: local (no remote endpoint configured)${c.reset}`);
        continue;
      }

      const status = await probePromises.get(ep)!;
      const statusColor = status.state === 'ok' ? c.green : c.yellow;
      const latency = status.latencyMs !== undefined ? ` (${formatMs(status.latencyMs)})` : '';
      console.log(`  ${' '.repeat(labelWidth)} ${c.dim}Connection:${c.reset} ${statusColor}${status.state}${c.reset}${latency} ${c.dim}— ${status.detail}${c.reset}`);
    }
  }


  // Tips section
  const tips: string[] = [];

  // Check for collections without context
  const collectionsWithoutContext = collections.filter(col => {
    const contexts = contextsByCollection.get(col.name) || [];
    return contexts.length === 0;
  });
  if (collectionsWithoutContext.length > 0) {
    const names = collectionsWithoutContext.map(c => c.name).slice(0, 3).join(', ');
    const more = collectionsWithoutContext.length > 3 ? ` +${collectionsWithoutContext.length - 3} more` : '';
    tips.push(`Add context to collections for better search results: ${names}${more}`);
    tips.push(`  ${c.dim}qmd context add qmd://<name>/ "What this collection contains"${c.reset}`);
    tips.push(`  ${c.dim}qmd context add qmd://<name>/meeting-notes "Weekly team meeting notes"${c.reset}`);
  }

  // Check for collections without update commands
  const collectionsWithoutUpdate = collections.filter(col => {
    const yamlCol = getCollectionFromYaml(col.name);
    return !yamlCol?.update;
  });
  if (collectionsWithoutUpdate.length > 0 && collections.length > 1) {
    const names = collectionsWithoutUpdate.map(c => c.name).slice(0, 3).join(', ');
    const more = collectionsWithoutUpdate.length > 3 ? ` +${collectionsWithoutUpdate.length - 3} more` : '';
    tips.push(`Add update commands to keep collections fresh: ${names}${more}`);
    tips.push(`  ${c.dim}qmd collection update-cmd <name> 'git stash && git pull --rebase --ff-only && git stash pop'${c.reset}`);
  }

  if (tips.length > 0) {
    console.log(`\n${c.bold}Tips${c.reset}`);
    for (const tip of tips) {
      console.log(`  ${tip}`);
    }
  }

  closeDb();
}

async function updateCollections(): Promise<void> {
  const db = getDb();
  const storeInstance = getStore();
  // Collections are defined in YAML; no duplicate cleanup needed.

  // Clear Ollama cache on update
  clearCache(db);

  const collections = listCollections(db);

  if (collections.length === 0) {
    console.log(`${c.dim}No collections found. Run 'qmd collection add .' to index markdown files.${c.reset}`);
    closeDb();
    return;
  }

  console.log(`${c.bold}Updating ${collections.length} collection(s)...${c.reset}\n`);

  for (let i = 0; i < collections.length; i++) {
    const col = collections[i];
    if (!col) continue;
    console.log(`${c.cyan}[${i + 1}/${collections.length}]${c.reset} ${c.bold}${col.name}${c.reset} ${c.dim}(${col.glob_pattern})${c.reset}`);

    // Execute custom update command if specified in YAML
    const yamlCol = getCollectionFromYaml(col.name);
    if (yamlCol?.update) {
      console.log(`${c.dim}    Running update command: ${yamlCol.update}${c.reset}`);
      try {
        const proc = nodeSpawn("bash", ["-c", yamlCol.update], {
          cwd: col.pwd,
          stdio: ["ignore", "pipe", "pipe"],
        });

        const [output, errorOutput, exitCode] = await new Promise<[string, string, number]>((resolve, reject) => {
          let out = "";
          let err = "";
          proc.stdout?.on("data", (d: Buffer) => { out += d.toString(); });
          proc.stderr?.on("data", (d: Buffer) => { err += d.toString(); });
          proc.on("error", reject);
          proc.on("close", (code) => resolve([out, err, code ?? 1]));
        });

        if (output.trim()) {
          console.log(output.trim().split('\n').map(l => `    ${l}`).join('\n'));
        }
        if (errorOutput.trim()) {
          console.log(errorOutput.trim().split('\n').map(l => `    ${l}`).join('\n'));
        }

        if (exitCode !== 0) {
          console.log(`${c.yellow}✗ Update command failed with exit code ${exitCode}${c.reset}`);
          process.exit(exitCode);
        }
      } catch (err) {
        console.log(`${c.yellow}✗ Update command failed: ${err}${c.reset}`);
        process.exit(1);
      }
    }

    const startTime = Date.now();
    console.log(`Collection: ${col.pwd} (${col.glob_pattern})`);
    progress.indeterminate();

    const result = await reindexCollection(storeInstance, col.pwd, col.glob_pattern, col.name, {
      ignorePatterns: yamlCol?.ignore,
      onProgress: (info) => {
        progress.set((info.current / info.total) * 100);
        const elapsed = (Date.now() - startTime) / 1000;
        const rate = info.current / elapsed;
        const remaining = (info.total - info.current) / rate;
        const eta = info.current > 2 ? ` ETA: ${formatETA(remaining)}` : "";
        if (isTTY) process.stderr.write(`\rIndexing: ${info.current}/${info.total}${eta}        `);
      },
    });

    progress.clear();
    console.log(`\nIndexed: ${result.indexed} new, ${result.updated} updated, ${result.unchanged} unchanged, ${result.removed} removed`);
    if (result.orphanedCleaned > 0) {
      console.log(`Cleaned up ${result.orphanedCleaned} orphaned content hash(es)`);
    }
    console.log("");
  }

  // Check if any documents need embedding (show once at end)
  const needsEmbedding = getHashesNeedingEmbedding(db);
  closeDb();

  console.log(`${c.green}✓ All collections updated.${c.reset}`);
  if (needsEmbedding > 0) {
    console.log(`\nRun 'qmd embed' to update embeddings (${needsEmbedding} unique hashes need vectors)`);
  }
}

async function contextAdd(pathArg: string | undefined, contextText: string): Promise<void> {
  const db = getDb();

  // Handle "/" as global context (applies to all collections)
  if (pathArg === '/') {
    setGlobalContext(contextText);
    resyncConfig();
    console.log(`${c.green}✓${c.reset} Set global context`);
    console.log(`${c.dim}Context: ${contextText}${c.reset}`);
    closeDb();
    return;
  }

  // Resolve path - defaults to current directory if not provided
  let fsPath = pathArg || '.';
  if (fsPath === '.' || fsPath === './') {
    fsPath = getPwd();
  } else if (fsPath.startsWith('~/')) {
    fsPath = homedir() + fsPath.slice(1);
  } else if (!fsPath.startsWith('/') && !fsPath.startsWith('qmd://')) {
    fsPath = resolve(getPwd(), fsPath);
  }

  // Handle virtual paths (qmd://collection/path)
  if (isVirtualPath(fsPath)) {
    const parsed = parseVirtualPath(fsPath);
    if (!parsed) {
      console.error(`${c.yellow}Invalid virtual path: ${fsPath}${c.reset}`);
      process.exit(1);
    }

    const coll = getCollectionFromYaml(parsed.collectionName);
    if (!coll) {
      console.error(`${c.yellow}Collection not found: ${parsed.collectionName}${c.reset}`);
      process.exit(1);
    }

    yamlAddContext(parsed.collectionName, parsed.path, contextText);
    resyncConfig();

    const displayPath = parsed.path
      ? `qmd://${parsed.collectionName}/${parsed.path}`
      : `qmd://${parsed.collectionName}/ (collection root)`;
    console.log(`${c.green}✓${c.reset} Added context for: ${displayPath}`);
    console.log(`${c.dim}Context: ${contextText}${c.reset}`);
    closeDb();
    return;
  }

  // Detect collection from filesystem path
  const detected = detectCollectionFromPath(db, fsPath);
  if (!detected) {
    console.error(`${c.yellow}Path is not in any indexed collection: ${fsPath}${c.reset}`);
    console.error(`${c.dim}Run 'qmd status' to see indexed collections${c.reset}`);
    process.exit(1);
  }

  yamlAddContext(detected.collectionName, detected.relativePath, contextText);
  resyncConfig();

  const displayPath = detected.relativePath ? `qmd://${detected.collectionName}/${detected.relativePath}` : `qmd://${detected.collectionName}/`;
  console.log(`${c.green}✓${c.reset} Added context for: ${displayPath}`);
  console.log(`${c.dim}Context: ${contextText}${c.reset}`);
  closeDb();
}

function contextList(): void {
  const db = getDb();

  const allContexts = listAllContexts();

  if (allContexts.length === 0) {
    console.log(`${c.dim}No contexts configured. Use 'qmd context add' to add one.${c.reset}`);
    closeDb();
    return;
  }

  console.log(`\n${c.bold}Configured Contexts${c.reset}\n`);

  let lastCollection = '';
  for (const ctx of allContexts) {
    if (ctx.collection !== lastCollection) {
      console.log(`${c.cyan}${ctx.collection}${c.reset}`);
      lastCollection = ctx.collection;
    }

    const displayPath = ctx.path ? `  ${ctx.path}` : '  / (root)';
    console.log(`${displayPath}`);
    console.log(`    ${c.dim}${ctx.context}${c.reset}`);
  }

  closeDb();
}

function contextRemove(pathArg: string): void {
  if (pathArg === '/') {
    // Remove global context
    setGlobalContext(undefined);
    // Resync so SQLite store_config is updated
    const s = getStore();
    resyncConfig();
    closeDb();
    console.log(`${c.green}✓${c.reset} Removed global context`);
    return;
  }

  // Handle virtual paths
  if (isVirtualPath(pathArg)) {
    const parsed = parseVirtualPath(pathArg);
    if (!parsed) {
      console.error(`${c.yellow}Invalid virtual path: ${pathArg}${c.reset}`);
      process.exit(1);
    }

    const coll = getCollectionFromYaml(parsed.collectionName);
    if (!coll) {
      console.error(`${c.yellow}Collection not found: ${parsed.collectionName}${c.reset}`);
      process.exit(1);
    }

    const success = yamlRemoveContext(coll.name, parsed.path);

    if (!success) {
      console.error(`${c.yellow}No context found for: ${pathArg}${c.reset}`);
      process.exit(1);
    }

    console.log(`${c.green}✓${c.reset} Removed context for: ${pathArg}`);
    return;
  }

  // Handle filesystem paths
  let fsPath = pathArg;
  if (fsPath === '.' || fsPath === './') {
    fsPath = getPwd();
  } else if (fsPath.startsWith('~/')) {
    fsPath = homedir() + fsPath.slice(1);
  } else if (!fsPath.startsWith('/')) {
    fsPath = resolve(getPwd(), fsPath);
  }

  const db = getDb();
  const detected = detectCollectionFromPath(db, fsPath);
  closeDb();

  if (!detected) {
    console.error(`${c.yellow}Path is not in any indexed collection: ${fsPath}${c.reset}`);
    process.exit(1);
  }

  const success = yamlRemoveContext(detected.collectionName, detected.relativePath);

  if (!success) {
    console.error(`${c.yellow}No context found for: qmd://${detected.collectionName}/${detected.relativePath}${c.reset}`);
    process.exit(1);
  }

  console.log(`${c.green}✓${c.reset} Removed context for: qmd://${detected.collectionName}/${detected.relativePath}`);
}

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
function getDocument(filename: string, fromLine?: number, maxLines?: number, lineNumbers?: boolean, fullPath: boolean = false): void {
  // Parse :line suffix from filename. Two forms:
  //   "file.md:100"     -> start at line 100
  //   "file.md:100:40"  -> start at line 100, read 40 lines
  // The :// in virtual paths is never matched because we anchor digits to $.
  // Explicit --from/-l flags always win over values parsed from the path.
  let inputPath = filename;
  const rangeMatch = inputPath.match(/:(\d+):(\d+)$/);
  if (rangeMatch) {
    if (fromLine === undefined) fromLine = parseInt(rangeMatch[1]!, 10);
    if (maxLines === undefined) maxLines = parseInt(rangeMatch[2]!, 10);
    inputPath = inputPath.slice(0, -rangeMatch[0].length);
  } else {
    const colonMatch = inputPath.match(/:(\d+)$/);
    if (colonMatch) {
      const matched = colonMatch[1];
      if (matched) {
        if (fromLine === undefined) fromLine = parseInt(matched, 10);
        inputPath = inputPath.slice(0, -colonMatch[0].length);
      }
    }
  }
  if (fromLine !== undefined) fromLine = Math.max(1, fromLine);

  const parsedIndexPath = isVirtualPath(inputPath) ? parseVirtualPath(inputPath) : null;
  if (parsedIndexPath?.indexName) {
    setIndexName(parsedIndexPath.indexName);
    setConfigIndexName(parsedIndexPath.indexName);
  }

  const db = getDb();

  // Handle docid lookup (#abc123, abc123, "#abc123", "abc123", etc.)
  if (isDocid(inputPath)) {
    const docidMatch = findDocumentByDocid(db, inputPath);
    if (docidMatch) {
      inputPath = docidMatch.filepath;
    } else {
      console.error(`Document not found: ${filename}`);
      closeDb();
      process.exit(1);
    }
  }
  let doc: { collectionName: string; path: string; body: string } | null = null;
  let virtualPath: string;

  // Handle virtual paths (qmd://collection/path)
  if (isVirtualPath(inputPath)) {
    const parsed = parseVirtualPath(inputPath);
    if (!parsed) {
      console.error(`Invalid virtual path: ${inputPath}`);
      closeDb();
      process.exit(1);
    }

    // Try exact match on collection + path
    doc = db.prepare(`
      SELECT d.collection as collectionName, d.path, content.doc as body
      FROM documents d
      JOIN content ON content.hash = d.hash
      WHERE d.collection = ? AND d.path = ? AND d.active = 1
    `).get(parsed.collectionName, parsed.path) as typeof doc;

    if (!doc) {
      // Try fuzzy match by path ending
      doc = db.prepare(`
        SELECT d.collection as collectionName, d.path, content.doc as body
        FROM documents d
        JOIN content ON content.hash = d.hash
        WHERE d.collection = ? AND d.path LIKE ? AND d.active = 1
        LIMIT 1
      `).get(parsed.collectionName, `%${parsed.path}`) as typeof doc;
    }

    virtualPath = inputPath;
  } else {
    // Try to interpret as collection/path format first (before filesystem path)
    // If path is relative (no / or ~ prefix), check if first component is a collection name
    if (!inputPath.startsWith('/') && !inputPath.startsWith('~')) {
      const parts = inputPath.split('/');
      if (parts.length >= 2) {
        const possibleCollection = parts[0];
        const possiblePath = parts.slice(1).join('/');

        // Check if this collection exists
        const collExists = possibleCollection ? db.prepare(`
          SELECT 1 FROM documents WHERE collection = ? AND active = 1 LIMIT 1
        `).get(possibleCollection) : null;

        if (collExists) {
          // Try exact match on collection + path
          doc = db.prepare(`
            SELECT d.collection as collectionName, d.path, content.doc as body
            FROM documents d
            JOIN content ON content.hash = d.hash
            WHERE d.collection = ? AND d.path = ? AND d.active = 1
          `).get(possibleCollection || "", possiblePath || "") as { collectionName: string; path: string; body: string } | null;

          if (!doc) {
            // Try fuzzy match by path ending
            doc = db.prepare(`
              SELECT d.collection as collectionName, d.path, content.doc as body
              FROM documents d
              JOIN content ON content.hash = d.hash
              WHERE d.collection = ? AND d.path LIKE ? AND d.active = 1
              LIMIT 1
            `).get(possibleCollection || "", `%${possiblePath}`) as { collectionName: string; path: string; body: string } | null;
          }

          if (doc) {
            virtualPath = buildVirtualPath(doc.collectionName, doc.path);
            // Skip the filesystem path handling below
          }
        }
      }
    }

    // If not found as collection/path, handle as filesystem paths
    if (!doc) {
      let fsPath = inputPath;

      // Expand ~ to home directory
      if (fsPath.startsWith('~/')) {
        fsPath = homedir() + fsPath.slice(1);
      } else if (!fsPath.startsWith('/')) {
        // Relative path - resolve from current directory
        fsPath = resolve(getPwd(), fsPath);
      }
      fsPath = getRealPath(fsPath);

      // Try to detect which collection contains this path
      const detected = detectCollectionFromPath(db, fsPath);

      if (detected) {
        // Found collection - query by collection name + relative path
        doc = db.prepare(`
          SELECT d.collection as collectionName, d.path, content.doc as body
          FROM documents d
          JOIN content ON content.hash = d.hash
          WHERE d.collection = ? AND d.path = ? AND d.active = 1
        `).get(detected.collectionName, detected.relativePath) as { collectionName: string; path: string; body: string } | null;
      }

      // Fuzzy match by filename (last component of path)
      if (!doc) {
        const filename = inputPath.split('/').pop() || inputPath;
        doc = db.prepare(`
          SELECT d.collection as collectionName, d.path, content.doc as body
          FROM documents d
          JOIN content ON content.hash = d.hash
          WHERE d.path LIKE ? AND d.active = 1
          LIMIT 1
        `).get(`%${filename}`) as { collectionName: string; path: string; body: string } | null;
      }

      if (doc) {
        virtualPath = buildVirtualPath(doc.collectionName, doc.path);
      } else {
        virtualPath = inputPath;
      }
    }
  }

  // Ensure doc is not null before proceeding
  if (!doc) {
    console.error(`Document not found: ${filename}`);
    closeDb();
    process.exit(1);
  }

  // Get context for this file
  const context = getContextForPath(db, doc.collectionName, doc.path);

  // Resolve the docid (first 6 chars of the content hash) so callers always
  // know what they retrieved and can cite it back to `get`/`multi-get`.
  const hashRow = db.prepare(`
    SELECT d.hash as hash
    FROM documents d
    WHERE d.collection = ? AND d.path = ? AND d.active = 1
  `).get(doc.collectionName, doc.path) as { hash: string } | null;
  const docid = hashRow?.hash ? hashRow.hash.slice(0, 6) : undefined;
  const canonicalPath = buildVirtualPath(doc.collectionName, doc.path);

  // --full-path: show the on-disk path instead of the qmd:// URL + docid, when
  // the file actually exists. Fall back to the canonical header otherwise.
  let header: string;
  if (fullPath) {
    const fsPath = resolveVirtualPath(db, canonicalPath);
    if (fsPath && existsSync(fsPath)) {
      header = renderFullPath(fsPath);
    } else {
      header = docid ? `${canonicalPath}  #${docid}` : canonicalPath;
    }
  } else {
    header = docid ? `${canonicalPath}  #${docid}` : canonicalPath;
  }

  let output = doc.body;
  const startLine = fromLine || 1;

  // Apply line filtering if specified
  if (fromLine !== undefined || maxLines !== undefined) {
    const lines = output.split('\n');
    const start = startLine - 1; // Convert to 0-indexed
    const end = maxLines !== undefined ? start + maxLines : lines.length;
    output = lines.slice(start, end).join('\n');
  }

  // Line numbers are on by default (disable with --no-line-numbers) so the
  // model can cite exact lines and request follow-up ranges via path:from:count.
  if (lineNumbers) {
    output = addLineNumbers(output, startLine);
  }

  // Header: identify the document (path + docid, or the on-disk path with
  // --full-path), then optional context.
  console.log(header);
  if (context) {
    console.log(`Folder Context: ${context}`);
  }
  console.log("---\n");
  console.log(output);
  closeDb();
}

// Multi-get: fetch multiple documents by glob pattern or comma-separated list
function multiGet(pattern: string, maxLines?: number, maxBytes: number = DEFAULT_MULTI_GET_MAX_BYTES, format: OutputFormat = "cli", lineNumbers: boolean = true, fullPath: boolean = false): void {
  const db = getDb();

  // Check if it's a comma-separated list or a glob pattern
  const isCommaSeparated = pattern.includes(',') && !pattern.includes('*') && !pattern.includes('?') && !pattern.includes('{');

  let files: { filepath: string; displayPath: string; bodyLength: number; collection?: string; path?: string }[];

  if (isCommaSeparated) {
    // Comma-separated list of files (can be virtual paths or relative paths)
    const names = pattern.split(',').map(s => s.trim()).filter(Boolean);
    files = [];
    for (const name of names) {
      let doc: { virtual_path: string; body_length: number; collection: string; path: string } | null = null;

      // Handle virtual paths
      if (isVirtualPath(name)) {
        const parsed = parseVirtualPath(name);
        if (parsed) {
          // Try exact match on collection + path
          doc = db.prepare(`
            SELECT
              'qmd://' || d.collection || '/' || d.path as virtual_path,
              LENGTH(content.doc) as body_length,
              d.collection,
              d.path
            FROM documents d
            JOIN content ON content.hash = d.hash
            WHERE d.collection = ? AND d.path = ? AND d.active = 1
          `).get(parsed.collectionName, parsed.path) as typeof doc;
        }
      } else {
        // Try exact match on path
        doc = db.prepare(`
          SELECT
            'qmd://' || d.collection || '/' || d.path as virtual_path,
            LENGTH(content.doc) as body_length,
            d.collection,
            d.path
          FROM documents d
          JOIN content ON content.hash = d.hash
          WHERE d.path = ? AND d.active = 1
          LIMIT 1
        `).get(name) as { virtual_path: string; body_length: number; collection: string; path: string } | null;

        // Try suffix match
        if (!doc) {
          doc = db.prepare(`
            SELECT
              'qmd://' || d.collection || '/' || d.path as virtual_path,
              LENGTH(content.doc) as body_length,
              d.collection,
              d.path
            FROM documents d
            JOIN content ON content.hash = d.hash
            WHERE d.path LIKE ? AND d.active = 1
            LIMIT 1
          `).get(`%${name}`) as { virtual_path: string; body_length: number; collection: string; path: string } | null;
        }
      }

      if (doc) {
        files.push({
          filepath: doc.virtual_path,
          displayPath: doc.virtual_path,
          bodyLength: doc.body_length,
          collection: doc.collection,
          path: doc.path
        });
      } else {
        console.error(`File not found: ${name}`);
      }
    }
  } else {
    // Glob pattern - matchFilesByGlob now returns virtual paths
    files = matchFilesByGlob(db, pattern).map(f => ({
      ...f,
      collection: undefined,  // Will be fetched later if needed
      path: undefined
    }));
    if (files.length === 0) {
      console.error(`No files matched pattern: ${pattern}`);
      closeDb();
      process.exit(1);
    }
  }

  // Collect results for structured output
  const results: { file: string; displayPath: string; fsPath?: string; docid?: string; title: string; body: string; context: string | null; skipped: boolean; skipReason?: string }[] = [];

  for (const file of files) {
    // Parse virtual path to get collection info if not already available
    let collection = file.collection;
    let path = file.path;

    if (!collection || !path) {
      const parsed = parseVirtualPath(file.filepath);
      if (parsed) {
        collection = parsed.collectionName;
        path = parsed.path;
      }
    }

    // Get context using collection-scoped function
    const context = collection && path ? getContextForPath(db, collection, path) : null;

    // Resolve docid (first 6 chars of content hash) so every entry can be cited.
    const docidRow = collection && path ? db.prepare(`
      SELECT d.hash as hash
      FROM documents d
      WHERE d.collection = ? AND d.path = ? AND d.active = 1
    `).get(collection, path) as { hash: string } | null : null;
    const docid = docidRow?.hash ? docidRow.hash.slice(0, 6) : undefined;

    // --full-path: resolve the on-disk path when it exists (else fall back).
    // Display as ./-prefixed relative path when under $PWD; absolute realpath
    // otherwise. See renderFullPath() for the policy.
    let fsPath: string | undefined;
    if (fullPath) {
      const resolved = resolveVirtualPath(db, file.filepath);
      if (resolved && existsSync(resolved)) fsPath = renderFullPath(resolved);
    }

    // Check size limit
    if (file.bodyLength > maxBytes) {
      results.push({
        file: file.filepath,
        displayPath: file.displayPath,
        fsPath,
        docid,
        title: file.displayPath.split('/').pop() || file.displayPath,
        body: "",
        context,
        skipped: true,
        skipReason: `File too large (${Math.round(file.bodyLength / 1024)}KB > ${Math.round(maxBytes / 1024)}KB). Use 'qmd get ${file.displayPath}' to retrieve.`,
      });
      continue;
    }

    // Fetch document content using collection and path
    if (!collection || !path) continue;

    const doc = db.prepare(`
      SELECT content.doc as body, d.title
      FROM documents d
      JOIN content ON content.hash = d.hash
      WHERE d.collection = ? AND d.path = ? AND d.active = 1
    `).get(collection, path) as { body: string; title: string } | null;

    if (!doc) continue;

    let body = doc.body;

    // Apply line limit if specified
    if (maxLines !== undefined) {
      const lines = body.split('\n');
      body = lines.slice(0, maxLines).join('\n');
      if (lines.length > maxLines) {
        body += `\n\n[... truncated ${lines.length - maxLines} more lines]`;
      }
    }

    // Line numbers on by default (disable with --no-line-numbers).
    if (lineNumbers) {
      body = addLineNumbers(body);
    }

    results.push({
      file: file.filepath,
      displayPath: file.displayPath,
      fsPath,
      docid,
      title: doc.title || file.displayPath.split('/').pop() || file.displayPath,
      body,
      context,
      skipped: false,
    });
  }

  closeDb();

  // --full-path replaces the qmd:// path + docid with the on-disk path (when it
  // resolved). Per result: pick the identifier and whether to show the docid.
  const identOf = (r: typeof results[number]): string => (fullPath && r.fsPath) ? r.fsPath : r.displayPath;
  const docidOf = (r: typeof results[number]): string | undefined => (fullPath && r.fsPath) ? undefined : r.docid;

  // Output based on format
  if (format === "json") {
    const output = results.map(r => {
      const docidVal = docidOf(r);
      return {
        file: identOf(r),
        ...(docidVal && { docid: `#${docidVal}` }),
        title: r.title,
        ...(r.context && { context: r.context }),
        ...(r.skipped ? { skipped: true, reason: r.skipReason } : { body: r.body }),
      };
    });
    console.log(JSON.stringify(output, null, 2));
  } else if (format === "csv") {
    const escapeField = (val: string | null | undefined): string => {
      if (val === null || val === undefined) return "";
      const str = String(val);
      if (str.includes(",") || str.includes('"') || str.includes("\n")) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    };
    console.log("docid,file,title,context,skipped,body");
    for (const r of results) {
      const docidVal = docidOf(r);
      console.log([docidVal ? `#${docidVal}` : "", identOf(r), r.title, r.context, r.skipped ? "true" : "false", r.skipped ? r.skipReason : r.body].map(escapeField).join(","));
    }
  } else if (format === "files") {
    for (const r of results) {
      const docidVal = docidOf(r);
      const id = docidVal ? `#${docidVal} ` : "";
      const ctx = r.context ? `,"${r.context.replace(/"/g, '""')}"` : "";
      const status = r.skipped ? "[SKIPPED]" : "";
      console.log(`${id}${identOf(r)}${ctx}${status ? `,${status}` : ""}`);
    }
  } else if (format === "md") {
    for (const r of results) {
      const docidVal = docidOf(r);
      console.log(`## ${identOf(r)}\n`);
      if (docidVal) console.log(`**docid:** \`#${docidVal}\`\n`);
      if (r.title && r.title !== r.displayPath) console.log(`**Title:** ${r.title}\n`);
      if (r.context) console.log(`**Context:** ${r.context}\n`);
      if (r.skipped) {
        console.log(`> ${r.skipReason}\n`);
      } else {
        console.log("```");
        console.log(r.body);
        console.log("```\n");
      }
    }
  } else if (format === "xml") {
    console.log('<?xml version="1.0" encoding="UTF-8"?>');
    console.log("<documents>");
    for (const r of results) {
      const docidVal = docidOf(r);
      const docidAttr = docidVal ? ` docid="#${docidVal}"` : "";
      console.log(`  <document${docidAttr}>`);
      console.log(`    <file>${escapeXml(identOf(r))}</file>`);
      console.log(`    <title>${escapeXml(r.title)}</title>`);
      if (r.context) console.log(`    <context>${escapeXml(r.context)}</context>`);
      if (r.skipped) {
        console.log(`    <skipped>true</skipped>`);
        console.log(`    <reason>${escapeXml(r.skipReason || "")}</reason>`);
      } else {
        console.log(`    <body>${escapeXml(r.body)}</body>`);
      }
      console.log("  </document>");
    }
    console.log("</documents>");
  } else {
    // CLI format (default)
    for (const r of results) {
      const docidVal = docidOf(r);
      const id = docidVal ? `  #${docidVal}` : "";
      console.log(`\n${'='.repeat(60)}`);
      console.log(`File: ${identOf(r)}${id}`);
      console.log(`${'='.repeat(60)}\n`);

      if (r.skipped) {
        console.log(`[SKIPPED: ${r.skipReason}]`);
        continue;
      }

      if (r.context) {
        console.log(`Folder Context: ${r.context}\n---\n`);
      }
      console.log(r.body);
    }
  }
}

// List files in virtual file tree
function listFiles(pathArg?: string): void {
  const db = getDb();

  if (!pathArg) {
    // No argument - list all collections
    const yamlCollections = yamlListCollections();

    if (yamlCollections.length === 0) {
      console.log("No collections found. Run 'qmd collection add .' to index files.");
      closeDb();
      return;
    }

    // Get file counts from database for each collection
    const collections = yamlCollections.map(coll => {
      const stats = db.prepare(`
        SELECT COUNT(*) as file_count
        FROM documents d
        WHERE d.collection = ? AND d.active = 1
      `).get(coll.name) as { file_count: number } | null;

      return {
        name: coll.name,
        file_count: stats?.file_count || 0
      };
    });

    console.log(`${c.bold}Collections:${c.reset}\n`);
    for (const coll of collections) {
      console.log(`  ${c.dim}qmd://${c.reset}${c.cyan}${coll.name}/${c.reset}  ${c.dim}(${coll.file_count} files)${c.reset}`);
    }
    closeDb();
    return;
  }

  // Parse the path argument
  let collectionName: string;
  let pathPrefix: string | null = null;

  const afterScheme = pathArg.startsWith('qmd://') ? pathArg.slice('qmd://'.length) : null;
  if (afterScheme !== null && afterScheme.startsWith('/')) {
    // Absolute-path collection: qmd:///Users/foo/bar — normalizeVirtualPath would corrupt
    // this by stripping all leading slashes, so bypass parseVirtualPath entirely.
    const normalized = afterScheme.replace(/\/$/, '');
    const allColls = yamlListCollections();
    const match = allColls
      .filter(c => normalized === c.name || normalized.startsWith(c.name + '/'))
      .sort((a, b) => b.name.length - a.name.length)[0];
    if (match) {
      collectionName = match.name;
      const rest = normalized.slice(match.name.length).replace(/^\//, '');
      pathPrefix = rest || null;
    } else {
      // Preserve the historical qmd:////collection/path alias behavior for normal
      // collections when no absolute-path collection matches.
      const parsed = parseVirtualPath(pathArg);
      if (!parsed) {
        console.error(`Invalid virtual path: ${pathArg}`);
        closeDb();
        process.exit(1);
      }
      collectionName = parsed.collectionName;
      pathPrefix = parsed.path;
    }
  } else if (afterScheme !== null) {
    // Normal virtual path: qmd://collection-name/path
    const parsed = parseVirtualPath(pathArg);
    if (!parsed) {
      console.error(`Invalid virtual path: ${pathArg}`);
      closeDb();
      process.exit(1);
    }
    collectionName = parsed.collectionName;
    pathPrefix = parsed.path;
  } else if (pathArg.startsWith('/')) {
    // Raw absolute filesystem path — longest-prefix match against collection names
    const normalized = pathArg.replace(/\/$/, '');
    const allColls = yamlListCollections();
    const match = allColls
      .filter(c => normalized === c.name || normalized.startsWith(c.name + '/'))
      .sort((a, b) => b.name.length - a.name.length)[0];
    if (match) {
      collectionName = match.name;
      const rest = normalized.slice(match.name.length).replace(/^\//, '');
      pathPrefix = rest || null;
    } else {
      collectionName = normalized;
    }
  } else {
    // Short collection name or name/path
    const parts = pathArg.split('/');
    collectionName = parts[0] || '';
    if (parts.length > 1) {
      pathPrefix = parts.slice(1).join('/');
    }
  }

  // Get the collection
  const coll = getCollectionFromYaml(collectionName);
  if (!coll) {
    console.error(`Collection not found: ${collectionName}`);
    console.error(`Run 'qmd ls' to see available collections.`);
    closeDb();
    process.exit(1);
  }

  // List files in the collection with size and modification time
  let query: string;
  let params: SQLiteValue[];

  if (pathPrefix) {
    // List files under a specific path
    query = `
      SELECT d.path, d.title, d.modified_at, LENGTH(ct.doc) as size
      FROM documents d
      JOIN content ct ON d.hash = ct.hash
      WHERE d.collection = ? AND d.path LIKE ? AND d.active = 1
      ORDER BY d.path
    `;
    params = [coll.name, `${pathPrefix}%`];
  } else {
    // List all files in the collection
    query = `
      SELECT d.path, d.title, d.modified_at, LENGTH(ct.doc) as size
      FROM documents d
      JOIN content ct ON d.hash = ct.hash
      WHERE d.collection = ? AND d.active = 1
      ORDER BY d.path
    `;
    params = [coll.name];
  }

  const files = db.prepare(query).all(...params) as { path: string; title: string; modified_at: string; size: number }[];

  if (files.length === 0) {
    if (pathPrefix) {
      console.log(`No files found under qmd://${collectionName}/${pathPrefix}`);
    } else {
      console.log(`No files found in collection: ${collectionName}`);
    }
    closeDb();
    return;
  }

  // Calculate max widths for alignment
  const maxSize = Math.max(...files.map(f => formatBytes(f.size).length));

  // Output in ls -l style
  for (const file of files) {
    const sizeStr = formatBytes(file.size).padStart(maxSize);
    const date = new Date(file.modified_at);
    const timeStr = formatLsTime(date);

    // Dim the qmd:// prefix, highlight the filename
    console.log(`${sizeStr}  ${timeStr}  ${c.dim}qmd://${collectionName}/${c.reset}${c.cyan}${file.path}${c.reset}`);
  }

  closeDb();
}

// Format date/time like ls -l
function formatLsTime(date: Date): string {
  const now = new Date();
  const sixMonthsAgo = new Date(now.getTime() - 6 * 30 * 24 * 60 * 60 * 1000);

  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const month = months[date.getMonth()];
  const day = date.getDate().toString().padStart(2, ' ');

  // If file is older than 6 months, show year instead of time
  if (date < sixMonthsAgo) {
    const year = date.getFullYear();
    return `${month} ${day}  ${year}`;
  } else {
    const hours = date.getHours().toString().padStart(2, '0');
    const minutes = date.getMinutes().toString().padStart(2, '0');
    return `${month} ${day} ${hours}:${minutes}`;
  }
}

// Collection management commands
function collectionList(): void {
  const db = getDb();
  const collections = listCollections(db);

  if (collections.length === 0) {
    console.log("No collections found. Run 'qmd collection add .' to create one.");
    closeDb();
    return;
  }

  console.log(`${c.bold}Collections (${collections.length}):${c.reset}\n`);

  for (const coll of collections) {
    const updatedAt = coll.last_modified ? new Date(coll.last_modified) : new Date();
    const timeAgo = formatTimeAgo(updatedAt);
    
    // Get YAML config to check includeByDefault
    const yamlColl = getCollectionFromYaml(coll.name);
    const excluded = yamlColl?.includeByDefault === false;
    const excludeTag = excluded ? ` ${c.yellow}[excluded]${c.reset}` : '';

    console.log(`${c.cyan}${coll.name}${c.reset} ${c.dim}(qmd://${coll.name}/)${c.reset}${excludeTag}`);
    console.log(`  ${c.dim}Pattern:${c.reset}  ${coll.glob_pattern}`);
    if (yamlColl?.ignore?.length) {
      console.log(`  ${c.dim}Ignore:${c.reset}   ${yamlColl.ignore.join(', ')}`);
    }
    console.log(`  ${c.dim}Files:${c.reset}    ${coll.active_count}`);
    console.log(`  ${c.dim}Updated:${c.reset}  ${timeAgo}`);
    console.log();
  }

  closeDb();
}

async function collectionAdd(pwd: string, globPattern: string, name?: string): Promise<void> {
  // If name not provided, generate from pwd basename
  let collName = name;
  if (!collName) {
    const parts = pwd.split('/').filter(Boolean);
    collName = parts[parts.length - 1] || 'root';
  }

  // Check if collection with this name already exists in YAML
  const existing = getCollectionFromYaml(collName);
  if (existing) {
    console.error(`${c.yellow}Collection '${collName}' already exists.${c.reset}`);
    console.error(`Use a different name with --name <name>`);
    process.exit(1);
  }

  // Check if a collection with this pwd+glob already exists in YAML
  const allCollections = yamlListCollections();
  const existingPwdGlob = allCollections.find(c => c.path === pwd && c.pattern === globPattern);

  if (existingPwdGlob) {
    console.error(`${c.yellow}A collection already exists for this path and pattern:${c.reset}`);
    console.error(`  Name: ${existingPwdGlob.name} (qmd://${existingPwdGlob.name}/)`);
    console.error(`  Pattern: ${globPattern}`);
    console.error(`\nUse 'qmd update' to re-index it, or remove it first with 'qmd collection remove ${existingPwdGlob.name}'`);
    process.exit(1);
  }

  // Add to YAML config + sync to SQLite
  const { addCollection } = await import("../collections.js");
  addCollection(collName, pwd, globPattern);
  resyncConfig();

  // Create the collection and index files
  console.log(`Creating collection '${collName}'...`);
  const newColl = getCollectionFromYaml(collName);
  await indexFiles(pwd, globPattern, collName, false, newColl?.ignore);
  console.log(`${c.green}✓${c.reset} Collection '${collName}' created successfully`);
}

function collectionRemove(name: string): void {
  // Check if collection exists in YAML
  const coll = getCollectionFromYaml(name);
  if (!coll) {
    console.error(`${c.yellow}Collection not found: ${name}${c.reset}`);
    console.error(`Run 'qmd collection list' to see available collections.`);
    process.exit(1);
  }

  const db = getDb();
  const result = removeCollection(db, name);
  // Also remove from YAML config
  yamlRemoveCollectionFn(name);
  closeDb();

  console.log(`${c.green}✓${c.reset} Removed collection '${name}'`);
  console.log(`  Deleted ${result.deletedDocs} documents`);
  if (result.cleanedHashes > 0) {
    console.log(`  Cleaned up ${result.cleanedHashes} orphaned content hashes`);
  }
}

function collectionRename(oldName: string, newName: string): void {
  // Check if old collection exists in YAML
  const coll = getCollectionFromYaml(oldName);
  if (!coll) {
    console.error(`${c.yellow}Collection not found: ${oldName}${c.reset}`);
    console.error(`Run 'qmd collection list' to see available collections.`);
    process.exit(1);
  }

  // Check if new name already exists in YAML
  const existing = getCollectionFromYaml(newName);
  if (existing) {
    console.error(`${c.yellow}Collection name already exists: ${newName}${c.reset}`);
    console.error(`Choose a different name or remove the existing collection first.`);
    process.exit(1);
  }

  const db = getDb();
  renameCollection(db, oldName, newName);
  // Also rename in YAML config
  yamlRenameCollectionFn(oldName, newName);
  closeDb();

  console.log(`${c.green}✓${c.reset} Renamed collection '${oldName}' to '${newName}'`);
  console.log(`  Virtual paths updated: ${c.cyan}qmd://${oldName}/${c.reset} → ${c.cyan}qmd://${newName}/${c.reset}`);
}

async function indexFiles(pwd?: string, globPattern: string = DEFAULT_GLOB, collectionName?: string, suppressEmbedNotice: boolean = false, ignorePatterns?: string[]): Promise<void> {
  const resolvedPwd = pwd || getPwd();
  const store = getStore();
  const db = store.db;

  // Clear Ollama cache on index
  clearCache(db);

  // Collection name must be provided (from YAML)
  if (!collectionName) {
    throw new Error("Collection name is required. Collections must be defined in ~/.config/qmd/index.yml");
  }

  console.log(`Collection: ${resolvedPwd} (${globPattern})`);

  progress.indeterminate();
  const startTime = Date.now();
  const result = await reindexCollection(store, resolvedPwd, globPattern, collectionName, {
    ignorePatterns,
    onProgress: (info) => {
      if (info.total > 0) {
        progress.set((info.current / info.total) * 100);
      }
      const elapsed = (Date.now() - startTime) / 1000;
      const rate = info.current > 0 && elapsed > 0 ? info.current / elapsed : 0;
      const remaining = rate > 0 ? (info.total - info.current) / rate : 0;
      const eta = info.current > 2 && rate > 0 ? ` ETA: ${formatETA(remaining)}` : "";
      if (isTTY) process.stderr.write(`\rIndexing: ${info.current}/${info.total}${eta}        `);
    },
  });

  // Check if vector index needs updating
  const needsEmbedding = getHashesNeedingEmbedding(db);

  progress.clear();
  console.log(`\nIndexed: ${result.indexed} new, ${result.updated} updated, ${result.unchanged} unchanged, ${result.removed} removed`);
  if (result.orphanedCleaned > 0) {
    console.log(`Cleaned up ${result.orphanedCleaned} orphaned content hash(es)`);
  }

  if (needsEmbedding > 0 && !suppressEmbedNotice) {
    console.log(`\nRun 'qmd embed' to update embeddings (${needsEmbedding} unique hashes need vectors)`);
  }

  closeDb();
}

function renderProgressBar(percent: number, width: number = 30): string {
  const filled = Math.round((percent / 100) * width);
  const empty = width - filled;
  const bar = "█".repeat(filled) + "░".repeat(empty);
  return bar;
}

function parseEmbedBatchOption(name: string, value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

async function vectorIndex(
  model: string = resolveEmbedModelForCli(),
  force: boolean = false,
  batchOptions?: { maxDocsPerBatch?: number; maxBatchBytes?: number; chunkStrategy?: ChunkStrategy; collection?: string },
): Promise<void> {
  const storeInstance = getStore();
  const db = storeInstance.db;

  if (force) {
    console.log(`${c.yellow}Force re-indexing: clearing all vectors...${c.reset}`);
  }

  // Check if there's work to do before starting
  const hashesToEmbed = getHashesNeedingEmbedding(db, batchOptions?.collection, model);
  if (hashesToEmbed === 0 && !force) {
    console.log(`${c.green}✓ All content hashes already have embeddings.${c.reset}`);
    closeDb();
    return;
  }

  console.log(`${c.dim}Model: ${shortModelName(model)}${c.reset}\n`);
  if (batchOptions?.maxDocsPerBatch !== undefined || batchOptions?.maxBatchBytes !== undefined) {
    const maxDocsPerBatch = batchOptions.maxDocsPerBatch ?? DEFAULT_EMBED_MAX_DOCS_PER_BATCH;
    const maxBatchBytes = batchOptions.maxBatchBytes ?? DEFAULT_EMBED_MAX_BATCH_BYTES;
    console.log(`${c.dim}Batch: ${maxDocsPerBatch} docs / ${formatBytes(maxBatchBytes)}${c.reset}\n`);
  }
  cursor.hide();
  progress.indeterminate();

  const startTime = Date.now();

  const result = await generateEmbeddings(storeInstance, {
    force,
    model,
    collection: batchOptions?.collection,
    maxDocsPerBatch: batchOptions?.maxDocsPerBatch,
    maxBatchBytes: batchOptions?.maxBatchBytes,
    chunkStrategy: batchOptions?.chunkStrategy,
    onProgress: (info) => {
      if (info.totalBytes === 0) return;
      // Progress is measured by input bytes, not by chunks. The final chunk
      // count is discovered lazily batch-by-batch, so displaying
      // chunksEmbedded/totalChunks makes the percent look wrong when a few
      // large documents remain. Show chunks as a count and label the byte
      // percentage explicitly as input progress.
      const percent = Math.min(100, (info.bytesProcessed / info.totalBytes) * 100);
      progress.set(percent);

      const elapsed = (Date.now() - startTime) / 1000;
      const bytesPerSec = elapsed > 0 ? info.bytesProcessed / elapsed : 0;
      const remainingBytes = Math.max(0, info.totalBytes - info.bytesProcessed);
      const etaSec = bytesPerSec > 0 ? remainingBytes / bytesPerSec : Number.POSITIVE_INFINITY;

      const bar = renderProgressBar(percent);
      const percentStr = percent.toFixed(0).padStart(3);
      const throughput = bytesPerSec > 0 ? `${formatBytes(bytesPerSec)}/s` : ".../s";
      const eta = elapsed > 2 && Number.isFinite(etaSec) ? formatETA(etaSec) : "...";
      const inputStr = `${formatBytes(info.bytesProcessed)}/${formatBytes(info.totalBytes)} input`;
      const chunkStr = `${formatCount(info.chunksEmbedded)} chunks`;
      const errStr = info.errors > 0 ? ` ${c.yellow}${formatCount(info.errors)} err${c.reset}` : "";

      if (isTTY) process.stderr.write(`\r${c.cyan}${bar}${c.reset} ${c.bold}${percentStr}% input${c.reset} ${c.dim}${chunkStr}${errStr} · ${inputStr} · ${throughput} · ETA ${eta}${c.reset}   `);
    },
  });

  progress.clear();
  cursor.show();

  const totalTimeSec = result.durationMs / 1000;

  if (result.chunksEmbedded === 0 && result.docsProcessed === 0) {
    console.log(`${c.green}✓ No non-empty documents to embed.${c.reset}`);
  } else {
    console.log(`\r${c.green}${renderProgressBar(100)}${c.reset} ${c.bold}100%${c.reset}                                    `);
    console.log(`\n${c.green}✓ Done!${c.reset} Embedded ${c.bold}${result.chunksEmbedded}${c.reset} chunks from ${c.bold}${result.docsProcessed}${c.reset} documents in ${c.bold}${formatETA(totalTimeSec)}${c.reset}`);
    if (result.errors > 0) {
      console.log(`${c.yellow}⚠ ${formatCount(result.errors)} chunks still failed after retries${c.reset}`);
      for (const failure of (result.failures ?? []).slice(0, 8)) {
        console.log(`  ${c.dim}${failure.path}#${failure.seq} (${failure.attempts} attempts): ${failure.reason}${c.reset}`);
      }
      if ((result.failures?.length ?? 0) > 8) {
        console.log(`  ${c.dim}...and ${formatCount((result.failures?.length ?? 0) - 8)} more${c.reset}`);
      }
    }
  }

  closeDb();
}


function search(query: string, opts: OutputOptions): void {
  const db = getDb();

  // Validate collection filter (supports multiple -c flags)
  // Use default collections if none specified
  const collectionNames = resolveCollectionFilter(opts.collection, true);
  const singleCollection = collectionNames.length === 1 ? collectionNames[0] : undefined;

  // Use large limit for --all, otherwise fetch more than needed and let outputResults filter
  const fetchLimit = opts.all ? 100000 : Math.max(50, opts.limit * 2);
  const results = filterByCollections(
    searchFTS(db, query, fetchLimit, singleCollection),
    collectionNames
  );

  // Add context to results
  const resultsWithContext = results.map(r => ({
    file: r.filepath,
    displayPath: r.displayPath,
    title: r.title,
    body: r.body || "",
    score: r.score,
    context: getContextForFile(db, r.filepath),
    hash: r.hash,
    docid: r.docid,
  }));

  closeDb();

  if (resultsWithContext.length === 0) {
    printEmptySearchResults(opts.format);
    return;
  }
  outputResults(resultsWithContext, query, opts);
}

async function vectorSearch(query: string, opts: OutputOptions, _model: string = DEFAULT_EMBED_MODEL): Promise<void> {
  const store = getStore();

  // Validate collection filter (supports multiple -c flags)
  // Use default collections if none specified
  const collectionNames = resolveCollectionFilter(opts.collection, true);
  const singleCollection = collectionNames.length === 1 ? collectionNames[0] : undefined;

  checkIndexHealth(store.db, resolveEmbedModelForCli());

  await withLLMSession(async () => {
    let results = await vectorSearchQuery(store, query, {
      collection: singleCollection,
      limit: opts.all ? 500 : (opts.limit || 10),
      minScore: opts.minScore || 0.3,
      intent: opts.intent,
      hooks: {
        onExpand: (original, expanded) => {
          logExpansionTree(original, expanded);
          process.stderr.write(`${c.dim}Searching ${expanded.length + 1} vector queries...${c.reset}\n`);
        },
      },
    });

    // Post-filter for multi-collection
    if (collectionNames.length > 1) {
      results = results.filter(r => {
        const prefixes = collectionNames.map(n => `qmd://${n}/`);
        return prefixes.some(p => r.file.startsWith(p));
      });
    }

    closeDb();

    if (results.length === 0) {
      printEmptySearchResults(opts.format);
      return;
    }

    outputResults(results.map(r => ({
      file: r.file,
      displayPath: r.displayPath,
      title: r.title,
      body: r.body,
      score: r.score,
      context: r.context,
      docid: r.docid,
    })), query, { ...opts, limit: results.length });
  }, { maxDuration: 10 * 60 * 1000, name: 'vectorSearch' });
}

async function querySearch(query: string, opts: OutputOptions, _embedModel: string = DEFAULT_EMBED_MODEL, _rerankModel: string = DEFAULT_RERANK_MODEL): Promise<void> {
  const store = getStore();

  // Validate collection filter (supports multiple -c flags)
  // Use default collections if none specified
  const collectionNames = resolveCollectionFilter(opts.collection, true);
  const singleCollection = collectionNames.length === 1 ? collectionNames[0] : undefined;

  checkIndexHealth(store.db, resolveEmbedModelForCli());

  // Check for structured query syntax (lex:/vec:/hyde:/intent: prefixes)
  const parsed = parseStructuredQuery(query);
  // Intent can come from --intent flag or from intent: line in query document
  const intent = opts.intent || parsed?.intent;

  await withLLMSession(async () => {
    let results;

    if (parsed) {
      const structuredQueries = parsed.searches;
      // Structured search — user provided their own query expansions
      const typeLabels = structuredQueries.map(s => s.type).join('+');
      process.stderr.write(`${c.dim}Structured search: ${structuredQueries.length} queries (${typeLabels})${c.reset}\n`);
      if (intent) {
        process.stderr.write(`${c.dim}├─ intent: ${intent}${c.reset}\n`);
      }

      // Log each sub-query
      for (const s of structuredQueries) {
        let preview = s.query.replace(/\n/g, ' ');
        if (preview.length > 72) preview = preview.substring(0, 69) + '...';
        process.stderr.write(`${c.dim}├─ ${s.type}: ${preview}${c.reset}\n`);
      }
      process.stderr.write(`${c.dim}└─ Searching...${c.reset}\n`);

      results = await structuredSearch(store, structuredQueries, {
        collections: singleCollection ? [singleCollection] : undefined,
        limit: opts.all ? 500 : (opts.limit || 10),
        minScore: opts.minScore || 0,
        candidateLimit: opts.candidateLimit,
        skipRerank: opts.skipRerank,
        explain: !!opts.explain,
        intent,
        chunkStrategy: opts.chunkStrategy,
        hooks: {
          onEmbedStart: (count) => {
            process.stderr.write(`${c.dim}Embedding ${count} ${count === 1 ? 'query' : 'queries'}...${c.reset}`);
          },
          onEmbedDone: (ms) => {
            process.stderr.write(`${c.dim} (${formatMs(ms)})${c.reset}\n`);
          },
          onRerankStart: (chunkCount) => {
            process.stderr.write(`${c.dim}Reranking ${chunkCount} chunks...${c.reset}`);
            progress.indeterminate();
          },
          onRerankDone: (ms) => {
            progress.clear();
            process.stderr.write(`${c.dim} (${formatMs(ms)})${c.reset}\n`);
          },
        },
      });
    } else {
      // Standard hybrid query with automatic expansion
      results = await hybridQuery(store, query, {
        collection: singleCollection,
        limit: opts.all ? 500 : (opts.limit || 10),
        minScore: opts.minScore || 0,
        candidateLimit: opts.candidateLimit,
        skipRerank: opts.skipRerank,
        explain: !!opts.explain,
        intent,
        chunkStrategy: opts.chunkStrategy,
        hooks: {
          onStrongSignal: (score) => {
            process.stderr.write(`${c.dim}Strong BM25 signal (${score.toFixed(2)}) — skipping expansion${c.reset}\n`);
          },
          onExpandStart: () => {
            process.stderr.write(`${c.dim}Expanding query...${c.reset}`);
          },
          onExpand: (original, expanded, ms) => {
            process.stderr.write(`${c.dim} (${formatMs(ms)})${c.reset}\n`);
            logExpansionTree(original, expanded);
            process.stderr.write(`${c.dim}Searching ${expanded.length + 1} queries...${c.reset}\n`);
          },
          onEmbedStart: (count) => {
            process.stderr.write(`${c.dim}Embedding ${count} ${count === 1 ? 'query' : 'queries'}...${c.reset}`);
          },
          onEmbedDone: (ms) => {
            process.stderr.write(`${c.dim} (${formatMs(ms)})${c.reset}\n`);
          },
          onRerankStart: (chunkCount) => {
            process.stderr.write(`${c.dim}Reranking ${chunkCount} chunks...${c.reset}`);
            progress.indeterminate();
          },
          onRerankDone: (ms) => {
            progress.clear();
            process.stderr.write(`${c.dim} (${formatMs(ms)})${c.reset}\n`);
          },
        },
      });
    }

    // Post-filter for multi-collection
    if (collectionNames.length > 1) {
      results = results.filter(r => {
        const prefixes = collectionNames.map(n => `qmd://${n}/`);
        return prefixes.some(p => r.file.startsWith(p));
      });
    }

    closeDb();

    if (results.length === 0) {
      printEmptySearchResults(opts.format);
      return;
    }

    // Use first lex/vec query for output context, or original query
    const structuredQueries = parsed?.searches;
    const displayQuery = structuredQueries
      ? (structuredQueries.find(s => s.type === 'lex')?.query || structuredQueries.find(s => s.type === 'vec')?.query || query)
      : query;

    outputResults(results.map(r => ({
      file: r.file,
      displayPath: r.displayPath,
      title: r.title,
      body: r.body,
      chunkPos: r.bestChunkPos,
      chunkLen: r.bestChunk.length,
      score: r.score,
      context: r.context,
      docid: r.docid,
      explain: r.explain,
    })), displayQuery, { ...opts, limit: results.length });
  }, { maxDuration: 10 * 60 * 1000, name: 'querySearch' });
}

function showHelp(): void {
  console.log("qmd — Quick Markdown Search");
  console.log("");
  console.log("Usage:");
  console.log("  qmd <command> [options]");
  console.log("");
  console.log("Primary commands:");
  console.log("  qmd query <query>             - Hybrid search with auto expansion + reranking (recommended)");
  console.log("  qmd query 'lex:..\\nvec:...'   - Structured query document (you provide lex/vec/hyde lines)");
  console.log("  qmd search <query>            - Full-text BM25 keywords (no LLM)");
  console.log("  qmd vsearch <query>           - Vector similarity only");
  console.log("  qmd get <file>[:from[:count]] - Show a document (line-numbered; #docid in header)");
  console.log("  qmd multi-get <pattern>       - Batch fetch via glob or comma-separated list");
  console.log("  qmd skills list/get/path      - List and retrieve bundled runtime skills");
  console.log("  qmd skill show/install        - Show or install the QMD skill");
  console.log("  qmd mcp                       - Start the MCP server (stdio transport for AI agents)");
  console.log("  qmd bench <fixture.json>      - Run search quality benchmarks against a fixture file");
  console.log("");
  console.log("Collections & context:");
  console.log("  qmd collection add/list/remove/rename/show   - Manage indexed folders");
  console.log("  qmd context add/list/rm                      - Attach human-written summaries");
  console.log("  qmd ls [collection[/path]]                   - Inspect indexed files");
  console.log("");
  console.log("Maintenance:");
  console.log("  qmd init                      - Create a project-local .qmd index");
  console.log("  qmd status                    - View index + collection health");
  console.log("  qmd update [--pull]           - Re-index collections (optionally git pull first)");
  console.log("  qmd embed [-f] [-c <name>]    - Generate/refresh vector embeddings");
  console.log("    --max-docs-per-batch <n>    - Cap docs loaded into memory per embedding batch");
  console.log("    --max-batch-mb <n>          - Cap UTF-8 MB loaded into memory per embedding batch");
  console.log("  qmd cleanup                   - Clear caches, vacuum DB");
  console.log("");
  console.log("Query syntax (qmd query):");
  console.log("  QMD queries are either a single expand query (no prefix) or a multi-line");
  console.log("  document where every line is typed with lex:, vec:, or hyde:. This grammar");
  console.log("  matches the docs in docs/SYNTAX.md and is enforced in the CLI.");
  console.log("");
  const grammar = [
    `query          = expand_query | query_document ;`,
    `expand_query   = text | explicit_expand ;`,
    `explicit_expand= "expand:" text ;`,
    `query_document = [ intent_line ] { typed_line } ;`,
    `intent_line    = "intent:" text newline ;`,
    `typed_line     = type ":" text newline ;`,
    `type           = "lex" | "vec" | "hyde" ;`,
    `text           = quoted_phrase | plain_text ;`,
    `quoted_phrase  = '"' { character } '"' ;`,
    `plain_text     = { character } ;`,
    `newline        = "\\n" ;`,
  ];
  console.log("  Grammar:");
  for (const line of grammar) {
    console.log(`    ${line}`);
  }
  console.log("");
  console.log("  Examples:");
  console.log("    qmd query \"how does auth work\"                # single-line → implicit expand");
  console.log("    qmd query $'lex: CAP theorem\\nvec: consistency'  # typed query document");
  console.log("    qmd query $'lex: \"exact matches\" sports -baseball'  # phrase + negation lex search");
  console.log("    qmd query $'hyde: Hypothetical answer text'       # hyde-only document");
  console.log("");
  console.log("  Constraints:");
  console.log("    - Standalone expand queries cannot mix with typed lines.");
  console.log("    - Query documents allow only lex:, vec:, or hyde: prefixes.");
  console.log("    - Each typed line must be single-line text with balanced quotes.");
  console.log("");
  console.log("AI agents & integrations:");
  console.log("  - Run `qmd mcp` to expose the MCP server (stdio) to agents/IDEs.");
  console.log("  - Run `qmd skills get qmd --full` for version-matched agent instructions.");
  console.log("  - `qmd skill install` installs the QMD skill into ./.agents/skills/qmd.");
  console.log("  - Use `qmd skill install --global` for ~/.agents/skills/qmd.");
  console.log("  - `qmd --skill` is kept as an alias for `qmd skill show`.");
  console.log("  - Advanced: `qmd mcp --http ...` and `qmd mcp --http --daemon` are optional for custom transports.");
  console.log("");
  console.log("Global options:");
  console.log("  --index <name>             - Use a named index (default: index)");
  console.log("  QMD_EDITOR_URI             - Editor link template for clickable TTY search output");
  console.log("");
  console.log("Search options:");
  console.log("  -n <num>                   - Max results (default 5, or 20 for --format files|json)");
  console.log("  --all                      - Return all matches (pair with --min-score)");
  console.log("  --min-score <num>          - Minimum similarity score");
  console.log("  --full                     - Output full document instead of snippet");
  console.log("  -C, --candidate-limit <n>  - Max candidates to rerank (default 40, lower = faster)");
  console.log("  --no-rerank                - Skip LLM reranking (use RRF scores only, much faster on CPU)");
  console.log("  --no-gpu                   - Force CPU mode for llama.cpp operations (same as QMD_FORCE_CPU=1)");
  console.log("  --line-numbers             - Include line numbers (search; get/multi-get are on by default)");
  console.log("  --no-line-numbers          - Disable line numbers for get/multi-get");
  console.log("  --full-path                - Show on-disk paths instead of qmd:// + docid (get/multi-get/search/query)");
  console.log("                                Paths are ./-prefixed when under $PWD, absolute otherwise");
  console.log("  --explain                  - Include retrieval score traces (query, CLI/--format json)");
  console.log("  --format <kind>            - Output format: cli (default) | json | csv | md | xml | files");
  console.log("  -c, --collection <name>    - Filter by one or more collections");
  console.log("");
  console.log("Embed/query options:");
  console.log("  --chunk-strategy <auto|regex> - Chunking mode (default: regex; auto uses AST for code files)");
  console.log("");
  console.log("Multi-get options:");
  console.log("  -l <num>                   - Maximum lines per file");
  console.log("  --max-bytes <num>          - Skip files larger than N bytes (default 10240)");
  console.log("  --format <kind>            - Same formats as search");
  console.log("");
  console.log(`Index: ${getDbPath()}`);
}





function printDoctorHint(): void {
  console.error("If qmd still behaves unexpectedly, run 'qmd doctor' for diagnostics.");
}

function exitWithError(error: unknown, code = 1): never {
  console.error(error instanceof Error ? error.message : String(error));
  printDoctorHint();
  process.exit(code);
}

type PackageJson = {
  version: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

function readPackageJson(): PackageJson {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const pkgPath = resolve(scriptDir, "..", "..", "package.json");
  return JSON.parse(readFileSync(pkgPath, "utf-8"));
}

async function showVersion(): Promise<void> {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const pkg = readPackageJson();

  let commit = "";
  try {
    commit = execSync(`git -C ${scriptDir} rev-parse --short HEAD`, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch {
    // Not a git repo or git not available
  }

  const versionStr = commit ? `${pkg.version} (${commit})` : pkg.version;
  console.log(`qmd ${versionStr}`);
}

// Main CLI - only run if this is the main module
const __filename = fileURLToPath(import.meta.url);
const argv1 = process.argv[1];
const isMain = argv1 === __filename
  || argv1?.endsWith("/qmd.ts")
  || argv1?.endsWith("/qmd.js")
  || (argv1 != null && realpathSync(argv1) === __filename);
if (isMain) {
  // Flip to production mode only when this module is executed as the CLI
  // entrypoint, not when imported for its exports. Tests must set INDEX_PATH
  // or use createStore() with an explicit path.
  enableProductionMode();

  const cli = parseCLI({
    setIndexName,
    setConfigIndexName,
    setConfigSource,
    findLocalConfigPath,
    getLocalDbPath,
    setStoreDbPathOverride,
    closeDb,
  });

  if (cli.values.version) {
    await showVersion();
    process.exit(0);
  }

  if (cli.values.skill) {
    showSkill();
    process.exit(0);
  }

  if (cli.values.help && cli.command === "skill") {
    console.log("Usage: qmd skill <show|install> [options]");
    console.log("");
    console.log("Commands:");
    console.log("  show                 Print the QMD skill");
    console.log("  install              Install QMD skill into ./.agents/skills/qmd");
    console.log("");
    console.log("Options:");
    console.log("  --global             Install into ~/.agents/skills/qmd");
    console.log("  --yes                Also create the .claude/skills/qmd symlink");
    console.log("  -f, --force          Replace existing install or symlink");
    process.exit(0);
  }

  if (!cli.command || cli.values.help) {
    showHelp();
    process.exit(cli.values.help ? 0 : 1);
  }

  switch (cli.command) {
    case "context": {
      const subcommand = cli.args[0];
      if (!subcommand) {
        console.error("Usage: qmd context <add|list|rm>");
        console.error("");
        console.error("Commands:");
        console.error("  qmd context add [path] \"text\"  - Add context (defaults to current dir)");
        console.error("  qmd context add / \"text\"       - Add global context to all collections");
        console.error("  qmd context list                - List all contexts");
        console.error("  qmd context rm <path>           - Remove context");
        process.exit(1);
      }

      switch (subcommand) {
        case "add": {
          if (cli.args.length < 2) {
            console.error("Usage: qmd context add [path] \"text\"");
            console.error("");
            console.error("Examples:");
            console.error("  qmd context add \"Context for current directory\"");
            console.error("  qmd context add . \"Context for current directory\"");
            console.error("  qmd context add /subfolder \"Context for subfolder\"");
            console.error("  qmd context add / \"Global context for all collections\"");
            console.error("");
            console.error("  Using virtual paths:");
            console.error("  qmd context add qmd://journals/ \"Context for entire journals collection\"");
            console.error("  qmd context add qmd://journals/2024 \"Context for 2024 journals\"");
            process.exit(1);
          }

          let pathArg: string | undefined;
          let contextText: string;

          // Check if first arg looks like a path or if it's the context text
          const firstArg = cli.args[1] || '';
          const secondArg = cli.args[2];

          if (secondArg) {
            // Two args: path + context
            pathArg = firstArg;
            contextText = cli.args.slice(2).join(" ");
          } else {
            // One arg: context only (use current directory)
            pathArg = undefined;
            contextText = firstArg;
          }

          await contextAdd(pathArg, contextText);
          break;
        }

        case "list": {
          contextList();
          break;
        }

        case "rm":
        case "remove": {
          if (cli.args.length < 2 || !cli.args[1]) {
            console.error("Usage: qmd context rm <path>");
            console.error("Examples:");
            console.error("  qmd context rm /");
            console.error("  qmd context rm qmd://journals/2024");
            process.exit(1);
          }
          contextRemove(cli.args[1]);
          break;
        }

        default:
          console.error(`Unknown subcommand: ${subcommand}`);
          console.error("Available: add, list, rm");
          process.exit(1);
      }
      break;
    }

    case "get": {
      if (!cli.args[0]) {
        console.error("Usage: qmd get <filepath>[:from[:count]] [--from <line>] [-l <lines>] [--no-line-numbers] [--full-path]");
        process.exit(1);
      }
      const fromLine = cli.values.from ? parseInt(cli.values.from as string, 10) : undefined;
      const maxLines = cli.values.l ? parseInt(cli.values.l as string, 10) : undefined;
      // Line numbers default ON for get; opt out with --no-line-numbers.
      const getLineNumbers = !cli.values["no-line-numbers"];
      getDocument(cli.args[0], fromLine, maxLines, getLineNumbers, !!cli.values["full-path"]);
      break;
    }

    case "multi-get": {
      if (!cli.args[0]) {
        console.error("Usage: qmd multi-get <pattern> [-l <lines>] [--max-bytes <bytes>] [--no-line-numbers] [--full-path] [--format json|csv|md|xml|files]");
        console.error("  pattern: glob (e.g., 'journals/2025-05*.md') or comma-separated list");
        process.exit(1);
      }
      const maxLinesMulti = cli.values.l ? parseInt(cli.values.l as string, 10) : undefined;
      const maxBytes = cli.values["max-bytes"] ? parseInt(cli.values["max-bytes"] as string, 10) : DEFAULT_MULTI_GET_MAX_BYTES;
      // Line numbers default ON for multi-get; opt out with --no-line-numbers.
      const mgLineNumbers = !cli.values["no-line-numbers"];
      multiGet(cli.args[0], maxLinesMulti, maxBytes, cli.opts.format, mgLineNumbers, !!cli.values["full-path"]);
      break;
    }

    case "ls": {
      listFiles(cli.args[0]);
      break;
    }

    case "collection": {
      const subcommand = cli.args[0];
      switch (subcommand) {
        case "list": {
          collectionList();
          break;
        }

        case "add": {
          const pwd = cli.args[1] || getPwd();
          const resolvedPwd = pwd === '.' ? getPwd() : getRealPath(resolve(pwd));
          const globPattern = cli.values.mask as string || DEFAULT_GLOB;
          const name = cli.values.name as string | undefined;

          await collectionAdd(resolvedPwd, globPattern, name);
          break;
        }

        case "remove":
        case "rm": {
          if (!cli.args[1]) {
            console.error("Usage: qmd collection remove <name>");
            console.error("  Use 'qmd collection list' to see available collections");
            process.exit(1);
          }
          collectionRemove(cli.args[1]);
          break;
        }

        case "rename":
        case "mv": {
          if (!cli.args[1] || !cli.args[2]) {
            console.error("Usage: qmd collection rename <old-name> <new-name>");
            console.error("  Use 'qmd collection list' to see available collections");
            process.exit(1);
          }
          collectionRename(cli.args[1], cli.args[2]);
          break;
        }

        case "set-update":
        case "update-cmd": {
          const name = cli.args[1];
          const cmd = cli.args.slice(2).join(' ') || null;
          if (!name) {
            console.error("Usage: qmd collection update-cmd <name> [command]");
            console.error("  Set the command to run before indexing (e.g., 'git pull')");
            console.error("  Omit command to clear it");
            process.exit(1);
          }
          const { updateCollectionSettings, getCollection } = await import("../collections.js");
          const col = getCollection(name);
          if (!col) {
            console.error(`Collection not found: ${name}`);
            process.exit(1);
          }
          updateCollectionSettings(name, { update: cmd });
          if (cmd) {
            console.log(`✓ Set update command for '${name}': ${cmd}`);
          } else {
            console.log(`✓ Cleared update command for '${name}'`);
          }
          break;
        }

        case "include":
        case "exclude": {
          const name = cli.args[1];
          if (!name) {
            console.error(`Usage: qmd collection ${subcommand} <name>`);
            console.error(`  ${subcommand === 'include' ? 'Include' : 'Exclude'} collection in default queries`);
            process.exit(1);
          }
          const { updateCollectionSettings, getCollection } = await import("../collections.js");
          const col = getCollection(name);
          if (!col) {
            console.error(`Collection not found: ${name}`);
            process.exit(1);
          }
          const include = subcommand === 'include';
          updateCollectionSettings(name, { includeByDefault: include });
          console.log(`✓ Collection '${name}' ${include ? 'included in' : 'excluded from'} default queries`);
          break;
        }

        case "show":
        case "info": {
          const name = cli.args[1];
          if (!name) {
            console.error("Usage: qmd collection show <name>");
            process.exit(1);
          }
          const { getCollection } = await import("../collections.js");
          const col = getCollection(name);
          if (!col) {
            console.error(`Collection not found: ${name}`);
            process.exit(1);
          }
          console.log(`Collection: ${name}`);
          console.log(`  Path:     ${col.path}`);
          console.log(`  Pattern:  ${col.pattern}`);
          console.log(`  Include:  ${col.includeByDefault !== false ? 'yes (default)' : 'no'}`);
          if (col.update) {
            console.log(`  Update:   ${col.update}`);
          }
          if (col.context) {
            const ctxCount = Object.keys(col.context).length;
            console.log(`  Contexts: ${ctxCount}`);
          }
          break;
        }

        case "help":
        case undefined: {
          console.log("Usage: qmd collection <command> [options]");
          console.log("");
          console.log("Commands:");
          console.log("  list                      List all collections");
          console.log("  add <path> [--name NAME]  Add a collection");
          console.log("  remove <name>             Remove a collection");
          console.log("  rename <old> <new>        Rename a collection");
          console.log("  show <name>               Show collection details");
          console.log("  update-cmd <name> [cmd]   Set pre-update command (e.g., 'git pull')");
          console.log("  include <name>            Include in default queries");
          console.log("  exclude <name>            Exclude from default queries");
          console.log("");
          console.log("Examples:");
          console.log("  qmd collection add ~/notes --name notes");
          console.log("  qmd collection update-cmd brain 'git pull'");
          console.log("  qmd collection exclude archive");
          process.exit(0);
        }

        default:
          console.error(`Unknown subcommand: ${subcommand}`);
          console.error("Run 'qmd collection help' for usage");
          printDoctorHint();
          process.exit(1);
      }
      break;
    }

    case "init":
      try {
        initLocalIndex();
      } catch (error) {
        exitWithError(error);
      }
      break;

    case "status":
      await showStatus();
      break;

    case "doctor": {
      const db = getDb();
      const store = getStore();
      const activeModels = resolveModelsForCli();
      await runDoctor(db, store, activeModels, getDbPath());
      closeDb();
      break;
    }

    case "update":
      await updateCollections();
      break;

    case "embed":
      try {
        const maxDocsPerBatch = parseEmbedBatchOption("maxDocsPerBatch", cli.values["max-docs-per-batch"]);
        const maxBatchMb = parseEmbedBatchOption("maxBatchBytes", cli.values["max-batch-mb"]);
        const embedChunkStrategy = parseChunkStrategy(cli.values["chunk-strategy"]);
        // Validate -c against configured collections before dispatching, so a
        // typo errors with "Collection not found: X" instead of silently
        // reporting success because no pending docs match a nonexistent name.
        // embed operates on a single collection; only the first value is used.
        const embedValidatedCollections = resolveCollectionFilter(cli.opts.collection, false);
        const embedCollection = embedValidatedCollections[0];
        await vectorIndex(resolveEmbedModelForCli(), !!cli.values.force, {
          maxDocsPerBatch,
          maxBatchBytes: maxBatchMb === undefined ? undefined : maxBatchMb * 1024 * 1024,
          chunkStrategy: embedChunkStrategy,
          collection: embedCollection,
        });
      } catch (error) {
        exitWithError(error);
      }
      break;

    case "pull": {
      const refresh = cli.values.refresh === undefined ? false : Boolean(cli.values.refresh);
      const activeModels = resolveModelsForCli();
      const models = [
        activeModels.embed,
        activeModels.generate,
        activeModels.rerank,
      ];
      console.log(`${c.bold}Pulling models${c.reset}`);
      const results = await pullModels(models, {
        refresh,
        cacheDir: DEFAULT_MODEL_CACHE_DIR,
      });
      for (const result of results) {
        const size = formatBytes(result.sizeBytes);
        const note = result.refreshed ? "refreshed" : "cached/checked";
        console.log(`- ${result.model} -> ${result.path} (${size}, ${note})`);
      }
      break;
    }

    case "search":
      if (!cli.query) {
        console.error("Usage: qmd search [options] <query>");
        process.exit(1);
      }
      search(cli.query, cli.opts);
      break;

    case "vsearch":
    case "vector-search": // undocumented alias
      if (!cli.query) {
        console.error("Usage: qmd vsearch [options] <query>");
        process.exit(1);
      }
      // Default min-score for vector search is 0.3
      if (!cli.values["min-score"]) {
        cli.opts.minScore = 0.3;
      }
      await vectorSearch(cli.query, cli.opts);
      break;

    case "query":
    case "deep-search": // undocumented alias
      if (!cli.query) {
        console.error("Usage: qmd query [options] <query>");
        process.exit(1);
      }
      await querySearch(cli.query, cli.opts);
      break;

    case "bench": {
      const fixturePath = cli.args[0];
      if (!fixturePath) {
        console.error("Usage: qmd bench <fixture.json> [--json] [-c collection]");
        console.error("");
        console.error("Run search quality benchmarks against a fixture file.");
        console.error("See src/bench/fixtures/example.json for the fixture format.");
        process.exit(1);
      }
      const { runBenchmark } = await import("../bench/bench.js");
      const benchCollection = cli.opts.collection;
      await runBenchmark(fixturePath, {
        json: !!cli.values.json,
        collection: Array.isArray(benchCollection) ? benchCollection[0] : benchCollection,
        dbPath: getDbPath(),
        configPath: configExists() ? getConfigPath() : undefined,
      });
      break;
    }

    case "mcp": {
      const sub = cli.args[0]; // stop | status | undefined

      // Cache dir for PID/log files — same dir as the index
      const cacheDir = process.env.XDG_CACHE_HOME
        ? resolve(process.env.XDG_CACHE_HOME, "qmd")
        : resolve(homedir(), ".cache", "qmd");
      const pidPath = resolve(cacheDir, "mcp.pid");

      // Subcommands take priority over flags
      if (sub === "stop") {
        if (!existsSync(pidPath)) {
          console.log("Not running (no PID file).");
          process.exit(0);
        }
        const pid = parseInt(readFileSync(pidPath, "utf-8").trim());
        try {
          process.kill(pid, 0); // alive?
          process.kill(pid, "SIGTERM");
          unlinkSync(pidPath);
          console.log(`Stopped QMD MCP server (PID ${pid}).`);
        } catch {
          unlinkSync(pidPath);
          console.log("Cleaned up stale PID file (server was not running).");
        }
        process.exit(0);
      }

      if (cli.values.http) {
        const port = Number(cli.values.port) || 8181;

        if (cli.values.daemon) {
          // Guard: check if already running
          if (existsSync(pidPath)) {
            const existingPid = parseInt(readFileSync(pidPath, "utf-8").trim());
            try {
              process.kill(existingPid, 0); // alive?
              console.error(`Already running (PID ${existingPid}). Run 'qmd mcp stop' first.`);
              process.exit(1);
            } catch {
              // Stale PID file — continue
            }
          }

          mkdirSync(cacheDir, { recursive: true });
          const logPath = resolve(cacheDir, "mcp.log");
          const logFd = openSync(logPath, "w"); // truncate — fresh log per daemon run
          const selfPath = fileURLToPath(import.meta.url);
          const indexArgs = cli.values.index ? ["--index", String(cli.values.index)] : [];
          const spawnArgs = selfPath.endsWith(".ts")
            ? ["--import", pathJoin(dirname(selfPath), "..", "..", "node_modules", "tsx", "dist", "esm", "index.mjs"), selfPath, ...indexArgs, "mcp", "--http", "--port", String(port)]
            : [selfPath, ...indexArgs, "mcp", "--http", "--port", String(port)];
          const child = nodeSpawn(process.execPath, spawnArgs, {
            stdio: ["ignore", logFd, logFd],
            detached: true,
          });
          child.unref();
          closeSync(logFd); // parent's copy; child inherited the fd

          writeFileSync(pidPath, String(child.pid));
          console.log(`Started on http://localhost:${port}/mcp (PID ${child.pid})`);
          console.log(`Logs: ${logPath}`);
          process.exit(0);
        }

        // Foreground HTTP mode — remove top-level cursor handlers so the
        // async cleanup handlers in startMcpHttpServer actually run.
        process.removeAllListeners("SIGTERM");
        process.removeAllListeners("SIGINT");
        const { startMcpHttpServer } = await import("../mcp/server.js");
        try {
          await startMcpHttpServer(port, { dbPath: getDbPath() });
        } catch (e: unknown) {
          if (typeof e === "object" && e !== null && "code" in e && e.code === "EADDRINUSE") {
            console.error(`Port ${port} already in use. Try a different port with --port.`);
            process.exit(1);
          }
          throw e;
        }
      } else {
        // Default: stdio transport
        const { startMcpServer } = await import("../mcp/server.js");
        await startMcpServer({ dbPath: getDbPath() });
      }
      break;
    }

    case "skills": {
      try {
        if (cli.values.help || cli.args[0] === "help") {
          showSkillsHelp();
        } else {
          runSkillsCommand(cli.args, Boolean(cli.values.json), Boolean(cli.values.full), Boolean(cli.values.all));
        }
      } catch (error) {
        if (cli.values.json) {
          outputSkillsJson({ success: false, error: error instanceof Error ? error.message : String(error) });
        } else {
          console.error(error instanceof Error ? error.message : String(error));
        }
        process.exit(1);
      }
      break;
    }

    case "skill": {
      const subcommand = cli.args[0];
      switch (subcommand) {
        case "show": {
          showSkill();
          break;
        }

        case "install": {
          try {
            await installSkill(Boolean(cli.values.global), Boolean(cli.values.force), Boolean(cli.values.yes));
          } catch (error) {
            exitWithError(error);
          }
          break;
        }

        case "help":
        case undefined: {
          console.log("Usage: qmd skill <show|install> [options]");
          console.log("");
          console.log("Commands:");
          console.log("  show                 Print the QMD skill");
          console.log("  install              Install QMD skill into ./.agents/skills/qmd");
          console.log("");
          console.log("Options:");
          console.log("  --global             Install into ~/.agents/skills/qmd");
          console.log("  --yes                Also create the .claude/skills/qmd symlink");
          console.log("  -f, --force          Replace existing install or symlink");
          process.exit(0);
        }

        default:
          console.error(`Unknown subcommand: ${subcommand}`);
          console.error("Run 'qmd skill help' for usage");
          printDoctorHint();
          process.exit(1);
      }
      break;
    }

    case "cleanup": {
      const db = getDb();

      // 1. Clear llm_cache
      const cacheCount = deleteLLMCache(db);
      console.log(`${c.green}✓${c.reset} Cleared ${cacheCount} cached API responses`);

      // 2. Remove orphaned vectors
      const orphanedVecs = cleanupOrphanedVectors(db);
      if (orphanedVecs > 0) {
        console.log(`${c.green}✓${c.reset} Removed ${orphanedVecs} orphaned embedding chunks`);
      } else {
        console.log(`${c.dim}No orphaned embeddings to remove${c.reset}`);
      }

      // 3. Remove inactive documents
      const inactiveDocs = deleteInactiveDocuments(db);
      if (inactiveDocs > 0) {
        console.log(`${c.green}✓${c.reset} Removed ${inactiveDocs} inactive document records`);
      }

      // 4. Vacuum to reclaim space
      vacuumDatabase(db);
      console.log(`${c.green}✓${c.reset} Database vacuumed`);

      closeDb();
      break;
    }

    default:
      console.error(`Unknown command: ${cli.command}`);
      console.error("Run 'qmd --help' for usage.");
      printDoctorHint();
      process.exit(1);
  }

  if (cli.command !== "mcp") {
    await finishSuccessfulCliCommand({
      command: cli.command,
      format: cli.opts.format,
    });
  }

} // end if (main module)
