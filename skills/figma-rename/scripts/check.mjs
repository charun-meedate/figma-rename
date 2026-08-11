#!/usr/bin/env node
// check.mjs — refuse a rename map that would break something.
//
//   node check.mjs                # validate the map against the inventory
//   node check.mjs --code         # also scan the codebase: how many hits each rename has
//   node check.mjs --after        # post-apply: assert no old spelling survives
//
// This runs before anything is applied, because every failure it catches is
// cheap here and expensive later: a duplicate name is a thrown error halfway
// through a Figma batch, and an identifier collision is a token that silently
// disappears from generated code.

import fs from 'node:fs/promises';
import path from 'node:path';

import {
  buildReplacer,
  compilePathGlob,
  listFiles,
  matchesAnyPath,
  namespaceClassPairs,
  spellingsFor,
} from './lib/codemod.mjs';
import { loadConfig, parseArgs } from './lib/config.mjs';
import { bucketOf, loadInventory } from './lib/inventory.mjs';
import { findChains, loadMap, selectRenames } from './lib/map.mjs';
import { assertUniqueIdentifiers, toCamel, toKebab } from './lib/naming.mjs';

const TOKEN_KINDS = new Set(['variable', 'textStyle', 'effectStyle', 'paintStyle']);

/** Characters Figma tolerates in a variable or style name without surprises. */
const SAFE_NAME = /^[A-Za-z0-9 _.&+()/-]+$/;

function checkNameLegality(to, errors, at) {
  if (to.trim() !== to) errors.push(`${at}: "${to}" has leading or trailing whitespace.`);
  if (to.startsWith('/') || to.endsWith('/')) errors.push(`${at}: "${to}" starts or ends with "/" — Figma reads that as an empty group.`);
  if (to.includes('//')) errors.push(`${at}: "${to}" contains an empty segment ("//").`);
  for (const segment of to.split('/')) {
    if (segment.trim() !== segment) errors.push(`${at}: segment "${segment}" in "${to}" has stray whitespace.`);
  }
  if (!SAFE_NAME.test(to)) errors.push(`${at}: "${to}" contains characters outside [A-Za-z0-9 _.&+()/-].`);
}

async function main() {
  const args = parseArgs();
  const config = await loadConfig(args.config);
  const map = await loadMap(config.renameMapPath);
  const inventory = await loadInventory(config.inventoryPath);
  const renames = selectRenames(map, { batch: args.batch, kind: args.kind });

  const allTokenNames = inventory.entries.filter((e) => TOKEN_KINDS.has(e.kind)).map((e) => e.name);

  if (args.after) return checkAfter(config, renames, allTokenNames);

  const errors = [];
  const warnings = [];

  // ---- the map still describes the file it was planned against ------------
  for (const r of renames) {
    const entry = inventory.byId.get(r.id);
    if (!entry) {
      errors.push(`${r.batchId}: id ${r.id} ("${r.from}") is not in the inventory — re-capture it and re-plan.`);
      continue;
    }
    if (entry.name !== r.from) {
      errors.push(
        `${r.batchId}: id ${r.id} is called "${entry.name}" in Figma but the map says from="${r.from}". ` +
          'Someone renamed it in between; re-capture the inventory.',
      );
    }
    if (entry.remote) {
      warnings.push(`${r.batchId}: "${r.from}" is a library (remote) entity — it cannot be renamed from this file.`);
    }
    checkNameLegality(r.to, errors, r.batchId);
  }

  // ---- no two things end up with the same name in one namespace -----------
  const byBucket = new Map();
  for (const entry of inventory.entries) {
    const bucket = bucketOf(entry);
    if (!byBucket.has(bucket)) byBucket.set(bucket, new Map());
    byBucket.get(bucket).set(entry.id, entry.name);
  }
  for (const r of renames) {
    const entry = inventory.byId.get(r.id);
    if (!entry) continue;
    byBucket.get(bucketOf(entry))?.set(r.id, r.to);
  }
  for (const [bucket, names] of byBucket) {
    const seen = new Map();
    for (const [id, name] of names) {
      const key = name.toLowerCase();
      if (seen.has(key)) {
        const message = `${bucket}: "${name}" would be the name of both ${seen.get(key)} and ${id}.`;
        // Figma rejects a duplicate variable name inside a collection outright;
        // duplicate component names are legal but make the asset picker a
        // guessing game, so they warn rather than block.
        if (bucket.startsWith('variable:') || bucket.startsWith('style:')) errors.push(message);
        else warnings.push(message);
      }
      seen.set(key, id);
    }
  }

  // ---- rename chains need staging through temporary names ----------------
  for (const batch of map.batches) {
    const chains = findChains(batch.renames);
    for (const c of chains) {
      warnings.push(
        `${batch.id}: "${c.from}" -> "${c.to}" collides with "${c.blockedBy}", which is also being renamed. ` +
          'emit-figma.mjs stages this through temporary names; nothing to fix.',
      );
    }
  }

  // ---- generated code must still have one identifier per token -----------
  const finalTokenNames = [];
  const toName = new Map(renames.map((r) => [r.id, r.to]));
  for (const entry of inventory.entries) {
    if (!TOKEN_KINDS.has(entry.kind)) continue;
    finalTokenNames.push(toName.get(entry.id) ?? entry.name);
  }
  for (const [label, fn] of [
    ['camelCase fields (Dart/TS)', toCamel],
    ['CSS custom properties', toKebab],
  ]) {
    try {
      assertUniqueIdentifiers(
        finalTokenNames.map((name) => [name, fn(name)]),
        label,
      );
    } catch (err) {
      errors.push(err.message);
    }
  }

  if (args.code) await reportCodeHits(config, renames, warnings, allTokenNames);

  report(errors, warnings, `${renames.length} rename(s) checked`);
}

