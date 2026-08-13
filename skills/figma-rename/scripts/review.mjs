#!/usr/bin/env node
// review.mjs — decide, resolve, and record where a batch has got to.
//
//   node review.mjs status                                   what is where
//   node review.mjs list --batch <id> [--pending] [--json]   every row, untruncated
//   node review.mjs accept --batch <id> --all
//   node review.mjs accept --batch <id> --rule "color/text-* -> text/$1/default"
//   node review.mjs accept --batch <id> --min-confidence high
//   node review.mjs reject --batch <id> --ids V1,V2 --note "keep the old name"
//   node review.mjs set-to <figma-id> --to <name>            fix one proposal
//   node review.mjs resolve <figma-id> --to <name>           answer a needsReview item
//   node review.mjs skip <figma-id> [--note "…"]             leave that name alone
//   node review.mjs mark <batch-id> --figma-applied | --applied
//
// This is the only writer of `decision` and `status`. Everything else reads
// them: `emit-figma` refuses a batch with pending rows, `apply-code` only
// touches batches Figma is already ahead on, `check --after` only scans what
// went out. So a rename cannot ship without somebody having said yes to it.
//
// ## Why a CLI and not a checkbox
//
// The plugin this replaced had a scrolling list of checkboxes. In a terminal
// the equivalent is not a TUI — it is the agent asking a handful of grouped
// questions and recording each answer here. Three hundred rows collapse into
// roughly (one question per rule) + (one per confidence tier) + (one per
// genuinely ambiguous row), because a rule is a decision the team already made
// and re-approving it row by row is theatre.
//
// The selectors exist to make that collapse possible: `--rule` decides
// everything one rule produced, `--min-confidence` decides a tier, `--ids`
// handles the leftovers.

import { COMMON_FLAGS, loadConfig, parseArgs } from './lib/config.mjs';
import {
  BATCH_STATUSES,
  batchById,
  decisionOf,
  effectiveRenames,
  isFrozen,
  loadMap,
  pendingRenames,
  statusOf,
  writeMap,
} from './lib/map.mjs';

const CONFIDENCE_RANK = { low: 0, medium: 1, high: 2 };

const USAGE = `Usage:
  review.mjs status
  review.mjs list    --batch <id> [--pending] [--json]
  review.mjs accept  --batch <id> (--all | --ids a,b | --rule "<rule>" | --match "<glob>" | --min-confidence low|medium|high)
  review.mjs reject   (same selectors) [--note "<why>"]
  review.mjs set-to  <figma-id> --to <name>
  review.mjs resolve <figma-id> --to <name>
  review.mjs skip    <figma-id> [--note "<why>"]
  review.mjs mark    <batch-id> --figma-applied | --applied

  --config <path>   use a config other than ./rename.config.json
  --note "<why>"    attach a reason to a decision; it survives a re-plan`;

function fail(message) {
  throw new Error(`${message}\n\n${USAGE}`);
}

/** `*` and `**` over a slash path, same shape as the convention globs. */
function globToRe(pattern) {
  let source = '';
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === '*') {
      if (pattern[i + 1] === '*') {
        source += '.*';
        i++;
      } else source += '[^/]*';
    } else if (/[.+^${}()|[\]\\?]/.test(char)) source += `\\${char}`;
    else source += char;
  }
  return new RegExp(`^${source}$`, 'i');
}

/**
 * Which rows a selector picks out.
 *
 * Deliberately refuses to default to "everything": `--all` has to be typed.
 * An accept that silently covered more than the reviewer looked at is the one
 * outcome this whole file exists to prevent.
 */
function selectRows(batch, args) {
  const rows = batch.renames;
  if (args.all) return rows;

  if (args.ids) {
    const wanted = new Set(String(args.ids).split(',').map((s) => s.trim()).filter(Boolean));
    const found = rows.filter((r) => wanted.has(r.id));
    const missing = [...wanted].filter((id) => !rows.some((r) => r.id === id));
    if (missing.length) fail(`These ids are not in batch "${batch.id}": ${missing.join(', ')}`);
    return found;
  }
  if (args.rule) {
    const found = rows.filter((r) => r.rule === args.rule);
    if (!found.length) {
      const rules = [...new Set(rows.map((r) => r.rule).filter(Boolean))];
      fail(`No row in "${batch.id}" came from that rule.\nRules in this batch:\n  ${rules.join('\n  ') || '(none)'}`);
    }
    return found;
  }
  if (args.match) {
    const re = globToRe(String(args.match));
    const found = rows.filter((r) => re.test(r.from) || re.test(r.to));
    if (!found.length) fail(`No row in "${batch.id}" matches "${args.match}".`);
    return found;
  }
  if (args['min-confidence']) {
    const floor = CONFIDENCE_RANK[args['min-confidence']];
    if (floor === undefined) fail(`--min-confidence must be low, medium or high (got "${args['min-confidence']}").`);
    // Rows with no confidence came from a rule, not a formula — a confidence
    // selector must not silently sweep them in.
    return rows.filter((r) => r.confidence && CONFIDENCE_RANK[r.confidence] >= floor);
  }
  fail('Pick what to decide on: --all, --ids, --rule, --match, or --min-confidence.');
  return [];
}

