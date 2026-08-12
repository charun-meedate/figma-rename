// The seam with `figma-token-export`.
//
// Renaming is not the goal — matching the standard so the exported code is
// predictable is. Which means the two skills have to agree on three things, and
// until now all three were prose in a doc:
//
//   1. the code spellings (`cssPrefix`, `flutterPrefix`) must match that
//      project's target settings, or the codemod matches NOTHING and silently
//      reports success;
//   2. `code.generated` must point at the same directories the generator writes,
//      or the codemod patches files that the next generate overwrites;
//   3. `tokens.config.json`'s `layers` globs are matched on TOKEN NAMES, so a
//      rename that moves a first segment silently orphans them and the token
//      lands in `other`.
//
// `code.tokensConfig` used to be a dead field: resolved to an absolute path in
// config.mjs and read by nothing. The hook was built and never connected. This
// is the connection.
//
// The key names do not line up between the two configs, which is worth stating
// because a human doing this by eye has to know:
//
//   figma-rename            figma-token-export
//   code.cssPrefix     <->  targets[type=web].cssPrefix
//   code.flutterPrefix <->  targets[type=flutter].prefix     (not `flutterPrefix`)

import fs from 'node:fs/promises';
import path from 'node:path';

/** Reads the project's tokens.config.json, or null when it has none. */
export async function loadTokensConfig(config) {
  const explicit = config.code.tokensConfig;
  const candidate = explicit ?? path.join(config.rootDir, 'tokens.config.json');
  try {
    const parsed = JSON.parse(await fs.readFile(candidate, 'utf8'));
    return { path: candidate, config: parsed, explicit: Boolean(explicit) };
  } catch (err) {
    if (err.code === 'ENOENT') {
      // Only an error if the user pointed at it themselves.
      if (explicit) {
        throw new Error(
          `code.tokensConfig points at ${candidate}, which does not exist. ` +
            'Remove the setting if this project has no token generator.',
        );
      }
      return null;
    }
    throw new Error(`Could not parse ${candidate}: ${err.message}`);
  }
}

/**
 * Cross-checks the two configs, and warns about the traps neither can see alone.
 *
 * @returns {{errors: string[], warnings: string[], notes: string[]}}
 */
export function crossCheck(config, tokens, renames = []) {
  const errors = [];
  const warnings = [];
  const notes = [];
  const targets = tokens.config.targets ?? [];

  // ---- 1. the spellings have to agree, or the codemod matches nothing -------
  const web = targets.find((t) => t.type === 'web');
  if (web) {
    const theirs = web.cssPrefix ?? '';
    if ((config.code.cssPrefix ?? '') !== theirs) {
      errors.push(
        `code.cssPrefix is ${JSON.stringify(config.code.cssPrefix ?? '')} but the web target in ` +
          `${path.basename(tokens.path)} uses ${JSON.stringify(theirs)}. ` +
          'Every CSS custom property the codemod looks for would be spelled wrong, and it would ' +
          'report "matched nothing" rather than failing.',
      );
    }
  }
  const flutter = targets.find((t) => t.type === 'flutter');
  if (flutter) {
    // Note the asymmetry: `prefix` there, `flutterPrefix` here.
    const theirs = flutter.prefix ?? 'App';
    if ((config.code.flutterPrefix ?? 'App') !== theirs) {
      errors.push(
        `code.flutterPrefix is ${JSON.stringify(config.code.flutterPrefix ?? 'App')} but the flutter ` +
          `target in ${path.basename(tokens.path)} uses \`prefix\`: ${JSON.stringify(theirs)}. ` +
          'The namespace class rewrites would target classes that do not exist.',
      );
    }
  }
  if (!web && !flutter) {
    notes.push(`${path.basename(tokens.path)} has no web or flutter target — nothing to cross-check.`);
  }

  // ---- 2. code.generated should be the directories the generator writes -----
  const outs = targets.map((t) => t.out).filter(Boolean);
  const declared = config.code.generated ?? [];
  const missing = outs.filter((out) => !declared.some((glob) => glob === out || glob.startsWith(`${out}/`)));
  if (missing.length) {
    warnings.push(
      `code.generated does not cover ${missing.map((m) => `"${m}"`).join(', ')}, which the generator writes. ` +
        'The codemod will patch those files, and the next regenerate will erase the patch — ' +
        `add ${missing.map((m) => `"${m}/**"`).join(', ')}.`,
    );
  }
  const stale = declared.filter(
    (glob) => !outs.some((out) => glob === out || glob.startsWith(`${out}/`) || out.startsWith(glob.replace(/\/\*\*$/, ''))),
  );
  if (stale.length) {
    notes.push(
      `code.generated lists ${stale.map((s) => `"${s}"`).join(', ')}, which no target writes to — ` +
        'harmless, but it means the codemod is skipping files nothing regenerates.',
    );
  }

  // ---- 3. layers globs are matched on token NAMES --------------------------
  //
  // This is the trap that costs an afternoon: the rename succeeds, the export
  // succeeds, and a target quietly stops containing a whole group of tokens.
  const layers = tokens.config.layers ?? {};
  const firstSegment = (name) => name.split('/')[0].toLowerCase();
  const moving = new Set();
  for (const r of renames) {
    const from = firstSegment(r.from);
    if (from !== firstSegment(r.to)) moving.add(from);
  }
  for (const [layer, globs] of Object.entries(layers)) {
    for (const glob of globs) {
      const stem = firstSegment(String(glob).replace(/[*].*$/, ''));
      if (stem && moving.has(stem)) {
        warnings.push(
          `${path.basename(tokens.path)} layer "${layer}" matches "${glob}", and this rename moves ` +
            `"${stem}/**" somewhere else. Update that glob in the same commit, or those tokens fall ` +
            'into `other` and every target selecting that layer silently loses them.',
        );
      }
    }
  }

  return { errors, warnings, notes };
}
