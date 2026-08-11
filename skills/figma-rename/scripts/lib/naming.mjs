// Name transforms shared by every spelling this skill rewrites.
//
// IMPORTANT: this file is a deliberate copy of
// `skills/figma-token-export/scripts/lib/naming.mjs`. The codemod has to
// produce byte-identical identifiers to the ones that skill's generators emit —
// if the two drift, a rename rewrites `AppColors.textPrimary` to a name the
// generator never writes, and the project stops compiling with no obvious
// culprit. `selftest.mjs` compares the two files when both are present and
// fails on drift. Change one, change the other.

/** Splits a token path into clean segments: "body/lg/bold" -> ["body","lg","bold"]. */
export function segments(name) {
  return name
    .split(/[/\s]+/)
    .flatMap((s) => s.split('-').filter(Boolean))
    .filter(Boolean)
    .map((s) => s.replace(/%/g, 'pct').replace(/\./g, '_'));
}

/**
 * camelCase identifier for Dart/TS fields.
 * A segment starting with a digit is prefixed with "_" — "spacing/8" -> "spacing_8"
 * (bare "8" is not a legal identifier in either language).
 */
export function toCamel(name, { dropSegments = 0 } = {}) {
  const parts = segments(name).slice(dropSegments);
  let out = '';
  for (const part of parts) {
    if (/^\d/.test(part)) {
      out += out === '' ? `n${part}` : `_${part}`;
    } else if (out === '') {
      out += part.toLowerCase();
    } else {
      out += part[0].toUpperCase() + part.slice(1).toLowerCase();
    }
  }
  return out;
}

/** kebab-case for CSS custom properties: "text/primary/default" -> "text-primary-default". */
export function toKebab(name, { dropSegments = 0 } = {}) {
  return segments(name).slice(dropSegments).join('-').toLowerCase();
}

/** PascalCase for class names: "border-width" -> "BorderWidth". */
export function toPascal(name) {
  return segments(name)
    .map((p) => p[0].toUpperCase() + p.slice(1).toLowerCase())
    .join('');
}

/** snake_case, for platforms that spell tokens that way. */
export function toSnake(name, { dropSegments = 0 } = {}) {
  return segments(name).slice(dropSegments).join('_').toLowerCase();
}

/** Dot path, the DTCG / JSON spelling: "text/primary/default" -> "text.primary.default". */
export function toDot(name) {
  return segments(name).join('.').toLowerCase();
}

/** First path segment — used to split a flat token map into namespaces. */
export function namespaceOf(name) {
  return name.split('/')[0];
}

/**
 * Throws on any identifier produced by two different token names.
 * Call this before writing a file, never after — a collision that reaches disk
 * looks like a missing token, which is a much harder bug to trace back here.
 * @param {Array<[string, string]>} pairs - [tokenName, identifier]
 */
export function assertUniqueIdentifiers(pairs, label) {
  const seen = new Map();
  const clashes = [];
  for (const [tokenName, identifier] of pairs) {
    if (seen.has(identifier)) {
      clashes.push(`  "${seen.get(identifier)}" and "${tokenName}" both map to "${identifier}"`);
    }
    seen.set(identifier, tokenName);
  }
  if (clashes.length) {
    throw new Error(`Identifier collision in ${label}:\n${clashes.join('\n')}`);
  }
}
