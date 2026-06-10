# QMD - Query Markup Documents

An on-device search engine for everything you need to remember. Index your markdown notes, meeting transcripts, documentation, and knowledge bases. Search with keywords or natural language. Ideal for your agentic flows.

QMD combines BM25 full-text search, vector semantic search, and LLM re-ranking, with local GGUF execution by default and optional per-role remote providers in this fork.

![QMD Architecture](assets/qmd-architecture.png)

You can read more about QMD's progress in the [CHANGELOG](CHANGELOG.md).

## Fork Overview

This fork focuses on remote-provider interoperability while preserving local-first defaults.

### What This Fork Adds

- Protocol-aware remote adapter layer for per-endpoint formats (`embed`, `expand`, `rerank`, `generate`).
- Explicit API format selection via env vars / YAML (`*_api_format`).
- OpenAI generation support across:
  - `/v1/chat/completions`
  - `/v1/completions`
  - `/v1/responses`
- Anthropic Messages support (`/v1/messages`) for expand/generate.
- Cohere-compatible embed/rerank adapters with vLLM compatibility:
  - Embed: `/v2/embed` and `/embed` fallback
  - Rerank: `/rerank`, `/v1/rerank`, `/v2/rerank` fallback
- Query-aware remote embedding in batch vector paths (`isQuery: true`) so query/document embedding intent is preserved in hybrid and structured search flows.

### Backward Compatibility Goals

- `auto` format keeps legacy behavior unless a specific format is configured.
- OpenAI-style `/v1/embeddings` remains supported.
- Local GGUF workflows remain default when no remote URLs are configured.

## Quick Start

```sh
# Install globally (Node or Bun)
npm install -g @tobilu/qmd
# or
bun install -g @tobilu/qmd

# Or run directly
npx @tobilu/qmd ...
bunx @tobilu/qmd ...

# Create collections for your notes, docs, and meeting transcripts
qmd collection add ~/notes --name notes
qmd collection add ~/Documents/meetings --name meetings
qmd collection add ~/work/docs --name docs

# Add context to help with search results, each piece of context will be returned when matching sub documents are returned. This works as a tree. This is the key feature of QMD as it allows LLMs to make much better contextual choices when selecting documents. Don't sleep on it!
qmd context add qmd://notes "Personal notes and ideas"
qmd context add qmd://meetings "Meeting transcripts and notes"
qmd context add qmd://docs "Work documentation"

# Generate embeddings for semantic search
qmd embed

# Search across everything
qmd search "project timeline"           # Fast keyword search
qmd vsearch "how to deploy"             # Semantic search
qmd query "quarterly planning process"  # Hybrid + reranking (best quality)

# Get a specific document
qmd get "meetings/2024-01-15.md"

# Get a document by docid (shown in search results)
qmd get "#abc123"

# Get multiple documents by glob pattern
qmd multi-get "journals/2025-05*.md"

# Search within a specific collection
qmd search "API" -c notes

# Export all matches for an agent
qmd search "API" --all --files --min-score 0.3
```

### Using with AI Agents

QMD's `--json` and `--files` output formats are designed for agentic workflows:

```sh
# Get structured results for an LLM
qmd search "authentication" --json -n 10

# List all relevant files above a threshold
qmd query "error handling" --all --files --min-score 0.4

# Retrieve full document content
qmd get "docs/api-reference.md" --full
```

### MCP Server

Although the tool works perfectly fine when you just tell your agent to use it on the command line, it also exposes an MCP (Model Context Protocol) server for tighter integration.

**Tools exposed:**
- `query` — Search with typed sub-queries (`lex`/`vec`/`hyde`), combined via RRF + reranking
- `get` — Retrieve a document by path or docid (with fuzzy matching suggestions)
- `multi_get` — Batch retrieve by glob pattern, comma-separated list, or docids
- `status` — Index health and collection info

**Claude Desktop configuration** (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "qmd": {
      "command": "qmd",
      "args": ["mcp"]
    }
  }
}
```

**Claude Code** — Install the plugin (recommended):

```bash
claude plugin marketplace add tobi/qmd
claude plugin install qmd@qmd
```

Or configure MCP manually in `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "qmd": {
      "command": "qmd",
      "args": ["mcp"]
    }
  }
}
```

#### HTTP Transport

By default, QMD's MCP server uses stdio (launched as a subprocess by each client). For a shared, long-lived server that avoids repeated model loading, use the HTTP transport:

```sh
# Foreground (Ctrl-C to stop)
qmd mcp --http                    # localhost:8181
qmd mcp --http --port 8080        # custom port

# Background daemon
qmd mcp --http --daemon           # start, writes PID to ~/.cache/qmd/mcp.pid
qmd mcp stop                      # stop via PID file
qmd status                        # shows "MCP: running (PID ...)" when active
```

The HTTP server exposes two endpoints:
- `POST /mcp` — MCP Streamable HTTP (JSON responses, stateless)
- `GET /health` — liveness check with uptime

LLM models stay loaded in VRAM across requests. Embedding/reranking contexts are disposed after 5 min idle and transparently recreated on the next request (~1s penalty, models remain loaded).

Point any MCP client at `http://localhost:8181/mcp` to connect.

### SDK / Library Usage

Use QMD as a library in your own Node.js or Bun applications.

#### Installation

```sh
npm install @tobilu/qmd
```

#### Quick Start

```typescript
import { createStore } from '@tobilu/qmd'

const store = await createStore({
  dbPath: './my-index.sqlite',
  config: {
    collections: {
      docs: { path: '/path/to/docs', pattern: '**/*.md' },
    },
  },
})

const results = await store.search({ query: "authentication flow" })
console.log(results.map(r => `${r.title} (${Math.round(r.score * 100)}%)`))

await store.close()
```

#### Store Creation

`createStore()` accepts three modes:

```typescript
import { createStore } from '@tobilu/qmd'

// 1. Inline config — no files needed besides the DB
const store = await createStore({
  dbPath: './index.sqlite',
  config: {
    collections: {
      docs: { path: '/path/to/docs', pattern: '**/*.md' },
      notes: { path: '/path/to/notes' },
    },
  },
})

// 2. YAML config file — collections defined in a file
const store2 = await createStore({
  dbPath: './index.sqlite',
  configPath: './qmd.yml',
})

// 3. DB-only — reopen a previously configured store
const store3 = await createStore({ dbPath: './index.sqlite' })
```

#### Search

The unified `search()` method handles both simple queries and pre-expanded structured queries:

