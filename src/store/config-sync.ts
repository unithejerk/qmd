import { createHash } from "crypto";
import type { Database } from "../db.js";
import type {
  NamedCollection,
  Collection,
  CollectionConfig,
  ContextMap,
} from "../collections.js";

type StoreCollectionRow = {
  name: string;
  path: string;
  pattern: string;
  ignore_patterns: string | null;
  include_by_default: number;
  update_command: string | null;
  context: string | null;
};

function rowToNamedCollection(row: StoreCollectionRow): NamedCollection {
  return {
    name: row.name,
    path: row.path,
    pattern: row.pattern,
    ...(row.ignore_patterns ? { ignore: JSON.parse(row.ignore_patterns) as string[] } : {}),
    ...(row.include_by_default === 0 ? { includeByDefault: false } : {}),
    ...(row.update_command ? { update: row.update_command } : {}),
    ...(row.context ? { context: JSON.parse(row.context) as ContextMap } : {}),
  };
}

export function buildInheritedContext(
  collection: NamedCollection | null,
  globalContext: string | undefined,
  path: string,
): string | null {
  const contexts: string[] = [];

  if (globalContext) {
    contexts.push(globalContext);
  }

  if (collection?.context) {
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    const matchingContexts: { prefix: string; context: string }[] = [];

    for (const [prefix, context] of Object.entries(collection.context)) {
      const normalizedPrefix = prefix.startsWith("/") ? prefix : `/${prefix}`;
      if (normalizedPath.startsWith(normalizedPrefix)) {
        matchingContexts.push({ prefix: normalizedPrefix, context });
      }
    }

    matchingContexts.sort((a, b) => a.prefix.length - b.prefix.length);
    for (const match of matchingContexts) {
      contexts.push(match.context);
    }
  }

  return contexts.length > 0 ? contexts.join("\n\n") : null;
}

export function getStoreCollections(db: Database): NamedCollection[] {
  const rows = db.prepare(`SELECT * FROM store_collections`).all() as StoreCollectionRow[];
  return rows.map(rowToNamedCollection);
}

export function getStoreCollection(db: Database, name: string): NamedCollection | null {
  const row = db.prepare(`SELECT * FROM store_collections WHERE name = ?`).get(name) as StoreCollectionRow | null | undefined;
  if (row == null) return null;
  return rowToNamedCollection(row);
}

export function getStoreGlobalContext(db: Database): string | undefined {
  const row = db.prepare(`SELECT value FROM store_config WHERE key = 'global_context'`).get() as { value: string } | null | undefined;
  if (row == null) return undefined;
  return row.value || undefined;
}

export function getStoreContexts(db: Database): Array<{ collection: string; path: string; context: string }> {
  const results: Array<{ collection: string; path: string; context: string }> = [];

  // Global context
  const globalCtx = getStoreGlobalContext(db);
  if (globalCtx) {
    results.push({ collection: "*", path: "/", context: globalCtx });
  }

  // Collection contexts
  const rows = db.prepare(`SELECT name, context FROM store_collections WHERE context IS NOT NULL`).all() as { name: string; context: string }[];
  for (const row of rows) {
    const ctxMap = JSON.parse(row.context) as ContextMap;
    for (const [path, context] of Object.entries(ctxMap)) {
      results.push({ collection: row.name, path, context });
    }
  }

  return results;
}

export function upsertStoreCollection(db: Database, name: string, collection: Omit<Collection, 'pattern'> & { pattern?: string }): void {
  db.prepare(`
    INSERT INTO store_collections (name, path, pattern, ignore_patterns, include_by_default, update_command, context)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      path = excluded.path,
      pattern = excluded.pattern,
      ignore_patterns = excluded.ignore_patterns,
      include_by_default = excluded.include_by_default,
      update_command = excluded.update_command,
      context = excluded.context
  `).run(
    name,
    collection.path,
    collection.pattern || '**/*.md',
    collection.ignore ? JSON.stringify(collection.ignore) : null,
    collection.includeByDefault === false ? 0 : 1,
    collection.update || null,
    collection.context ? JSON.stringify(collection.context) : null,
  );
}

export function deleteStoreCollection(db: Database, name: string): boolean {
  const result = db.prepare(`DELETE FROM store_collections WHERE name = ?`).run(name);
  return result.changes > 0;
}

export function renameStoreCollection(db: Database, oldName: string, newName: string): boolean {
  // Check target doesn't exist
  const existing = db.prepare(`SELECT name FROM store_collections WHERE name = ?`).get(newName) as { name: string } | null | undefined;
  if (existing != null) {
    throw new Error(`Collection '${newName}' already exists`);
  }

  const result = db.prepare(`UPDATE store_collections SET name = ? WHERE name = ?`).run(newName, oldName);
  return result.changes > 0;
}

export function updateStoreContext(db: Database, collectionName: string, path: string, text: string): boolean {
  const row = db.prepare(`SELECT context FROM store_collections WHERE name = ?`).get(collectionName) as { context: string | null } | null | undefined;
  if (row == null) return false;

  const ctxMap: ContextMap = row.context ? JSON.parse(row.context) : {};
  ctxMap[path] = text;
  db.prepare(`UPDATE store_collections SET context = ? WHERE name = ?`).run(JSON.stringify(ctxMap), collectionName);
  return true;
}

export function removeStoreContext(db: Database, collectionName: string, path: string): boolean {
  const row = db.prepare(`SELECT context FROM store_collections WHERE name = ?`).get(collectionName) as { context: string | null } | null | undefined;
  if (row == null) return false;
  if (!row.context) return false;

  const ctxMap: ContextMap = JSON.parse(row.context);
  if (!(path in ctxMap)) return false;

  delete ctxMap[path];
  const newCtx = Object.keys(ctxMap).length > 0 ? JSON.stringify(ctxMap) : null;
  db.prepare(`UPDATE store_collections SET context = ? WHERE name = ?`).run(newCtx, collectionName);
  return true;
}

export function setStoreGlobalContext(db: Database, value: string | undefined): void {
  if (value === undefined) {
    db.prepare(`DELETE FROM store_config WHERE key = 'global_context'`).run();
  } else {
    db.prepare(`INSERT INTO store_config (key, value) VALUES ('global_context', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(value);
  }
}

/**
 * Sync external config (YAML/inline) into SQLite store_collections.
 * External config always wins. Skips sync if config hash hasn't changed.
 */
export function syncConfigToDb(db: Database, config: CollectionConfig): void {
  // Check config hash — skip sync if unchanged
  const configJson = JSON.stringify(config);
  const hash = createHash('sha256').update(configJson).digest('hex');

  const existingHash = db.prepare(`SELECT value FROM store_config WHERE key = 'config_hash'`).get() as { value: string } | null | undefined;
  if (existingHash != null && existingHash.value === hash) {
    return; // Config unchanged, skip sync
  }

  // Sync collections
  const configNames = new Set(Object.keys(config.collections));

  for (const [name, coll] of Object.entries(config.collections)) {
    upsertStoreCollection(db, name, coll);
  }

  // Delete collections not in config
  const dbCollections = db.prepare(`SELECT name FROM store_collections`).all() as { name: string }[];
  for (const row of dbCollections) {
    if (!configNames.has(row.name)) {
      db.prepare(`DELETE FROM store_collections WHERE name = ?`).run(row.name);
    }
  }

  // Sync global context
  if (config.global_context !== undefined) {
    setStoreGlobalContext(db, config.global_context);
  } else {
    setStoreGlobalContext(db, undefined);
  }

  // Save config hash
  db.prepare(`INSERT INTO store_config (key, value) VALUES ('config_hash', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(hash);
}
