import { realpathSync, mkdirSync } from "node:fs";
import { qmdHomedir } from "../paths.js";

export function homedir(): string {
  return qmdHomedir();
}

/**
 * Check if a path is absolute.
 * Supports:
 * - Unix paths: /path/to/file
 * - Windows native: C:\\path or C:/path
 * - Git Bash: /c/path or /C/path (C-Z drives, excluding A/B floppy drives)
 *
 * Note: /c without trailing slash is treated as Unix path (directory named "c"),
 * while /c/ or /c/path are treated as Git Bash paths (C: drive).
 */
export function isAbsolutePath(path: string): boolean {
  if (!path) return false;

  // Unix absolute path
  if (path.startsWith('/')) {
    // Check if it's a Git Bash style path like /c/ or /c/Users (C-Z only, not A or B)
    // Requires path[2] === '/' to distinguish from Unix paths like /c or /cache
    // Skipped on WSL where /c/ is a valid drvfs mount point, not a drive letter
    if (!isWSL() && path.length >= 3 && path[2] === '/') {
      const driveLetter = path[1];
      if (driveLetter && /[c-zC-Z]/.test(driveLetter)) {
        return true;
      }
    }
    // Any other path starting with / is Unix absolute
    return true;
  }

  // Windows native path: C:\ or C:/ (any letter A-Z)
  if (path.length >= 2 && /[a-zA-Z]/.test(path[0]!) && path[1] === ':') {
    return true;
  }

  return false;
}

/**
 * Normalize path separators to forward slashes.
 * Converts Windows backslashes to forward slashes.
 */
export function normalizePathSeparators(path: string): string {
  return path.replace(/\\/g, '/');
}

/**
 * Replace emoji and symbol Unicode codepoints with their hex representation.
 *
 * Used in {@link handelize} to produce ASCII-safe filenames from paths
 * containing emoji characters. Each emoji run is replaced with its
 * hyphen-joined hex code points (e.g. `🐘` -> `1f418`).
 */
export function emojiToHex(str: string): string {
  return str.replace(/(?:\p{So}\p{Mn}?|\p{Sk})+/gu, (run) => {
    return [...run].filter(c => /\p{So}|\p{Sk}/u.test(c))
      .map(c => c.codePointAt(0)!.toString(16)).join('-');
  });
}

/**
 * Transform a filename into a token-friendly, URL-safe form.
 *
 * Applies a series of normalizations:
 * - Converts `___` separators to `/` for path reconstruction
 * - Replaces emoji/symbol codepoints with hex representations via {@link emojiToHex}
 * - Replaces all non-alphanumeric characters (except `$`) with hyphens
 * - Strips leading/trailing hyphens from each segment
 * - Preserves file extensions on the last segment
 *
 * The result is safe for use in contexts where token boundaries matter
 * (e.g. LLM tokenizers).
 *
 * @throws {Error} If `path` is empty or contains no valid filename content
 */
export function handelize(path: string): string {
  if (!path || path.trim() === '') {
    throw new Error('handelize: path cannot be empty');
  }

  const segments = path.split('/').filter(Boolean);
  const lastSegment = segments[segments.length - 1] || '';
  const filenameWithoutExt = lastSegment.replace(/\.[^.]+$/, '');
  const hasValidContent = /[\p{L}\p{N}\p{So}\p{Sk}$]/u.test(filenameWithoutExt);
  if (!hasValidContent) {
    throw new Error(`handelize: path "${path}" has no valid filename content`);
  }

  const result = path
    .replace(/___/g, '/')
    .split('/')
    .map((segment, idx, arr) => {
      const isLastSegment = idx === arr.length - 1;
      segment = emojiToHex(segment);

      if (isLastSegment) {
        const extMatch = segment.match(/(\.[a-z0-9]+)$/i);
        const ext = extMatch ? extMatch[1] : '';
        const nameWithoutExt = ext ? segment.slice(0, -ext.length) : segment;

        const cleanedName = nameWithoutExt
          .replace(/[^\p{L}\p{N}$]+/gu, '-')
          .replace(/^-+|-+$/g, '');

        return cleanedName + ext;
      } else {
        return segment
          .replace(/[^\p{L}\p{N}$]+/gu, '-')
          .replace(/^-+|-+$/g, '');
      }
    })
    .filter(Boolean)
    .join('/');

  if (!result) {
    throw new Error(`handelize: path "${path}" resulted in empty string after processing`);
  }

  return result;
}

/**
 * Detect if running inside WSL (Windows Subsystem for Linux).
 * On WSL, paths like /c/work/... are valid drvfs mount points, not Git Bash paths.
 */
function isWSL(): boolean {
  return !!(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP);
}

/**
 * Get the relative path from a prefix.
 * Returns null if path is not under prefix.
 * Returns empty string if path equals prefix.
 */