```typescript
// Simple query — auto-expanded via LLM, then BM25 + vector + reranking
const results = await store.search({ query: "authentication flow" })

// With options
const results2 = await store.search({
  query: "rate limiting",
  intent: "API throttling and abuse prevention",
  collection: "docs",
  limit: 5,
  minScore: 0.3,
  explain: true,
})

// Pre-expanded queries — skip auto-expansion, control each sub-query
const results3 = await store.search({
  queries: [
    { type: 'lex', query: '"connection pool" timeout -redis' },
    { type: 'vec', query: 'why do database connections time out under load' },
  ],
  collections: ["docs", "notes"],
})

// Skip reranking for faster results
const fast = await store.search({ query: "auth", rerank: false })
```

For direct backend access:

```typescript
// BM25 keyword search (fast, no LLM)
const lexResults = await store.searchLex("auth middleware", { limit: 10 })

// Vector similarity search (embedding model, no reranking)
const vecResults = await store.searchVector("how users log in", { limit: 10 })

// Manual query expansion for full control
const expanded = await store.expandQuery("auth flow", { intent: "user login" })
const results4 = await store.search({ queries: expanded })
```

#### Retrieval

```typescript
// Get a document by path or docid
const doc = await store.get("docs/readme.md")
const byId = await store.get("#abc123")

if (!("error" in doc)) {
  console.log(doc.title, doc.displayPath, doc.context)
}

// Get document body with line range
const body = await store.getDocumentBody("docs/readme.md", {
  fromLine: 50,
  maxLines: 100,
})

// Batch retrieve by glob or comma-separated list
const { docs, errors } = await store.multiGet("docs/**/*.md", {
  maxBytes: 20480,
})
```

#### Collections

```typescript
// Add a collection
await store.addCollection("myapp", {
  path: "/src/myapp",
  pattern: "**/*.ts",
  ignore: ["node_modules/**", "*.test.ts"],
})

// List collections with document stats
const collections = await store.listCollections()
// => [{ name, pwd, glob_pattern, doc_count, active_count, last_modified, includeByDefault }]

// Get names of collections included in queries by default
const defaults = await store.getDefaultCollectionNames()

// Remove / rename
await store.removeCollection("myapp")
await store.renameCollection("old-name", "new-name")
```

#### Context

Context adds descriptive metadata that improves search relevance and is returned alongside results:

```typescript
// Add context for a path within a collection
await store.addContext("docs", "/api", "REST API reference documentation")

// Set global context (applies to all collections)
await store.setGlobalContext("Internal engineering documentation")

// List all contexts
const contexts = await store.listContexts()
// => [{ collection, path, context }]

// Remove context
await store.removeContext("docs", "/api")
await store.setGlobalContext(undefined)  // clear global
```

#### Indexing

```typescript
// Re-index collections by scanning the filesystem
const result = await store.update({
  collections: ["docs"],  // optional — defaults to all
  onProgress: ({ collection, file, current, total }) => {
    console.log(`[${collection}] ${current}/${total} ${file}`)
  },
})
// => { collections, indexed, updated, unchanged, removed, needsEmbedding }

// Generate vector embeddings
const embedResult = await store.embed({
  force: false,           // true to re-embed everything
  chunkStrategy: "auto",  // "auto" (default, AST-aware for code) or "regex"
  onProgress: ({ current, total, collection }) => {
    console.log(`Embedding ${current}/${total}`)
  },
})
```

#### Types

Key types exported for SDK consumers:

```typescript
import type {
  QMDStore,            // The store interface
  SearchOptions,       // Options for search()
  LexSearchOptions,    // Options for searchLex()
  VectorSearchOptions, // Options for searchVector()
  HybridQueryResult,   // Search result with score, snippet, context
  SearchResult,        // Result from searchLex/searchVector
  ExpandedQuery,       // Typed sub-query { type: 'lex'|'vec'|'hyde', query }
  DocumentResult,      // Document metadata + body
  DocumentNotFound,    // Error with similarFiles suggestions
  MultiGetResult,      // Batch retrieval result
  UpdateProgress,      // Progress callback info for update()
  UpdateResult,        // Aggregated update result
  EmbedProgress,       // Progress callback info for embed()
  EmbedResult,         // Embedding result
  StoreOptions,        // createStore() options
  CollectionConfig,    // Inline config shape
  IndexStatus,         // From getStatus()
  IndexHealthInfo,     // From getIndexHealth()
} from '@tobilu/qmd'
```

Utility exports:

```typescript
import {
  extractSnippet,              // Extract a relevant snippet from text
  addLineNumbers,              // Add line numbers to text
  DEFAULT_MULTI_GET_MAX_BYTES, // Default max file size for multiGet (10KB)
  Maintenance,                 // Database maintenance operations
} from '@tobilu/qmd'
```

#### Lifecycle

```typescript
// Close the store — disposes LLM models and DB connection
await store.close()
```

The SDK requires explicit `dbPath` — no defaults are assumed. This makes it safe to embed in any application without side effects.

## Architecture

### System Overview

