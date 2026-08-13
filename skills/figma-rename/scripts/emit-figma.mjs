#!/usr/bin/env node
// emit-figma.mjs — turn one batch of the rename map into a `use_figma` script.
//
//   node emit-figma.mjs --batch variable-color-semantic
//   node emit-figma.mjs --batch variable-color-semantic --with-code-syntax
//   node emit-figma.mjs --batch variable-color-semantic --reverse   # rollback
//
// Refuses a batch that has already gone out, one with undecided rows, and a
// second batch while another is still mid-flight — see the status gates below.
//
// Why generate the script instead of writing it by hand: a batch is 20–40
// id/name pairs, and a hand-transcribed id renames the wrong variable with no
// error. The generated script also carries three properties that are easy to
// forget under time pressure:
//
//   1. It resolves and validates EVERY id before assigning ANY name, so a bad
//      batch throws before it has half-applied. `use_figma` does not execute a
//      script that throws, so a rejected batch leaves the file untouched.
//   2. It stages rename chains through temporary names, so "a -> b, b -> c"
//      cannot collide mid-run.
//   3. It returns the old and new name of everything it touched, which is the
//      record that makes `--reverse` trustworthy.

import { COMMON_FLAGS, loadConfig, parseArgs } from './lib/config.mjs';
import { batchById, effectiveRenames, findChains, loadMap, pendingRenames, statusOf } from './lib/map.mjs';
import { toCamel, toKebab } from './lib/naming.mjs';

const GETTERS = {
  variable: 'figma.variables.getVariableByIdAsync',
  component: 'figma.getNodeByIdAsync',
  componentSet: 'figma.getNodeByIdAsync',
  layer: 'figma.getNodeByIdAsync',
  textStyle: 'figma.getStyleByIdAsync',
  effectStyle: 'figma.getStyleByIdAsync',
  paintStyle: 'figma.getStyleByIdAsync',
};

const NODE_KINDS = new Set(['component', 'componentSet', 'layer']);

const USAGE = `
emit-figma.mjs — print the script to paste into use_figma

  --batch <id>            required; the batch to emit
  --reverse               emit the rollback for an applied batch
  --with-code-syntax      also set Figma Dev Mode code syntax (variables only)
  --force                 emit although another batch is already in flight
  --config <path>         use a config other than ./rename.config.json

Load the figma-use skill before calling use_figma.
`;

