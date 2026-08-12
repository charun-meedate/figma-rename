#!/usr/bin/env node
// plan.mjs — inventory + convention -> a rename map to review.
//
//   node plan.mjs                          # every kind in config.kinds
//   node plan.mjs --kind variable          # one kind
//   node plan.mjs --only "color/**"        # one slice of names
//   node plan.mjs --max-batch 25           # smaller batches
//   node plan.mjs --min-confidence medium  # drop low-confidence suggestions
//   node plan.mjs --no-suggest             # convention rules only
//   node plan.mjs --dry-run                # print the summary, write nothing
//
// Two sources feed the map: the convention rules (what the team decided) and
// the value-based suggest engine (what the values say). Rules win where both
// have an opinion — see references/suggest-engine.md.
//
// The output is a PROPOSAL. Nothing in it reaches Figma or the codebase until
// a human has read it and `check.mjs` has passed. Names the convention cannot
// decide mechanically come back under `needsReview` with `to: null` rather
// than a confident guess.

import { loadConfig, parseArgs } from './lib/config.mjs';
import { compileConvention, compileGlob, matchesAny, proposeName } from './lib/convention.mjs';
import { bucketOf, loadInventory } from './lib/inventory.mjs';
import { MAP_VERSION, writeMap } from './lib/map.mjs';
import { toPascal } from './lib/naming.mjs';
import { isGenericName, suggestForEntries } from './lib/suggest.mjs';

const CONFIDENCE_RANK = { low: 0, medium: 1, high: 2 };

// A batch is one commit and one human review. 40 renames is roughly the point
// where a reviewer stops reading each line and starts skimming — the failure
// this whole batching scheme exists to prevent. Override with `--max-batch`.
const DEFAULT_MAX_BATCH = 40;

function slug(text) {
  return String(text).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'default';
}