```
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│                                     QMD System Architecture                              │
└──────────────────────────────────────────────────────────────────────────────────────────┘

  ┌──────────────────────────┐  ┌──────────────────────────┐  ┌──────────────────────────┐
  │        CLI (qmd)         │  │     MCP Server (stdio +   │  │     SDK / Library        │
  │  ┌────────────────────┐  │  │        HTTP daemon)      │  │  ┌────────────────────┐  │
  │  │ • query (hybrid)   │  │  │  ┌────────────────────┐  │  │  │ createStore()      │  │
  │  │ • search (BM25)    │  │  │  │ Tools: query, get, │  │  │  │ store.search()     │  │
  │  │ • vsearch (vector) │  │  │  │ multi_get, status  │  │  │  │ store.get()        │  │
  │  │ • embed            │  │  │  └────────┬───────────┘  │  │  │ store.addContext() │  │
  │  │ • update (reindex) │  │  │           │              │  │  └────────┬───────────┘  │
  │  │ • context add/rm   │  │  │  ┌────────┴───────────┐  │  │           │              │
  │  │ • collection mgmt  │  │  │  │ stdio transport     │  │  │           │              │
  │  │ • multi-get / ls   │  │  │  │ HTTP transport      │  │  │           │              │
  │  └────────┬───────────┘  │  │  │ (SSE streamable)    │  │  │           │              │
  │           │              │  │  └────────────────────┘  │  │           │              │
  └───────────┼──────────────┘  └────────────┬─────────────┘  └───────────┼──────────────┘
              │                              │                              │
              └──────────────────────────────┼──────────────────────────────┘
                                             │
                                             ▼
  ┌──────────────────────────────────────────────────────────────────────────────────────────┐
  │                                   Store (src/store.ts)                                    │
  │  ┌───────────────────┐  ┌───────────────────┐  ┌───────────────────┐                      │
  │  │   Query Engine    │  │     Retrieval     │  │    Embedding      │                      │
  │  │  (query-engine)   │  │   (retrieval.ts)  │  │    Pipeline       │                      │
  │  │  ┌─────────────┐  │  │  ┌─────────────┐  │  │ (embedding-pipe)  │                      │
  │  │  │ hybridQuery │  │  │  │ searchFTS   │  │  │  ┌─────────────┐  │                      │
  │  │  │ vSearch     │  │  │  │ searchVec   │  │  │  │ generate    │  │                      │
  │  │  │ structured  │  │  │  │ rrfFusion   │  │  │  │ Embeddings  │  │                      │
  │  │  │ expandQuery │  │  │  │ getContext  │  │  │  └─────────────┘  │                      │
  │  │  │ rerank      │  │  │  └─────────────┘  │  │                   │                      │
  │  │  └─────────────┘  │  │                   │  │  ┌─────────────┐  │                      │
  │  └───────────────────┘  └───────────────────┘  │  │  Chunking   │  │                      │
  │                                                 │  │  regex+AST  │  │                      │
  │  ┌───────────────────┐  ┌───────────────────┐  │  └─────────────┘  │                      │
  │  │    Collections    │  │   Cache + Maint   │  │                   │                      │
  │  │  (collections.ts) │  │  ┌─────────────┐  │  │  ┌─────────────┐  │                      │
  │  │  YAML config      │  │  │ LLM cache   │  │  │  │  Document   │  │                      │
  │  │  context per-path │  │  │ cleanup     │  │  │  │  Ops /      │  │                      │
  │  │  update commands  │  │  │ vacuum      │  │  │  │  Reindex    │  │                      │
  │  └───────────────────┘  │  └─────────────┘  │  │  └─────────────┘  │                      │
  │                         └───────────────────┘  └───────────────────┘                      │
  └──────────────────────────────────────┬───────────────────────────────────────────────────┘
                                         │
              ┌──────────────────────────┼──────────────────────────┐
              │                          │                          │
              ▼                          ▼                          ▼
  ┌──────────────────────┐  ┌──────────────────────┐  ┌──────────────────────┐
  │    LLM Abstraction   │  │    Remote LLM HTTP   │  │    YAML Config       │
  │    (src/llm.ts)      │  │    (src/remote/)     │  │  ~/.config/qmd/      │
  │                      │  │                      │  │  index.yml           │
  │  ┌────────────────┐  │  │  ┌────────────────┐  │  │                      │
  │  │ node-llama-cpp │  │  │  │ RemoteLLM      │  │  │  • Collection defs  │
  │  │ (local GGUF)   │  │  │  │ (HTTP client)  │  │  │  • Path contexts    │
  │  │                │  │  │  │                │  │  │  • Model URLs/keys  │
  │  │ • embedBatch   │  │  │  │ ┌────────────┐ │  │  │  • API formats      │
  │  │ • expandQuery  │  │  │  │ │ Circuit    │ │  │  └──────────────────────┘
  │  │ • rerank       │  │  │  │ │ Breaker    │ │  │
  │  │ • generate     │  │  │  │ │ (retry)    │ │  │
  │  └────────────────┘  │  │  │ └────────────┘ │  │
  │                      │  │  │                │  │
  │  Model Cache:        │  │  │ ┌────────────┐ │  │
  │  ~/.cache/qmd/models │  │  │ │ Transport  │ │  │
  │  (HF auto-download)  │  │  │ │ (fetch)    │ │  │
  │                      │  │  │ └────────────┘ │  │
  │                      │  │  └────────────────┘  │
  │                      │  │                      │
  │                      │  │  ┌────────────────┐  │
  │                      │  │  │   Adapters     │  │
  │                      │  │  │  ┌──────────┐  │  │
  │                      │  │  │  │ OpenAI   │  │  │
  │                      │  │  │  │ Cohere   │  │  │
  │                      │  │  │  │ Ollama   │  │  │
  │                      │  │  │  │ vLLM     │  │  │
  │                      │  │  │  │ Anthropic│  │  │
  │                      │  │  │  │ Legacy   │  │  │
  │                      │  │  │  └──────────┘  │  │
  │                      │  │  └────────────────┘  │
  │                      │  │                      │
  │                      │  │  Remote Tokenizer    │
  │                      │  │  /tokenize endpoint  │
  │                      │  │                      │
  └──────────┬───────────┘  └──────────┬───────────┘
             │                         │
             │    implements           │    implements
             │    LLM interface        │    LLM interface
             └────────────┬────────────┘
                          │
                          ▼
  ┌──────────────────────────────────────────────────────────────────────────────────────────┐
  │                              SQLite Database (~/.cache/qmd/)                              │
  │  ┌──────────────┐  ┌───────────────┐  ┌──────────────┐  ┌──────────────┐                  │
  │  │  FTS5 Index  │  │ sqlite-vec    │  │   Content    │  │   Metadata   │                  │
  │  │  (BM25)      │  │ (embeddings)  │  │   (docs)     │  │  (documents, │                  │
  │  │              │  │               │  │              │  │   contexts,  │                  │
  │  │ full-text    │  │ cosine-sim    │  │ raw text +   │  │   collection │                  │
  │  │ keyword      │  │ vector search │  │ dedup by     │  │   config,    │                  │
  │  │ search       │  │               │  │ content hash │  │   llm_cache) │                  │
  │  └──────────────┘  └───────────────┘  └──────────────┘  └──────────────┘                  │
  └──────────────────────────────────────────────────────────────────────────────────────────┘
```

### LLM Backend: Local vs Remote