async function main() {
  const args = parseArgs(process.argv.slice(2), {
    usage: USAGE,
    flags: [...COMMON_FLAGS, ...['batch','reverse','with-code-syntax','force']],
    wantsValue: ['config','batch'],
  });
  const config = await loadConfig(args.config);
  const map = await loadMap(config.renameMapPath);

  const batchId = args.batch ?? args._[0];
  if (!batchId) {
    console.error('[emit] --batch <id> is required. Batches in this map:');
    for (const b of map.batches) {
      console.error(`  ${b.id}  (${b.kind}, ${b.renames.length} rename(s), ${statusOf(b)})`);
    }
    process.exit(1);
  }
  const batch = batchById(map, batchId);
  const reverse = Boolean(args.reverse);
  const status = statusOf(batch);

  // Status gates. Without them, re-running a forward emit on an applied batch
  // only fails by luck of the name check, and a reverse can be generated for a
  // batch that never went out — a script that would rename things backwards
  // from a state they were never in.
  if (reverse) {
    if (status === 'planned') {
      throw new Error(
        `"${batch.id}" has not been applied — there is nothing to reverse. ` +
          '(If Figma was renamed outside this tool, run review.mjs mark ' +
          `${batch.id} --figma-applied first.)`,
      );
    }
  } else {
    if (status !== 'planned') {
      throw new Error(
        `"${batch.id}" is ${status} — it has already gone out. ` +
          `To undo it: node emit-figma.mjs --batch ${batch.id} --reverse`,
      );
    }
    const pending = pendingRenames(batch);
    if (pending.length) {
      throw new Error(
        `"${batch.id}" has ${pending.length} undecided row(s). Nothing ships unreviewed:\n` +
          `  node review.mjs list --batch ${batch.id} --pending\n` +
          `  node review.mjs accept --batch ${batch.id} --all`,
      );
    }
    // One batch in flight at a time is what makes "one batch = one commit" hold.
    const inFlight = map.batches.filter((b) => statusOf(b) === 'figma-applied');
    if (inFlight.length && !args.force) {
      throw new Error(
        `"${inFlight[0].id}" is already applied in Figma but not in code. Finish it first ` +
          '(apply-code, check --after, review.mjs mark --applied), or pass --force to run two at once.',
      );
    }
  }

  const rows = effectiveRenames(batch);
  if (!rows.length) {
    throw new Error(`"${batch.id}" has no accepted rows — every one was rejected. Nothing to emit.`);
  }

  const getter = GETTERS[batch.kind];
  if (!getter) throw new Error(`No Plugin API getter for kind "${batch.kind}".`);

  const pairs = rows.map((r) => ({
    id: r.id,
    from: reverse ? r.to : r.from,
    to: reverse ? r.from : r.to,
  }));

  const staged = findChains(pairs).length > 0;
  const pageId = NODE_KINDS.has(batch.kind) ? batch.pageId ?? null : null;
  const withCodeSyntax = Boolean(args['with-code-syntax']) && batch.kind === 'variable';

  const pairLines = pairs
    .map((p) => {
      const codeSyntax = withCodeSyntax
        ? `, {"WEB": ${JSON.stringify(`var(--${config.code.cssPrefix ?? ''}${toKebab(p.to)})`)}, ` +
          `"ANDROID": ${JSON.stringify(toCamel(p.to))}, "iOS": ${JSON.stringify(toCamel(p.to))}}`
        : '';
      return `  [${JSON.stringify(p.id)}, ${JSON.stringify(p.from)}, ${JSON.stringify(p.to)}${codeSyntax}]`;
    })
    .join(',\n');

  const script = `// figma-rename — batch "${batch.id}" (${batch.kind})${reverse ? ' — REVERSE / rollback' : ''}
// ${pairs.length} rename(s). Generated by emit-figma.mjs; do not hand-edit the pairs.
// [id, expectedCurrentName, newName${withCodeSyntax ? ', codeSyntax' : ''}]
const PAIRS = [
${pairLines}
];
${
  pageId
    ? `
// Node renames need the owning page loaded. Exactly one page switch per call.
const page = await figma.getNodeByIdAsync(${JSON.stringify(pageId)});
if (!page) throw new Error("Page ${pageId} not found");
await figma.setCurrentPageAsync(page);
`
    : ''
}
// ---- resolve and validate everything BEFORE mutating anything -------------
const resolved = [];
const problems = [];
for (const row of PAIRS) {
  const [id, expected, to] = row;
  const target = await ${getter}(id);
  if (!target) { problems.push({ id, error: "not found in this file" }); continue; }
  if (target.name !== expected) {
    problems.push({ id, error: "name is " + JSON.stringify(target.name) + ", map expected " + JSON.stringify(expected) });
    continue;
  }
  ${batch.kind === 'variable' ? 'if (target.remote) { problems.push({ id, error: "library variable — rename it in its source file" }); continue; }' : ''}
  resolved.push({ target, from: target.name, to, row });
}
if (problems.length) {
  // Throwing here means the script does not execute at all: the file is
  // untouched and the map can be re-planned against a fresh inventory.
  throw new Error("Refusing to rename — " + problems.length + " problem(s): " + JSON.stringify(problems));
}
${
  staged
    ? `
// This batch contains a rename chain (something is being renamed TO a name
// that something else is being renamed FROM). Stage through temporary names so
// no intermediate state collides.
resolved.forEach((item, i) => { item.target.name = "__rn_tmp_" + i; });
`
    : ''
}
for (const item of resolved) {
  item.target.name = item.to;${
    withCodeSyntax
      ? `
  const syntax = item.row[3];
  if (syntax) for (const platform of Object.keys(syntax)) item.target.setVariableCodeSyntax(platform, syntax[platform]);`
      : ''
  }
}

return {
  batch: ${JSON.stringify(batch.id)},
  kind: ${JSON.stringify(batch.kind)},
  ${reverse ? 'reversed: true,\n  ' : ''}renamed: resolved.length,
  ${staged ? 'staged: true,\n  ' : ''}pairs: resolved.map(i => ({ id: i.target.id, from: i.from, to: i.to })),
  mutatedNodeIds: resolved.map(i => i.target.id),
};
`;

  console.log(script);
  console.error(
    `[emit] batch "${batch.id}": ${pairs.length} ${batch.kind} rename(s)` +
      `${staged ? ', staged through temporary names' : ''}${reverse ? ', REVERSE' : ''}` +
      `${withCodeSyntax ? ', with code syntax' : ''}`,
  );
  console.error(`[emit] pass this to use_figma with fileKey ${map.fileKey ?? '(set figma.fileKey in rename.config.json)'}`);
  console.error(
    reverse
      ? `[emit] after use_figma succeeds, the batch is back to where it was — git revert the batch commit too`
      : `[emit] after use_figma succeeds: node review.mjs mark ${batch.id} --figma-applied`,
  );
}

main().catch((err) => {
  console.error(`[emit] ${err.message}`);
  process.exit(1);
});
