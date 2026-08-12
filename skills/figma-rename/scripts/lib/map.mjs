// The rename map: the single artefact both sides of the rename read from.
//
//   Figma   <-- emit-figma.mjs  <-- rename-map.json -->  apply-code.mjs --> code
//
// It is written by `plan.mjs`, decided on through `review.mjs`, validated by
// `check.mjs`, and committed. Every downstream step derives from it, which is
// what keeps the Figma rename and the code rewrite from drifting apart: there
// is one list of pairs, not two.
//
// ## Why lifecycle state lives in here
//
// v2 adds two state fields — `batches[].status` and `renames[].decision`. They
// could have gone in a side journal (`rename/applied.json`); they are here
// instead, and the reason is `git revert`:
//
//   A batch's status flip lands inside that batch's commit. Reverting the
//   commit therefore restores `status: "planned"` at the same moment it
//   restores the code. Lifecycle state and code state cannot disagree across a
//   revert, which is what makes "one batch = one commit = one rollback" a
//   property rather than a hope.
//
// A journal only reverts if every person remembers to stage it. And since
// re-planning has to merge human edits (`to` fixes, promoted `code` pairs,
// resolved review items) regardless, the journal's one advantage — letting
// plan overwrite freely — was never real.
//
// `status` is not an outcome log. What actually happened in Figma is the
// `use_figma` return value, and that belongs in the commit message.

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { VALID_KINDS } from './config.mjs';

export const MAP_VERSION = 2;

/**
 * A batch moves forward only, and only by an explicit `review.mjs mark`.
 *
 *   planned        nothing has been touched; safe to re-plan, edit, discard
 *   figma-applied  the use_figma call succeeded — Figma is ahead of the code
 *   applied        code rewritten and verified; the batch commit is being made
 *
 * The middle state is the one that earns its keep: it is what lets
 * `apply-code` know which batch's rewrite is *due*, and what makes
 * `check --after` scan the right thing.
 */
export const BATCH_STATUSES = ['planned', 'figma-applied', 'applied'];
export const FROZEN_STATUSES = ['figma-applied', 'applied'];

/** A row nobody has ruled on yet cannot be applied. */
export const DECISIONS = ['pending', 'accepted', 'rejected'];

export const REVIEW_DECISIONS = ['pending', 'rejected'];

export async function loadMap(mapPath) {
  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(mapPath, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(`No rename map at ${mapPath}. Run plan.mjs first.`);
    }
    throw new Error(`Could not read ${mapPath}: ${err.message}`);
  }
  return validateShape(parsed, mapPath);
}

/** Same as loadMap, but a missing file is not an error — used by plan.mjs. */
export async function loadMapIfPresent(mapPath) {
  try {
    return await loadMap(mapPath);
  } catch (err) {
    if (err.message.startsWith('No rename map at')) return null;
    throw err;
  }
}

export function validateShape(parsed, label = 'rename map') {
  const errors = [];
  if (parsed.version === 1) {
    throw new Error(
      `${label} is version 1. This format is unreleased and has no upgrade path — ` +
        'delete it and run plan.mjs again (nothing has been applied from a v1 map).',
    );
  }
  if (parsed.version !== MAP_VERSION) {
    errors.push(`version is ${parsed.version}, expected ${MAP_VERSION}.`);
  }
  if (!Array.isArray(parsed.batches)) {
    throw new Error(`Invalid ${label}: \`batches\` must be an array.`);
  }

  const seenBatchIds = new Set();
  parsed.batches.forEach((batch, bi) => {
    if (!batch.id) errors.push(`batches[${bi}] is missing \`id\`.`);
    if (seenBatchIds.has(batch.id)) errors.push(`batches[${bi}]: duplicate batch id "${batch.id}".`);
    seenBatchIds.add(batch.id);
    if (!VALID_KINDS.has(batch.kind)) {
      errors.push(`batches[${bi}].kind "${batch.kind}" is not one of: ${[...VALID_KINDS].join(', ')}.`);
    }
    if (batch.status !== undefined && !BATCH_STATUSES.includes(batch.status)) {
      errors.push(`batches[${bi}].status "${batch.status}" is not one of: ${BATCH_STATUSES.join(', ')}.`);
    }
    if (!Array.isArray(batch.renames)) {
      errors.push(`batches[${bi}].renames must be an array.`);
      return;
    }
    batch.renames.forEach((r, ri) => {
      const at = `batches[${bi}].renames[${ri}]`;
      if (!r.id) errors.push(`${at} is missing \`id\`.`);
      if (!r.from) errors.push(`${at} is missing \`from\`.`);
      // A rejected row keeps its `to` for the record — it is the proposal that
      // was turned down, not an empty slot.
      if (!r.to) errors.push(`${at} is missing \`to\`.`);
      if (r.decision !== undefined && !DECISIONS.includes(r.decision)) {
        errors.push(`${at}.decision "${r.decision}" is not one of: ${DECISIONS.join(', ')}.`);
      }
      if (r.code !== undefined) {
        if (!Array.isArray(r.code)) {
          errors.push(`${at}.code must be an array of { from, to } literal string pairs.`);
        } else {
          r.code.forEach((pair, pi) => {
            if (!pair || !pair.from || !pair.to) errors.push(`${at}.code[${pi}] needs both \`from\` and \`to\`.`);
          });
        }
      }
    });
  });

  (parsed.needsReview ?? []).forEach((item, i) => {
    if (item.decision !== undefined && !REVIEW_DECISIONS.includes(item.decision)) {
      errors.push(`needsReview[${i}].decision "${item.decision}" is not one of: ${REVIEW_DECISIONS.join(', ')}.`);
    }
  });

  if (errors.length) {
    throw new Error(`Invalid ${label}:\n- ${errors.join('\n- ')}`);
  }
  return parsed;
}