```
                              ┌─────────────────────────┐
                              │     LLM Interface        │
                              │     (src/llm/types.ts)   │
                              │                          │
                              │  embed / embedBatch      │
                              │  expandQuery             │
                              │  rerank                  │
                              │  generate / modelExists  │
                              └────────────┬────────────┘
                                           │
                     ┌─────────────────────┴─────────────────────┐
                     │                                           │
                     ▼                                           ▼
  ┌──────────────────────────────────┐    ┌──────────────────────────────────┐
  │        Local (llama-cpp)         │    │         Remote (HTTP)            │
  │        (src/llm/llama-cpp.ts)    │    │     (src/remote/remote-llm.ts)   │
  │                                  │    │                                  │
  │  ┌────────────────────────────┐  │    │  ┌────────────────────────────┐  │
  │  │ node-llama-cpp bindings   │  │    │  │ Per-endpoint config        │  │
  │  │ • embeddinggemma (300M)   │  │    │  │ • env vars  > YAML > def.  │  │
  │  │ • qwen3-reranker (0.6B)   │  │    │  │ • QMD_{ROLE}_BASE_URL      │  │
  │  │ • qmd-expansion (1.7B)    │  │    │  │ • QMD_{ROLE}_API_FORMAT    │  │
  │  │ • Qwen3-Embedding (opt)   │  │    │  └────────────────────────────┘  │
  │  └────────────────────────────┘  │    │                                  │
  │                                  │    │  ┌────────────────────────────┐  │
  │  GPU backends:                   │    │  │ Circuit Breaker            │  │
  │  • Metal / CUDA / Vulkan / CPU   │    │  │ (exponential backoff,      │  │
  │                                  │    │  │  half-open recovery)       │  │
  │  Session mgmt:                   │    │  └────────────────────────────┘  │
  │  • 5-min idle disposal           │    │                                  │
  │  • lazy re-creation              │    │  ┌────────────────────────────┐  │
  │                                  │    │  │ Protocol Adapters          │  │
  │  Prompt formatting:              │    │  │ ┌────────┬───────────────┐ │  │
  │  • Nomic (embeddinggemma)        │    │  │ │ Format │ Adapter       │ │  │
  │  • Qwen3 instruct (embed+gen)    │    │  │ ├────────┼───────────────┤ │  │
  │                                  │    │  │ │openai  │ chat/complet/ │ │  │
  └──────────────────────────────────┘    │  │ │        │ responses     │ │  │
                                          │  │ ├────────┼───────────────┤ │  │
                                          │  │ │cohere  │ embed, rerank │ │  │
                                          │  │ ├────────┼───────────────┤ │  │
                                          │  │ │ollama  │ embed, text   │ │  │
                                          │  │ ├────────┼───────────────┤ │  │
                                          │  │ │vllm    │ pooling,score │ │  │
                                          │  │ ├────────┼───────────────┤ │  │
                                          │  │ │anthrop │ messages      │ │  │
                                          │  │ └────────┴───────────────┘ │  │
                                          │  └────────────────────────────┘  │
                                          └──────────────────────────────────┘
```

### Hybrid Query Pipeline

```
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│                              QMD Hybrid Search Pipeline                                   │
│                         (qmd query — the full retrieval flow)                             │
└──────────────────────────────────────────────────────────────────────────────────────────┘

                              ┌─────────────────┐
                              │   User Query    │
                              └────────┬────────┘
                                       │
                                       ▼
                          ┌───────────────────────┐
                          │     BM25 Probe        │
                          │  Strong signal (>0.5)?│
                          │  Yes → skip expansion │
                          │  No  → expand query   │
                          └───────────┬───────────┘
                                      │
                          ┌───────────┴───────────┐
                          ▼                       ▼
                 ┌────────────────┐      ┌────────────────┐
                 │ Query Expansion│      │  Original Query│
                 │  LLM (expand)  │      │   (×2 weight)  │
                 │                │      │                │
                 │ local: qmd-1.7B│      │ +1-2 HyDE var. │
                 │ remote: OpenAI │      │ (optional LLM   │
                 │  / Anthropic   │      │  generation)    │
                 └───────┬────────┘      └───────┬────────┘
                         │                       │
                         │ expanded sub-queries  │
                         └───────────┬───────────┘
                                     │
              ┌──────────────────────┼──────────────────────┐
              ▼                      ▼                      ▼
     ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
     │   Lexical (FTS) │    │  Vector (embed) │    │  HyDE (embed)   │
     │   BM25 keyword  │    │  ┌───────────┐  │    │  ┌───────────┐  │
     │   search        │    │  │ local:    │  │    │  │ local:    │  │
     │                 │    │  │ embed-gem │  │    │  │ embed-gem │  │
     │                 │    │  │ remote:   │  │    │  │ remote:   │  │
     │                 │    │  │ OpenAI    │  │    │  │ OpenAI    │  │
     │                 │    │  │ Cohere    │  │    │  │ Cohere    │  │
     │                 │    │  │ Ollama    │  │    │  │ Ollama    │  │
     │                 │    │  │ vLLM      │  │    │  │ vLLM      │  │
     │                 │    │  └───────────┘  │    │  └───────────┘  │
     └────────┬────────┘    └────────┬────────┘    └────────┬────────┘
              │                      │                      │
              └──────────────────────┼──────────────────────┘
                                     │
                                     ▼
                          ┌───────────────────────┐
                          │     RRF Fusion        │
                          │  k=60, weighted       │
                          │  Original query: ×2.0 │
                          │  Expansions:     ×1.0 │
                          │  Top-rank bonus:+0.05 │
                          │  ── Top 30 kept ──    │
                          └───────────┬───────────┘
                                      │
                                      ▼
                          ┌───────────────────────┐
                          │  Chunk + Cross-encoder│
                          │       Rerank          │
                          │                       │
                          │ Chunk top candidates  │
                          │ → rerank per-chunk    │
                          │ ┌───────────────────┐ │
                          │ │ local: qwen3-0.6B │ │
                          │ │ remote: Cohere    │ │
                          │ │ / vLLM Score API  │ │
                          │ └───────────────────┘ │
                          └───────────┬───────────┘
                                      │
                                      ▼
                          ┌───────────────────────┐
                          │  Position-Aware       │
                          │    Score Blend        │
                          │                       │
                          │ Rank 1-3:  75% RRF    │
                          │ Rank 4-10: 60% RRF    │
                          │ Rank 11+:  40% RRF    │
                          └───────────┬───────────┘
                                      │
                                      ▼
                          ┌───────────────────────┐
                          │    Final Results      │
                          │  (score + snippet +   │
                          │   docid + context)    │
                          └───────────────────────┘
```

## Score Normalization & Fusion

### Search Backends

| Backend | Raw Score | Conversion | Range |
|---------|-----------|------------|-------|
| **FTS (BM25)** | SQLite FTS5 BM25 | `Math.abs(score)` | 0 to ~25+ |
| **Vector** | Cosine distance | `1 / (1 + distance)` | 0.0 to 1.0 |
| **Reranker** | LLM 0-10 rating | `score / 10` | 0.0 to 1.0 |

