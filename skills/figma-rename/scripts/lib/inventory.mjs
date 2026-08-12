// The inventory: what exists in the Figma file right now.
//
// It is produced by read-only `use_figma` calls (see references/inventory.md)
// and written verbatim into the project. Committing it is what makes a rename
// reviewable months later: it is the only record of what the names *were*,
// and `check.mjs` uses it to refuse a rename map that has gone stale.

import fs from 'node:fs/promises';

import { VALID_KINDS } from './config.mjs';

/**
 * The uniqueness namespace a name lives in.
 *
 * Computed on demand from an inventory entry — never stored in the rename map.
 * A stored copy was write-only and disagreed with this function for layers
 * (it was built without `parentId`), which is the worst kind of duplicate: one
 * that looks authoritative. Two entries in the same bucket
 * may not end up with the same name — Figma rejects a duplicate variable name
 * inside one collection, and a duplicate style name is legal but makes the
 * picker unusable.
 */
export function bucketOf(entry) {
  if (entry.kind === 'variable') return `variable:${entry.scope ?? ''}`;
  if (entry.kind === 'layer') return `layer:${entry.parentId ?? entry.scope ?? ''}`;
  if (entry.kind === 'component' || entry.kind === 'componentSet') return 'component';
  return `style:${entry.kind}`;
}

export async function loadInventory(inventoryPath) {
  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(inventoryPath, 'utf8'));
  } catch (err) {
    throw new Error(
      `Could not read ${inventoryPath}: ${err.message}\n` +
        'Capture it first — references/inventory.md has the read-only use_figma scripts.',
    );
  }
  const entries = parsed.entries ?? parsed;
  if (!Array.isArray(entries)) {
    throw new Error(`${inventoryPath}: expected { "entries": [...] } or a bare array.`);
  }

  const errors = [];
  const byId = new Map();
  entries.forEach((entry, i) => {
    if (!entry || typeof entry !== 'object') {
      errors.push(`entries[${i}] is not an object.`);
      return;
    }
    if (!VALID_KINDS.has(entry.kind)) {
      errors.push(`entries[${i}].kind "${entry.kind}" is not one of: ${[...VALID_KINDS].join(', ')}.`);
    }
    if (typeof entry.id !== 'string' || !entry.id) errors.push(`entries[${i}] is missing \`id\`.`);
    if (typeof entry.name !== 'string' || !entry.name) errors.push(`entries[${i}] (${entry.id}) is missing \`name\`.`);
    if (entry.id && byId.has(entry.id)) errors.push(`entries[${i}]: duplicate id "${entry.id}".`);
    if (entry.id) byId.set(entry.id, entry);
  });

  if (errors.length) {
    throw new Error(`Invalid inventory ${inventoryPath}:\n- ${errors.join('\n- ')}`);
  }

  return {
    fileKey: parsed.fileKey ?? null,
    capturedAt: parsed.capturedAt ?? null,
    entries,
    byId,
    /** Every name currently taken in the same uniqueness bucket as `entry`. */
    namesInBucket(bucket) {
      return entries.filter((e) => bucketOf(e) === bucket).map((e) => e.name);
    },
  };
}
