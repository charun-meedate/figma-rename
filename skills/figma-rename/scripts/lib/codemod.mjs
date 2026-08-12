// Rewriting the code side of a rename.
//
// One Figma name is spelled several different ways once it reaches a codebase,
// and a rename has to move all of them at once:
//
//   Figma      text/primary/default
//   CSS        --text-primary-default
//   TS/Dart    textPrimaryDefault              (top-level field)
//   TS/Dart    AppTextColors.primaryDefault    (member inside a namespace class)
//   DTCG/JSON  text.primary.default
//
// The spellings must match `figma-token-export`'s generators exactly - they are
// produced by the same `naming.mjs` functions, which is why that file is
// duplicated into this skill rather than re-derived.
//
// Two properties this module is built around:
//
//  1. **One pass, simultaneous.** All pairs go into a single alternation regex
//     and are replaced in one traversal. Replacing pair by pair would let a
//     chain (`a -> b`, `b -> c`) turn every `a` into `c`.
//  2. **Guarded boundaries.** `--text-primary` must not match inside
//     `--text-primary-default`, and `primaryDefault` must not match a variable
//     that happens to share the name - the member spelling only matches after
//     a dot.

import fs from 'node:fs/promises';
import path from 'node:path';

import { toCamel, toKebab, toPascal, segments } from './naming.mjs';

// snake_case and the DTCG dot path. They live here rather than in naming.mjs
// because no generator in figma-token-export emits them — they exist for
// hand-written codebases that spell tokens that way, and keeping them out of
// naming.mjs is what lets that file stay byte-identical with its twin.
const toSnake = (name, { dropSegments = 0 } = {}) => segments(name).slice(dropSegments).join('_').toLowerCase();
const toDot = (name) => segments(name).join('.').toLowerCase();

/** Lookaround pairs per guard kind. The escaped literal is dropped in between. */
const GUARDS = {
  ident: ['(?<![\\w$])', '(?![\\w$])'],
  cssvar: ['(?<![\\w-])', '(?![\\w-])'],
  kebab: ['(?<![\\w-])', '(?![\\w-])'],
  path: ['(?<![\\w/.-])', '(?![\\w/-])'],
  member: ['(?<=\\.)', '(?![\\w$])'],
  dot: ['(?<![\\w.-])', '(?![\\w.-])'],
};

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Token-ish kinds spell themselves as identifiers in code; component-ish kinds do not. */
const TOKEN_KINDS = new Set(['variable', 'textStyle', 'effectStyle', 'paintStyle']);

/**
 * Every literal string pair one rename implies.
 *
 * For tokens the spellings are derived, because the derivation is exactly what
 * the generator does. For components and layers only the **exact Figma name**
 * is derived - turning "btn primary" into `BtnPrimary` and rewriting the
 * codebase on that hunch is how a rename breaks an unrelated class. Component
 * code symbols come from explicit `code` pairs in the rename map, which
 * `plan.mjs` proposes as `codeSuggestion` and a human confirms.
 */
export function spellingsFor(rename, opts = {}) {
  const { spellings = [], cssPrefix = '' } = opts;
  const want = new Set(spellings);
  const out = [];
  const add = (spelling, guard, from, to) => {
    if (from && to && from !== to) out.push({ spelling, guard, from, to });
  };

  if (want.has('figmaPath')) add('figmaPath', 'path', rename.from, rename.to);

  if (TOKEN_KINDS.has(rename.kind)) {
    if (want.has('cssVar')) {
      add('cssVar', 'cssvar', `--${cssPrefix}${toKebab(rename.from)}`, `--${cssPrefix}${toKebab(rename.to)}`);
    }
    if (want.has('kebab')) add('kebab', 'kebab', toKebab(rename.from), toKebab(rename.to));
    if (want.has('camel')) add('camel', 'ident', toCamel(rename.from), toCamel(rename.to));
    if (want.has('camelMember')) {
      add(
        'camelMember',
        'member',
        toCamel(rename.from, { dropSegments: 1 }),
        toCamel(rename.to, { dropSegments: 1 }),
      );
    }
    if (want.has('pascal')) add('pascal', 'ident', toPascal(rename.from), toPascal(rename.to));
    if (want.has('snake')) add('snake', 'kebab', toSnake(rename.from), toSnake(rename.to));
    if (want.has('dot')) add('dot', 'dot', toDot(rename.from), toDot(rename.to));
  }

  for (const pair of rename.code ?? []) {
    add('explicit', GUARDS[pair.guard] ? pair.guard : 'ident', pair.from, pair.to);
  }

  return out;
}

