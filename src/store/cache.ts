/**
 * LLM cache helpers — keyed hashing and SQLite-backed storage.
 *
 * Extracted from src/store.ts to reduce module size and clarify boundaries.
 */

import { createHash } from "crypto";
import type { Database } from "../db.js";

/**
 * Generate a deterministic cache key from a URL and request body.
 */
export function getCacheKey(url: string, body: object): string {
  const hash = createHash("sha256");
  hash.update(url);
  hash.update(JSON.stringify(body));
  return hash.digest("hex");
}

/**
 * Look up a cached result by key.
 * Returns the raw string result, or null on miss.
 */
export function getCachedResult(db: Database, cacheKey: string): string | null {
  const row = db.prepare(`SELECT result FROM llm_cache WHERE hash = ?`).get(cacheKey) as { result: string } | null;
  return row?.result || null;
}

/**
 * Store a result in the cache, creating or replacing the key.
 * Occasionally prunes the cache to the 1000 most recent entries.
 */
export function setCachedResult(db: Database, cacheKey: string, result: string): void {
  const now = new Date().toISOString();
  db.prepare(`INSERT OR REPLACE INTO llm_cache (hash, result, created_at) VALUES (?, ?, ?)`).run(cacheKey, result, now);
  if (Math.random() < 0.01) {
    db.exec(`DELETE FROM llm_cache WHERE hash NOT IN (SELECT hash FROM llm_cache ORDER BY created_at DESC LIMIT 1000)`);
  }
}

/**
 * Delete every row from the LLM cache table.
 */
export function clearCache(db: Database): void {
  db.exec(`DELETE FROM llm_cache`);
}
