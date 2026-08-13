#!/usr/bin/env node
// apply-code.mjs — rewrite every reference in the codebase to match the rename.
//
//   node apply-code.mjs                       # dry run over the batch(es) that are due
//   node apply-code.mjs --batch <id> --write  # apply one batch
//   node apply-code.mjs --write               # apply every batch Figma is ahead on
//
// "Due" means status `figma-applied`: Figma has been renamed, the code has not.
// A batch that has not reached Figma cannot be written, and one already applied
// is refused as a no-op — so the codebase can never run ahead of the design.
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
  TOKEN_KINDS,
} from './lib/codemod.mjs';
import { COMMON_FLAGS, loadConfig, parseArgs } from './lib/config.mjs';
import { loadInventory } from './lib/inventory.mjs';
import {
  batchById,
  effectiveRenames,
  ladderFor,
  loadMap,
  pendingRenames,
  selectRenames,
  sourceOf,
  statusOf,
} from './lib/map.mjs';

const USAGE = `
apply-code.mjs — rewrite the codebase for a batch Figma has already applied

  (no flags)              dry run: report what would change, write nothing
  --write                 actually rewrite the files
  --batch <id>            one batch (default: every figma-applied batch)
  --kind <k>              one kind only
  --no-namespace-classes  skip generated class-name rewrites
  --include-generated     also rewrite generated files (normally the generator's job)
  --config <path>         use a config other than ./rename.config.json
`;

