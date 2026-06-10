/**
 * Test helper — Store creation with temp YAML config for store tests.
 *
 * Extracted from test/store.test.ts. All helpers accept explicit parameters
 * instead of closing over module-level mutable state, so each split test file
 * can manage its own Store lifecycle independently.
 */
import { openDatabase } from "../../src/db.js";
import type { Database } from "../../src/db.js";
import { unlink, mkdtemp, rmdir, writeFile, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import {
  createStore,
  hashContent,
  insertContent,
  insertDocument,
  syncConfigToDb,
  type Store,
} from "../../src/store.js";
import type { CollectionConfig } from "../../src/collections.js";

export async function setupTestDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "qmd-test-"));
}

export async function teardownTestDir(dir: string): Promise<void> {
  try {
    const files = await readdir(dir);
    for (const file of files) {
      await unlink(join(dir, file));
    }
    await rmdir(dir);
  } catch {
    // ignore cleanup errors
  }
}

export async function createTestStore(testDir: string): Promise<{ store: Store; configDir: string }> {
  const dbPath = join(testDir, `test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  const configDir = await mkdtemp(join(testDir, `config-${Date.now()}-${Math.random().toString(36).slice(2)}`));
  process.env.QMD_CONFIG_DIR = configDir;
  const emptyConfig: CollectionConfig = { collections: {} };
  await writeFile(join(configDir, "index.yml"), YAML.stringify(emptyConfig));
  const store = createStore(dbPath);
  return { store, configDir };
}

export async function cleanupTestStore(store: Store, configDir?: string): Promise<void> {
  store.close();
  try { await unlink(store.dbPath); } catch { /* ignore */ }
  if (configDir) {
    try {
      const files = await readdir(configDir);
      for (const file of files) await unlink(join(configDir, file));
      await rmdir(configDir);
    } catch { /* ignore */ }
  }
  delete process.env.QMD_CONFIG_DIR;
}

export async function insertTestDocument(
  db: Database,
  collectionName: string,
  opts: {
    name?: string; title?: string; hash?: string;
    displayPath?: string; filepath?: string;
    body?: string; active?: number;
  }
): Promise<number> {
  const now = new Date().toISOString();
  const title = opts.title || "Test Document";
  let path: string;
  if (opts.displayPath) { path = opts.displayPath; }
  else if (opts.filepath) { path = opts.filepath.startsWith('/') ? opts.filepath : opts.filepath; }
  else { path = `test/${opts.name || "test-doc"}.md`; }
  const body = opts.body || "# Test Document\n\nThis is test content.";
  const hash = opts.hash || await hashContent(body);
  insertContent(db, hash, body, now);
  insertDocument(db, collectionName, path, title, hash, now, now);
  const row = db.prepare(`SELECT id FROM documents WHERE collection = ? AND path = ?`).get(collectionName, path) as { id: number } | undefined;
  if (opts.active === 0 && row) { db.prepare(`UPDATE documents SET active = 0 WHERE id = ?`).run(row.id); }
  return row?.id ?? 0;
}

export async function syncTestConfig(store: Store, configDir: string): Promise<void> {
  const configPath = join(configDir, "index.yml");
  const content = await readFile(configPath, "utf-8");
  const config = YAML.parse(content) as CollectionConfig;
  store.db.prepare(`DELETE FROM store_config WHERE key = 'config_hash'`).run();
  syncConfigToDb(store.db, config);
}

export async function createTestCollection(
  store: Store,
  configDir: string,
  options: { pwd?: string; glob?: string; name?: string } = {}
): Promise<string> {
  const pwd = options.pwd || "/test/collection";
  const glob = options.glob || "**/*.md";
  const name = options.name || pwd.split('/').filter(Boolean).pop() || 'test';
  const configPath = join(configDir, "index.yml");
  const content = await readFile(configPath, "utf-8");
  const config = YAML.parse(content) as CollectionConfig;
  config.collections[name] = { path: pwd, pattern: glob };
  await writeFile(configPath, YAML.stringify(config));
  await syncTestConfig(store, configDir);
  return name;
}

export async function addPathContext(
  store: Store,
  configDir: string,
  collectionName: string,
  pathPrefix: string,
  contextText: string
): Promise<void> {
  const configPath = join(configDir, "index.yml");
  const content = await readFile(configPath, "utf-8");
  const config = YAML.parse(content) as CollectionConfig;
  if (!config.collections[collectionName]) throw new Error(`Collection ${collectionName} not found`);
  if (!config.collections[collectionName].context) config.collections[collectionName].context = {};
  config.collections[collectionName].context![pathPrefix] = contextText;
  await writeFile(configPath, YAML.stringify(config));
  await syncTestConfig(store, configDir);
}

export async function addGlobalContext(store: Store, configDir: string, contextText: string): Promise<void> {
  const configPath = join(configDir, "index.yml");
  const content = await readFile(configPath, "utf-8");
  const config = YAML.parse(content) as CollectionConfig;
  config.global_context = contextText;
  await writeFile(configPath, YAML.stringify(config));
  await syncTestConfig(store, configDir);
}