### Fusion Strategy

The `query` command uses **Reciprocal Rank Fusion (RRF)** with position-aware blending:

1. **Query Expansion**: Original query (×2 for weighting) + 1 LLM variation
2. **Parallel Retrieval**: Each query searches both FTS and vector indexes
3. **RRF Fusion**: Combine all result lists using `score = Σ(1/(k+rank+1))` where k=60
4. **Top-Rank Bonus**: Documents ranking #1 in any list get +0.05, #2-3 get +0.02
5. **Top-K Selection**: Take top 30 candidates for reranking
6. **Re-ranking**: LLM scores each document (yes/no with logprobs confidence)
7. **Position-Aware Blending**:
   - RRF rank 1-3: 75% retrieval, 25% reranker (preserves exact matches)
   - RRF rank 4-10: 60% retrieval, 40% reranker
   - RRF rank 11+: 40% retrieval, 60% reranker (trust reranker more)

**Why this approach**: Pure RRF can dilute exact matches when expanded queries don't match. The top-rank bonus preserves documents that score #1 for the original query. Position-aware blending prevents the reranker from destroying high-confidence retrieval results.

### Score Interpretation

| Score | Meaning |
|-------|---------|
| 0.8 - 1.0 | Highly relevant |
| 0.5 - 0.8 | Moderately relevant |
| 0.2 - 0.5 | Somewhat relevant |
| 0.0 - 0.2 | Low relevance |

## Requirements

### System Requirements

- **Node.js** >= 22
- **Bun** >= 1.0.0 (optional alternative runtime)
- **macOS**: Homebrew SQLite (for extension support)
  ```sh
  brew install sqlite
  ```

### GGUF Models (via node-llama-cpp)

QMD uses three local GGUF models (auto-downloaded on first use):

| Model | Purpose | Size |
|-------|---------|------|
| `embeddinggemma-300M-Q8_0` | Vector embeddings (default) | ~300MB |
| `qwen3-reranker-0.6b-q8_0` | Re-ranking | ~640MB |
| `qmd-query-expansion-1.7B-q4_k_m` | Query expansion (fine-tuned) | ~1.1GB |

Models are downloaded from HuggingFace and cached in `~/.cache/qmd/models/`.

### Custom Embedding Model

Override the default embedding model via the `QMD_EMBED_MODEL` environment variable.
This is useful for multilingual corpora (e.g. Chinese, Japanese, Korean) where
`embeddinggemma-300M` has limited coverage.

```sh
# Use Qwen3-Embedding-0.6B for better multilingual (CJK) support
export QMD_EMBED_MODEL="hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf"

# After changing the model, re-embed all collections:
qmd embed -f
```

Supported model families:
- **embeddinggemma** (default) — English-optimized, small footprint
- **Qwen3-Embedding** — Multilingual (119 languages including CJK), MTEB top-ranked

> **Note:** When switching embedding models, you must re-index with `qmd embed -f`
> since vectors are not cross-compatible between models. The prompt format is
> automatically adjusted for each model family.

## Installation

```sh
npm install -g @tobilu/qmd
# or
bun install -g @tobilu/qmd
```

### Development

```sh
git clone https://github.com/tobi/qmd
cd qmd
npm install
npm link
```

## Usage

### Collection Management

```sh
# Create a collection from current directory
qmd collection add . --name myproject

# Create a collection with explicit path and custom glob mask
qmd collection add ~/Documents/notes --name notes --mask "**/*.md"

# List all collections
qmd collection list

# Remove a collection
qmd collection remove myproject

# Rename a collection
qmd collection rename myproject my-project

# List files in a collection
qmd ls notes
qmd ls notes/subfolder
```

### Generate Vector Embeddings

```sh
# Embed all indexed documents (900 tokens/chunk, 15% overlap)
qmd embed

# Force re-embed everything
qmd embed -f

# Enable AST-aware chunking for code files (TS, JS, Python, Go, Rust)
qmd embed --chunk-strategy auto

# Also works with query for consistent chunk selection
qmd query "auth flow" --chunk-strategy auto
```

**AST-aware chunking** (`--chunk-strategy auto`) uses tree-sitter to chunk code
files at function, class, and import boundaries instead of arbitrary text
positions. This produces higher-quality chunks and better search results for
codebases. Markdown and other file types always use regex-based chunking
regardless of strategy.

The default is `regex` (existing behavior). Use `--chunk-strategy auto` to
opt in. Run `qmd status` to verify which grammars are available.

> **Note:** Tree-sitter grammars are optional dependencies. If they are not
> installed, `--chunk-strategy auto` falls back to regex-only chunking
> automatically. Tested on both Node.js and Bun.

### Context Management

Context adds descriptive metadata to collections and paths, helping search understand your content.

```sh
# Add context to a collection (using qmd:// virtual paths)
qmd context add qmd://notes "Personal notes and ideas"
qmd context add qmd://docs/api "API documentation"

# Add context from within a collection directory
cd ~/notes && qmd context add "Personal notes and ideas"
cd ~/notes/work && qmd context add "Work-related notes"

# Add global context (applies to all collections)
qmd context add / "Knowledge base for my projects"

# List all contexts
qmd context list

# Remove context
qmd context rm qmd://notes/old
```

### Search Commands

```
┌──────────────────────────────────────────────────────────────────┐
│                        Search Modes                              │
├──────────┬───────────────────────────────────────────────────────┤
│ search   │ BM25 full-text search only                           │
│ vsearch  │ Vector semantic search only                          │
│ query    │ Hybrid: FTS + Vector + Query Expansion + Re-ranking  │
└──────────┴───────────────────────────────────────────────────────┘
```

```sh
# Full-text search (fast, keyword-based)
qmd search "authentication flow"

# Vector search (semantic similarity)
qmd vsearch "how to login"

# Hybrid search with re-ranking (best quality)
qmd query "user authentication"
```

### Options

```sh
# Search options
-n <num>           # Number of results (default: 5, or 20 for --files/--json)
-c, --collection   # Restrict search to a specific collection
--all              # Return all matches (use with --min-score to filter)
--min-score <num>  # Minimum score threshold (default: 0)
--full             # Show full document content
--line-numbers     # Add line numbers to output
--explain          # Include retrieval score traces (query, JSON/CLI output)
--index <name>     # Use named index

# Output formats (for search and multi-get)
--files            # Output: docid,score,filepath,context
--json             # JSON output with snippets
--csv              # CSV output
--md               # Markdown output
--xml              # XML output

# Get options
qmd get <file>[:line]  # Get document, optionally starting at line
-l <num>               # Maximum lines to return
--from <num>           # Start from line number

# Multi-get options
-l <num>           # Maximum lines per file
--max-bytes <num>  # Skip files larger than N bytes (default: 10KB)
```

