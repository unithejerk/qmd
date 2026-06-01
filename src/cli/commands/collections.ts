/**
 * Collection management CLI commands
 *
 * Extracted from qmd.ts to reduce module size and clarify dependencies.
 */

import { getDb, closeDb, resyncConfig } from "../lifecycle.js";
import {
  listCollections,
  removeCollection,
  renameCollection,
} from "../../store.js";
import {
  addCollection,
  getCollection as getCollectionFromYaml,
  listCollections as yamlListCollections,
  removeCollection as yamlRemoveCollectionFn,
  renameCollection as yamlRenameCollectionFn,
} from "../../collections.js";
import { formatTimeAgo } from "./doctor.js";

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
// Collection list
// =============================================================================

export function collectionList(): void {
  const db = getDb();
  const collections = listCollections(db);

  if (collections.length === 0) {
    console.log(
      "No collections found. Run 'qmd collection add .' to create one.",
    );
    closeDb();
    return;
  }

  console.log(`${c.bold}Collections (${collections.length}):${c.reset}\n`);

  for (const coll of collections) {
    const updatedAt = coll.last_modified
      ? new Date(coll.last_modified)
      : new Date();
    const timeAgo = formatTimeAgo(updatedAt);

    // Get YAML config to check includeByDefault
    const yamlColl = getCollectionFromYaml(coll.name);
    const excluded = yamlColl?.includeByDefault === false;
    const excludeTag = excluded ? ` ${c.yellow}[excluded]${c.reset}` : "";

    console.log(
      `${c.cyan}${coll.name}${c.reset} ${c.dim}(qmd://${coll.name}/)${c.reset}${excludeTag}`,
    );
    console.log(`  ${c.dim}Pattern:${c.reset}  ${coll.glob_pattern}`);
    if (yamlColl?.ignore?.length) {
      console.log(`  ${c.dim}Ignore:${c.reset}   ${yamlColl.ignore.join(", ")}`);
    }
    console.log(`  ${c.dim}Files:${c.reset}    ${coll.active_count}`);
    console.log(`  ${c.dim}Updated:${c.reset}  ${timeAgo}`);
    console.log();
  }

  closeDb();
}

// =============================================================================
// Collection add
// =============================================================================

export async function collectionAdd(
  pwd: string,
  globPattern: string,
  name?: string,
  indexFiles?: (
    pwd: string,
    globPattern: string,
    collectionName: string,
    suppressEmbedNotice: boolean,
    ignorePatterns?: string[],
  ) => Promise<void>,
): Promise<void> {
  // If name not provided, generate from pwd basename
  let collName = name;
  if (!collName) {
    const parts = pwd.split("/").filter(Boolean);
    collName = parts[parts.length - 1] || "root";
  }

  // Check if collection with this name already exists in YAML
  const existing = getCollectionFromYaml(collName);
  if (existing) {
    console.error(
      `${c.yellow}Collection '${collName}' already exists.${c.reset}`,
    );
    console.error(`Use a different name with --name <name>`);
    process.exit(1);
  }

  // Check if a collection with this pwd+glob already exists in YAML
  const allCollections = yamlListCollections();
  const existingPwdGlob = allCollections.find(
    (c) => c.path === pwd && c.pattern === globPattern,
  );

  if (existingPwdGlob) {
    console.error(
      `${c.yellow}A collection already exists for this path and pattern:${c.reset}`,
    );
    console.error(
      `  Name: ${existingPwdGlob.name} (qmd://${existingPwdGlob.name}/)`,
    );
    console.error(`  Pattern: ${globPattern}`);
    console.error(
      `\nUse 'qmd update' to re-index it, or remove it first with 'qmd collection remove ${existingPwdGlob.name}'`,
    );
    process.exit(1);
  }

  // Add to YAML config + sync to SQLite
  addCollection(collName, pwd, globPattern);
  resyncConfig();

  // Create the collection and index files
  console.log(`Creating collection '${collName}'...`);
  const newColl = getCollectionFromYaml(collName);
  if (indexFiles) {
    await indexFiles(
      pwd,
      globPattern,
      collName,
      false,
      newColl?.ignore,
    );
  } else {
    console.log(
      `${c.green}✓${c.reset} Collection '${collName}' config added (no indexing callback provided)`,
    );
    return;
  }
  console.log(
    `${c.green}✓${c.reset} Collection '${collName}' created successfully`,
  );
}

// =============================================================================
// Collection remove
// =============================================================================

export function collectionRemove(name: string): void {
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
    console.log(
      `  Cleaned up ${result.cleanedHashes} orphaned content hashes`,
    );
  }
}

// =============================================================================
// Collection rename
// =============================================================================

export function collectionRename(oldName: string, newName: string): void {
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
    console.error(
      `${c.yellow}Collection name already exists: ${newName}${c.reset}`,
    );
    console.error(
      `Choose a different name or remove the existing collection first.`,
    );
    process.exit(1);
  }

  const db = getDb();
  renameCollection(db, oldName, newName);
  // Also rename in YAML config
  yamlRenameCollectionFn(oldName, newName);
  closeDb();

  console.log(
    `${c.green}✓${c.reset} Renamed collection '${oldName}' to '${newName}'`,
  );
  console.log(
    `  Virtual paths updated: ${c.cyan}qmd://${oldName}/${c.reset} → ${c.cyan}qmd://${newName}/${c.reset}`,
  );
}