function summarise(batch) {
  const counts = { accepted: 0, pending: 0, rejected: 0 };
  for (const r of batch.renames) counts[decisionOf(r)]++;
  return counts;
}

// ------------------------------------------------------------------- commands

function cmdStatus(map) {
  const openReview = (map.needsReview ?? []).filter((i) => (i.decision ?? 'pending') === 'pending');
  console.log(`[review] ${map.batches.length} batch(es) in ${map.fileKey ?? 'this map'}`);
  for (const batch of map.batches) {
    const c = summarise(batch);
    const bits = [`${c.accepted} accepted`, `${c.pending} pending`, `${c.rejected} rejected`];
    console.log(`  ${statusOf(batch).padEnd(14)} ${batch.id.padEnd(30)} ${bits.join(', ')}`);
  }
  if (openReview.length) {
    console.log(`\n[review] ${openReview.length} open question(s) — these need a person:`);
    for (const item of openReview.slice(0, 20)) {
      console.log(`  ${item.name}`);
      console.log(`      ${item.why}`);
      if (item.suggestion) console.log(`      would be: ${item.suggestion}`);
      console.log(`      resolve <${item.id}> --to <name>   |   skip <${item.id}>`);
    }
    if (openReview.length > 20) console.log(`  … ${openReview.length - 20} more`);
  }

  const blocked = map.batches.filter((b) => !isFrozen(b) && pendingRenames(b).length);
  if (blocked.length) {
    console.log(`\n[review] pending rows block these batches from being applied:`);
    for (const b of blocked) console.log(`  ${b.id} — ${pendingRenames(b).length} undecided (list --batch ${b.id})`);
  }
  const inFlight = map.batches.filter((b) => statusOf(b) === 'figma-applied');
  for (const b of inFlight) {
    console.log(`\n[review] "${b.id}" is figma-applied — Figma is ahead of the code. Next: apply-code --batch ${b.id} --write`);
  }
}

function cmdList(map, args) {
  if (!args.batch) fail('list needs --batch <id>.');
  const batch = batchById(map, args.batch);
  const rows = args.pending ? pendingRenames(batch) : batch.renames;

  if (args.json) {
    console.log(JSON.stringify({ id: batch.id, kind: batch.kind, scope: batch.scope, status: statusOf(batch), renames: rows }, null, 2));
    return;
  }
  console.log(`[review] ${batch.id} (${batch.kind}, ${statusOf(batch)}) — ${rows.length} row(s)`);
  for (const r of rows) {
    const mark = { accepted: '+', rejected: '-', pending: '?' }[decisionOf(r)];
    console.log(`  ${mark} ${r.from}  ->  ${r.to}`);
    const meta = [r.source, r.confidence && `[${r.confidence}]`].filter(Boolean).join(' ');
    if (meta) console.log(`      ${meta}${r.rule ? `  via ${r.rule}` : ''}`);
    if (r.reason) console.log(`      ${r.reason}`);
    if (r.note) console.log(`      note: ${r.note}`);
    console.log(`      id: ${r.id}`);
  }
  const c = summarise(batch);
  console.log(`[review] ${c.accepted} accepted, ${c.pending} pending, ${c.rejected} rejected`);
}

function cmdDecide(map, args, decision) {
  if (!args.batch) fail(`${decision} needs --batch <id>.`);
  const batch = batchById(map, args.batch);
  if (isFrozen(batch)) {
    fail(`Batch "${batch.id}" is ${statusOf(batch)} — it has already gone out. Decisions can only change a planned batch.`);
  }
  const rows = selectRows(batch, args);
  let changed = 0;
  for (const row of rows) {
    if (decisionOf(row) === decision && (args.note ?? row.note) === row.note) continue;
    row.decision = decision;
    if (args.note) row.note = String(args.note);
    changed++;
  }
  console.log(`[review] ${decision} ${changed} row(s) in ${batch.id}${changed !== rows.length ? ` (${rows.length - changed} already ${decision})` : ''}`);
  for (const row of rows.slice(0, 8)) console.log(`  ${row.from}  ->  ${row.to}`);
  if (rows.length > 8) console.log(`  … ${rows.length - 8} more`);
  const c = summarise(batch);
  console.log(`[review] ${batch.id}: ${c.accepted} accepted, ${c.pending} pending, ${c.rejected} rejected`);
  return changed > 0;
}

function cmdSetTo(map, args) {
  const figmaId = args._[1];
  if (!figmaId || !args.to) fail('set-to needs a Figma id and --to <name>.');
  for (const batch of map.batches) {
    if (isFrozen(batch)) continue;
    const row = batch.renames.find((r) => r.id === figmaId);
    if (!row) continue;
    const was = row.to;
    row.to = String(args.to);
    row.decision = 'accepted';
    row.source = 'human';
    row.rule = undefined;
    if (args.note) row.note = String(args.note);
    console.log(`[review] ${batch.id}: ${row.from}  ->  ${row.to}   (was "${was}", now accepted)`);
    return true;
  }
  fail(`No planned batch holds ${figmaId}. (An applied batch cannot be edited — plan again and the merge will carry your decisions.)`);
  return false;
}