/** Counts, per rename, how many places in the codebase would actually change. */
async function reportCodeHits(config, renames, warnings, allTokenNames) {
  const classes = namespaceClassPairs(renames, { ...config.code, allTokenNames });
  for (const advisory of classes.advisories) warnings.push(advisory);
  const pairs = [...renames.flatMap((r) => spellingsFor(r, config.code)), ...classes.pairs];
  const forward = buildReplacer(pairs);
  // The reverse replacer answers a different question: is the NEW spelling
  // already taken by something unrelated? A rename onto an occupied name
  // compiles and means the wrong thing, which no test will catch.
  const reverse = buildReplacer(pairs.map((p) => ({ ...p, from: p.to, to: p.from })));

  const files = await listFiles({
    roots: config.code.roots,
    include: config.code.include,
    exclude: config.code.exclude,
    baseDir: config.rootDir,
  });

  // Generated files are counted separately: `apply-code.mjs` skips them and
  // the generator rebuilds them, so folding them into one total makes the
  // codemod look far bigger than the change it will actually make.
  const generatedRe = (config.code.generated ?? []).map(compilePathGlob);
  const isGenerated = (file) =>
    matchesAnyPath(path.relative(config.rootDir, file).split(path.sep).join('/'), generatedRe);

  const hits = new Map();
  const occupied = new Map();
  let consumerHits = 0;
  let generatedHits = 0;
  let consumerFiles = 0;
  for (const file of files) {
    const text = await fs.readFile(file, 'utf8');
    const generated = isGenerated(file);
    if (!generated) consumerFiles++;
    for (const [re, sink] of [
      [forward, hits],
      [reverse, occupied],
    ]) {
      if (!re) continue;
      for (const match of text.matchAll(re.re)) {
        if (sink === hits) {
          if (generated) generatedHits++;
          else consumerHits++;
          if (generated) continue; // reported, but not the codemod's work
        }
        sink.set(match[0], (sink.get(match[0]) ?? 0) + 1);
      }
    }
  }

  console.log(
    `[check] ${consumerFiles} file(s) the codemod will rewrite, ${consumerHits} occurrence(s)`,
  );
  if (generatedHits) {
    console.log(
      `[check] ${generatedHits} more occurrence(s) sit in generated files — those come from ` +
        'regenerating tokens, not from apply-code.mjs',
    );
  }
  const silent = pairs.filter((p) => !hits.has(p.from));
  if (silent.length) {
    console.log(`[check] ${silent.length} spelling(s) appear nowhere in hand-written code (fine if unused there)`);
  }
  for (const [name, count] of occupied) {
    warnings.push(`"${name}" already appears in the codebase ${count}x, and a rename targets that spelling.`);
  }
}

/** After applying: nothing may still be spelled the old way. */
async function checkAfter(config, renames, allTokenNames) {
  const classes = namespaceClassPairs(renames, { ...config.code, allTokenNames });
  const pairs = [...renames.flatMap((r) => spellingsFor(r, config.code)), ...classes.pairs];
  const replacer = buildReplacer(pairs);
  const files = await listFiles({
    roots: config.code.roots,
    include: config.code.include,
    exclude: config.code.exclude,
    baseDir: config.rootDir,
  });

  const leftovers = [];
  for (const file of replacer ? files : []) {
    const text = await fs.readFile(file, 'utf8');
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      for (const match of line.matchAll(replacer.re)) {
        leftovers.push(`${path.relative(config.rootDir, file)}:${i + 1}: ${match[0]} — ${line.trim().slice(0, 100)}`);
      }
    });
  }

  report(
    leftovers.map((l) => `stale name still in code — ${l}`),
    [],
    `${files.length} file(s) scanned for ${pairs.length} old spelling(s)`,
  );
}

function report(errors, warnings, summary) {
  for (const w of warnings) console.log(`[check] warning: ${w}`);
  if (errors.length) {
    console.error(`\n[check] ${errors.length} problem(s):`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.log(`[check] OK — ${summary}${warnings.length ? `, ${warnings.length} warning(s)` : ''}`);
}

main().catch((err) => {
  console.error(`[check] ${err.message}`);
  process.exit(1);
});