export async function writeMap(mapPath, map) {
  // Validate what we are about to persist. A map that only fails when the next
  // tool loads it reads as that tool being broken.
  validateShape(map, mapPath);
  await fs.mkdir(path.dirname(mapPath), { recursive: true });
  await fs.writeFile(mapPath, `${JSON.stringify(map, null, 2)}\n`, 'utf8');
}

// --------------------------------------------------------------- reading state

export const statusOf = (batch) => batch.status ?? 'planned';
export const decisionOf = (rename) => rename.decision ?? 'pending';
export const isFrozen = (batch) => FROZEN_STATUSES.includes(statusOf(batch));

export function batchesByStatus(map, ...statuses) {
  return map.batches.filter((b) => statuses.includes(statusOf(b)));
}

/** Rows that will actually be applied. Rejected rows are invisible everywhere. */
export function effectiveRenames(batch) {
  return batch.renames.filter((r) => decisionOf(r) !== 'rejected');
}

export function pendingRenames(batch) {
  return batch.renames.filter((r) => decisionOf(r) === 'pending');
}

export function batchById(map, id) {
  const batch = map.batches.find((b) => b.id === id);
  if (!batch) {
    const known = map.batches.map((b) => `${b.id} (${statusOf(b)})`).join(', ') || 'none';
    throw new Error(`No batch called "${id}". Batches in this map: ${known}`);
  }
  return batch;
}

/**
 * Renames across the map, narrowed the way the caller needs.
 *
 * `statuses` is the important knob and every CLI sets it deliberately:
 * `emit-figma` wants planned, `apply-code` wants figma-applied,
 * `check --after` wants everything already out the door.
 */
export function selectRenames(map, { batch, kind, statuses, decisions = ['accepted', 'pending'] } = {}) {
  const batches = map.batches.filter(
    (b) =>
      (!batch || b.id === batch) &&
      (!kind || b.kind === kind) &&
      (!statuses || statuses.includes(statusOf(b))),
  );
  if (batch && batches.length === 0) {
    // Distinguish "no such batch" from "that batch is in the wrong state" —
    // they need different fixes.
    const exists = map.batches.some((b) => b.id === batch);
    if (exists) {
      const found = map.batches.find((b) => b.id === batch);
      throw new Error(
        `Batch "${batch}" is ${statusOf(found)}; this command works on ${statuses?.join(' or ') ?? 'any status'}.`,
      );
    }
    const known = map.batches.map((b) => b.id).join(', ') || 'none';
    throw new Error(`No batch called "${batch}". Batches in this map: ${known}`);
  }
  return batches.flatMap((b) =>
    b.renames
      .filter((r) => decisions.includes(decisionOf(r)))
      .map((r) => ({ ...r, batchId: b.id, kind: b.kind, batchStatus: statusOf(b) })),
  );
}

/**
 * Detects rename chains and cycles within one batch.
 *
 * A chain (A->B where some other entry is B->C) and a cycle (A->B, B->A) are
 * the two ways a "just loop and assign" rename corrupts data: the second
 * assignment collides with, or silently re-renames, the result of the first.
 * Both are handled by staging through temporary names — this only reports.
 */
export function findChains(renames) {
  const froms = new Map(renames.map((r) => [r.from, r]));
  const conflicts = [];
  for (const r of renames) {
    if (froms.has(r.to) && froms.get(r.to) !== r) {
      conflicts.push({ from: r.from, to: r.to, blockedBy: froms.get(r.to).from });
    }
  }
  return conflicts;
}

/**
 * One Figma id may not be renamed by two batches that are both still waiting.
 *
 * A frozen batch plus a pending one IS legal, and is the normal shape when a
 * convention changes after part of it shipped: the pending row's `from` is the
 * frozen row's `to`, which the inventory already agrees with. Two *pending*
 * batches touching one id is not legal — the first `use_figma` call moves the
 * name and the second throws on validation, halfway through.
 */
export function findDuplicateIds(map) {
  const seen = new Map();
  const clashes = [];
  for (const batch of map.batches) {
    if (isFrozen(batch)) continue;
    for (const rename of effectiveRenames(batch)) {
      if (seen.has(rename.id)) {
        clashes.push({ id: rename.id, batches: [seen.get(rename.id), batch.id], name: rename.from });
      } else {
        seen.set(rename.id, batch.id);
      }
    }
  }
  return clashes;
}