function cmdResolve(map, args) {
  const figmaId = args._[1];
  if (!figmaId || !args.to) fail('resolve needs a Figma id and --to <name>.');
  const items = map.needsReview ?? [];
  const index = items.findIndex((i) => i.id === figmaId);
  if (index === -1) {
    fail(`${figmaId} is not an open question in this map. Use \`list --batch <id>\` if it is already in a batch, then set-to.`);
  }
  const item = items[index];

  // Land it in the batch that owns its kind and scope, or open one — a
  // resolved question is an ordinary accepted rename from here on.
  let batch = map.batches.find(
    (b) => !isFrozen(b) && b.kind === item.kind && (b.scope ?? null) === (item.scope ?? null),
  );
  if (!batch) {
    batch = {
      id: `${item.kind}-resolved`,
      kind: item.kind,
      scope: item.scope ?? null,
      pageId: null,
      status: 'planned',
      renames: [],
    };
    // Do not collide with an existing id.
    let n = 2;
    while (map.batches.some((b) => b.id === batch.id)) batch.id = `${item.kind}-resolved-${n++}`;
    map.batches.push(batch);
    console.log(`[review] opened batch "${batch.id}" for resolved questions`);
  }
  batch.renames.push({
    id: item.id,
    from: item.name,
    to: String(args.to),
    source: 'human',
    decision: 'accepted',
    note: args.note ? String(args.note) : `resolved: ${item.why}`,
  });
  items.splice(index, 1);
  console.log(`[review] ${batch.id}: ${item.name}  ->  ${args.to}   (accepted)`);
  return true;
}

function cmdSkip(map, args) {
  const figmaId = args._[1];
  if (!figmaId) fail('skip needs a Figma id.');
  const item = (map.needsReview ?? []).find((i) => i.id === figmaId);
  if (!item) fail(`${figmaId} is not an open question in this map.`);
  item.decision = 'rejected';
  if (args.note) item.note = String(args.note);
  // Recorded rather than deleted, so re-planning does not ask again.
  console.log(`[review] leaving "${item.name}" alone. Re-planning will not raise it again.`);
  return true;
}

function cmdMark(map, args) {
  const batchId = args._[1];
  if (!batchId) fail('mark needs a batch id.');
  const batch = batchById(map, batchId);
  const target = args['figma-applied'] ? 'figma-applied' : args.applied ? 'applied' : null;
  if (!target) fail('mark needs --figma-applied or --applied.');

  const from = statusOf(batch);
  const order = BATCH_STATUSES.indexOf(from);
  const to = BATCH_STATUSES.indexOf(target);
  if (to !== order + 1) {
    fail(
      `"${batch.id}" is ${from}; it cannot go straight to ${target}. ` +
        `The order is ${BATCH_STATUSES.join(' -> ')}, one step at a time.`,
    );
  }
  if (target === 'figma-applied') {
    const pending = pendingRenames(batch);
    if (pending.length) {
      fail(`"${batch.id}" still has ${pending.length} undecided row(s) — accept or reject them first (list --batch ${batch.id} --pending).`);
    }
    if (!effectiveRenames(batch).length) {
      fail(`"${batch.id}" has nothing accepted — every row was rejected. Nothing was applied, so there is nothing to mark.`);
    }
  }
  batch.status = target;
  console.log(`[review] ${batch.id}: ${from} -> ${target}`);
  if (target === 'figma-applied') {
    console.log('[review] next: re-capture dumps, regenerate tokens, then apply-code --batch ' + batch.id + ' --write');
  } else {
    console.log('[review] next: commit this batch (map included, so a revert restores this status too)');
  }
  return true;
}

// ---------------------------------------------------------------------- entry

async function main() {
  const args = parseArgs(process.argv.slice(2), {
    usage: USAGE,
    flags: [...COMMON_FLAGS, ...['batch','all','ids','rule','match','min-confidence','note','to','json','pending','figma-applied','applied']],
    wantsValue: ['config','batch','ids','rule','match','min-confidence','note','to'],
  });
  const command = args._[0];
  if (!command || command === 'help') {
    console.log(USAGE);
    return;
  }

  const config = await loadConfig(args.config);
  const map = await loadMap(config.renameMapPath);

  let dirty = false;
  switch (command) {
    case 'status':
      cmdStatus(map);
      break;
    case 'list':
      cmdList(map, args);
      break;
    case 'accept':
      dirty = cmdDecide(map, args, 'accepted');
      break;
    case 'reject':
      dirty = cmdDecide(map, args, 'rejected');
      break;
    case 'set-to':
      dirty = cmdSetTo(map, args);
      break;
    case 'resolve':
      dirty = cmdResolve(map, args);
      break;
    case 'skip':
      dirty = cmdSkip(map, args);
      break;
    case 'mark':
      dirty = cmdMark(map, args);
      break;
    default:
      fail(`Unknown command "${command}".`);
  }

  if (dirty) await writeMap(config.renameMapPath, map);
}

main().catch((err) => {
  console.error(`[review] ${err.message}`);
  process.exit(1);
});
