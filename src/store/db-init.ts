import { loadSqliteVec } from "../db.js";
import type { Database } from "../db.js";

const CJK_CHAR_PATTERN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const CJK_RUN_PATTERN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;
const FTS_CJK_NORMALIZED_VERSION = "1";

let sqliteVecUnavailableReason: string | null = null;
let sqliteVecAvailable: boolean | null = null;

export function createSqliteVecUnavailableError(reason: string): Error {
  return new Error(
    "sqlite-vec extension is unavailable. " +
    `${reason}. ` +
    "Install Homebrew SQLite so the sqlite-vec extension can be loaded, " +
    "and set BREW_PREFIX if Homebrew is installed in a non-standard location.",
  );
}

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function verifySqliteVecLoaded(db: Database): void {
  try {
    db.prepare("SELECT vec_version() as version").get();
  } catch (err) {
    throw createSqliteVecUnavailableError(
      getErrorMessage(err)
    );
  }
}

export function isSqliteVecAvailableState(): boolean {
  return sqliteVecAvailable === true;
}

export function getSqliteVecUnavailableReason(): string | null {
  return sqliteVecUnavailableReason;
}

/**
 * FTS5's unicode61 tokenizer does not segment CJK text into searchable words.
 * Normalize CJK runs by spacing every character so exact CJK queries can be
 * translated into phrase queries while Latin text keeps the default tokenizer.
 */
export function normalizeCjkForFTS(text: string): string {
  return text.replace(CJK_RUN_PATTERN, run => ` ${Array.from(run).join(' ')} `);
}

export function containsCjk(text: string): boolean {
  return CJK_CHAR_PATTERN.test(text);
}

export function sanitizeFTS5Phrase(phrase: string, sanitizeTerm: (term: string) => string): string {
  return normalizeCjkForFTS(phrase)
    .split(/\s+/)
    .map(t => sanitizeTerm(t))
    .filter(t => t)
    .join(' ');
}

function rebuildFTSForCjkNormalization(db: Database): void {
  const version = db.prepare(`SELECT value FROM store_config WHERE key = 'fts_cjk_normalized_version'`).get() as { value?: string } | undefined;
  if (version?.value === FTS_CJK_NORMALIZED_VERSION) return;

  try {
    db.exec(`DELETE FROM documents_fts WHERE rowid >= 0`);
  } catch {
    // Some older/corrupt FTS5 shadow-table states can reject bulk deletes even
    // though reads still work. Recreate the virtual table; documents_fts is a
    // derived index, so rebuilding it from documents/content is safe.
    db.exec(`DROP TABLE IF EXISTS documents_fts`);
    db.exec(`
      CREATE VIRTUAL TABLE documents_fts USING fts5(
        filepath, title, body,
        tokenize='porter unicode61'
      )
    `);
  }
  const rows = db.prepare(`
    SELECT d.id, d.collection, d.path, d.title, content.doc as body
    FROM documents d
    JOIN content ON content.hash = d.hash
    WHERE d.active = 1
  `).all() as { id: number; collection: string; path: string; title: string; body: string }[];
  const insert = db.prepare(`INSERT INTO documents_fts(rowid, filepath, title, body) VALUES (?, ?, ?, ?)`);
  const rebuild = db.transaction(() => {
    for (const row of rows) {
      insert.run(
        row.id,
        normalizeCjkForFTS(`${row.collection}/${row.path}`),
        normalizeCjkForFTS(row.title),
        normalizeCjkForFTS(row.body),
      );
    }
  });
  rebuild();
  db.prepare(`
    INSERT OR REPLACE INTO store_config(key, value)
    VALUES ('fts_cjk_normalized_version', ?)
  `).run(FTS_CJK_NORMALIZED_VERSION);
}

