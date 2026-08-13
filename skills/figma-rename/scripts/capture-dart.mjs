#!/usr/bin/env node
// Builds rename/inventory.json for a Flutter project whose tokens are a Dart
// class of `static const` members — `"source": "code"`.
//
// Measured on a real app (mobile-rizzup): one `AppColors` class, 53 members,
// 1,140 references across 334 files. The member name is what every one of those
// references spells, so it is the name the inventory records — the class name is
// not a token, and renaming it is a separate `code` pair.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { COMMON_FLAGS, parseArgs } from './lib/config.mjs';

const USAGE = `
capture-dart.mjs — build an inventory from a Dart token class

  capture-dart.mjs lib/presentation/styles/app_colors.dart [more.dart …]

  --class <Name>   only this class (default: every class in the file)
  --scope <name>   the batch name to record (default: the class name)
  --out <path>     where to write (default: rename/inventory.json)
  --dry-run        print what was found, write nothing

Records the MEMBER name, because that is what every reference spells:
\`AppColors.textPrimary\` and \`static const textPrimary\` both move with it.
Set code.spellings to ["camel"] so one pair covers the declaration and the uses.
`;

/**
 * `static const` members per class, in source order.
 *
 * Deliberately shallow: a brace counter rather than a Dart parser, because the
 * shape this reads — a class of constants — has no nesting worth the extra
 * machinery, and a parser that half-understands Dart is worse than one that
 * plainly does not.
 */
export function dartTokenClasses(source) {
  const classes = [];
  const classRe = /(?:^|\n)\s*(?:abstract\s+)?class\s+(\w+)([^{]*)\{/g;
  let match;
  while ((match = classRe.exec(source))) {
    const name = match[1];
    // A ThemeExtension holds its tokens as instance fields rather than static
    // constants — it is the layer that has light and dark, and on a real app it
    // was the biggest: 114 fields against 879 call sites. Instance fields are
    // read ONLY for that shape, because `final X y;` in an ordinary class is
    // usually a dependency, not a token.
    const isThemeExtension = /extends\s+ThemeExtension\b/.test(match[2]);
    // Walk to the matching close brace so members of the next class are not
    // attributed to this one.
    let depth = 1;
    let i = classRe.lastIndex;
    while (i < source.length && depth > 0) {
      if (source[i] === '{') depth++;
      else if (source[i] === '}') depth--;
      i++;
    }
    const body = source.slice(classRe.lastIndex, i - 1);
    const members = [...body.matchAll(/static\s+(?:const|final)\s+(?:[\w<>?,\s]+\s+)?(\w+)\s*=/g)].map(
      (m) => m[1],
    );
    if (isThemeExtension) {
      // `final Color textDefault;` — a declaration, so it ends in `;` with no
      // initialiser. That is what separates a field from a constructor default.
      for (const field of body.matchAll(/(?:^|\n)\s*final\s+[\w<>?]+\s+(\w+)\s*;/g)) {
        if (!members.includes(field[1])) members.push(field[1]);
      }
    }
    if (members.length) classes.push({ name, members, isThemeExtension });
  }
  return classes;
}

/** `textSecondaryPlus` → `text-secondary-plus`, which is what toCamel reverses. */
export function memberToTokenName(member) {
  return member
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .toLowerCase();
}

async function main() {
  const args = parseArgs(process.argv.slice(2), {
    flags: [...COMMON_FLAGS, 'class', 'scope', 'out', 'dry-run'],
    wantsValue: ['class', 'scope', 'out'],
    usage: USAGE,
  });

  const files = args._;
  if (files.length === 0) throw new Error('Name at least one Dart file.\n' + USAGE.trim());

  const entries = [];
  const seen = new Set();
  for (const file of files) {
    const source = await fs.readFile(file, 'utf8').catch((err) => {
      throw new Error(`Could not read ${file}: ${err.message}`);
    });
    for (const cls of dartTokenClasses(source)) {
      if (args.class && cls.name !== args.class) continue;
      for (const member of cls.members) {
        const name = memberToTokenName(member);
        if (seen.has(name)) continue;
        seen.add(name);
        entries.push({ kind: 'variable', id: `dart:${cls.name}.${member}`, name, scope: args.scope ?? cls.name });
      }
    }
  }

  if (entries.length === 0) {
    throw new Error(
      'No `static const` members found. This reads a class of constants; a project that ' +
        'builds its theme some other way needs a different capture.',
    );
  }

  const classes = [...new Set(entries.map((e) => e.scope))];
  console.log(`[capture-dart] ${entries.length} token(s) from ${classes.join(', ')}`);
  for (const entry of entries.slice(0, 5)) {
    console.log(`[capture-dart]   ${entry.id.slice(5)}  →  ${entry.name}`);
  }
  if (entries.length > 5) console.log(`[capture-dart]   … ${entries.length - 5} more`);
  console.log('[capture-dart] the class name is not a token — rename it with an explicit `code` pair.');

  if (args['dry-run']) {
    console.log('[capture-dart] dry run. Re-run without --dry-run to write.');
    return;
  }

  const out = args.out ?? 'rename/inventory.json';
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, `${JSON.stringify({ capturedFrom: files, entries }, null, 1)}\n`);
  console.log(`[capture-dart] wrote ${out}`);
  console.log('[capture-dart] next: set code.spellings to ["camel"], then node plan.mjs');
}

// Exported for tests; only run as a command when invoked as one. Without this,
// importing this file executes main(), which fails on the missing argument and
// calls process.exit — taking its importer down with it.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`[capture-dart] ${err.message}`);
    process.exit(1);
  });
}