// ------------------------------------------------------------- convention hash

/** Stable stringify — key order must not change the hash. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .filter((k) => !k.startsWith('$')) // `$comment` keys are documentation
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * Fingerprints the convention a map was planned under.
 *
 * A map planned under one standard and applied under another produces names
 * nobody chose — and the diff looks fine, because every individual rename is
 * internally consistent. `check.mjs` compares this and refuses.
 */
export function conventionHash(convention) {
  return `sha256:${createHash('sha256').update(canonical(convention ?? {})).digest('hex').slice(0, 16)}`;
}

// ---------------------------------------------------------------------- merge

/**
 * Re-planning merges; it never overwrites.
 *
 * Two things must survive a re-plan, and before v2 neither did:
 *
 *  1. **Anything that reached Figma.** Frozen batches are copied through
 *     byte-for-byte and their ids are never reused, so
 *     `emit-figma --reverse --batch <id>` for an applied batch keeps resolving
 *     even after the convention changed and the map was re-planned twice.
 *  2. **Human decisions.** A rejection, a hand-edited `to`, a promoted `code`
 *     pair, a resolved review item — these are the expensive part of a run.
 *     Re-deriving the proposal must not throw them away.
 *
 * Keyed by Figma id, not by name: names are exactly what is in motion.
 */
export function mergePlans(oldMap, freshMap, { fresh = false } = {}) {
  const report = { frozen: 0, carried: 0, reset: 0, rejectedKept: 0, skipsKept: 0, newRows: 0 };
  if (!oldMap) {
    for (const batch of freshMap.batches) report.newRows += batch.renames.length;
    return { map: freshMap, report };
  }

  const frozenBatches = oldMap.batches.filter(isFrozen);
  report.frozen = frozenBatches.length;

  // Decisions from batches that had not shipped yet, keyed by Figma id.
  const priorDecisions = new Map();
  for (const batch of oldMap.batches) {
    if (isFrozen(batch)) continue;
    for (const rename of batch.renames) {
      if (decisionOf(rename) !== 'pending') priorDecisions.set(rename.id, rename);
    }
  }

  // Review items the user explicitly chose to leave alone. Re-plan must not
  // ask again — that is the whole point of answering.
  const skipped = new Map();
  for (const item of oldMap.needsReview ?? []) {
    if (item.decision === 'rejected') skipped.set(item.id, item);
  }
  report.skipsKept = skipped.size;

  const takenIds = new Set(oldMap.batches.map((b) => b.id));
  const frozenIds = new Set(frozenBatches.map((b) => b.id));

  const merged = [];
  for (const batch of freshMap.batches) {
    // A frozen batch owns its id forever; a fresh batch that wants it moves.
    const id = frozenIds.has(batch.id) ? nextFreeId(batch.id, takenIds) : batch.id;
    takenIds.add(id);

    const renames = batch.renames.map((row) => {
      const prior = fresh ? undefined : priorDecisions.get(row.id);
      if (!prior) {
        report.newRows++;
        return { ...row, decision: 'pending' };
      }
      // A hand-written name is an override of the proposal, not agreement with
      // it — so a new proposal does not supersede it. Resetting here would
      // silently undo the one kind of decision that took real thought.
      if (prior.source === 'human') {
        report.carried++;
        return { ...prior };
      }
      if (prior.to !== row.to) {
        // The user ruled on a *name*, and the name changed. Asking again is
        // the honest move; carrying the old verdict would apply a decision to
        // something it was never made about.
        report.reset++;
        return {
          ...row,
          decision: 'pending',
          note: `target changed on re-plan (was "${prior.to}"${prior.decision === 'rejected' ? ', previously rejected' : ''})`,
        };
      }
      if (prior.decision === 'rejected') {
        report.rejectedKept++;
        return { ...row, decision: 'rejected', note: prior.note };
      }
      // Accepted: the human's version wins wholesale — their `to`, their
      // promoted `code` pairs, their note.
      report.carried++;
      return { ...prior };
    });

    merged.push({ ...batch, id, status: 'planned', renames });
  }

  const needsReview = (freshMap.needsReview ?? [])
    .filter((item) => !skipped.has(item.id))
    .map((item) => ({ ...item, decision: 'pending' }));
  // Carry the settled ones through so the record of the answer survives.
  for (const item of skipped.values()) needsReview.push(item);

  return {
    map: { ...freshMap, batches: [...frozenBatches, ...merged], needsReview },
    report,
  };
}

/** `variable-color-1` -> `variable-color-2` -> … until free. */
function nextFreeId(base, taken) {
  const match = base.match(/^(.*?)-(\d+)$/);
  const stem = match ? match[1] : base;
  let n = match ? Number(match[2]) + 1 : 2;
  while (taken.has(`${stem}-${n}`)) n++;
  return `${stem}-${n}`;
}
