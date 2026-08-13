#!/usr/bin/env node
// check.mjs — refuse a rename map that would break something.
//
//   node check.mjs                # validate the map against the inventory
//   node check.mjs --code         # also scan the codebase: how many hits each rename has
//   node check.mjs --after        # post-apply: assert no old spelling survives
//
// Status-aware. Planned batches are checked forwards (the inventory should still
// hold `from`); batches that already went out are checked backwards (it should
// hold `to`), so re-capturing the inventory mid-run is safe. `--after` looks
// only at what has been applied.
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
  TOKEN_KINDS,
} from './lib/codemod.mjs';
import { COMMON_FLAGS, loadConfig, parseArgs } from './lib/config.mjs';
import { crossCheck, loadTokensConfig } from './lib/handoff.mjs';
import { bucketOf, loadInventory } from './lib/inventory.mjs';
import {
  conventionHash,
  findChains,
  findDuplicateIds,
  isFrozen,
  loadMap,
  selectRenames,
  statusOf,
} from './lib/map.mjs';
import { assertUniqueIdentifiers, toCamel, toKebab } from './lib/naming.mjs';

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

const USAGE = `
check.mjs — refuse before anything is touched

  (no flags)              check the map against the inventory
  --code                  also scan the repo and count what would change
  --after                 post-apply: no old spelling may survive anywhere
  --batch <id>            one batch only
  --kind <k>              one kind only
  --no-namespace-classes  skip generated class-name rewrites; needed when a
                          namespace the Flutter generator special-cases (colors)
                          maps to two new class names at once
  --allow-convention-drift  proceed although the convention changed since planning
  --config <path>         use a config other than ./rename.config.json
`;