/**
 * The names `figma-token-export` actually gives a namespace, per target.
 *
 * These mirror the generator line for line, because the previous version of
 * this function guessed and got the most common case wrong:
 *
 *   flutter.mjs:  /^colou?rs?$/i.test(ns) ? `${prefix}Colors` : `${prefix}${Pascal(ns)}Colors`
 *
 * So `color/**` produces `AppColors`, not `AppColorColors`. Moving `color/**`
 * to `surface/**` — the example used throughout these docs — therefore had the
 * codemod rewriting a class that never existed, while leaving the real
 * `AppColors` untouched.
 *
 * Two more corrections in the same family:
 *  - shadows have no per-namespace class (one `${prefix}Shadows`, plus one per
 *    mode), so the old `${prefix}${Ns}Shadows` pair could never match anything;
 *  - web emits a single `color` object, so only *dimension* namespaces get a
 *    TypeScript object — and those were missing entirely, meaning a TS project
 *    got no namespace-object rename at all.
 *
 * Both the colour and the dimension spelling are emitted for a namespace: a
 * rename row does not carry `resolvedType`, and a pair that matches nothing is
 * reported as such rather than doing damage.
 */
function generatedNamesFor(ns, flutterPrefix) {
  const pascal = toPascal(ns);
  return {
    // Dart colours — the special case that was wrong.
    dartColors: /^colou?rs?$/i.test(ns) ? `${flutterPrefix}Colors` : `${flutterPrefix}${pascal}Colors`,
    // Dart dimension / typography scale classes.
    dartScale: `${flutterPrefix}${pascal}`,
    // TypeScript dimension objects.
    webObject: toCamel(ns),
  };
}

/**
 * Names the web target exports regardless of any namespace (`web.mjs:197-199`).
 *
 * `export const color` is the whole colour set, not a namespace object — so a
 * `color/** -> surface/**` rename must NOT rewrite it. Getting this wrong is
 * worse than missing a rename: it renames a symbol that had nothing to do with
 * the move, and the file still compiles.
 */
const WEB_FIXED_EXPORTS = new Set(['color', 'colorVar', 'typography', 'shadow', 'boxShadow', 'boxShadowVar']);

/**
 * Namespace symbols the generator will not hand to a namespace, suffixing with
 * `Scale` instead (`avoidReserved`).
 *
 * Whether it fires depends on which token groups the project exports, which the
 * codemod cannot see — so a rename landing on one of these produces an advisory
 * rather than a rewrite to a name that may gain a suffix.
 */
const GENERATOR_RESERVED = new Set(['color', 'colors', 'colour', 'colours', 'typography', 'shadow', 'shadows']);

/**
 * Class and object names that follow from a token changing its first segment.
 *
 * `figma-token-export` emits one class/object per namespace, so moving *every*
 * `color/**` token under `surface/**` renames `AppColors` to
 * `AppSurfaceColors` in generated code - and in every consumer that named the
 * class. That rewrite is correct only when the namespace moves WHOLE:
 *
 *   - if `color/` splits into `text/` and `surface/`, there is no single new
 *     class, and picking either one silently points half the call sites at the
 *     wrong class;
 *   - if only some `color/` tokens move, `AppColorColors` still exists for the
 *     rest, and renaming it breaks the ones that stayed.
 *
 * Both cases come back as `advisories` instead. The compiler will point at
 * those call sites by name, which is a better tool than a guess. Pass
 * `allTokenNames` (every token name in the file, pre-rename) to get the
 * partial-move check; without it only the split case can be seen.
 *
 * @returns {{pairs: Array, advisories: string[]}}
 */
export function namespaceClassPairs(renames, { flutterPrefix = 'App', allTokenNames = null } = {}) {
  const nsOf = (name) => name.split('/')[0].toLowerCase();

  const targets = new Map(); // fromNs -> Set of new namespace names
  const movedNames = new Map(); // fromNs -> Set of old token names
  for (const r of renames) {
    if (!TOKEN_KINDS.has(r.kind)) continue;
    const from = nsOf(r.from);
    const to = nsOf(r.to);
    if (!from || !to || from === to) continue;
    if (!targets.has(from)) targets.set(from, new Set());
    if (!movedNames.has(from)) movedNames.set(from, new Set());
    targets.get(from).add(r.to.split('/')[0]);
    movedNames.get(from).add(r.from);
  }

  const pairs = [];
  const advisories = [];
  for (const [fromNs, toNsSet] of targets) {
    if (toNsSet.size > 1) {
      advisories.push(
        `namespace "${fromNs}" splits into ${[...toNsSet].join(', ')} - no single class rename follows. ` +
          'Leave those class references to the compiler.',
      );
      continue;
    }
    if (allTokenNames) {
      const staying = allTokenNames.filter((n) => nsOf(n) === fromNs && !movedNames.get(fromNs).has(n));
      if (staying.length) {
        advisories.push(
          `namespace "${fromNs}" only partly moves - ${staying.length} token(s) stay behind, so its class ` +
            'keeps existing. Leave those class references to the compiler.',
        );
        continue;
      }
    }
    const [toNs] = toNsSet;
    if (GENERATOR_RESERVED.has(toNs.toLowerCase())) {
      advisories.push(
        `namespace "${fromNs}" moves to "${toNs}", which the generator reserves for its fixed symbols — ` +
          `the namespace class may come out as "${toPascal(toNs)}Scale" instead. ` +
          'Regenerate first and check the emitted name before trusting these call sites.',
      );
      continue;
    }
    const before = generatedNamesFor(fromNs, flutterPrefix);
    const after = generatedNamesFor(toNs, flutterPrefix);
    for (const key of ['dartColors', 'dartScale', 'webObject']) {
      if (before[key] === after[key]) continue;
      // A fixed web export is not a namespace object — leave it alone.
      if (key === 'webObject' && (WEB_FIXED_EXPORTS.has(before[key]) || WEB_FIXED_EXPORTS.has(after[key]))) {
        continue;
      }
      pairs.push({ spelling: 'namespaceClass', guard: 'ident', from: before[key], to: after[key] });
    }
  }
  return { pairs, advisories };
}

