#!/usr/bin/env node
// Builds rename/inventory.json for a project whose tokens are CSS custom
// properties — `"source": "code"`. The Figma capture happens in `use_figma`
// and cannot live here; this one can, and does, because a code-source project
// has no reason to hand-write an inventory.
//
// This started as a snippet in references/inventory.md and became a script the
// first time it was measured against a real stylesheet: it silently captured
// 149 of 176 tokens, because it required a definition to follow `{` or `;` and
// most of that file's definitions follow a comment line. A capture that misses
// 15% and says nothing is worse than one that refuses.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { COMMON_FLAGS, parseArgs } from './lib/config.mjs';

const USAGE = `
capture-css.mjs — build an inventory from CSS custom properties

  capture-css.mjs <file.css> [more.css …]

  --layer <name>      only names starting with this, with it stripped from the
                      recorded name: --layer color- turns --color-primary into
                      "primary". Use it for a shadcn-style file where @theme
                      holds the names and :root only holds values.
  --separator <char>  what separates segments in the source names (default "-").
                      "primary-soft-light" becomes "primary/soft/light".
  --flat              keep names as one segment: "primary-soft-light" stays put.
                      Right when hierarchy is not encoded in the name at all.
  --scope <name>      the batch name to record (default: the file's basename)
  --out <path>        where to write (default: rename/inventory.json)
  --dry-run           print what was found, write nothing

Definitions only — a var() reference is a use, not a definition.
`;

/**
 * Every custom property DEFINED in a stylesheet.
 *
 * The rule is "a `--name:` that is not the inside of a `var(...)`", rather than
 * "a `--name:` that follows `{` or `;`". The second is the obvious one and it
 * drops every definition written under a comment — which, in a stylesheet
 * organised into commented sections, is most of them.
 */
export function definedProperties(css) {
  const found = [];
  for (const match of css.matchAll(/--([a-zA-Z0-9_-]+)\s*:/g)) {
    const before = css.slice(Math.max(0, match.index - 8), match.index);
    if (/var\(\s*$/.test(before)) continue;
    found.push(match[1]);
  }
  return [...new Set(found)];
}

/** `primary-soft-light` → `primary/soft/light`, minus an optional layer prefix. */
export function toTokenName(cssName, { layer = '', separator = '-', flat = false } = {}) {
  const bare = layer && cssName.startsWith(layer) ? cssName.slice(layer.length) : cssName;
  if (flat || !separator) return bare;
  return bare.split(separator).filter(Boolean).join('/');
}

async function main() {
  const args = parseArgs(process.argv.slice(2), {
    flags: [...COMMON_FLAGS, 'layer', 'separator', 'flat', 'scope', 'out', 'dry-run'],
    wantsValue: ['layer', 'separator', 'scope', 'out'],
    usage: USAGE,
  });

  const files = args._;
  if (files.length === 0) throw new Error('Name at least one CSS file.\n' + USAGE.trim());

  const layer = args.layer ?? '';
  const separator = args.separator ?? '-';
  const entries = [];
  const seen = new Set();
  let skipped = 0;

  for (const file of files) {
    const css = await fs.readFile(file, 'utf8').catch((err) => {
      throw new Error(`Could not read ${file}: ${err.message}`);
    });
    const scope = args.scope ?? path.basename(file);
    for (const cssName of definedProperties(css)) {
      if (layer && !cssName.startsWith(layer)) {
        skipped++;
        continue;
      }
      const name = toTokenName(cssName, { layer, separator, flat: args.flat });
      if (seen.has(name)) continue;
      seen.add(name);
      entries.push({ kind: 'variable', id: `css:${cssName}`, name, scope });
    }
  }

  console.log(`[capture-css] ${entries.length} token(s) from ${files.length} file(s)`);
  if (skipped) console.log(`[capture-css]   ${skipped} skipped: outside --layer "${layer}"`);
  // The name shape is a guess about the project, and the wrong guess produces a
  // plan that looks reasonable and regroups everything incorrectly. Show it.
  for (const entry of entries.slice(0, 5)) {
    console.log(`[capture-css]   --${entry.id.slice(4)}  →  ${entry.name}`);
  }
  if (entries.length > 5) console.log(`[capture-css]   … ${entries.length - 5} more`);
  console.log('[capture-css] check those segments before planning — "-" to "/" is a guess about this project.');

  if (args['dry-run']) {
    console.log('[capture-css] dry run. Re-run without --dry-run to write.');
    return;
  }

  const out = args.out ?? 'rename/inventory.json';
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, `${JSON.stringify({ capturedFrom: files, entries }, null, 1)}\n`);
  console.log(`[capture-css] wrote ${out}`);
  console.log('[capture-css] next: node plan.mjs');
}

// Exported for tests; only run as a command when invoked as one. Without this,
// importing this file executes main(), which fails on the missing argument and
// calls process.exit — taking its importer down with it.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`[capture-css] ${err.message}`);
    process.exit(1);
  });
}