### Output Format

Default output is colorized CLI format (respects `NO_COLOR` env).

When stdout is a TTY, result paths are emitted as clickable terminal hyperlinks (OSC 8). Clicking a path opens the file in your editor using an editor URI template.

When stdout is not a TTY (for example piped to another command or redirected to a file), QMD emits plain text paths with no escape sequences.

TTY example:

```
docs/guide.md:42 #a1b2c3
Title: Software Craftsmanship
Context: Work documentation
Score: 93%

This section covers the **craftsmanship** of building
quality software with attention to detail.
See also: engineering principles


notes/meeting.md:15 #d4e5f6
Title: Q4 Planning
Context: Personal notes and ideas
Score: 67%

Discussion about code quality and craftsmanship
in the development process.
```

Configure the editor link target with `QMD_EDITOR_URI` (or `editor_uri` in config):

```sh
# VS Code (default)
export QMD_EDITOR_URI="vscode://file/{path}:{line}:{col}"

# Cursor
export QMD_EDITOR_URI="cursor://file/{path}:{line}:{col}"

# Zed
export QMD_EDITOR_URI="zed://file/{path}:{line}:{col}"

# Sublime Text
export QMD_EDITOR_URI="subl://open?url=file://{path}&line={line}"
```

Template placeholders:
- `{path}` absolute filesystem path (URI-encoded)
- `{line}` 1-based line number
- `{col}` or `{column}` 1-based column number

- **Path**: Collection-relative path (e.g., `docs/guide.md`)
- **Docid**: Short hash identifier (e.g., `#a1b2c3`) - use with `qmd get #a1b2c3`
- **Title**: Extracted from document (first heading or filename)
- **Context**: Path context if configured via `qmd context add`
- **Score**: Color-coded (green >70%, yellow >40%, dim otherwise)
- **Snippet**: Context around match with query terms highlighted

### Examples

```sh
# Get 10 results with minimum score 0.3
qmd query -n 10 --min-score 0.3 "API design patterns"

# Output as markdown for LLM context
qmd search --md --full "error handling"

# JSON output for scripting
qmd query --json "quarterly reports"

# Inspect how each result was scored (RRF + rerank blend)
qmd query --json --explain "quarterly reports"

# Use separate index for different knowledge base
qmd --index work search "quarterly reports"
```

### Index Maintenance

```sh
# Show index status and collections with contexts
qmd status

# Re-index all collections
qmd update

# Re-index with git pull first (for remote repos)
qmd update --pull

# Get document by filepath (with fuzzy matching suggestions)
qmd get notes/meeting.md

# Get document by docid (from search results)
qmd get "#abc123"

# Get document starting at line 50, max 100 lines
qmd get notes/meeting.md:50 -l 100

# Get multiple documents by glob pattern
qmd multi-get "journals/2025-05*.md"

# Get multiple documents by comma-separated list (supports docids)
qmd multi-get "doc1.md, doc2.md, #abc123"

# Limit multi-get to files under 20KB
qmd multi-get "docs/*.md" --max-bytes 20480

# Output multi-get as JSON for agent processing
qmd multi-get "docs/*.md" --json

# Clean up cache and orphaned data
qmd cleanup
```

## Data Storage

Index stored in: `~/.cache/qmd/index.sqlite`

### Schema

