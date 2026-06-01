import { parseArgs } from "node:util";

// =============================================================================
// Types
// =============================================================================

export type OutputFormat = "cli" | "csv" | "md" | "xml" | "files" | "json";
export type ChunkStrategy = "auto" | "regex";

export type OutputOptions = {
  format: OutputFormat;
  full: boolean;
  limit: number;
  minScore: number;
  all?: boolean;
  collection?: string | string[];
  lineNumbers?: boolean;
  explain?: boolean;
  context?: string;
  candidateLimit?: number;
  intent?: string;
  skipRerank?: boolean;
  chunkStrategy?: ChunkStrategy;
  fullPath?: boolean;
};

export type ParseCLIResult = {
  command: string;
  args: string[];
  query: string;
  opts: OutputOptions;
  values: Record<string, unknown>;
};

/**
 * Callbacks for CLI-specific side effects that parseCLI shouldn't
 * depend on directly (to avoid circular imports from qmd.ts).
 */
export type ParseCLICallbacks = {
  setIndexName: (name: string | null) => void;
  setConfigIndexName: (name: string) => void;
  setConfigSource: (config?: { configPath: string }) => void;
  findLocalConfigPath: () => string | undefined;
  getLocalDbPath: (configPath: string) => string | undefined;
  setStoreDbPathOverride: (path: string | undefined) => void;
  closeDb: () => void;
  parseChunkStrategy: (value: unknown) => ChunkStrategy | undefined;
};

// =============================================================================
// Helpers
// =============================================================================

export function parseChunkStrategy(value: unknown): ChunkStrategy | undefined {
  if (value === undefined) return undefined;
  const s = String(value);
  if (s === "auto" || s === "regex") return s;
  throw new Error(`--chunk-strategy must be "auto" or "regex" (got "${s}")`);
}

const VALID_FORMATS: ReadonlyArray<OutputFormat> = [
  "cli", "json", "csv", "md", "xml", "files",
];

// =============================================================================
// Parser
// =============================================================================

export function parseCLI(callbacks?: Partial<ParseCLICallbacks>): ParseCLIResult {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      // Global options
      index: { type: "string" },
      context: { type: "string" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
      skill: { type: "boolean" },
      global: { type: "boolean" },
      yes: { type: "boolean" },
      // Search options
      n: { type: "string" },
      "min-score": { type: "string" },
      all: { type: "boolean" },
      full: { type: "boolean" },
      format: { type: "string" },
      // Legacy boolean format aliases (back-compat, prefer --format <kind>)
      csv: { type: "boolean" },
      md: { type: "boolean" },
      xml: { type: "boolean" },
      files: { type: "boolean" },
      json: { type: "boolean" },
      explain: { type: "boolean" },
      collection: { type: "string", short: "c", multiple: true },
      // Collection options
      name: { type: "string" },
      mask: { type: "string" },
      // Embed options
      force: { type: "boolean", short: "f" },
      "max-docs-per-batch": { type: "string" },
      "max-batch-mb": { type: "string" },
      // Update options
      pull: { type: "boolean" },
      refresh: { type: "boolean" },
      // Get options
      l: { type: "string" },
      from: { type: "string" },
      "max-bytes": { type: "string" },
      "line-numbers": { type: "boolean" },
      "no-line-numbers": { type: "boolean" },
      "full-path": { type: "boolean" },
      // Query options
      "candidate-limit": { type: "string", short: "C" },
      "no-rerank": { type: "boolean", default: false },
      "no-gpu": { type: "boolean", default: false },
      intent: { type: "string" },
      // Chunking options
      "chunk-strategy": { type: "string" },
      // MCP HTTP transport options
      http: { type: "boolean" },
      daemon: { type: "boolean" },
      port: { type: "string" },
    },
    allowPositionals: true,
    strict: false,
  });

  if (values["no-gpu"]) {
    process.env.QMD_FORCE_CPU = "1";
  }

  // Select index name (default: "index"). If no explicit --index is supplied,
  // a project-local .qmd/index.yaml overrides the global config/cache paths.
  const indexName = values.index as string | undefined;
  if (indexName) {
    callbacks?.setIndexName?.(indexName);
    callbacks?.setConfigIndexName?.(indexName);
    callbacks?.setConfigSource?.();
  } else {
    const localConfigPath = callbacks?.findLocalConfigPath?.();
    if (localConfigPath) {
      callbacks?.setConfigSource?.({ configPath: localConfigPath });
      const dbPath = callbacks?.getLocalDbPath?.(localConfigPath);
      if (dbPath !== undefined) {
        callbacks?.setStoreDbPathOverride?.(dbPath);
      }
      callbacks?.closeDb?.();
    } else {
      callbacks?.setConfigSource?.();
    }
  }

  // Determine output format. Prefer --format <kind>; fall back to the
  // legacy boolean aliases (--csv/--md/--xml/--files/--json) which remain
  // wired up for back-compat but are no longer documented.
  let format: OutputFormat = "cli";
  const rawFormat = typeof values.format === "string"
    ? values.format.toLowerCase().trim()
    : "";
  if (rawFormat) {
    if ((VALID_FORMATS as ReadonlyArray<string>).includes(rawFormat)) {
      format = rawFormat as OutputFormat;
    } else {
      console.error(`Unknown --format value: ${values.format}`);
      console.error(`Valid: ${VALID_FORMATS.join(", ")}`);
      process.exit(1);
    }
  } else if (values.csv) format = "csv";
  else if (values.md) format = "md";
  else if (values.xml) format = "xml";
  else if (values.files) format = "files";
  else if (values.json) format = "json";

  // Default limit: 20 for --files/--json, 5 otherwise
  // --all means return all matches (use very large limit)
  const defaultLimit = (format === "files" || format === "json") ? 20 : 5;
  const isAll = !!values.all;

  const opts: OutputOptions = {
    format,
    full: !!values.full,
    limit: isAll
      ? 100000
      : (values.n ? parseInt(String(values.n), 10) || defaultLimit : defaultLimit),
    minScore: values["min-score"]
      ? parseFloat(String(values["min-score"])) || 0
      : 0,
    all: isAll,
    collection: values.collection as string[] | undefined,
    lineNumbers: !!values["line-numbers"],
    candidateLimit: values["candidate-limit"]
      ? parseInt(String(values["candidate-limit"]), 10)
      : undefined,
    skipRerank: !!values["no-rerank"],
    explain: !!values.explain,
    intent: values.intent as string | undefined,
    chunkStrategy: parseChunkStrategy(values["chunk-strategy"]),
    fullPath: !!values["full-path"],
  };

  return {
    command: positionals[0] || "",
    args: positionals.slice(1),
    query: positionals.slice(1).join(" "),
    opts,
    values: values as Record<string, unknown>,
  };
}
