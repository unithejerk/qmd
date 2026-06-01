/**
 * Context management CLI commands
 *
 * Extracted from qmd.ts to reduce module size and clarify dependencies.
 */

import type { Database } from "../../db.js";
import { getDb, closeDb, resyncConfig, getStore } from "../lifecycle.js";
import {
  getPwd,
  getRealPath,
  homedir,
  resolve,
  isVirtualPath,
  parseVirtualPath,
} from "../../store.js";
import {
  setGlobalContext,
  getCollection as getCollectionFromYaml,
  addContext as yamlAddContext,
  removeContext as yamlRemoveContext,
  listCollections as yamlListCollections,
  listAllContexts,
} from "../../collections.js";

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

// =============================================================================
// Context detection
// =============================================================================

/**
 * Detect which collection (if any) contains the given filesystem path.
 * Returns { collectionName, relativePath } or null if not in any collection.
 */
export function detectCollectionFromPath(
  db: Database,
  fsPath: string,
): { collectionName: string; relativePath: string } | null {
  const realPath = getRealPath(fsPath);

  // Find collections that this path is under from YAML
  const allCollections = yamlListCollections();

  // Find longest matching path
  let bestMatch: { name: string; path: string } | null = null;
  for (const coll of allCollections) {
    if (realPath.startsWith(coll.path + "/") || realPath === coll.path) {
      if (!bestMatch || coll.path.length > bestMatch.path.length) {
        bestMatch = { name: coll.name, path: coll.path };
      }
    }
  }

  if (!bestMatch) return null;

  // Calculate relative path
  let relativePath = realPath;
  if (relativePath.startsWith(bestMatch.path + "/")) {
    relativePath = relativePath.slice(bestMatch.path.length + 1);
  } else if (relativePath === bestMatch.path) {
    relativePath = "";
  }

  return {
    collectionName: bestMatch.name,
    relativePath,
  };
}

// =============================================================================
// Context add
// =============================================================================

export async function contextAdd(
  pathArg: string | undefined,
  contextText: string,
): Promise<void> {
  const db = getDb();

  // Handle "/" as global context (applies to all collections)
  if (pathArg === "/") {
    setGlobalContext(contextText);
    resyncConfig();
    console.log(`${c.green}✓${c.reset} Set global context`);
    console.log(`${c.dim}Context: ${contextText}${c.reset}`);
    closeDb();
    return;
  }

  // Resolve path - defaults to current directory if not provided
  let fsPath = pathArg || ".";
  if (fsPath === "." || fsPath === "./") {
    fsPath = getPwd();
  } else if (fsPath.startsWith("~/")) {
    fsPath = homedir() + fsPath.slice(1);
  } else if (!fsPath.startsWith("/") && !fsPath.startsWith("qmd://")) {
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
      console.error(
        `${c.yellow}Collection not found: ${parsed.collectionName}${c.reset}`,
      );
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
    console.error(
      `${c.yellow}Path is not in any indexed collection: ${fsPath}${c.reset}`,
    );
    console.error(
      `${c.dim}Run 'qmd status' to see indexed collections${c.reset}`,
    );
    process.exit(1);
  }

  yamlAddContext(detected.collectionName, detected.relativePath, contextText);
  resyncConfig();

  const displayPath = detected.relativePath
    ? `qmd://${detected.collectionName}/${detected.relativePath}`
    : `qmd://${detected.collectionName}/`;
  console.log(`${c.green}✓${c.reset} Added context for: ${displayPath}`);
  console.log(`${c.dim}Context: ${contextText}${c.reset}`);
  closeDb();
}

// =============================================================================
// Context list
// =============================================================================

export function contextList(): void {
  const db = getDb();
  const allContexts = listAllContexts();

  if (allContexts.length === 0) {
    console.log(
      `${c.dim}No contexts configured. Use 'qmd context add' to add one.${c.reset}`,
    );
    closeDb();
    return;
  }

  console.log(`\n${c.bold}Configured Contexts${c.reset}\n`);

  let lastCollection = "";
  for (const ctx of allContexts) {
    if (ctx.collection !== lastCollection) {
      console.log(`${c.cyan}${ctx.collection}${c.reset}`);
      lastCollection = ctx.collection;
    }

    const displayPath = ctx.path ? `  ${ctx.path}` : "  / (root)";
    console.log(`${displayPath}`);
    console.log(`    ${c.dim}${ctx.context}${c.reset}`);
  }

  closeDb();
}

// =============================================================================
// Context remove
// =============================================================================

export function contextRemove(pathArg: string): void {
  if (pathArg === "/") {
    // Remove global context
    setGlobalContext(undefined);
    // Resync so SQLite store_config is updated
    getStore();
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
      console.error(
        `${c.yellow}Collection not found: ${parsed.collectionName}${c.reset}`,
      );
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
  if (fsPath === "." || fsPath === "./") {
    fsPath = getPwd();
  } else if (fsPath.startsWith("~/")) {
    fsPath = homedir() + fsPath.slice(1);
  } else if (!fsPath.startsWith("/")) {
    fsPath = resolve(getPwd(), fsPath);
  }

  const db = getDb();
  const detected = detectCollectionFromPath(db, fsPath);
  closeDb();

  if (!detected) {
    console.error(
      `${c.yellow}Path is not in any indexed collection: ${fsPath}${c.reset}`,
    );
    process.exit(1);
  }

  const success = yamlRemoveContext(
    detected.collectionName,
    detected.relativePath,
  );

  if (!success) {
    console.error(
      `${c.yellow}No context found for: qmd://${detected.collectionName}/${detected.relativePath}${c.reset}`,
    );
    process.exit(1);
  }

  console.log(
    `${c.green}✓${c.reset} Removed context for: qmd://${detected.collectionName}/${detected.relativePath}`,
  );
}
