/**
 * Split a mask string on top-level commas.
 *
 * Keeps commas inside grouping syntax untouched, e.g.:
 * - braces:       glob with brace groups like `{md,txt}`
 * - extglob:      `@(README.md,test1.md)`
 * - char classes: `file[1,2].md`
 */
export function splitTopLevelCommaPatterns(mask: string): string[] {
  let braceDepth = 0;
  let parenDepth = 0;
  let bracketDepth = 0;
  let escaping = false;
  let current = "";
  const out: string[] = [];

  for (const ch of mask) {
    if (escaping) {
      current += ch;
      escaping = false;
      continue;
    }

    if (ch === "\\") {
      current += ch;
      escaping = true;
      continue;
    }

    if (ch === "[" && bracketDepth >= 0) {
      bracketDepth++;
      current += ch;
      continue;
    }
    if (ch === "]" && bracketDepth > 0) {
      bracketDepth--;
      current += ch;
      continue;
    }

    if (bracketDepth === 0) {
      if (ch === "{") {
        braceDepth++;
        current += ch;
        continue;
      }
      if (ch === "}" && braceDepth > 0) {
        braceDepth--;
        current += ch;
        continue;
      }
      if (ch === "(") {
        parenDepth++;
        current += ch;
        continue;
      }
      if (ch === ")" && parenDepth > 0) {
        parenDepth--;
        current += ch;
        continue;
      }
      if (ch === "," && braceDepth === 0 && parenDepth === 0) {
        const trimmed = current.trim();
        if (trimmed) out.push(trimmed);
        current = "";
        continue;
      }
    }

    current += ch;
  }

  const tail = current.trim();
  if (tail) out.push(tail);
  return out;
}
