# Test Modularization Plan

## Status

| File | Lines | Status |
|------|-------|--------|
| `test/remote.test.ts` | 3,406 | ✅ Split into 23 files under `test/remote/` |
| `test/store.test.ts` | 2,634 | ❌ This plan |
| `test/cli.test.ts` | 2,479 | ❌ This plan |

## Strategy

Use the same approach that worked for remote tests: extract shared helpers via agents (the part that needs judgment), then mechanical splitting via scripts (the part that doesn't). **2 agents total** — one for store, one for CLI — plus scripts I run directly.

---

## Wave 1 — Extract helpers (2 agents, parallel)

### Agent A: Create `test/helpers/store.ts`

Read `test/store.test.ts` lines 57–258. Extract the 6 helper functions and module-level state into a clean helper module. This is the only part of the store split that needs judgment — the helpers reference `testDir`, `testConfigDir`, and `currentTestStore` as module-level variables that must become function parameters.

**Exports to create:**
- `setupTestDir()` — mkdtemp, return path
- `teardownTestDir(dir)` — rm -rf
- `createTestStore(testDir)` — temp YAML config + Store, returns `{ store, configDir }`
- `cleanupTestStore(store, configDir)` — close, unlink, cleanup config dir
- `insertTestDocument(db, collectionName, opts)`
- `syncTestConfig(store, configDir)`
- `createTestCollection(store, configDir, opts)`
- `addPathContext(store, configDir, collectionName, pathPrefix, contextText)`
- `addGlobalContext(store, configDir, contextText)`

**Key transformation:** Replace module-level closures over `testDir`/`testConfigDir`/`currentTestStore` with explicit parameters. The `beforeAll`/`afterAll` at lines 239–258 stays in the source file (the splitter script will replicate it per file).

### Agent B: Create `test/helpers/cli.ts`

Read `test/cli.test.ts` lines 29–101. Extract the subprocess runner and fixture setup into a helper.

**Exports to create:**
- `qmdCommand` — resolved `{ command, args }` for Bun vs Node
- `runQmd(args, opts)` — spawn qmd subprocess, return `{ stdout, stderr, exitCode }`
- `createTestFixtures(testDir)` — creates README.md, notes/, docs/ fixture files
- `getFreshDbPath(testDir)` — unique SQLite path per test
- `createIsolatedTestEnv(testDir, prefix)` — `{ dbPath, configDir }`

---

## Wave 2 — Split files (scripts, run by me directly)

Once both helpers exist, I run two splitter scripts:

### Script 1: `scripts/split-store-tests.mjs`

Reads `test/store.test.ts`, finds each top-level `describe(` block, and writes it to `test/store/{name}.test.ts` with:

- LLM-friendly JSDoc header
- DB-dependent blocks: imports from `../../src/store.js` + `../helpers/store.js` + `../../src/llm.js` + `beforeAll`/`afterAll`
- Pure-function blocks (Snippet Extraction, RRF, Virtual Paths, Docid): just vitest + the specific store functions
- Body copied verbatim, with these replacements in test bodies:
  - `createTestStore()` → `await createTestStore(testDir)`
  - `cleanupTestDb(store)` → `await cleanupTestStore(store, configDir)`
  - Function calls to `insertTestDocument()`, `createTestCollection()`, etc. → use helper versions
  - `testConfigDir` → `configDir` (local variable from createTestStore)

The 12 output files:

| File | Source lines | DB needed |
|------|-------------|-----------|
| `creation.test.ts` | 265–463 | Yes |
| `path-context.test.ts` | 464–518 | Yes |
| `fts-search.test.ts` | 519–979 | Yes |
| `document-retrieval.test.ts` | 980–1373 | Yes |
| `snippet-extraction.test.ts` | 1374–1547 | No |
| `reciprocal-rank-fusion.test.ts` | 1548–1658 | No |
| `fuzzy-matching.test.ts` | 1659–1769 | Yes |
| `vector-table.test.ts` | 1770–1846 | Yes |
| `integration.test.ts` | 1847–2241 | Yes + LLM |
| `edge-cases.test.ts` | 2242–2342 | Yes |
| `virtual-paths.test.ts` | 2343–2498 | No |
| `docid-and-path-fidelity.test.ts` | 2499–2634 | No |

### Script 2: `scripts/split-cli-tests.mjs`

Reads `test/cli.test.ts`, finds each top-level `describe(` block, and writes it to `test/cli/{name}.test.ts`. CLI tests are simpler — EVERY block spawns subprocesses via `runQmd()` and needs its own `beforeAll`/`afterAll` for temp dirs + fixtures. No shared mutable state.

The 26 output files follow the same naming convention as the describe strings: `help.test.ts`, `skills.test.ts`, `embed.test.ts`, etc.

---

## Wave 3 — Verify (me directly)

```sh
# Delete originals
rm test/store.test.ts test/cli.test.ts

# Run both suites
npx vitest run test/store/ test/cli/ --reporter=verbose
```

Fix any import path issues. The remote split taught us to watch for:
1. Dynamic imports with stale relative paths (CLI tests don't use these)
2. Helper functions called without proper imports
3. Tests that reference module-level variables from the old file

---

## Risk register

| Risk | Mitigation |
|------|-----------|
| Store module-level variables leak into split files | Helper requires explicit params; splitter script replaces them |
| Integration tests need LLM models | `integration.test.ts` gets a skip guard for CI |
| CLI subprocess spawns need env vars | `runQmd()` helper sets `INDEX_PATH` + `QMD_CONFIG_DIR` |
| Splitter script line ranges are wrong | Verify with `grep -n "describe("` before running |

## What we learned from the remote split

1. **Scripts beat agents for mechanical work.** The 23 remote files took 3 rounds of script fixes. A single splitter script with precise line ranges and pre-written import headers is more reliable.
2. **Helpers make everything easier.** Once `http-mock.ts` existed, each remote test file was self-contained. Same pattern here.
3. **Dynamic imports are the biggest footgun.** `vi.spyOn(await import('../src/...'))` paths change when files move. CLI tests don't use these, and store tests don't either (they use LLM directly, not via dynamic imports).
4. **Run the tests before deleting the original.** Verify all split files pass before removing the monolithic source.
