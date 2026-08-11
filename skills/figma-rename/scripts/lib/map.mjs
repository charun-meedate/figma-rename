// The rename map: the single artefact both sides of the rename read from.
//
//   Figma   <-- emit-figma.mjs  <-- rename-map.json -->  apply-code.mjs --> code
//
// It is written by `plan.mjs`, edited by a human, validated by `check.mjs`,
// and committed. Every downstream step derives from it, which is what keeps
// the Figma rename and the code rewrite from drifting apart: there is one
// list of pairs, not two.

import fs from 'node:fs/promises';
import path from 'node:path';

import { VALID_KINDS } from './config.mjs';

export const MAP_VERSION = 1;

export async function loadMap(mapPath) {
  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(mapPath, 'utf8'));
  } catch (err) {
    throw new Error(`Could not read ${mapPath}: ${err.message}\nRun plan.mjs first.`);
  }
  return validateShape(parsed, mapPath);
}

export function validateShape(parsed, label = 'rename map') {
  const errors = [];
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
    if (!Array.isArray(batch.renames)) {
      errors.push(`batches[${bi}].renames must be an array.`);
      return;
    }
    batch.renames.forEach((r, ri) => {
      const at = `batches[${bi}].renames[${ri}]`;
      if (!r.id) errors.push(`${at} is missing \`id\`.`);
      if (!r.from) errors.push(`${at} is missing \`from\`.`);
      if (!r.to) errors.push(`${at} is missing \`to\`.`);
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

  if (errors.length) {
    throw new Error(`Invalid ${label}:\n- ${errors.join('\n- ')}`);
  }
  return parsed;
}

export async function writeMap(mapPath, map) {
  await fs.mkdir(path.dirname(mapPath), { recursive: true });
  await fs.writeFile(mapPath, `${JSON.stringify(map, null, 2)}\n`, 'utf8');
}

/** Every rename across every batch, optionally narrowed by batch id or kind. */
export function selectRenames(map, { batch, kind } = {}) {
  const batches = map.batches.filter((b) => (!batch || b.id === batch) && (!kind || b.kind === kind));
  if (batch && batches.length === 0) {
    const known = map.batches.map((b) => b.id).join(', ') || 'none';
    throw new Error(`No batch called "${batch}". Batches in this map: ${known}`);
  }
  return batches.flatMap((b) => b.renames.map((r) => ({ ...r, batchId: b.id, kind: b.kind })));
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