async function main() {
  const args = parseArgs(process.argv.slice(2), {
    usage: USAGE,
    flags: [...COMMON_FLAGS, ...['batch','kind','write','include-generated','no-namespace-classes']],
    wantsValue: ['config','batch','kind'],
  });
  const config = await loadConfig(args.config);
  const map = await loadMap(config.renameMapPath, { expectSource: config.source });
  const inventory = await loadInventory(config.inventoryPath);
  // Default selection is the batches Figma is already ahead on — exactly the
  // set whose code rewrite is DUE. Before v2 a bare `--write` rewrote every
  // batch in the map, putting the codebase N batches ahead of Figma with
  // nothing to catch it.
  // The state a reviewed batch sits in while its rewrite is DUE. Under Figma
  // that is figma-applied (Figma moved, code has not); with no Figma leg it is
  // planned, because there is nothing for the code to be behind.
  const ladder = ladderFor(map);
  const codeSource = sourceOf(map) === 'code';
  const dueStatus = codeSource ? 'planned' : 'figma-applied';

  if (args.batch) {
    const batch = batchById(map, args.batch);
    const status = statusOf(batch);
    if (args.write) {
      if (status !== dueStatus) {
        throw new Error(
          status === 'planned'
            ? `"${batch.id}" has not been renamed in Figma yet. Order matters:\n` +
              `  node emit-figma.mjs --batch ${batch.id}   → run it in Figma\n` +
              `  node review.mjs mark ${batch.id} --figma-applied\n` +
              '  then this command'
            : `"${batch.id}" is already applied — its code rewrite is done. Nothing to do.`,
        );
      }
      const pending = pendingRenames(batch);
      if (pending.length) {
        throw new Error(`"${batch.id}" has ${pending.length} undecided row(s) — review first.`);
      }
    }
  }

  const statuses = args.batch ? undefined : [dueStatus];
  // With no Figma leg there is no emit gate guaranteeing one due batch at a
  // time, so a bare `--write` could rewrite every reviewed batch at once — the
  // "apply everything and lose the rollback" failure the batch loop exists to
  // prevent. Naming the candidates and demanding --batch is the same answer
  // review.mjs gives with its mandatory --all.
  if (codeSource && args.write && !args.batch) {
    const due = map.batches.filter(
      (b) => statusOf(b) === dueStatus && !pendingRenames(b).length && effectiveRenames(b).length,
    );
    if (due.length > 1) {
      throw new Error(
        `${due.length} batches are reviewed and waiting: ${due.map((b) => b.id).join(', ')}.\n` +
          'Name one with --batch. One batch is one commit is one thing you can revert.',
      );
    }
  }

  const renames = selectRenames(map, {
    batch: args.batch,
    kind: args.kind,
    statuses,
    decisions: ['accepted'],
  });
  if (renames.length === 0) {
    const inFlight = map.batches.filter((b) => statusOf(b) === dueStatus);
    throw new Error(
      inFlight.length
        ? codeSource
          ? 'Nothing accepted to apply in the batches that are reviewed and waiting.'
          : 'Nothing accepted to apply in the batches Figma is ahead on.'
        : codeSource
          ? 'No batch is waiting for its code rewrite. Plan and review one first ' +
            '(plan.mjs → review.mjs accept).'
          : 'No batch is waiting for its code rewrite. Apply one in Figma first ' +
            '(emit-figma → use_figma → review.mjs mark <id> --figma-applied).',
    );
  }

  // Commit state is git state, which these scripts deliberately cannot read —
  // so this is an advisory, not a gate. Two applied-but-uncommitted batches
  // cannot be reverted separately, which is the whole promise of one-per-commit.
  if (codeSource && args.write) {
    const alreadyApplied = map.batches.filter((b) => statusOf(b) === 'applied');
    if (alreadyApplied.length) {
      console.log(
        `[apply-code] note: ${alreadyApplied.map((b) => b.id).join(', ')} ` +
          `${alreadyApplied.length === 1 ? 'is' : 'are'} already applied — commit ` +
          `${alreadyApplied.length === 1 ? 'it' : 'them'} first if you have not, ` +
          'or two batches end up in one revert.',
      );
    }
  }

  const allTokenNames = inventory.entries.filter((e) => TOKEN_KINDS.has(e.kind)).map((e) => e.name);
  // Keep each pair tied to the rename it came from. A pair's own `from` is a
  // CODE spelling (`--colors-red-500`), never the Figma name, so anything that
  // tries to match the two up later compares two different alphabets and
  // silently concludes nothing changed.
  const pairsByRename = renames.map((r) => ({ rename: r, pairs: spellingsFor(r, config.code) }));
  const tokenPairs = pairsByRename.flatMap((entry) => entry.pairs);
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
  if (args['include-generated']) {
    console.log(
      '[apply-code] WARNING --include-generated: these files are rebuilt from tokens.json. ' +
        'Patching them here is either erased by the next generate, or it is not — and then they ' +
        'disagree with tokens.json and `generate --check` reports drift with no obvious cause.',
    );
  }
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

  // A rename that only regroups segments — `font-family/heading` becoming
  // `font/family/heading` — spells identically in code, because every code
  // spelling flattens `/` and `-` the same way. `spellingsFor` correctly emits
  // no pair for it, and without this the run reports "0 occurrences" and leaves
  // the reader wondering whether the scan is broken. It is not: there is
  // genuinely nothing on this side to change.
  const inert = pairsByRename
    .filter(({ pairs }) => !pairs.some((p) => p.spelling !== 'figmaPath'))
    .map(({ rename }) => rename);
  if (inert.length) {
    console.log(
      `\n[apply-code] ${inert.length} rename(s) change no code spelling — regrouping only ` +
        '(Figma path changes, the generated identifier does not):',
    );
    for (const r of inert.slice(0, 8)) console.log(`[apply-code]   ${r.from}  ->  ${r.to}`);
    if (inert.length > 8) console.log(`[apply-code]   … ${inert.length - 8} more`);
  }

  const silent = [...new Set(tokenPairs.map((p) => p.from))]
    .filter((from) => !perPair.has(from))
    // figmaPath spellings for an inert rename are already explained above.
    .filter((from) => !inert.some((r) => r.from === from));
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
  // Order matters under source:code — the mark is what makes `check --after`
  // able to see this batch at all, so it comes first, not last.
  if (codeSource) {
    console.log('\n[apply-code] applied. Record it, then verify:');
    if (args.batch) console.log(`[apply-code]   node review.mjs mark ${args.batch} --applied`);
    console.log('[apply-code]   rebuild and run the test suite');
    console.log('[apply-code]   node check.mjs --after          then commit');
    return;
  }
  console.log('\n[apply-code] applied. Next: rebuild, run the test suite, then:');
  console.log('[apply-code]   node check.mjs --after');
  if (args.batch) console.log(`[apply-code]   node review.mjs mark ${args.batch} --applied     then commit`);
}

main().catch((err) => {
  console.error(`[apply-code] ${err.message}`);
  process.exit(1);
});