```sql
collections     -- Indexed directories with name and glob patterns
path_contexts   -- Context descriptions by virtual path (qmd://...)
documents       -- Markdown content with metadata and docid (6-char hash)
documents_fts   -- FTS5 full-text index
content_vectors -- Embedding chunks (hash, seq, pos, 900 tokens each)
vectors_vec     -- sqlite-vec vector index (hash_seq key)
llm_cache       -- Cached LLM responses (query expansion, rerank scores)
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `XDG_CACHE_HOME` | `~/.cache` | Cache directory location |
| `QMD_LLAMA_GPU` | `auto` | Force llama.cpp GPU backend (`metal`, `vulkan`, `cuda`) or disable GPU with `false` |
| `QMD_FORCE_CPU` | unset | Set to `1`/`true` to force CPU mode before any CUDA/Vulkan/Metal probing. Equivalent CLI flag: `--no-gpu`. |
| `QMD_EMBED_PARALLELISM` | automatic | Override embedding/reranking context parallelism (1-8). Windows CUDA defaults to `1` because parallel CUDA contexts can crash with `ggml-cuda.cu:98`; use Vulkan or raise this only if your driver is stable. |

### Remote LLM Endpoints

QMD can run fully local or delegate each LLM role to remote APIs. Roles are independent, so you can mix providers and protocols.

#### Remote Setup Checklist

1. Decide which roles you want remote (`embed`, `expand`, `rerank`, `generate`).
2. Set each role's `*_api_url`, `*_api_format`, and `*_api_model` in YAML or env vars.
3. Add API keys only for endpoints that require auth.
4. Run `qmd embed` (or `qmd embed -f` after model changes) and validate with `qmd vsearch` / `qmd query`.

#### RemoteLLM Roles

| Role | Used for | Typical route(s) |
|------|----------|------------------|
| `embed` | `qmd embed`, vector search (`vsearch`, hybrid pipeline) | `/v1/embeddings`, `/v2/embed`, `/embed`, `/pooling`, `/v1/pooling` |
| `expand` | Query expansion in hybrid search | `/v1/chat/completions`, `/v1/completions`, `/v1/responses`, `/v1/messages` |
| `rerank` | Final relevance sorting of candidate chunks | `/rerank`, `/v1/rerank`, `/v2/rerank`, `/score`, `/v1/score` |
| `generate` | General text generation path (SDK/adapter surface) | `/v1/chat/completions`, `/v1/completions`, `/v1/responses`, `/v1/messages` |

#### Activation and Precedence

QMD stays local by default. Remote mode is activated when any remote endpoint URL is configured:

- env vars: `QMD_*_BASE_URL`
- YAML: `models.*_api_url`
- backward-compat embed trigger: `OPENAI_BASE_URL`

Precedence is:

1. Environment variables (`QMD_*`)
2. YAML config (`~/.config/qmd/index.yml`, `models:`)
3. Backward-compat embed fallbacks (`OPENAI_BASE_URL`/`OPENAI_API_KEY`)

#### Endpoint Formats and Adapter Mapping

Allowed `*_api_format` values:

| Role | Allowed formats |
|------|-----------------|
| `embed` | `auto`, `openai_v1_embeddings`, `cohere_v2_embed`, `ollama_embed`, `vllm_pooling` |
| `expand` | `auto`, `openai_chat_completions`, `openai_completions`, `openai_responses`, `anthropic_messages` |
| `rerank` | `auto`, `cohere_v1_rerank`, `cohere_v2_rerank`, `vllm_score` |
| `generate` | `auto`, `openai_chat_completions`, `openai_completions`, `openai_responses`, `anthropic_messages` |

Adapter notes:

- `auto` keeps legacy behavior.
- `cohere_v2_embed` uses the Cohere-compatible embed adapter with path/payload/input-type fallback.
- `vllm_pooling` uses the vLLM Pooling adapter (`/pooling` with `/v1/pooling` fallback).
- `cohere_v1_rerank` / `cohere_v2_rerank` use the Cohere-compatible rerank adapter.
- `vllm_score` uses the vLLM Score adapter (`/score` with `/v1/score` fallback).
- `anthropic_messages` uses `x-api-key` + `anthropic-version` headers and `/messages` payloads.

#### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `QMD_EMBED_BASE_URL` | — | Embed API base URL |
| `QMD_EMBED_API_FORMAT` | `auto` | Embed protocol |
| `QMD_EMBED_MODEL` | *(empty, local)* | Embed model name |
| `QMD_EMBED_API_KEY` | — | Embed bearer token |
| `QMD_EXPAND_BASE_URL` | *(empty, local)* | Expand API base URL |
| `QMD_EXPAND_API_FORMAT` | `auto` | Expand protocol |
| `QMD_EXPAND_MODEL` | *(empty, local)* | Expand model name |
| `QMD_EXPAND_API_KEY` | — | Expand API key/token |
| `QMD_RERANK_BASE_URL` | *(empty, local)* | Rerank API base URL |
| `QMD_RERANK_API_FORMAT` | `auto` | Rerank protocol |
| `QMD_RERANK_MODEL` | *(empty, local)* | Rerank model name |
| `QMD_RERANK_API_KEY` | — | Rerank bearer token |
| `QMD_GENERATE_BASE_URL` | *(empty, local)* | Generate API base URL |
| `QMD_GENERATE_API_FORMAT` | `auto` | Generate protocol |
| `QMD_GENERATE_MODEL` | *(empty, local)* | Generate model name |
| `QMD_GENERATE_API_KEY` | — | Generate API key/token |
| `OPENAI_BASE_URL` | — | Backward-compat embed URL fallback |
| `OPENAI_API_KEY` | — | API key fallback for endpoints |

#### YAML Configuration (Full Multi-Endpoint Example)

```yaml
models:
  # Local defaults are still useful as fallback documentation in your config.
  embed: hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf
  rerank: hf:ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF/qwen3-reranker-0.6b-q8_0.gguf
  generate: hf:tobil/qmd-query-expansion-1.7B-gguf/qmd-query-expansion-1.7B-q4_k_m.gguf

  embed_api_url: http://localhost:11434/v1
  embed_api_format: openai_v1_embeddings
  embed_api_model: Qwen/Qwen3-Embedding-0.6B
  embed_api_key: ""

  expand_api_url: https://openrouter.ai/api/v1
  expand_api_format: openai_chat_completions
  expand_api_model: google/gemini-2.0-flash-lite-001
  expand_api_key: sk-or-...

  rerank_api_url: https://openrouter.ai/api/v1
  rerank_api_format: cohere_v1_rerank
  rerank_api_model: cohere/rerank-v3.5
  rerank_api_key: sk-or-...

  generate_api_url: https://openrouter.ai/api/v1
  generate_api_format: openai_chat_completions
  generate_api_model: google/gemini-2.0-flash-lite-001
  generate_api_key: sk-or-...
```

Environment variables override YAML values.

#### Common Remote Profiles

OpenAI-compatible `/v1/embeddings` only:

```yaml
models:
  embed_api_url: http://your-host:port/v1
  embed_api_format: openai_v1_embeddings
  embed_api_model: Qwen/Qwen3-Embedding-0.6B
```

vLLM Cohere-compatible embed endpoint (your fork use case):

```yaml
models:
  embed_api_url: http://10.0.0.165:8000
  embed_api_format: cohere_v2_embed
  embed_api_model: qwen3-embedding-0.6b
```

Use the exact model id returned by `GET /v1/models`.

vLLM Score API reranking:

```yaml
models:
  rerank_api_url: http://10.0.0.165:8000
  rerank_api_format: vllm_score
  rerank_api_model: BAAI/bge-reranker-v2-m3
```

Anthropic Messages for expand/generate:

```yaml
models:
  expand_api_url: https://api.anthropic.com/v1
  expand_api_format: anthropic_messages
  expand_api_model: your-claude-model-id
  expand_api_key: sk-ant-...

  generate_api_url: https://api.anthropic.com/v1
  generate_api_format: anthropic_messages
  generate_api_model: your-claude-model-id
  generate_api_key: sk-ant-...
```

#### Remote Embed Behavior in This Fork (`cohere_v2_embed`)

1. Endpoint fallback:
   `.../v2/embed` first, then `.../embed`.
2. Request-shape fallback:
   `inputs` object form first, then `texts` array form.
3. `input_type` fallback:
   query mode: `search_query` then `query`; document mode: `search_document` then `document`.
4. Response normalization:
   accepts Cohere-style and compatible embedding payload shapes.
5. Safety checks:
   embedding count and dimension consistency are validated.

The adapter caches the last successful endpoint path, request shape, and input type per base URL.

#### Query vs Document Embeddings

This fork forwards query intent through batch embedding paths (`isQuery: true`) in hybrid and structured search, so remote providers that support query/document embedding modes can improve retrieval quality.

#### Remote Tokenizer Support

When running against remote embedding providers, QMD can also use vLLM-style tokenizer endpoints for exact token-aware chunking during embedding:

- Probes `/tokenize` with `/v1/tokenize` fallback
- Uses `/detokenize` with `/v1/detokenize` fallback when it needs to trim chunks precisely
- Defaults to automatic detection in remote mode
- Falls back to character-based chunking with approximate token counts if tokenizer endpoints are unavailable

Useful environment variables:

- `QMD_REMOTE_TOKENIZER=auto|off|force` to control remote tokenizer use
- `QMD_TOKENIZER_BASE_URL` / `QMD_TOKENIZER_MODEL` / `QMD_TOKENIZER_API_KEY` to override the tokenizer endpoint independently of the embed endpoint
- `QMD_REMOTE_TOKENIZER_TIMEOUT_MS` to adjust tokenizer request timeout

#### Graceful Degradation Behavior

- Missing expand key: expansion falls back to passthrough/fallback query variants.
- Missing rerank key: reranking returns uniform scores instead of failing search.
- Generate failures: return `null` for generation calls without breaking indexing/search.

#### Verification Workflow

1. Confirm the model id on the remote endpoint:
   `curl -s http://HOST:PORT/v1/models | jq .`
