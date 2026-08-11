#!/usr/bin/env node
// apply-code.mjs — rewrite every reference in the codebase to match the rename.
//
//   node apply-code.mjs                       # dry run: what would change
//   node apply-code.mjs --batch <id> --write  # apply one batch
//   node apply-code.mjs --write               # apply the whole map
//
// Dry run is the default on purpose. The interesting output is not "it worked",
// it is the file list and the per-spelling counts — a spelling with zero hits
// usually means the codebase spells that token some way this config does not
// know about, and finding that out AFTER a 400-file rewrite is no fun.
//
// Files listed in `code.generated` are skipped: they are rebuilt from
// tokens.json by `figma-token-export`, and patching them here would be undone
// by the next generate — or worse, would not be, and would then disagree with
// tokens.json.

import fs from 'node:fs/promises';
import path from 'node:path';

import {
  buildReplacer,
  compilePathGlob,
  listFiles,
  matchesAnyPath,
  namespaceClassPairs,
  rewrite,
  spellingsFor,
} from './lib/codemod.mjs';
import { loadConfig, parseArgs } from './lib/config.mjs';
import { loadInventory } from './lib/inventory.mjs';
import { loadMap, selectRenames } from './lib/map.mjs';

const TOKEN_KINDS = new Set(['variable', 'textStyle', 'effectStyle', 'paintStyle']);

async function main() {
  const args = parseArgs();
  const config = await loadConfig(args.config);
  const map = await loadMap(config.renameMapPath);
  const inventory = await loadInventory(config.inventoryPath);
  const renames = selectRenames(map, { batch: args.batch, kind: args.kind });
  if (renames.length === 0) throw new Error('The rename map selects nothing to apply.');

  const allTokenNames = inventory.entries.filter((e) => TOKEN_KINDS.has(e.kind)).map((e) => e.name);
  const tokenPairs = renames.flatMap((r) => spellingsFor(r, config.code));
  const classes = args['no-namespace-classes']
    ? { pairs: [], advisories: [] }
    : namespaceClassPairs(renames, { ...config.code, allTokenNames });
  const classPairs = classes.pairs;
  const replacer = buildReplacer([...tokenPairs, ...classPairs]);
  if (!replacer) {
    console.log('[apply-code] nothing to rewrite: every rename resolves to the same code spelling.');
    return;
  }

  const generatedRe = (config.code.generated ?? []).map(compilePathGlob);
  const all = await listFiles({
    roots: config.code.roots,
    include: config.code.include,
    exclude: config.code.exclude,
    baseDir: config.rootDir,
  });
  const files = args['include-generated']
    ? all
    : all.filter((f) => !matchesAnyPath(path.relative(config.rootDir, f).split(path.sep).join('/'), generatedRe));
  const skipped = all.length - files.length;

  const write = Boolean(args.write);
  const perFile = [];
  const perPair = new Map();
  let changedFiles = 0;
  let total = 0;

  for (const file of files) {
    const before = await fs.readFile(file, 'utf8');
    const { text, hits, total: fileTotal } = rewrite(before, replacer);
    if (fileTotal === 0) continue;
    changedFiles++;
    total += fileTotal;
    perFile.push({ file: path.relative(config.rootDir, file), count: fileTotal });
    for (const [from, n] of hits) perPair.set(from, (perPair.get(from) ?? 0) + n);
    if (write) await fs.writeFile(file, text, 'utf8');
  }

  const verb = write ? 'rewrote' : 'would rewrite';
  console.log(
    `[apply-code] ${verb} ${total} occurrence(s) in ${changedFiles} of ${files.length} scanned file(s)` +
      `${skipped ? `, ${skipped} generated file(s) skipped` : ''}`,
  );

  for (const { file, count } of perFile.sort((a, b) => b.count - a.count)) {
    console.log(`[apply-code]   ${String(count).padStart(4)}  ${file}`);
  }

  const silent = [...new Set(tokenPairs.map((p) => p.from))].filter((from) => !perPair.has(from));
  if (silent.length) {
    console.log(`\n[apply-code] ${silent.length} spelling(s) matched nothing:`);
    for (const from of silent.slice(0, 15)) console.log(`[apply-code]   ${from}`);
    if (silent.length > 15) console.log(`[apply-code]   … ${silent.length - 15} more`);
    console.log('[apply-code] (expected for unused tokens; suspicious if a token you know is used appears here)');
  }

  const classHits = classPairs.filter((p) => perPair.has(p.from));
  if (classHits.length) {
    console.log('\n[apply-code] namespace classes moved (one pair, many call sites — read these):');
    for (const p of classHits) console.log(`[apply-code]   ${p.from} -> ${p.to}  (${perPair.get(p.from)}x)`);
  }
  if (classes.advisories.length) {
    console.log('\n[apply-code] namespace class references NOT rewritten — the build will name them:');
    for (const advisory of classes.advisories) console.log(`[apply-code]   ${advisory}`);
  }

  if (!write) {
    console.log('\n[apply-code] dry run. Re-run with --write to apply.');
    return;
  }
  console.log('\n[apply-code] applied. Next: rebuild, run the test suite, then node check.mjs --after');
}

main().catch((err) => {
  console.error(`[apply-code] ${err.message}`);
  process.exit(1);
});
