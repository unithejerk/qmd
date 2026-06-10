/**
 * Test helper — CLI subprocess runner and fixture setup for CLI integration tests.
 *
 * Extracted from test/cli.test.ts. Each split test file imports these helpers,
 * creates its own temp dir in beforeAll, and manages fixtures independently.
 */
import { chmod, copyFile, mkdtemp, rm, writeFile, mkdir } from "fs/promises";
import { existsSync, lstatSync, readFileSync, symlinkSync, writeFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";

// Detect runtime to pick tsx (Node) vs bun (Bun)
const thisDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(thisDir, "..", "..");
const qmdScript = join(projectRoot, "src", "cli", "qmd.ts");
const isBunRuntime = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
const tsxCli = join(projectRoot, "node_modules", "tsx", "dist", "cli.mjs");

export const qmdCommand = isBunRuntime
  ? { command: process.execPath, args: [qmdScript] }
  : { command: process.execPath, args: [tsxCli, qmdScript] };

export function qmdRunnerArgs(args: string[]): { command: string; args: string[] } {
  return { command: qmdCommand.command, args: [...qmdCommand.args, ...args] };
}

/** Spawn a qmd subprocess and return stdout, stderr, and exit code. */
export async function runQmd(
  args: string[],
  options: {
    cwd?: string;
    env?: Record<string, string>;
    dbPath: string;
    configDir: string;
  }
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const runner = qmdRunnerArgs(args);
  const proc = spawn(runner.command, runner.args, {
    cwd: options.cwd || process.cwd(),
    env: {
      ...process.env,
      INDEX_PATH: options.dbPath,
      QMD_CONFIG_DIR: options.configDir,
      PWD: options.cwd || process.cwd(),
      QMD_DOCTOR_DEVICE_PROBE: "0",
      ...options.env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const stdoutPromise = new Promise<string>((resolve, reject) => {
    let data = "";
    proc.stdout?.on("data", (chunk: Buffer) => { data += chunk.toString(); });
    proc.once("error", reject);
    proc.stdout?.once("end", () => resolve(data));
  });
  const stderrPromise = new Promise<string>((resolve, reject) => {
    let data = "";
    proc.stderr?.on("data", (chunk: Buffer) => { data += chunk.toString(); });
    proc.once("error", reject);
    proc.stderr?.once("end", () => resolve(data));
  });
  const exitCode = await new Promise<number>((resolve, reject) => {
    proc.once("error", reject);
    proc.on("close", (code) => resolve(code ?? 1));
  });
  return { stdout: await stdoutPromise, stderr: await stderrPromise, exitCode };
}

/** Create the standard test fixture files under the given directory. */
export async function createFixtures(fixturesDir: string): Promise<void> {
  await mkdir(fixturesDir, { recursive: true });
  await mkdir(join(fixturesDir, "notes"), { recursive: true });
  await mkdir(join(fixturesDir, "docs"), { recursive: true });

  await writeFile(join(fixturesDir, "README.md"), `# Test Project\n\nThis is a test project for QMD CLI testing.\n\n## Features\n\n- Full-text search with BM25\n- Vector similarity search\n- Hybrid search with reranking\n`);
  await writeFile(join(fixturesDir, "notes", "meeting.md"), `# Team Meeting Notes\n\nDate: 2024-01-15\n\n## Attendees\n- Alice\n- Bob\n- Charlie\n\n## Discussion Topics\n- Project timeline review\n- Resource allocation\n- Technical debt prioritization\n\n## Action Items\n1. Alice to update documentation\n2. Bob to fix authentication bug\n3. Charlie to review pull requests\n`);
  await writeFile(join(fixturesDir, "notes", "ideas.md"), `# Product Ideas\n\n## Feature Requests\n- Dark mode support\n- Keyboard shortcuts\n- Export to PDF\n\n## Technical Improvements\n- Improve search performance\n- Add caching layer\n- Optimize database queries\n`);
  await writeFile(join(fixturesDir, "docs", "api.md"), `# API Documentation\n\n## Endpoints\n\n### GET /search\nSearch for documents.\n\nParameters:\n- q: Search query (required)\n- limit: Max results (default: 10)\n\n### GET /document/:id\nRetrieve a specific document.\n\n### POST /index\nIndex new documents.\n`);
  await writeFile(join(fixturesDir, "test1.md"), `# Test Document 1\n\nThis is the first test document.\n\nIt has multiple lines for testing line numbers.\nLine 6 is here.\nLine 7 is here.\n`);
  await writeFile(join(fixturesDir, "test2.md"), `# Test Document 2\n\nThis is the second test document.\n`);
}

/** Set up the full CLI test environment: temp dir, config, fixtures. */
export async function setupCliTestEnv(): Promise<{
  testDir: string;
  dbPath: string;
  configDir: string;
  fixturesDir: string;
}> {
  const testDir = await mkdtemp(join(tmpdir(), "qmd-test-"));
  const dbPath = join(testDir, "test.sqlite");
  const configDir = join(testDir, "config");
  const fixturesDir = join(testDir, "fixtures");

  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, "index.yml"), "collections: {}\n");
  await createFixtures(fixturesDir);

  return { testDir, dbPath, configDir, fixturesDir };
}

/** Clean up the test environment. */
export async function teardownCliTestEnv(testDir: string): Promise<void> {
  if (testDir) {
    await rm(testDir, { recursive: true, force: true });
  }
}

/** Create an isolated test environment (db + config dir) within an existing testDir. */
export async function createIsolatedTestEnv(
  testDir: string,
  prefix: string
): Promise<{ dbPath: string; configDir: string }> {
  const dbPath = join(testDir, `${prefix}-${Date.now()}.sqlite`);
  const configDir = join(testDir, `${prefix}-config-${Date.now()}`);
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, "index.yml"), "collections: {}\n");
  return { dbPath, configDir };
}