async function main() {
  const args = parseArgs();
  const config = await loadConfig(args.config);
  // The merged view. Anyone who has to ask "is my override actually winning?"
  // has already lost an afternoon to a shared config; this answers it in one
  // command, and names which file the base came from.
  if (args['print-config']) {
    console.log(`[config] ${config.configPath}`);
    console.log(`[config] extends: ${config.extendsFrom ?? '(nothing — this project stands alone)'}`);
    console.log(JSON.stringify({ kinds: config.kinds, convention: config.convention, code: config.code }, null, 2));
    return;
  }

  const inventory = await loadInventory(config.inventoryPath);
  const convention = compileConvention(config.convention);

  const kinds = args.kind ? [args.kind] : config.kinds;
  const only = args.only ? [compileGlob(args.only)] : null;
  const maxBatch = Number(args['max-batch'] ?? DEFAULT_MAX_BATCH);
  if (!Number.isFinite(maxBatch) || maxBatch < 1) {
    throw new Error(`--max-batch must be a positive number (got ${args['max-batch']}).`);
  }

  const scoped = inventory.entries.filter(
    (e) => kinds.includes(e.kind) && (!only || matchesAny(e.name, only)),
  );
  if (scoped.length === 0) {
    throw new Error(
      `Nothing to plan: no inventory entry matches kind(s) [${kinds.join(', ')}]` +
        `${args.only ? ` and --only "${args.only}"` : ''}.`,
    );
  }

  // Value-based suggestions. Rules win where both have an opinion: a rule is
  // something the team decided, a suggestion is something a formula noticed.
  // Off by default unless the inventory actually carries values.
  const wantSuggest = args['no-suggest'] ? false : scoped.some((e) => e.value !== undefined);
  const minConfidence = CONFIDENCE_RANK[args['min-confidence'] ?? 'low'] ?? 0;
  let suggested = new Map();
  let suggestReview = [];
  let calibration = null;
  if (wantSuggest) {
    const result = suggestForEntries(inventory.entries, {
      sizeNaming: config.convention?.sizeNaming ?? 'semantic',
      group: config.convention?.colorGroup ?? 'colors',
    });
    calibration = result.calibration;
    suggestReview = result.review;
    suggested = new Map(
      result.suggestions
        .filter((s) => CONFIDENCE_RANK[s.confidence] >= minConfidence)
        .map((s) => [s.id, s]),
    );
  }

  const groups = new Map();
  const needsReview = [];
  const counts = { renamed: 0, normalized: 0, unchanged: 0, conforming: 0, ignored: 0, needsReview: 0, suggested: 0 };

  // Anything the engine parked for a human is out of the batches entirely.
  // Without this an alias or a duplicate falls through to the normalizer and
  // gets a pointless "Color 1 -> color-1" rename on top of its open question.
  const parked = new Set();
  for (const item of suggestReview) {
    if (!kinds.includes('variable')) continue;
    parked.add(item.id);
    needsReview.push({ kind: 'variable', id: item.id, name: item.name, scope: null, suggestion: item.suggestion, why: item.why });
    counts.needsReview++;
  }

  for (const entry of scoped) {
    if (parked.has(entry.id)) continue;
    const result = proposeName(entry.name, convention);
    counts[result.status] = (counts[result.status] ?? 0) + 1;

    if (result.status === 'needsReview') {
      needsReview.push({
        kind: entry.kind,
        id: entry.id,
        name: entry.name,
        scope: entry.scope ?? null,
        suggestion: result.suggestion ?? null,
        why: result.why,
      });
      continue;
    }

    const suggestion = suggested.get(entry.id);
    let to = result.to;
    let rule = result.rule;
    let reason = null;
    let confidence = null;
    let source = 'rule';

    // A rule that actually matched is a decision the team wrote down, so it
    // outranks a formula. Bare normalisation is not a decision — it would turn
    // "Color 1" into "color-1", which is tidier and no more meaningful, and
    // would shut out the suggestion that knows the thing is blue.
    const ruleDecided = result.status === 'renamed';
    if (!ruleDecided && suggestion && suggestion.suggestedName !== entry.name) {
      to = suggestion.suggestedName;
      rule = null;
      reason = suggestion.reason;
      confidence = suggestion.confidence;
      source = suggestion.source;
      counts.suggested++;
      if (counts[result.status]) counts[result.status]--;
    }
    if (to === null) continue;

    // A generic name that no rule claimed and no suggestion could name is an
    // open question, not a formatting problem. Emitting "Variable 3" ->
    // "variable-3" would spend a rename, a review and a commit on making the
    // absence of a name tidier.
    if (source === 'rule' && !ruleDecided && isGenericName(entry.name)) {
      needsReview.push({
        kind: entry.kind,
        id: entry.id,
        name: entry.name,
        scope: entry.scope ?? null,
        suggestion: null,
        why: wantSuggest
          ? 'generic name, and nothing in its value names it confidently — name it by hand'
          : 'generic name — capture values in the inventory to get a suggestion, or name it by hand',
      });
      counts.needsReview++;
      if (counts[result.status]) counts[result.status]--;
      continue;
    }

    const key = `${entry.kind}:${entry.scope ?? ''}`;
    if (!groups.has(key)) {
      groups.set(key, { kind: entry.kind, scope: entry.scope ?? null, pageIds: new Set(), renames: [] });
    }
    if (entry.pageId) groups.get(key).pageIds.add(entry.pageId);
    const rename = { id: entry.id, from: entry.name, to, source };
    if (rule) rename.rule = rule;
    // `reason` and `confidence` are what make a 300-line map reviewable: the
    // question at review time becomes "is this reason true", not "do I like
    // this name". A suggestion without one is not reviewable at all.
    if (reason) rename.reason = reason;
    if (confidence) rename.confidence = confidence;
    // A component's code symbol is a guess, never a derivation — it is offered
    // as a suggestion the reviewer promotes to `code`, and apply-code ignores
    // it until they do. See references/code-sync.md.
    if (entry.kind === 'component' || entry.kind === 'componentSet') {
      rename.codeSuggestion = [{ from: toPascal(entry.name), to: toPascal(result.to) }];
    }
    groups.get(key).renames.push(rename);
  }

  const batches = [];
  for (const [key, group] of groups) {
    const chunks = [];
    for (let i = 0; i < group.renames.length; i += maxBatch) {
      chunks.push(group.renames.slice(i, i + maxBatch));
    }
    // A node batch carries the page it lives on, because the generated Figma
    // script may switch pages exactly once. Entries spanning two pages cannot
    // honour that, so the pageId is dropped and emit-figma leaves the page
    // alone — split the batch by page in the map if that happens.
    const pageIds = [...group.pageIds];
    chunks.forEach((renames, i) => {
      const base = `${group.kind}-${slug(group.scope ?? key)}`;
      batches.push({
        id: chunks.length > 1 ? `${base}-${i + 1}` : base,
        kind: group.kind,
        scope: group.scope,
        pageId: pageIds.length === 1 ? pageIds[0] : null,
        bucket: bucketOf({ kind: group.kind, scope: group.scope }),
        renames,
      });
    });
    if (pageIds.length > 1) {
      console.log(
        `[plan] warning: batch "${group.kind}-${slug(group.scope ?? key)}" spans ${pageIds.length} pages — ` +
          'split it by page before applying, so each use_figma call switches page once.',
      );
    }
  }

  const map = {
    version: MAP_VERSION,
    fileKey: config.figma?.fileKey ?? inventory.fileKey ?? null,
    convention: config.convention,
    ...(calibration ? { calibration } : {}),
    batches,
    needsReview,
  };

  const total = batches.reduce((n, b) => n + b.renames.length, 0);
  console.log(`[plan] ${scoped.length} inventory entr${scoped.length === 1 ? 'y' : 'ies'} in scope`);
  for (const [status, n] of Object.entries(counts)) {
    if (n) console.log(`[plan]   ${status.padEnd(11)} ${n}`);
  }
  if (calibration) {
    const describe = (c) =>
      c.source === 'calibrated' ? `learned from ${c.shades} shade(s) in this file` : 'built-in ladder (no ramp to learn from)';
    console.log(`[plan] shade ladders — chromatic: ${describe(calibration.chromatic)}; neutral: ${describe(calibration.neutral)}`);
    if (calibration.families) console.log(`[plan]   ${calibration.families} ramp(s) calibrated individually`);
  }
  console.log(`[plan] ${total} rename(s) across ${batches.length} batch(es)`);
  for (const batch of batches) {
    console.log(`[plan]   ${batch.id} — ${batch.renames.length}`);
    for (const r of batch.renames.slice(0, 5)) {
      const note = r.confidence ? `   [${r.confidence}] ${r.reason}` : '';
      console.log(`[plan]     ${r.from}  ->  ${r.to}${note}`);
    }
    if (batch.renames.length > 5) console.log(`[plan]     … ${batch.renames.length - 5} more`);
  }
  if (needsReview.length) {
    console.log(`\n[plan] ${needsReview.length} name(s) the convention will not decide — edit them by hand:`);
    for (const item of needsReview.slice(0, 10)) {
      console.log(`[plan]   ${item.name}${item.suggestion ? ` (would be "${item.suggestion}")` : ''} — ${item.why}`);
    }
    if (needsReview.length > 10) console.log(`[plan]   … ${needsReview.length - 10} more in the map`);
  }

  if (args['dry-run']) {
    console.log('\n[plan] --dry-run: nothing written.');
    return;
  }

  await writeMap(config.renameMapPath, map);
  console.log(`\n[plan] wrote ${config.renameMapPath}`);
  console.log('[plan] read it, edit it, then: node check.mjs');
}

main().catch((err) => {
  console.error(`[plan] ${err.message}`);
  process.exit(1);
});