export function getRelativePathFromPrefix(path: string, prefix: string): string | null {
  // Empty prefix is invalid
  if (!prefix) {
    return null;
  }

  const normalizedPath = normalizePathSeparators(path);
  const normalizedPrefix = normalizePathSeparators(prefix);

  // Ensure prefix ends with / for proper matching
  const prefixWithSlash = !normalizedPrefix.endsWith('/')
    ? normalizedPrefix + '/'
    : normalizedPrefix;

  // Exact match
  if (normalizedPath === normalizedPrefix) {
    return '';
  }

  // Check if path starts with prefix
  if (normalizedPath.startsWith(prefixWithSlash)) {
    return normalizedPath.slice(prefixWithSlash.length);
  }

  return null;
}

export function resolve(...paths: string[]): string {
  if (paths.length === 0) {
    throw new Error("resolve: at least one path segment is required");
  }

  // Normalize all paths to use forward slashes
  const normalizedPaths = paths.map(normalizePathSeparators);

  let result = '';
  let windowsDrive = '';

  // Check if first path is absolute
  const firstPath = normalizedPaths[0]!;
  if (isAbsolutePath(firstPath)) {
    result = firstPath;

    // Extract Windows drive letter if present
    if (firstPath.length >= 2 && /[a-zA-Z]/.test(firstPath[0]!) && firstPath[1] === ':') {
      windowsDrive = firstPath.slice(0, 2);
      result = firstPath.slice(2);
    } else if (!isWSL() && firstPath.startsWith('/') && firstPath.length >= 3 && firstPath[2] === '/') {
      // Git Bash style: /c/ -> C: (C-Z drives only, not A or B)
      // Skipped on WSL where /c/ is a valid drvfs mount point, not a drive letter
      const driveLetter = firstPath[1];
      if (driveLetter && /[c-zC-Z]/.test(driveLetter)) {
        windowsDrive = driveLetter.toUpperCase() + ':';
        result = firstPath.slice(2);
      }
    }
  } else {
    // Start with PWD or cwd, then append the first relative path
    const pwd = normalizePathSeparators(process.env.PWD || process.cwd());

    // Extract Windows drive from PWD if present
    if (pwd.length >= 2 && /[a-zA-Z]/.test(pwd[0]!) && pwd[1] === ':') {
      windowsDrive = pwd.slice(0, 2);
      result = pwd.slice(2) + '/' + firstPath;
    } else {
      result = pwd + '/' + firstPath;
    }
  }

  // Process remaining paths
  for (let i = 1; i < normalizedPaths.length; i++) {
    const p = normalizedPaths[i]!;
    if (isAbsolutePath(p)) {
      // Absolute path replaces everything
      result = p;

      // Update Windows drive if present
      if (p.length >= 2 && /[a-zA-Z]/.test(p[0]!) && p[1] === ':') {
        windowsDrive = p.slice(0, 2);
        result = p.slice(2);
      } else if (!isWSL() && p.startsWith('/') && p.length >= 3 && p[2] === '/') {
        // Git Bash style (C-Z drives only, not A or B)
        // Skipped on WSL where /c/ is a valid drvfs mount point, not a drive letter
        const driveLetter = p[1];
        if (driveLetter && /[c-zC-Z]/.test(driveLetter)) {
          windowsDrive = driveLetter.toUpperCase() + ':';
          result = p.slice(2);
        } else {
          windowsDrive = '';
        }
      } else {
        windowsDrive = '';
      }
    } else {
      // Relative path - append
      result = result + '/' + p;
    }
  }

  // Normalize . and .. components
  const parts = result.split('/').filter(Boolean);
  const normalized: string[] = [];
  for (const part of parts) {
    if (part === '..') {
      normalized.pop();
    } else if (part !== '.') {
      normalized.push(part);
    }
  }

  // Build final path
  const finalPath = '/' + normalized.join('/');

  // Prepend Windows drive if present
  if (windowsDrive) {
    return windowsDrive + finalPath;
  }

  return finalPath;
}

// Flag to indicate production mode (set by qmd.ts at startup)
let _productionMode = false;

export function enableProductionMode(): void {
  _productionMode = true;
}

/** Reset production mode flag — only for testing. */
export function _resetProductionModeForTesting(): void {
  _productionMode = false;
}

export function getDefaultDbPath(indexName: string = "index"): string {
  // Always allow override via INDEX_PATH (for testing)
  if (process.env.INDEX_PATH) {
    return process.env.INDEX_PATH;
  }

  // In non-production mode (tests), require explicit path
  if (!_productionMode) {
    throw new Error(
      "Database path not set. Tests must set INDEX_PATH env var or use createStore() with explicit path. " +
      "This prevents tests from accidentally writing to the global index.",
    );
  }

  const cacheDir = process.env.XDG_CACHE_HOME || resolve(homedir(), ".cache");
  const qmdCacheDir = resolve(cacheDir, "qmd");
  try { mkdirSync(qmdCacheDir, { recursive: true }); } catch {
    // Best effort cache dir creation; resolve still returns the path.
  }
  return resolve(qmdCacheDir, `${indexName}.sqlite`);
}

export function getPwd(): string {
  return process.env.PWD || process.cwd();
}

export function getRealPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}