2. Generate vectors:
   `qmd embed -f`
3. Run semantic search:
   `qmd vsearch "test query"`
4. Run hybrid search (expand + rerank path):
   `qmd query "test query"`
5. Inspect index health:
   `qmd status`

#### Troubleshooting

| Symptom | Likely Cause | Fix |
|---------|--------------|-----|
| `Embedding dimension mismatch` | Remote embedding model changed after vectors were created | Rebuild vectors with `qmd embed -f` |
| HTTP 404/405 on embed | Wrong path contract (`/v1/embeddings` vs `/v2/embed`) | Set `embed_api_format` correctly and verify `embed_api_url` base |
| Poor hybrid quality | Query/document mode not supported by provider or wrong embed model | Use provider-native embedding model and verify `input_type` support |
| Rerank always uniform | Missing/invalid rerank key or rerank endpoint errors | Set `rerank_api_key`, validate rerank URL/model |
| Expand returns mostly original query | Missing expand key or format mismatch | Set `expand_api_key`, verify `expand_api_format` and endpoint protocol |

## How It Works

### Indexing Flow

```
Collection ──► Glob Pattern ──► Markdown Files ──► Parse Title ──► Hash Content
    │                                                   │              │
    │                                                   │              ▼
    │                                                   │         Generate docid
    │                                                   │         (6-char hash)
    │                                                   │              │
    └──────────────────────────────────────────────────►└──► Store in SQLite
                                                                       │
                                                                       ▼
                                                                  FTS5 Index
```

### Embedding Flow

Documents are chunked into ~900-token pieces with 15% overlap using smart boundary detection:

```
Document ──► Smart Chunk (~900 tokens) ──► Format each chunk ──► node-llama-cpp ──► Store Vectors
                │                           "title | text"        embedBatch()
                │
                └─► Chunks stored with:
                    - hash: document hash
                    - seq: chunk sequence (0, 1, 2...)
                    - pos: character position in original
```

### Smart Chunking

Instead of cutting at hard token boundaries, QMD uses a scoring algorithm to find natural markdown break points. This keeps semantic units (sections, paragraphs, code blocks) together.

**Break Point Scores:**

| Pattern | Score | Description |
|---------|-------|-------------|
| `# Heading` | 100 | H1 - major section |
| `## Heading` | 90 | H2 - subsection |
| `### Heading` | 80 | H3 |
| `#### Heading` | 70 | H4 |
| `##### Heading` | 60 | H5 |
| `###### Heading` | 50 | H6 |
| ` ``` ` | 80 | Code block boundary |
| `---` / `***` | 60 | Horizontal rule |
| Blank line | 20 | Paragraph boundary |
| `- item` / `1. item` | 5 | List item |
| Line break | 1 | Minimal break |

**Algorithm:**

1. Scan document for all break points with scores
2. When approaching the 900-token target, search a 200-token window before the cutoff
3. Score each break point: `finalScore = baseScore × (1 - (distance/window)² × 0.7)`
4. Cut at the highest-scoring break point

The squared distance decay means a heading 200 tokens back (score ~30) still beats a simple line break at the target (score 1), but a closer heading wins over a distant one.

**Code Fence Protection:** Break points inside code blocks are ignored—code stays together. If a code block exceeds the chunk size, it's kept whole when possible.

**AST-Aware Chunking (Code Files):**

For supported code files, QMD also parses the source with [tree-sitter](https://tree-sitter.github.io/) and adds AST-derived break points that are merged with the regex scores above:

| AST Node | Score | Languages |
|----------|-------|-----------|
| Class / interface / struct / impl / trait | 100 | All |
| Function / method | 90 | All |
| Type alias / enum | 80 | All |
| Import / use declaration | 60 | All |

Supported for `.ts`, `.tsx`, `.js`, `.jsx`, `.py`, `.go`, and `.rs` files. Enable with `--chunk-strategy auto`. Markdown and other file types always use regex chunking.

### Query Flow (Hybrid)

```
Query ──► LLM Expansion ──► [Original, Variant 1, Variant 2]
                │
      ┌─────────┴─────────┐
      ▼                   ▼
   For each query:     FTS (BM25)
      │                   │
      ▼                   ▼
   Vector Search      Ranked List
      │
      ▼
   Ranked List
      │
      └─────────┬─────────┘
                ▼
         RRF Fusion (k=60)
         Original query ×2 weight
         Top-rank bonus: +0.05/#1, +0.02/#2-3
                │
                ▼
         Top 30 candidates
                │
                ▼
         LLM Re-ranking
         (yes/no + logprob confidence)
                │
                ▼
         Position-Aware Blend
         Rank 1-3:  75% RRF / 25% reranker
         Rank 4-10: 60% RRF / 40% reranker
         Rank 11+:  40% RRF / 60% reranker
                │
                ▼
         Final Results
```

## Model Configuration

Models are configured in `src/llm.ts` as HuggingFace URIs:

```typescript
const DEFAULT_EMBED_MODEL = "hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf";
const DEFAULT_RERANK_MODEL = "hf:ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF/qwen3-reranker-0.6b-q8_0.gguf";
const DEFAULT_GENERATE_MODEL = "hf:tobil/qmd-query-expansion-1.7B-gguf/qmd-query-expansion-1.7B-q4_k_m.gguf";
```

### EmbeddingGemma Prompt Format

```
// For queries
"task: search result | query: {query}"

// For documents
"title: {title} | text: {content}"
```

### Qwen3-Reranker

Uses node-llama-cpp's `createRankingContext()` and `rankAndSort()` API for cross-encoder reranking. Returns documents sorted by relevance score (0.0 - 1.0).

### Qwen3 (Query Expansion)

Used for generating query variations via `LlamaChatSession`.

## License

MIT
