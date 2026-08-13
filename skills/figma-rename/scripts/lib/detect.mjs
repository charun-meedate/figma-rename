// What shape of project this is, and which spellings that shape needs.
//
// Six real projects produced six different answers, and the differences were
// not framework-level — two Tailwind v4 apps needed different captures because
// one was scaffolded from shadcn. Getting it wrong is silent: the wrong
// spellings rewrite the definitions, leave the call sites, and report success.
//
// This only ever SUGGESTS. Writing the config is a decision, and a detector
// that edits config is a detector you have to audit before every run.

import fs from 'node:fs/promises';
import path from 'node:path';

const read = async (file) => {
  try {
    return await fs.readFile(file, 'utf8');
  } catch {
    return null;
  }
};

const exists = async (file) => (await read(file)) !== null;

/** Shallow scan for stylesheets — deep enough for src/, cheap enough to always run. */
async function findStylesheets(rootDir, depth = 3) {
  const found = [];
  const walk = async (dir, left) => {
    if (left < 0) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (/^(node_modules|\.git|dist|build|\.next|ios|android)$/.test(entry.name)) continue;
        await walk(full, left - 1);
      } else if (/\.css$/.test(entry.name)) {
        found.push(full);
      }
    }
  };
  await walk(rootDir, depth);
  return found;
}

/**
 * The shapes worth telling apart, each with what it implies.
 *
 * `spellings` is the minimum set the shape needs — a project may legitimately
 * carry more. `capture` is the command that produces an inventory for it.
 */
export async function detectStack(rootDir) {
  const shapes = [];

  // A declaration beats a heuristic. `tokens.config.json` naming the Tailwind
  // major is the generator's own statement about what it emits — stronger than
  // anything guessed from scanning stylesheets, and the only way to know the
  // version when the generated CSS is not committed yet.
  const declared = await read(path.join(rootDir, 'tokens.config.json'));
  if (declared) {
    let parsed = null;
    try {
      parsed = JSON.parse(declared);
    } catch {
      /* a broken tokens.config.json is check.mjs's problem, not this one */
    }
    const web = (parsed?.targets ?? []).find((t) => t.type === 'web');
    if (web?.tailwind) {
      shapes.push({
        shape: `tailwind-v${web.tailwind}-generated`,
        why: `tokens.config.json declares tailwind: ${web.tailwind}`,
        spellings: ['cssVar', 'tailwind'],
        capture: null,
        note:
          'the utility drops the leading namespace (`color/surface/primary` → `bg-surface-primary`), ' +
          'so classes in hand-written code need an explicit `code` pair — check.mjs says so too',
      });
      return shapes;
    }
  }

  if (await exists(path.join(rootDir, 'pubspec.yaml'))) {
    shapes.push({
      shape: 'flutter',
      why: 'pubspec.yaml — tokens live in a Dart class',
      spellings: ['camel'],
      capture: 'capture-dart.mjs lib/…/app_colors.dart',
    });
  }

  for (const file of ['tailwind.config.js', 'tailwind.config.ts', 'tailwind.config.cjs']) {
    if (await exists(path.join(rootDir, file))) {
      shapes.push({
        shape: 'tailwind-v3',
        why: `${file} — the token names are keys in a JS object`,
        // v3 derives class names from the object key, which no derived spelling
        // reaches; moving a group needs an explicit code pair.
        spellings: ['cssVar'],
        capture: 'capture-css.mjs <the css file holding the values>',
        note: 'moving a whole group needs an explicit `code` pair with guard "tailwindGroup" — see references/code-sync.md',
      });
      break;
    }
  }

  const sheets = await findStylesheets(rootDir);
  for (const sheet of sheets) {
    const css = await read(sheet);
    if (!css || !/@theme\b/.test(css)) continue;
    const twoLayer = /@theme\s+inline/.test(css) && /--color-[a-z0-9-]+\s*:\s*var\(/.test(css);
    shapes.push({
      shape: twoLayer ? 'tailwind-v4-shadcn' : 'tailwind-v4',
      why: twoLayer
        ? `${path.relative(rootDir, sheet)} — @theme inline maps values into Tailwind's namespace`
        : `${path.relative(rootDir, sheet)} — @theme holds the token names`,
      spellings: ['cssVar', 'tailwind'],
      capture: twoLayer
        ? `capture-css.mjs ${path.relative(rootDir, sheet)} --layer color- --flat`
        : `capture-css.mjs ${path.relative(rootDir, sheet)}`,
      note: twoLayer
        ? 'only @theme names anything — capturing :root and enabling `tailwind` rewrites classes to names no theme entry defines'
        : null,
    });
    break;
  }

  return shapes;
}

/**
 * The lines to print when a detected shape needs spellings the config lacks.
 *
 * Returns an empty array when nothing is missing, so the caller can stay quiet.
 * Deliberately not an error: a project may be mid-migration, or may have
 * decided the class names are not its problem this pass.
 */
export function stackAdvice(shapes, codeConfig = {}) {
  const have = new Set(codeConfig.spellings ?? []);
  const lines = [];
  for (const shape of shapes) {
    const missing = shape.spellings.filter((s) => !have.has(s));
    if (!missing.length) continue;
    lines.push(
      `looks like ${shape.shape} (${shape.why}), which needs ` +
        `code.spellings ${JSON.stringify(missing)} — not set.`,
    );
    if (shape.note) lines.push(`  ${shape.note}`);
  }
  return lines;
}