/**
 * Collapses pairs into one regex plus a lookup.
 * Throws when the same literal is asked to become two different things - that
 * is a rename map that cannot be applied, not something to resolve by ordering.
 */
export function buildReplacer(pairs) {
  const byFrom = new Map();
  for (const pair of pairs) {
    const existing = byFrom.get(pair.from);
    if (existing && existing.to !== pair.to) {
      throw new Error(
        `Ambiguous rewrite: "${pair.from}" would become both "${existing.to}" (${existing.spelling}) ` +
          `and "${pair.to}" (${pair.spelling}).`,
      );
    }
    if (!existing) byFrom.set(pair.from, pair);
  }
  const unique = [...byFrom.values()].sort((a, b) => b.from.length - a.from.length);
  if (unique.length === 0) return null;

  const source = unique
    .map((p) => {
      const [pre, post] = GUARDS[p.guard] ?? GUARDS.ident;
      return `${pre}${escapeRe(p.from)}${post}`;
    })
    .join('|');

  return { re: new RegExp(source, 'g'), byFrom, pairs: unique };
}

/** Applies a replacer to one string. Returns the new text and a per-pair hit count. */
export function rewrite(text, replacer) {
  const hits = new Map();
  if (!replacer) return { text, hits, total: 0 };
  let total = 0;
  const next = text.replace(replacer.re, (matched) => {
    const pair = replacer.byFrom.get(matched);
    if (!pair) return matched;
    hits.set(matched, (hits.get(matched) ?? 0) + 1);
    total++;
    return pair.to;
  });
  return { text: next, hits, total };
}

// ---------------------------------------------------------------- file walking

/** Compiles a path glob supporting `**`, `*`, `?` and `{a,b}`. */
export function compilePathGlob(pattern) {
  let source = '';
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === '*') {
      if (pattern[i + 1] === '*') {
        // `**/` may also match zero directories, so "**/*.ts" matches "a.ts".
        if (pattern[i + 2] === '/') {
          source += '(?:.*/)?';
          i += 2;
        } else {
          source += '.*';
          i++;
        }
      } else {
        source += '[^/]*';
      }
    } else if (char === '?') {
      source += '[^/]';
    } else if (char === '{') {
      const close = pattern.indexOf('}', i);
      if (close === -1) {
        source += '\\{';
      } else {
        const options = pattern.slice(i + 1, close).split(',');
        source += `(?:${options.map((o) => o.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`;
        i = close;
      }
    } else if (/[.+^$()|[\]\\]/.test(char)) {
      source += `\\${char}`;
    } else {
      source += char;
    }
  }
  return new RegExp(`^${source}$`);
}

export function matchesAnyPath(relPath, compiled) {
  return compiled.some((re) => re.test(relPath));
}

/**
 * Lists files under `roots` that match `include` and no `exclude`.
 * Paths come back absolute; globs are matched against the path relative to
 * `baseDir`, so a config written once works from any cwd.
 */
export async function listFiles({ roots, include, exclude, baseDir }) {
  const includeRe = include.map(compilePathGlob);
  const excludeRe = exclude.map(compilePathGlob);
  const found = [];
  const seen = new Set();

  async function walk(dir) {
    let dirents;
    try {
      dirents = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const dirent of dirents) {
      const full = path.join(dir, dirent.name);
      const rel = path.relative(baseDir, full).split(path.sep).join('/');
      if (matchesAnyPath(rel, excludeRe)) continue;
      if (dirent.isDirectory()) {
        // Cheap prune: an exclude of "**/node_modules/**" should stop the walk
        // at the directory rather than filter thousands of files one at a time.
        if (matchesAnyPath(`${rel}/x`, excludeRe)) continue;
        await walk(full);
      } else if (dirent.isFile() && matchesAnyPath(rel, includeRe) && !seen.has(full)) {
        seen.add(full);
        found.push(full);
      }
    }
  }

  for (const root of roots) await walk(root);
  return found.sort();
}