export function initializeDatabase(db: Database): void {
  try {
    loadSqliteVec(db);
    verifySqliteVecLoaded(db);
    sqliteVecAvailable = true;
    sqliteVecUnavailableReason = null;
  } catch (err) {
    // sqlite-vec is optional — vector search won't work but FTS is fine
    sqliteVecAvailable = false;
    sqliteVecUnavailableReason = getErrorMessage(err);
    console.warn(sqliteVecUnavailableReason);
  }
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");

  // Drop legacy tables that are now managed in YAML
  db.exec(`DROP TABLE IF EXISTS path_contexts`);
  db.exec(`DROP TABLE IF EXISTS collections`);

  // Content-addressable storage - the source of truth for document content
  db.exec(`
    CREATE TABLE IF NOT EXISTS content (
      hash TEXT PRIMARY KEY,
      doc TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);

  // Documents table - file system layer mapping virtual paths to content hashes
  // Collections are now managed in ~/.config/qmd/index.yml
  db.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      collection TEXT NOT NULL,
      path TEXT NOT NULL,
      title TEXT NOT NULL,
      hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      modified_at TEXT NOT NULL,
      source_mtime_ms INTEGER NOT NULL DEFAULT -1,
      source_size INTEGER NOT NULL DEFAULT -1,
      active INTEGER NOT NULL DEFAULT 1,
      FOREIGN KEY (hash) REFERENCES content(hash) ON DELETE CASCADE,
      UNIQUE(collection, path)
    )
  `);
  for (const column of [
    { name: "source_mtime_ms", definition: "INTEGER NOT NULL DEFAULT -1" },
    { name: "source_size", definition: "INTEGER NOT NULL DEFAULT -1" },
  ]) {
    try {
      db.exec(`ALTER TABLE documents ADD COLUMN ${column.name} ${column.definition}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("duplicate column name")) throw error;
    }
  }

  db.exec(`CREATE INDEX IF NOT EXISTS idx_documents_collection ON documents(collection, active)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_documents_hash ON documents(hash)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_documents_path ON documents(path, active)`);

  // Cache table for LLM API calls
  db.exec(`
    CREATE TABLE IF NOT EXISTS llm_cache (
      hash TEXT PRIMARY KEY,
      result TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);

  // Content vectors. Avoid PRAGMA schema probes during startup; legacy vector
  // columns are repaired lazily when a vector/embedding query first needs them.
  db.exec(`
    CREATE TABLE IF NOT EXISTS content_vectors (
      hash TEXT NOT NULL,
      seq INTEGER NOT NULL DEFAULT 0,
      pos INTEGER NOT NULL DEFAULT 0,
      model TEXT NOT NULL,
      embed_fingerprint TEXT NOT NULL DEFAULT '',
      total_chunks INTEGER NOT NULL DEFAULT 1,
      embedded_at TEXT NOT NULL,
      PRIMARY KEY (hash, seq)
    )
  `);

  // Store collections — makes the DB self-contained (no external config needed)
  db.exec(`
    CREATE TABLE IF NOT EXISTS store_collections (
      name TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      pattern TEXT NOT NULL DEFAULT '**/*.md',
      ignore_patterns TEXT,
      include_by_default INTEGER DEFAULT 1,
      update_command TEXT,
      context TEXT
    )
  `);

  // Store config — key-value metadata (e.g. config_hash for sync optimization)
  db.exec(`
    CREATE TABLE IF NOT EXISTS store_config (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `);

  // FTS - index filepath (collection/path), title, and content
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
      filepath, title, body,
      tokenize='porter unicode61'
    )
  `);

  // Triggers keep FTS in sync for callers that write directly to documents.
  // Production indexing paths rebuild entries in TypeScript so CJK text can be
  // normalized before it reaches the unicode61 tokenizer.
  db.exec(`DROP TRIGGER IF EXISTS documents_ai`);
  db.exec(`
    CREATE TRIGGER documents_ai AFTER INSERT ON documents
    WHEN new.active = 1
    BEGIN
      INSERT INTO documents_fts(rowid, filepath, title, body)
      SELECT
        new.id,
        new.collection || '/' || new.path,
        new.title,
        (SELECT doc FROM content WHERE hash = new.hash)
      WHERE new.active = 1;
    END
  `);

  db.exec(`DROP TRIGGER IF EXISTS documents_ad`);
  db.exec(`
    CREATE TRIGGER documents_ad AFTER DELETE ON documents BEGIN
      DELETE FROM documents_fts WHERE rowid = old.id;
    END
  `);

  db.exec(`DROP TRIGGER IF EXISTS documents_au`);
  db.exec(`
    CREATE TRIGGER documents_au AFTER UPDATE ON documents
    BEGIN
      -- Delete from FTS if no longer active
      DELETE FROM documents_fts WHERE rowid = old.id AND new.active = 0;

      -- Update FTS if still/newly active
      INSERT OR REPLACE INTO documents_fts(rowid, filepath, title, body)
      SELECT
        new.id,
        new.collection || '/' || new.path,
        new.title,
        (SELECT doc FROM content WHERE hash = new.hash)
      WHERE new.active = 1;
    END
  `);

  rebuildFTSForCjkNormalization(db);
}