async function main() {
  const args = parseArgs(process.argv.slice(2), {
    usage: USAGE,
    flags: [...COMMON_FLAGS, ...['batch','kind','code','after','allow-convention-drift','no-namespace-classes']],
    wantsValue: ['config','batch','kind'],
  });
  const config = await loadConfig(args.config);
  const map = await loadMap(config.renameMapPath);
  const inventory = await loadInventory(config.inventoryPath);

  const allTokenNames = inventory.entries.filter((e) => TOKEN_KINDS.has(e.kind)).map((e) => e.name);

  if (args.after) {
    // Only what has actually gone out. Scanning planned batches here was the
    // reason a bare `check --after` failed on every multi-batch run: batches
    // 2..N legitimately still use their old names in code.
    const applied = selectRenames(map, {
      batch: args.batch,
      kind: args.kind,
      statuses: ['figma-applied', 'applied'],
      decisions: ['accepted'],
    });
    if (!applied.length) {
      console.log('[check] nothing has been applied yet — nothing to verify.');
      return;
    }
    return checkAfter(config, applied, allTokenNames, args['no-namespace-classes']);
  }

  const errors = [];
  const warnings = [];

  // ---- the map was planned under the convention that is loaded now --------
  const currentHash = conventionHash(config.convention);
  if (map.conventionHash && map.conventionHash !== currentHash && !args['allow-convention-drift']) {
    errors.push(
      'This map was planned under a different convention than the one loading now ' +
        `(map ${map.conventionHash}, config ${currentHash}). Applying it would produce names nobody chose — ` +
        'and every individual rename would still look internally consistent, so the diff would not show it. ' +
        'Re-plan (the merge keeps your decisions), or pass --allow-convention-drift if you know why they differ.',
    );
  }

  // ---- one id may not be in two batches that are both still waiting -------
  for (const clash of findDuplicateIds(map)) {
    errors.push(
      `id ${clash.id} ("${clash.name}") is renamed by both ${clash.batches.join(' and ')}. ` +
        'The first apply moves the name and the second throws halfway through — put it in one batch.',
    );
  }

  const pendingRows = selectRenames(map, {
    batch: args.batch,
    kind: args.kind,
    statuses: ['planned'],
    decisions: ['accepted', 'pending'],
  });
  const undecided = pendingRows.filter((r) => (r.decision ?? 'pending') === 'pending');
  if (undecided.length) {
    warnings.push(
      `${undecided.length} row(s) are still undecided — emit-figma will refuse them. ` +
        'Run: node review.mjs status',
    );
  }

  // ---- the map still describes the file it was planned against ------------
  for (const r of pendingRows) {
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

  // ---- batches that already went out are checked BACKWARDS ----------------
  //
  // For an applied batch the inventory should now hold the NEW name. Checking
  // `from` there is what used to hard-error the moment someone followed the
  // manual's "re-capture before every planning pass" — work already finished
  // reported as a stale map.
  const appliedRows = selectRenames(map, {
    kind: args.kind,
    statuses: ['figma-applied', 'applied'],
    decisions: ['accepted'],
  });
  for (const r of appliedRows) {
    const entry = inventory.byId.get(r.id);
    if (!entry) continue; // deleted in Figma since; not this command's business
    if (entry.name !== r.to && entry.name !== r.from) {
      warnings.push(
        `${r.batchId}: "${r.to}" was applied but is now called "${entry.name}" in Figma — ` +
          'renamed again outside this tool. A re-plan will pick it up.',
      );
    }
  }

  const renames = pendingRows;

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

  // ---- the handoff to figma-token-export ----------------------------------
  const tokensConfig = await loadTokensConfig(config);
  if (tokensConfig) {
    const handoff = crossCheck(config, tokensConfig, renames);
    errors.push(...handoff.errors);
    warnings.push(...handoff.warnings);
    for (const note of handoff.notes) console.log(`[check] note: ${note}`);
  } else if (config.code.generated?.length) {
    warnings.push(
      `code.generated lists ${config.code.generated.length} path(s) but this project has no ` +
        'tokens.config.json — if the tokens here are hand-written, empty `generated` or the codemod ' +
        'will skip the very files that need renaming.',
    );
  }

  // The rollback story this skill tells is "one batch, one commit, git revert".
  // Nothing ever checked that the project is in git at all — and a real run
  // landed 20 renames in a shared Figma file from a plain folder, leaving the
  // reverse script and an unversioned rename-map as the only way back.
  if (!(await inGitWorkTree(config.rootDir))) {
    warnings.push(
      'this project is not in a git repository, so "one batch = one commit" does not hold here. ' +
        'Rolling back means running emit-figma --reverse and keeping rename/rename-map.json — ' +
        'if that file is lost, the renames cannot be undone. `git init` first if you can.',
    );
  }

  if (args.code) await reportCodeHits(config, renames, warnings, allTokenNames, args['no-namespace-classes']);

  report(errors, warnings, `${renames.length} rename(s) checked`);
}

/** Counts, per rename, how many places in the codebase would actually change. */
async function reportCodeHits(config, renames, warnings, allTokenNames, noClasses = false) {
  // apply-code has always had this escape hatch; check did not, so a namespace
  // the Flutter generator special-cases (`colors` -> AppColors) made the
  // documented preflight impossible to run at all — the one command whose whole
  // job is to be runnable before anything is touched.
  const classes = noClasses
    ? { pairs: [], advisories: ['namespace-class rewrites skipped (--no-namespace-classes)'] }
    : namespaceClassPairs(renames, { ...config.code, allTokenNames });
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
    let hitThisFile = 0;
    for (const [re, sink] of [
      [forward, hits],
      [reverse, occupied],
    ]) {
      if (!re) continue;
      for (const match of text.matchAll(re.re)) {
        if (sink === hits) {
          if (generated) {
            generatedHits++;
            continue; // reported, but not the codemod's work
          }
          consumerHits++;
          hitThisFile++;
        }
        sink.set(match[0], (sink.get(match[0]) ?? 0) + 1);
      }
    }
    if (hitThisFile) consumerFiles++;
  }

  // Files WITH A HIT, not files scanned. Counting scanned files reported
  // thousands of files "the codemod will rewrite" on a normal repo, while
  // apply-code reported the honest number for the same map — two commands
  // disagreeing by orders of magnitude about one question.
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
async function checkAfter(config, renames, allTokenNames, noClasses = false) {
  const classes = noClasses
    ? { pairs: [], advisories: [] }
    : namespaceClassPairs(renames, { ...config.code, allTokenNames });
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
    `${files.length} file(s) scanned for ${pairs.length} old spelling(s) from applied batch(es)`,
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

/** True when `dir` is inside a git work tree. Walks up rather than shelling out. */
async function inGitWorkTree(dir) {
  let current = path.resolve(dir);
  for (;;) {
    try {
      await fs.stat(path.join(current, '.git'));
      return true;
    } catch {
      /* keep walking */
    }
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}
