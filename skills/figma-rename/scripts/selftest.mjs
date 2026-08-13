#!/usr/bin/env node
// selftest.mjs — run after touching anything in scripts/.
//
//   node selftest.mjs
//
// Builds a throwaway project in a temp directory and drives the real CLIs over
// it. The assertions are on real output, not on mocks: what the codemod writes
// into a file, what check.mjs refuses, what emit-figma.mjs prints.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildReplacer, namespaceClassPairs, rewrite, spellingsFor } from './lib/codemod.mjs';
import { classifyComponent, findNameCollisions, suggestComponentName } from './lib/classify.mjs';
import { caseSegment, compileConvention, compileConventions, normalizeName, proposeName } from './lib/convention.mjs';
import { MAP_VERSION } from './lib/map.mjs';
import {
  SHADE_CHROMATIC,
  SHADE_NEUTRAL,
  calibrateShades,
  hueName,
  isGenericName,
  rgbToHsl,
  suggestColorName,
  suggestForEntries,
  suggestNumberName,
  valueBasedApplies,
} from './lib/suggest.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// `--relock` rewrites lib/naming.lock.json from the current source. It exists
// so that re-locking is a deliberate act with a visible diff, never something
// that happens as a side effect of running the tests.
if (process.argv.includes('--relock')) {
  const source = fs.readFileSync(path.join(HERE, 'lib/naming.mjs'), 'utf8');
  const functions = {};
  for (const match of source.matchAll(/export function (\w+)\(([\s\S]*?)\n\}/g)) {
    const normalised = `${match[2]}\n}`.replace(/\s+/g, ' ');
    functions[match[1]] = createHash('sha256').update(normalised).digest('hex').slice(0, 16);
  }
  const lockPath = path.join(HERE, 'lib/naming.lock.json');
  const existing = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  fs.writeFileSync(lockPath, `${JSON.stringify({ ...existing, functions }, null, 2)}\n`);
  console.log(`re-locked ${Object.keys(functions).length} function(s) in ${lockPath}`);
  console.log('Now make the same change in figma-token-export, or the codemod and the generator will disagree.');
  process.exit(0);
}

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL ${name}`);
    console.log(`       ${err.message.split('\n').join('\n       ')}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

/**
 * Parses an emitted script the way `use_figma` will run it — as an async
 * function body, so top-level `await` and `return` are legal. A syntax error
 * here would otherwise only surface as a failed Figma call.
 */
function assertParses(script, label) {
  try {
    // eslint-disable-next-line no-new
    new AsyncFunction(script);
  } catch (err) {
    throw new Error(`${label} is not valid JS: ${err.message}`);
  }
}

/** Runs a CLI in `cwd`; returns { ok, out }. Never throws on a non-zero exit. */
function run(script, args, cwd) {
  try {
    const out = execFileSync(process.execPath, [path.join(HERE, script), ...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, out };
  } catch (err) {
    return { ok: false, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}


/**
 * Walks a project's planned batches through review, the way a real run does.
 *
 * Every CLI past `plan` now refuses undecided rows and refuses to run out of
 * order, so the tests have to do what a user does: accept, then mark. Faking it
 * by hand-writing statuses into the map would test the fixture, not the gates.
 */
function acceptEverything(dir) {
  const map = JSON.parse(fs.readFileSync(path.join(dir, 'rename/rename-map.json'), 'utf8'));
  for (const batch of map.batches) {
    if ((batch.status ?? 'planned') !== 'planned' || !batch.renames.length) continue;
    const result = run('review.mjs', ['accept', '--batch', batch.id, '--all'], dir);
    if (!result.ok) throw new Error(`review accept failed for ${batch.id}: ${result.out}`);
  }
}

function markFigmaApplied(dir, batchId) {
  const result = run('review.mjs', ['mark', batchId, '--figma-applied'], dir);
  if (!result.ok) throw new Error(`mark failed for ${batchId}: ${result.out}`);
}

/** Accepts, then marks every planned batch as applied in Figma. */
function applyInFigma(dir) {
  acceptEverything(dir);
  const map = JSON.parse(fs.readFileSync(path.join(dir, 'rename/rename-map.json'), 'utf8'));
  for (const batch of map.batches) {
    if ((batch.status ?? 'planned') === 'planned' && batch.renames.length) markFigmaApplied(dir, batch.id);
  }
}

// ---------------------------------------------------------------- convention

section('convention');

const convention = compileConvention({
  separator: '/',
  segmentCase: 'kebab',
  aliases: { bg: 'background', txt: 'text' },
  rules: [
    { match: 'color/text-*', to: 'text/$1/default' },
    { match: 'color/**', to: 'palette/$1' },
  ],
  conforming: ['spacing/**'],
  ignore: ['_wip/**'],
  structure: { minSegments: 2, maxSegments: 5, categories: ['text', 'palette', 'surface', 'spacing'] },
});

test('normalizeName is idempotent', () => {
  const once = normalizeName('Color/Text Primary', convention);
  assert.equal(once, 'color/text-primary');
  assert.equal(normalizeName(once, convention), once);
});

test('camelCase segments are split into words, digits are left alone', () => {
  assert.equal(normalizeName('color/textPrimary/500', convention), 'color/text-primary/500');
});

test('aliases replace whole segments only', () => {
  assert.equal(normalizeName('bg/background', convention), 'background/background');
});

test('a rule template fills $1 from the wildcard', () => {
  assert.deepEqual(proposeName('color/text-primary', convention), {
    to: 'text/primary/default',
    status: 'renamed',
    rule: 'color/text-* -> text/$1/default',
    why: null,
  });
});

test('** captures the whole remainder', () => {
  assert.equal(proposeName('color/blue/500', convention).to, 'palette/blue/500');
});

test('first matching rule wins', () => {
  // "color/text-primary" matches both rules; the specific one is declared first.
  assert.equal(proposeName('color/text-primary', convention).to.startsWith('text/'), true);
});

test('conforming names are left alone', () => {
  assert.equal(proposeName('spacing/8', convention).status, 'conforming');
});

test('ignored names are skipped', () => {
  assert.equal(proposeName('_wip/thing', convention).status, 'ignored');
});

test('a name only needing case normalization reports `normalized`', () => {
  const result = proposeName('Text/Primary Default', convention);
  assert.equal(result.status, 'normalized');
  assert.equal(result.to, 'text/primary-default');
});

test('an already-correct name reports `unchanged` and proposes nothing', () => {
  const result = proposeName('text/primary-default', convention);
  assert.equal(result.status, 'unchanged');
  assert.equal(result.to, null);
});

test('a structure violation is needsReview with to:null, not a guess', () => {
  const result = proposeName('mystery', convention);
  assert.equal(result.status, 'needsReview');
  assert.equal(result.to, null);
  assert.match(result.why, /minSegments/);
  assert.equal(result.suggestion, 'mystery');
});

test('an unknown category is needsReview', () => {
  const result = proposeName('weird/thing', convention);
  assert.equal(result.status, 'needsReview');
  assert.match(result.why, /categories/);
});

test('a template referencing a capture the glob does not have is a config error', () => {
  assert.throws(
    () => compileConvention({ rules: [{ match: 'color/x', to: 'y/$1' }] }),
    /\$1 but "color\/x" has 0 wildcard/,
  );
});

// ------------------------------------------------------------------- codemod

section('codemod');

const codeOpts = {
  spellings: ['figmaPath', 'cssVar', 'camel', 'camelMember', 'pascal'],
  cssPrefix: '',
  flutterPrefix: 'App',
};

const tokenRename = { kind: 'variable', from: 'color/text-primary', to: 'text/primary/default' };

test('a token rename derives every spelling the generators emit', () => {
  const spellings = Object.fromEntries(spellingsFor(tokenRename, codeOpts).map((s) => [s.spelling, [s.from, s.to]]));
  assert.deepEqual(spellings.figmaPath, ['color/text-primary', 'text/primary/default']);
  assert.deepEqual(spellings.cssVar, ['--color-text-primary', '--text-primary-default']);
  assert.deepEqual(spellings.camel, ['colorTextPrimary', 'textPrimaryDefault']);
  assert.deepEqual(spellings.camelMember, ['textPrimary', 'primaryDefault']);
  assert.deepEqual(spellings.pascal, ['ColorTextPrimary', 'TextPrimaryDefault']);
});

test('a component rename derives ONLY the exact Figma name', () => {
  const spellings = spellingsFor({ kind: 'component', from: 'btn primary', to: 'Button/Primary' }, codeOpts);
  assert.deepEqual(
    spellings.map((s) => s.spelling),
    ['figmaPath'],
  );
});

test('an explicit code pair is applied for any kind', () => {
  const spellings = spellingsFor(
    { kind: 'component', from: 'btn primary', to: 'Button/Primary', code: [{ from: 'BtnPrimary', to: 'ButtonPrimary' }] },
    codeOpts,
  );
  assert.equal(spellings.some((s) => s.spelling === 'explicit' && s.from === 'BtnPrimary'), true);
});

test('a CSS var does not match a longer var that starts with it', () => {
  const replacer = buildReplacer(spellingsFor({ kind: 'variable', from: 'text/primary', to: 'text/main' }, codeOpts));
  const { text } = rewrite('a: var(--text-primary); b: var(--text-primary-hover);', replacer);
  assert.equal(text, 'a: var(--text-main); b: var(--text-primary-hover);');
});

test('a camelCase field does not match inside a longer identifier', () => {
  const replacer = buildReplacer(spellingsFor({ kind: 'variable', from: 'text/primary', to: 'text/main' }, codeOpts));
  const { text } = rewrite('textPrimary; textPrimaryHover; myTextPrimary;', replacer);
  assert.equal(text, 'textMain; textPrimaryHover; myTextPrimary;');
});

test('the member spelling only matches after a dot', () => {
  const replacer = buildReplacer(
    spellingsFor({ kind: 'variable', from: 'color/text-primary', to: 'color/text-main' }, codeOpts),
  );
  // The bare local must survive; only the member after the dot may move.
  const { text } = rewrite('const textPrimary = 1; AppColorColors.textPrimary;', replacer);
  assert.equal(text, 'const textPrimary = 1; AppColorColors.textMain;');
});

test('a rename chain is applied simultaneously, not sequentially', () => {
  // a -> b and b -> c. A naive two-pass replace turns every `a` into `c`.
  const pairs = [
    ...spellingsFor({ kind: 'variable', from: 'x/a', to: 'x/b' }, codeOpts),
    ...spellingsFor({ kind: 'variable', from: 'x/b', to: 'x/c' }, codeOpts),
  ];
  const { text } = rewrite('var(--x-a) var(--x-b)', buildReplacer(pairs));
  assert.equal(text, 'var(--x-b) var(--x-c)');
});

test('a swap is applied simultaneously', () => {
  const pairs = [
    ...spellingsFor({ kind: 'variable', from: 'x/a', to: 'x/b' }, codeOpts),
    ...spellingsFor({ kind: 'variable', from: 'x/b', to: 'x/a' }, codeOpts),
  ];
  const { text } = rewrite('var(--x-a) var(--x-b)', buildReplacer(pairs));
  assert.equal(text, 'var(--x-b) var(--x-a)');
});

test('one literal that would become two different things is refused', () => {
  assert.throws(
    () =>
      buildReplacer([
        { spelling: 'cssVar', guard: 'cssvar', from: '--a', to: '--b' },
        { spelling: 'cssVar', guard: 'cssvar', from: '--a', to: '--c' },
      ]),
    /Ambiguous rewrite/,
  );
});

test('a namespace that moves whole produces the names the generator really emits', () => {
  const { pairs, advisories } = namespaceClassPairs(
    [{ kind: 'variable', from: 'color/surface/raised', to: 'surface/raised' }],
    { flutterPrefix: 'App', allTokenNames: ['color/surface/raised'] },
  );
  assert.equal(advisories.length, 0);
  const from = pairs.map((p) => p.from);
  // flutter.mjs special-cases /^colou?rs?$/ — the class is AppColors.
  assert.ok(from.includes('AppColors'), `expected AppColors, got ${JSON.stringify(from)}`);
  assert.equal(pairs.find((p) => p.from === 'AppColors').to, 'AppSurfaceColors');
  assert.equal(from.includes('AppColorColors'), false, 'AppColorColors never existed');
  // Shadows have no per-namespace class.
  assert.equal(from.some((n) => n.endsWith('Shadows')), false);
  // `export const color` is the fixed colour object, not a namespace object.
  assert.equal(from.includes('color'), false, 'renaming the fixed web export would hit unrelated code');
});

test('a dimension namespace gets its TypeScript object renamed too', () => {
  const { pairs } = namespaceClassPairs([{ kind: 'variable', from: 'spacing/md', to: 'gap/md' }], {
    flutterPrefix: 'App',
    allTokenNames: ['spacing/md'],
  });
  const web = pairs.find((p) => p.from === 'spacing');
  assert.ok(web, `web.mjs exports a dimension namespace object; got ${JSON.stringify(pairs.map((p) => p.from))}`);
  assert.equal(web.to, 'gap');
  assert.equal(pairs.find((p) => p.from === 'AppSpacing').to, 'AppGap');
});

test('moving onto a name the generator reserves is advised, not rewritten', () => {
  // avoidReserved would suffix the class with `Scale`, and whether it fires
  // depends on which groups the project exports — which this cannot see.
  const { pairs, advisories } = namespaceClassPairs(
    [{ kind: 'variable', from: 'spacing/md', to: 'typography/md' }],
    { flutterPrefix: 'App', allTokenNames: ['spacing/md'] },
  );
  assert.equal(pairs.length, 0);
  assert.match(advisories[0], /reserves/);
  assert.match(advisories[0], /Scale/);
});

test('keeping the first segment produces no namespace class pairs', () => {
  const { pairs } = namespaceClassPairs([{ kind: 'variable', from: 'text/a', to: 'text/b' }], {
    flutterPrefix: 'App',
  });
  assert.equal(pairs.length, 0);
});

test('a namespace that SPLITS is advised, never rewritten', () => {
  // This is the case that would otherwise ask for AppColor -> AppText and
  // AppColor -> AppSurface in the same pass.
  const { pairs, advisories } = namespaceClassPairs(
    [
      { kind: 'variable', from: 'color/text-primary', to: 'text/primary' },
      { kind: 'variable', from: 'color/bg-raised', to: 'surface/raised' },
    ],
    { flutterPrefix: 'App' },
  );
  assert.equal(pairs.length, 0);
  assert.equal(advisories.length, 1);
  assert.match(advisories[0], /splits into/);
});

test('a namespace that only PARTLY moves is advised, never rewritten', () => {
  const { pairs, advisories } = namespaceClassPairs(
    [{ kind: 'variable', from: 'color/text-primary', to: 'text/primary' }],
    { flutterPrefix: 'App', allTokenNames: ['color/text-primary', 'color/stays-put'] },
  );
  assert.equal(pairs.length, 0);
  assert.match(advisories[0], /partly moves/);
});

// ------------------------------------------------------------ suggest engine

section('suggest engine');

const hex = (h) => {
  const s = h.replace('#', '');
  return {
    r: parseInt(s.slice(0, 2), 16) / 255,
    g: parseInt(s.slice(2, 4), 16) / 255,
    b: parseInt(s.slice(4, 6), 16) / 255,
    a: 1,
  };
};
const BUILTIN = { families: [], chromatic: { ladder: SHADE_CHROMATIC }, neutral: { ladder: SHADE_NEUTRAL } };

const TAILWIND_BLUE = {
  50: '#eff6ff', 100: '#dbeafe', 200: '#bfdbfe', 300: '#93c5fd', 400: '#60a5fa', 500: '#3b82f6',
  600: '#2563eb', 700: '#1d4ed8', 800: '#1e40af', 900: '#1e3a8a', 950: '#172554',
};
const TAILWIND_GRAY = {
  50: '#f9fafb', 100: '#f3f4f6', 200: '#e5e7eb', 300: '#d1d5db', 400: '#9ca3af', 500: '#6b7280',
  600: '#4b5563', 700: '#374151', 800: '#1f2937', 900: '#111827', 950: '#030712',
};

test('the built-in chromatic ladder names 9 of 11 Tailwind blues', () => {
  const hits = Object.entries(TAILWIND_BLUE).filter(
    ([shade, h]) => suggestColorName(hex(h), { ladders: BUILTIN }).name === `colors/blue/${shade}`,
  );
  // The two palest miss on purpose: #eff6ff carries so little colour that
  // "pale blue" and "blue-tinted grey" are the same measurement.
  assert.equal(hits.length, 9, `expected 9, got ${hits.length}`);
  for (const shade of ['50', '100']) {
    const result = suggestColorName(hex(TAILWIND_BLUE[shade]), { ladders: BUILTIN });
    assert.equal(result.confidence, 'medium', 'the ambiguous ones must not claim high confidence');
    assert.match(result.reason, /tint/);
  }
});

test('the built-in neutral ladder names all 11 Tailwind greys', () => {
  for (const [shade, h] of Object.entries(TAILWIND_GRAY)) {
    assert.equal(suggestColorName(hex(h), { ladders: BUILTIN }).name, `colors/gray/${shade}`);
  }
});

test('a tinted neutral is read by chroma, not by HSL saturation', () => {
  // #111827 reads as 39% HSL saturation — the spec's "saturation < 10% means
  // grey" rule calls it blue. Chroma (9%) gets it right.
  const result = suggestColorName(hex('#111827'), { ladders: BUILTIN });
  assert.equal(result.name, 'colors/gray/900');
  assert.equal(rgbToHsl(...Object.values(hex('#111827')).slice(0, 3)).s > 30, true);
});

test('hue naming wraps around 0/360 instead of falling off the table', () => {
  assert.equal(hueName(355).name, 'red');
  assert.equal(hueName(5).name, 'red');
  assert.equal(hueName(217).name, 'blue');
});

test('a hue near a boundary is offered with medium confidence', () => {
  assert.equal(suggestColorName(hex('#3b82f6'), { ladders: BUILTIN }).confidence, 'high');
  // 200 is the cyan/blue boundary.
  const boundary = suggestColorName({ r: 0, g: 0.66, b: 1, a: 1 }, { ladders: BUILTIN });
  assert.equal(boundary.confidence, 'medium');
});

test('alpha earns a suffix so two variants cannot collide on one name', () => {
  const opaque = suggestColorName({ ...hex('#3b82f6'), a: 1 }, { ladders: BUILTIN });
  const faded = suggestColorName({ ...hex('#3b82f6'), a: 0.5 }, { ladders: BUILTIN });
  assert.equal(opaque.name, 'colors/blue/500');
  assert.equal(faded.name, 'colors/blue/500/alpha-50');
});

test('shade ladders are learned from the ramps a file already has', () => {
  // A ramp numbered 010..900 whose 500 sits at L=47% — nothing like Tailwind.
  const ramp = [
    ['010', '#FBF9F9'], ['025', '#FFF1EF'], ['050', '#FFE8E4'], ['100', '#FFD2CB'],
    ['200', '#FFB5AB'], ['300', '#FF8B7D'], ['400', '#FF5548'], ['500', '#E50913'],
    ['700', '#9A201B'], ['900', '#631813'],
  ];
  const entries = ramp.map(([shade, h], i) => ({
    kind: 'variable', id: `V${i}`, name: `palette/brand/${shade}`, resolvedType: 'COLOR', value: hex(h),
  }));
  const ladders = calibrateShades(entries);
  assert.equal(ladders.families.length, 1);
  assert.equal(ladders.chromatic.source, 'calibrated');

  const roundTrip = entries.filter(
    (e) => suggestColorName(e.value, { ladders }).name.split('/').pop() === e.name.split('/').pop(),
  );
  assert.ok(roundTrip.length >= 9, `calibrated ladder should re-derive the ramp, got ${roundTrip.length}/10`);
  // The built-in ladder is not merely worse here — it is wrong everywhere.
  const builtinHits = entries.filter(
    (e) => suggestColorName(e.value, { ladders: BUILTIN }).name.split('/').pop() === e.name.split('/').pop(),
  );
  assert.ok(builtinHits.length < 4, 'the built-in ladder should visibly fail on a non-Tailwind ramp');
});

// The next three cases all come from running against a production Figma file.
// None of them can be reached with invented data, and each one was a real bug
// or a real ambiguity the engine used to paper over.

/** Builds calibrated ladders from `{prefix: {shade: hex}}`. */
const laddersFrom = (ramps) => {
  const entries = [];
  let i = 0;
  for (const [prefix, steps] of Object.entries(ramps)) {
    for (const [shade, h] of Object.entries(steps)) {
      entries.push({ kind: 'variable', id: `V${i++}`, name: `${prefix}/${shade}`, resolvedType: 'COLOR', value: hex(h) });
    }
  }
  return calibrateShades(entries);
};

// A blue-grey ramp ("nevada") beside a real blue ramp — six steps each.
const NEVADA = { 100: '#d4dae3', 300: '#a4acb7', 500: '#656e7c', 700: '#3c4450', 900: '#282e37', 950: '#181c21' };
const BLUE = { 100: '#dbeafe', 300: '#93c5fd', 500: '#3b82f6', 700: '#1d4ed8', 900: '#1e3a8a', 950: '#172554' };
const GREYSCALE = { 100: '#d9d9d9', 300: '#ababab', 500: '#6d6d6d', 700: '#444444', 900: '#2d2d2d', 950: '#1c1c1c' };

test('a blue-grey ramp is not dragged onto the blue ramp beside it', () => {
  const ladders = laddersFrom({ 'palette/nevada': NEVADA, 'palette/blue': BLUE });
  // nevada/500 is a neutral by chroma but sits at the same hue as blue.
  const result = suggestColorName(hex(NEVADA[500]), { ladders });
  assert.match(result.name, /gray/, `expected a grey, got ${result.name}`);
  const nevadaFamily = ladders.families.find((f) => f.prefix === 'palette/nevada');
  assert.equal(nevadaFamily.neutral, true);
  assert.equal(nevadaFamily.achromatic, false, 'a tinted neutral must keep its hue');
});

test('a pure-grey ramp does not compete for pale colours', () => {
  // A grey ramp reports hue 0 only because hue is undefined when there is no
  // colour. Letting it match on that pulled every pale red onto the grey ladder.
  const ladders = laddersFrom({ 'palette/greyscale': GREYSCALE, 'palette/blue': BLUE });
  const grey = ladders.families.find((f) => f.prefix === 'palette/greyscale');
  assert.equal(grey.achromatic, true, 'a ramp of pure greys must be flagged achromatic');

  // #dbeafe carries little enough colour to land in the ambiguous band. With a
  // pure-grey ramp in the file it must still read as blue — the grey ramp has
  // no hue to compete with. This is the regression that cost blue 4 of 16
  // steps on the production file.
  assert.match(suggestColorName(hex('#dbeafe'), { ladders }).name, /blue/);
  assert.match(suggestColorName(hex(BLUE[500]), { ladders }).name, /blue/);
  // A genuine pure grey still lands on the grey ladder.
  assert.match(suggestColorName(hex(GREYSCALE[500]), { ladders }).name, /gray/);
});

test('two ramps at the same hue are reported as competing, not silently picked', () => {
  // A production file holds palette/red and palette/brand-primary one degree
  // apart, whose 500 steps sit at L=60% and L=39%.
  const ladders = laddersFrom({
    'palette/red': { 100: '#fee2e2', 300: '#fca5a5', 500: '#ef4444', 700: '#b91c1c', 900: '#7f1d1d', 950: '#450a0a' },
    'palette/brand-primary': { 100: '#fe8677', 300: '#fe1319', 500: '#c0060e', 700: '#860206', 900: '#4f0102', 950: '#1d0101' },
  });
  const result = suggestColorName(hex('#c0060e'), { ladders });
  assert.equal(result.confidence, 'low');
  assert.ok(result.competing, 'both readings must be named');
  assert.equal(result.competing.length, 2);
  assert.match(result.reason, /cannot say which/);
});

test('number category is decided by collection and scope before value range', () => {
  // 8 is a legal spacing AND a legal radius; only the context settles it.
  assert.equal(suggestNumberName(8, { name: 'radius', collectionName: 'Radius' }).name, 'radius/lg');
  assert.equal(suggestNumberName(8, { collectionName: 'Spacing', scopes: ['GAP'] }).name, 'spacing/xs');
});

test('a value-range-only guess never claims better than low confidence', () => {
  const guess = suggestNumberName(0.5, { name: 'Variable 3' });
  assert.equal(guess.name, 'opacity/50');
  assert.equal(guess.confidence, 'low');
});

test('a value off the built-in scale keeps the number and drops confidence', () => {
  const odd = suggestNumberName(18, { collectionName: 'Spacing', scopes: ['GAP'] });
  assert.equal(odd.name, 'spacing/18');
  assert.equal(odd.confidence, 'medium');
  assert.match(odd.reason, /not on the built-in scale/);
});

test('the spec expected-output table reproduces', () => {
  const cases = [
    [16, { collectionName: 'Spacing', scopes: ['GAP'] }, 'spacing/md'],
    [8, { name: 'radius' }, 'radius/lg'],
    [24, { name: 'heading', scopes: ['FONT_SIZE'] }, 'fontSize/2xl'],
    [700, { name: 'weight-bold', scopes: ['FONT_WEIGHT'] }, 'fontWeight/bold'],
  ];
  for (const [value, ctx, want] of cases) {
    assert.equal(suggestNumberName(value, ctx).name, want, `${value} should be ${want}`);
  }
});

test('a name that already has a group path is left alone', () => {
  assert.equal(valueBasedApplies('text/primary/default'), false);
  assert.equal(valueBasedApplies('Color 1'), true);
  assert.equal(valueBasedApplies('primary'), true);
  // Generic even when grouped — nobody chose "Color 4".
  assert.equal(valueBasedApplies('palette/Color 4'), true);
});

test('generic names are detected on the leaf segment', () => {
  for (const name of ['Variable 1', 'Color 12', 'Value 3', 'Untitled', 'New 2', '404']) {
    assert.equal(isGenericName(name), true, `${name} should be generic`);
  }
  assert.equal(isGenericName('primary'), false);
});

test('an alias goes to review, because a role is not visible in a value', () => {
  const { review, suggestions } = suggestForEntries([
    { kind: 'variable', id: 'A', name: 'Color 5', resolvedType: 'COLOR', value: hex('#3b82f6'), alias: 'B', aliasName: 'colors/blue/500' },
  ]);
  assert.equal(suggestions.length, 0);
  assert.match(review[0].why, /role/);
});

test('two variables with one value are reported as duplicates, not suffixed apart', () => {
  const { suggestions, review } = suggestForEntries([
    { kind: 'variable', id: 'A', name: 'Color 1', resolvedType: 'COLOR', value: hex('#3b82f6') },
    { kind: 'variable', id: 'B', name: 'primary', resolvedType: 'COLOR', value: hex('#3b82f6') },
  ]);
  assert.equal(suggestions.length, 0, 'neither may be silently renamed');
  assert.equal(review.length, 2);
  assert.match(review[0].why, /same value/);
  assert.equal(/-2$|_2$/.test(review[0].suggestion ?? ''), false, 'a numeric suffix would hide the real problem');
});

// ------------------------------------------------------ component classifier

section('component classifier');

/** A complete, all-falsy signature — override only what the case is about. */
// aspectRatio is DERIVED, not defaulted. It used to be hardcoded to 1, which
// let fixtures describe a 44×24 pill that claimed to be square — and any rule
// reading the ratio then passed or failed for a reason no real capture could
// reproduce. The capture script computes width/height; so does this.
const sig = (over) => {
  const base = {
    width: 0, height: 0, childCount: 0, directChildCount: 0, totalDescendants: 0,
    layoutMode: 'NONE', hasAutoLayout: false, cornerRadius: 0, hasFill: false, hasSolidFill: false,
    hasStroke: false, hasImageFill: false, hasGradientFill: false, textNodes: [], childTypes: [],
    childNames: [], smallInstances: 0, variantProps: [], ...over,
  };
  return { aspectRatio: base.height > 0 ? base.width / base.height : 1, ...base };
};

const BUTTON_FILLED = sig({ width: 120, height: 40, cornerRadius: 8, hasFill: true, hasSolidFill: true, childCount: 1, totalDescendants: 1, textNodes: [{ text: 'Save', fontSize: 14 }] });
const BUTTON_OUTLINE = sig({ width: 120, height: 40, cornerRadius: 8, hasStroke: true, childCount: 1, totalDescendants: 1, textNodes: [{ text: 'Cancel', fontSize: 14 }] });
const BADGE = sig({ width: 24, height: 24, cornerRadius: 12, hasFill: true, hasSolidFill: true, childCount: 1, totalDescendants: 1, textNodes: [{ text: '3', fontSize: 11 }] });

test('ordinary component shapes classify as themselves', () => {
  const cases = [
    [BUTTON_FILLED, 'Button'],
    [BUTTON_OUTLINE, 'Button'],
    [BADGE, 'Badge'],
    [sig({ width: 280, height: 44, cornerRadius: 4, hasStroke: true, hasInput: true, childCount: 1, totalDescendants: 1, textNodes: [{ text: 'Enter name', fontSize: 14 }] }), 'Text Input'],
    [sig({ width: 160, height: 32, childCount: 1, totalDescendants: 1, textNodes: [{ text: 'Copy link', fontSize: 12 }] }), 'Tooltip'],
    [sig({ width: 40, height: 40, cornerRadius: 8, hasIcon: true, childCount: 1, totalDescendants: 1 }), 'Icon Button'],
    [sig({ width: 400, height: 320, hasClose: true, hasOverlay: true, childCount: 4, totalDescendants: 12, textNodes: [{ text: 'Confirm', fontSize: 20 }, { text: 'Sure?', fontSize: 14 }] }), 'Modal'],
    [sig({ width: 44, height: 24, cornerRadius: 12, hasFill: true, hasSolidFill: true, childCount: 1, totalDescendants: 1 }), 'Toggle'],
    [sig({ width: 40, height: 40, cornerRadius: 20, hasFill: true, hasSolidFill: true, childCount: 1, totalDescendants: 1 }), 'Avatar'],
    [sig({ width: 20, height: 20, cornerRadius: 2, hasStroke: true }), 'Checkbox'],
    [sig({ width: 20, height: 20, cornerRadius: 10, hasStroke: true }), 'Radio Button'],
    [sig({ width: 320, height: 1, hasFill: true, hasSolidFill: true }), 'Divider'],
  ];
  for (const [signature, want] of cases) {
    const got = classifyComponent(signature, { pageName: 'Components' });
    assert.equal(got?.name, want, `expected ${want}, got ${got?.name ?? '(none)'}`);
  }
});

test('real component sets from TestDSDS classify as what they are called', () => {
  // Captured live from iK3ri10PCRhIXJZ2OyGpJc with the script in
  // references/inventory.md. The file's own names are the ground truth, and
  // both of these were wrong before: Button read as Slider (the geometry-only
  // half of the Slider rule describes any short wide labelled thing) and
  // Toggle read as Badge (28×16 fell under the plugin's 36px width floor).
  const button = sig({
    width: 129, height: 28, childCount: 3, directChildCount: 3, totalDescendants: 7,
    layoutMode: 'HORIZONTAL', hasAutoLayout: true, cornerRadius: 8, hasFill: true, hasSolidFill: true,
    textNodes: [{ text: 'Button CTA', fontSize: 12, isBold: true }],
    variantProps: ['Size', 'Type', 'Icon', 'State'], variantCount: 60, measuredFrom: 'variant',
    hasIcon: true, smallInstances: 4,
  });
  const toggle = sig({
    width: 28, height: 16, childCount: 1, directChildCount: 1, totalDescendants: 1,
    layoutMode: 'HORIZONTAL', hasAutoLayout: true, cornerRadius: 9999, hasFill: true, hasSolidFill: true,
    variantProps: ['Pressed', 'Size', 'State'], variantCount: 4, measuredFrom: 'variant',
  });
  assert.equal(classifyComponent(button, { pageName: 'Button' })?.name, 'Button');
  assert.equal(classifyComponent(toggle, { pageName: 'Toggle' })?.name, 'Toggle');
});

test('measuring a variant set as a whole is what the capture must not do', () => {
  // The same Button set measured at set level — 553×1126, 60 children, GRID —
  // is the variant grid, not the component. It classified as Card. This asserts
  // the wrong shape stays wrong, so nobody "fixes" the classifier to accept it
  // instead of fixing the capture.
  const grid = sig({
    width: 553, height: 1126, childCount: 60, directChildCount: 60, totalDescendants: 372,
    layoutMode: 'GRID', hasAutoLayout: true, cornerRadius: 5, hasFill: true, hasSolidFill: true,
    hasStroke: true, textNodes: Array.from({ length: 8 }, () => ({ text: 'Button CTA', fontSize: 12, isBold: true })),
    variantProps: ['Size', 'Type', 'Icon', 'State'], hasIcon: true, smallInstances: 180,
  });
  assert.notEqual(classifyComponent(grid, { pageName: 'Button' })?.name, 'Button');
});

test('a loose geometric rule never outranks a specific one', () => {
  // The three regressions found by porting the plugin's table verbatim. Each
  // used to win on priority alone, and each read as high confidence.
  assert.notEqual(classifyComponent(BUTTON_FILLED, {}).name, 'Tooltip');
  assert.notEqual(classifyComponent(BUTTON_OUTLINE, {}).name, 'Text Input');
  assert.notEqual(classifyComponent(BADGE, {}).name, 'Radio Button');
});

test('a catch-all shape is offered at low confidence, never as certain', () => {
  const container = sig({ width: 300, height: 200, layoutMode: 'VERTICAL', hasAutoLayout: true, childCount: 3, totalDescendants: 8, hasFill: true, hasSolidFill: true });
  assert.equal(classifyComponent(container, {}).confidence, 'low');
  assert.notEqual(classifyComponent(BUTTON_FILLED, {}).confidence, 'low');
});

test('nothing matched means no name, not "Component"', () => {
  // The plugin answered "Small Element" / "Bar Element" / "Component" here.
  // Those read as answers in a list of 200, and they are not names.
  const nothing = sig({ width: 77, height: 55, hasFill: true, hasSolidFill: true, childCount: 2, totalDescendants: 2 });
  assert.equal(classifyComponent(nothing, { pageName: 'Misc' }), null);
});

test('the page name is a last resort, and says so', () => {
  const nothing = sig({ width: 77, height: 55, hasFill: true, hasSolidFill: true, childCount: 2, totalDescendants: 2 });
  const result = classifyComponent(nothing, { pageName: '❖ Button' });
  assert.equal(result.name, 'Button');
  assert.equal(result.confidence, 'low');
  assert.match(result.reason, /No structural rule matched/);
});

test('the label is not baked into the name by default', () => {
  assert.equal(suggestComponentName(BUTTON_FILLED, {}).name, 'Button');
  assert.equal(suggestComponentName(BUTTON_FILLED, { includeTextHint: true }).name, 'Save Button');
});

test('runners-up are named, because the winner is a ranking not a fact', () => {
  assert.match(classifyComponent(BUTTON_FILLED, {}).reason, /also matched/);
});

test('components landing on one name are reported, not suffixed apart', () => {
  const collisions = findNameCollisions([
    { id: '1', currentName: 'btn a', name: 'Button', reason: 'x' },
    { id: '2', currentName: 'btn b', name: 'Button', reason: 'y' },
    { id: '3', currentName: 'card', name: 'Card', reason: 'z' },
  ]);
  assert.equal(collisions.length, 1);
  assert.equal(collisions[0].name, 'Button');
  assert.equal(collisions[0].members.length, 2);
});

test('a signature built by hand is refused', () => {
  assert.throws(() => classifyComponent({ width: 10 }, {}), /missing/);
});

// ------------------------------------------------- shared naming standard

section('shared standard (extends)');

/** A throwaway project whose config extends something. */
function projectExtending(extendsValue, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'figma-rename-ext-'));
  fs.mkdirSync(path.join(dir, 'rename'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'rename.config.json'),
    // A figma-source project needs a fileKey; these fixtures are figma-source.
    JSON.stringify({ extends: extendsValue, figma: { fileKey: 'K' }, ...overrides }, null, 2),
  );
  fs.writeFileSync(
    path.join(dir, 'rename/inventory.json'),
    JSON.stringify({
      entries: [
        { kind: 'variable', id: 'A', name: 'color/bg-raised', scope: 'semantic', resolvedType: 'COLOR', value: { r: 1, g: 1, b: 1, a: 1 } },
        { kind: 'variable', id: 'B', name: 'color/surface/raised', scope: 'semantic', resolvedType: 'COLOR', value: { r: 1, g: 1, b: 1, a: 1 } },
        { kind: 'variable', id: 'C', name: 'space/md', scope: 'dimen', resolvedType: 'FLOAT', value: 16, scopes: ['GAP'] },
      ],
    }),
  );
  return dir;
}

test('a project inherits the standard without restating it', () => {
  const dir = projectExtending('aurora');
  const result = run('plan.mjs', ['--dry-run'], dir);
  assert.equal(result.ok, true, result.out);
  // The rules live in the preset; the project's config named none of them.
  assert.match(result.out, /color\/bg-raised {2}-> {2}color\/surface\/raised/);
  assert.match(result.out, /space\/md {2}-> {2}spacing\/md/);
  // And what the standard already calls correct stays untouched.
  assert.match(result.out, /conforming {2}1/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the project wins where it overrides, the standard holds everywhere else', () => {
  const dir = projectExtending('aurora', { code: { cssPrefix: 'ds-', flutterPrefix: 'Rz' } });
  const result = run('plan.mjs', ['--print-config'], dir);
  assert.equal(result.ok, true, result.out);
  const printed = JSON.parse(result.out.slice(result.out.indexOf('{')));
  assert.equal(printed.code.cssPrefix, 'ds-', 'the project override must win');
  assert.equal(printed.code.flutterPrefix, 'Rz');
  assert.equal(printed.convention.segmentCase, 'kebab', 'and the standard must still apply');
  assert.match(result.out, /extends: aurora/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an array override replaces rather than appends', () => {
  // "these, not those" — appending would silently keep rules the project was
  // trying to drop, and it would look like the standard misbehaving.
  const dir = projectExtending('aurora', { convention: { conforming: ['space/**'] } });
  const result = run('plan.mjs', ['--print-config'], dir);
  const printed = JSON.parse(result.out.slice(result.out.indexOf('{')));
  assert.deepEqual(printed.convention.conforming, ['space/**']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a team file works as the standard, not just a shipped preset', () => {
  const dir = projectExtending('./shared-naming.json');
  fs.writeFileSync(
    path.join(dir, 'shared-naming.json'),
    JSON.stringify({ convention: { segmentCase: 'snake', rules: [{ match: 'space/**', to: 'gap/$1' }] } }),
  );
  const result = run('plan.mjs', ['--dry-run'], dir);
  assert.equal(result.ok, true, result.out);
  assert.match(result.out, /space\/md {2}-> {2}gap\/md/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a missing standard names the presets that do exist', () => {
  const dir = projectExtending('nope');
  const result = run('plan.mjs', ['--dry-run'], dir);
  assert.equal(result.ok, false);
  assert.match(result.out, /could not find "nope"/);
  assert.match(result.out, /Presets in this skill: .*aurora/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the shipped presets are valid on their own', () => {
  const presetsDir = path.resolve(HERE, '../presets');
  const presets = fs.readdirSync(presetsDir).filter((f) => f.endsWith('.json'));
  assert.ok(presets.length >= 1, 'the skill must ship at least one standard');
  for (const file of presets) {
    const parsed = JSON.parse(fs.readFileSync(path.join(presetsDir, file), 'utf8'));
    assert.ok(parsed.convention, `${file} has no convention block`);
    // A preset whose own rules cannot compile fails every project that extends it.
    compileConvention(parsed.convention);
  }
});

test('a preset never marks as conforming something its own rules want to fix', () => {
  // Rules now win over conforming, so this can no longer silently disable a
  // rule — but a preset that claims a name in both places is still telling two
  // stories about it, and the reader has to guess which one is intended.
  const presetsDir = path.resolve(HERE, '../presets');
  for (const file of fs.readdirSync(presetsDir).filter((f) => f.endsWith('.json'))) {
    const parsed = JSON.parse(fs.readFileSync(path.join(presetsDir, file), 'utf8'));
    const compiled = compileConvention({ ...parsed.convention, rules: [] });
    for (const rule of parsed.convention.rules ?? []) {
      const sample = rule.match.replace(/\*\*/g, 'x/y').replace(/\*/g, 'x');
      assert.notEqual(
        proposeName(sample, compiled).status,
        'conforming',
        `${file}: "${rule.match}" overlaps conforming, which already claims "${sample}"`,
      );
    }
  }
});

test('a regex written where a glob belongs is refused, with the glob spelled out', () => {
  // It compiles to a literal that matches nothing, so without this the only
  // symptom is a plan that quietly renames less than you asked for.
  assert.throws(
    () => compileConvention({ rules: [{ match: '^palette/(.*)$', to: 'primitive/$1' }] }),
    /glob, not a regex[\s\S]*"palette\/\*\*"/,
  );
  assert.throws(
    () => compileConvention({ rules: [{ match: 'color/text-*$' }] }),
    /glob, not a regex/,
  );
  // A plain glob with wildcards is still fine.
  assert.doesNotThrow(() => compileConvention({ rules: [{ match: 'palette/**', to: 'x/$1' }] }));
});

test('an explicit rule beats an inherited conforming glob', () => {
  // The whole point of extends is that a project overrides one thing without
  // restating the standard. aurora marks palette/** conforming; a project that
  // moves palette to primitive must be able to say so in one rule.
  const compiled = compileConvention({
    conforming: ['palette/**'],
    rules: [{ name: 'palette-to-primitive', match: 'palette/**', to: 'primitive/$1' }],
  });
  const result = proposeName('palette/blue/500', compiled);
  assert.equal(result.status, 'renamed', 'conforming must not shadow a rule that names this');
  assert.equal(result.to, 'primitive/blue/500');
});

test('conforming still wins when only transform would have touched the name', () => {
  // transform is a blanket tidy-up, not a statement about this name — letting it
  // override conforming would make every conforming glob meaningless the moment
  // a separator was set.
  const compiled = compileConvention({
    conforming: ['palette/**'],
    transform: { separator: '-' },
    rules: [],
  });
  assert.equal(proposeName('palette/blue/500', compiled).status, 'conforming');
});

test('ignore still vetoes a rule that matches', () => {
  const compiled = compileConvention({
    ignore: ['palette/**'],
    rules: [{ name: 'x', match: 'palette/**', to: 'primitive/$1' }],
  });
  assert.equal(proposeName('palette/blue/500', compiled).status, 'ignored');
});

// ---------------------------------------------------------------- transform

section('transform');

test('prefix, separator and case run without writing a single glob rule', () => {
  const c = compileConvention({
    segmentCase: 'kebab',
    transform: {
      separator: { from: '-', to: '/' },
      stripPrefix: ['palette'],
      addPrefix: 'primitive',
      replace: [{ find: 'btn', with: 'button' }],
    },
  });
  assert.equal(proposeName('palette/red/500', c).to, 'primitive/red/500');
  assert.equal(proposeName('palette/btn/bg', c).to, 'primitive/button/bg');
  assert.equal(proposeName('color-text-primary', c).to, 'primitive/color/text/primary');
});

test('transform is idempotent — a prefix is not added twice', () => {
  const c = compileConvention({ segmentCase: 'kebab', transform: { addPrefix: 'primitive' } });
  const once = proposeName('red/500', c).to;
  assert.equal(once, 'primitive/red/500');
  assert.equal(proposeName(once, c).to, null, 'running it again must be a no-op');
});

test('a strip never leaves a name with nothing in it', () => {
  const c = compileConvention({ segmentCase: 'kebab', transform: { stripPrefix: ['palette'] } });
  assert.equal(proposeName('palette', c).to, null, '"palette" alone has no name left after stripping');
  assert.equal(proposeName('palette/red', c).to, 'red');
});

test('a rule still outranks the transform', () => {
  const c = compileConvention({
    segmentCase: 'kebab',
    rules: [{ match: 'palette/brand-*', to: 'brand/$1' }],
    transform: { stripPrefix: ['palette'], addPrefix: 'primitive' },
  });
  // The rule fires first, then the transform runs on its output.
  assert.equal(proposeName('palette/brand-primary', c).to, 'primitive/brand/primary');
});

// -------------------------------------------------------------------- naming

section('naming');

/** Every `export function` in a naming.mjs, normalised for comparison. */
function namingFunctions(file) {
  const source = fs.readFileSync(file, 'utf8');
  const out = new Map();
  for (const match of source.matchAll(/export function (\w+)\(([\s\S]*?)\n\}/g)) {
    out.set(match[1], `${match[2]}\n}`.replace(/\s+/g, ' '));
  }
  return out;
}

test('naming.mjs matches its lock file', () => {
  // This skill ships in its own repo, so the sibling check below usually finds
  // nothing — and a check that silently skips is worse than no check at all,
  // because it reads as passing. The lock is what actually holds the line: it
  // pins the exact source of every function `figma-token-export` also ships,
  // so an accidental edit fails here even with that skill nowhere in sight.
  const lock = JSON.parse(fs.readFileSync(path.join(HERE, 'lib/naming.lock.json'), 'utf8')).functions;
  const mine = namingFunctions(path.join(HERE, 'lib/naming.mjs'));
  const hash = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);

  for (const [name, expected] of Object.entries(lock)) {
    assert.ok(mine.has(name), `naming.mjs no longer exports ${name}()`);
    assert.equal(
      hash(mine.get(name)),
      expected,
      `${name}() changed. If that was deliberate, change it in figma-token-export too, ` +
        'then re-lock with: node selftest.mjs --relock',
    );
  }
  assert.equal(Object.keys(lock).length, mine.size, 'a function was added to naming.mjs without re-locking');
});

test('naming.mjs is identical to the figma-token-export copy when both are present', () => {
  const sibling = path.resolve(HERE, '../../figma-token-export/scripts/lib/naming.mjs');
  if (!fs.existsSync(sibling)) {
    console.log('       (no sibling checkout — the lock file above is the real guard)');
    return;
  }
  const mine = namingFunctions(path.join(HERE, 'lib/naming.mjs'));
  const theirs = namingFunctions(sibling);
  // The whole export set, not the intersection. Comparing only shared names is
  // how the two files drifted unnoticed: this skill had added toSnake/toDot and
  // the sibling had avoidReserved, and every shared body still matched, so the
  // check passed while the files were no longer the same.
  assert.deepEqual(
    [...mine.keys()].sort(),
    [...theirs.keys()].sort(),
    'naming.mjs exports a different set of functions from figma-token-export — a spelling only one side knows is a spelling that will drift.',
  );
  for (const name of mine.keys()) {
    assert.equal(
      mine.get(name),
      theirs.get(name),
      `${name}() has drifted from figma-token-export — the codemod would rewrite identifiers the generator never emits.`,
    );
  }
});

// --------------------------------------------------------------- end to end

section('end to end');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'figma-rename-'));

const inventory = {
  fileKey: 'FILEKEY0000000000000000',
  entries: [
    { kind: 'variable', id: 'VariableID:1:1', name: 'color/text-primary', scope: 'Semantic', resolvedType: 'COLOR' },
    { kind: 'variable', id: 'VariableID:1:2', name: 'color/bg-raised', scope: 'Semantic', resolvedType: 'COLOR' },
    { kind: 'variable', id: 'VariableID:1:3', name: 'spacing/8', scope: 'Scale', resolvedType: 'FLOAT' },
    { kind: 'variable', id: 'VariableID:1:4', name: 'Color/Blue 500', scope: 'Primitive', resolvedType: 'COLOR' },
  ],
};

const config = {
  figma: { fileKey: 'FILEKEY0000000000000000' },
  inventoryPath: 'rename/inventory.json',
  renameMapPath: 'rename/rename-map.json',
  kinds: ['variable'],
  convention: {
    separator: '/',
    segmentCase: 'kebab',
    aliases: { bg: 'surface' },
    rules: [
      { match: 'color/text-*', to: 'text/$1/default' },
      { match: 'color/bg-*', to: 'surface/$1' },
      { match: 'color/**', to: 'palette/$1' },
    ],
    conforming: ['spacing/**'],
    structure: { minSegments: 2, categories: ['text', 'surface', 'palette', 'spacing'] },
  },
  code: {
    roots: ['.'],
    include: ['**/*.{css,dart,ts}'],
    exclude: ['**/node_modules/**', '**/rename/**'],
    generated: ['src/tokens/**'],
    spellings: ['figmaPath', 'cssVar', 'camel', 'camelMember', 'pascal'],
    cssPrefix: '',
    flutterPrefix: 'App',
  },
};

fs.mkdirSync(path.join(tmp, 'rename'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'src/tokens'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'src/app'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'rename.config.json'), JSON.stringify(config, null, 2));
fs.writeFileSync(path.join(tmp, 'rename/inventory.json'), JSON.stringify(inventory, null, 2));
fs.writeFileSync(
  path.join(tmp, 'src/tokens/tokens.css'),
  ':root { --color-text-primary: #111; --color-bg-raised: #fff; }\n',
);
fs.writeFileSync(
  path.join(tmp, 'src/app/button.css'),
  '.btn { color: var(--color-text-primary); background: var(--color-bg-raised); }\n' +
    '.btn:hover { color: var(--color-text-primary-hover); }\n',
);
fs.writeFileSync(
  path.join(tmp, 'src/app/theme.dart'),
  'final a = AppColorColors.textPrimary;\nfinal b = colorBgRaised;\nfinal c = myColorTextPrimary;\n',
);

test('plan writes a rename map and reports the buckets', () => {
  const result = run('plan.mjs', [], tmp);
  assert.equal(result.ok, true, result.out);
  assert.match(result.out, /color\/text-primary {2}-> {2}text\/primary\/default/);
  const map = JSON.parse(fs.readFileSync(path.join(tmp, 'rename/rename-map.json'), 'utf8'));
  const all = map.batches.flatMap((b) => b.renames);
  assert.equal(all.length, 3, `expected 3 renames, got ${all.length}`);
  assert.equal(all.find((r) => r.id === 'VariableID:1:2').to, 'surface/raised');
  assert.equal(all.find((r) => r.id === 'VariableID:1:4').to, 'palette/blue-500');
  // spacing/8 matched `conforming` and must not appear at all.
  assert.equal(all.some((r) => r.from === 'spacing/8'), false);
});

test('a generic name nothing can name goes to review, not to a cosmetic rename', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'figma-rename-generic-'));
  fs.mkdirSync(path.join(dir, 'rename'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'rename.config.json'),
    JSON.stringify({ ...config, convention: { segmentCase: 'kebab' } }, null, 2),
  );
  fs.writeFileSync(
    path.join(dir, 'rename/inventory.json'),
    JSON.stringify({
      entries: [
        { kind: 'variable', id: 'A', name: 'Value 1', scope: 'Spacing', resolvedType: 'FLOAT', value: 16, scopes: ['GAP'] },
        { kind: 'variable', id: 'B', name: 'Variable 3', scope: 'Misc', resolvedType: 'FLOAT', value: 0.5 },
      ],
    }),
  );

  // With the low-confidence guess filtered out, "Variable 3" must not fall
  // through to the normalizer and become "variable-3".
  const result = run('plan.mjs', ['--min-confidence', 'medium'], dir);
  assert.equal(result.ok, true, result.out);
  const map = JSON.parse(fs.readFileSync(path.join(dir, 'rename/rename-map.json'), 'utf8'));
  const renames = map.batches.flatMap((b) => b.renames);
  assert.deepEqual(renames.map((r) => r.to), ['spacing/md']);
  assert.equal(renames[0].confidence, 'high');
  assert.equal(map.needsReview.some((r) => r.name === 'Variable 3'), true);
  assert.equal(renames.some((r) => r.to === 'variable-3'), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('plan groups by collection, so a batch is one reviewable unit', () => {
  const map = JSON.parse(fs.readFileSync(path.join(tmp, 'rename/rename-map.json'), 'utf8'));
  assert.deepEqual(map.batches.map((b) => b.id).sort(), ['variable-primitive', 'variable-semantic']);
});

test('check passes on the planned map', () => {
  const result = run('check.mjs', [], tmp);
  assert.equal(result.ok, true, result.out);
  assert.match(result.out, /OK/);
});

test('check --code reports how many places will actually change', () => {
  const result = run('check.mjs', ['--code'], tmp);
  assert.equal(result.ok, true, result.out);
  assert.match(result.out, /the codemod will rewrite/);
});

test('check refuses a map whose `from` no longer matches the inventory', () => {
  const mapPath = path.join(tmp, 'rename/rename-map.json');
  const original = fs.readFileSync(mapPath, 'utf8');
  const map = JSON.parse(original);
  map.batches[0].renames[0].from = 'color/something-else';
  fs.writeFileSync(mapPath, JSON.stringify(map, null, 2));
  const result = run('check.mjs', [], tmp);
  fs.writeFileSync(mapPath, original);
  assert.equal(result.ok, false, 'check should have failed');
  assert.match(result.out, /re-capture the inventory/);
});

test('check refuses two renames landing on the same name', () => {
  const mapPath = path.join(tmp, 'rename/rename-map.json');
  const original = fs.readFileSync(mapPath, 'utf8');
  const map = JSON.parse(original);
  const semantic = map.batches.find((b) => b.id === 'variable-semantic');
  semantic.renames[0].to = semantic.renames[1].to;
  fs.writeFileSync(mapPath, JSON.stringify(map, null, 2));
  const result = run('check.mjs', [], tmp);
  fs.writeFileSync(mapPath, original);
  assert.equal(result.ok, false, 'check should have failed');
  assert.match(result.out, /would be the name of both/);
});

test('check refuses a rename that collides in generated code but not in Figma', () => {
  const mapPath = path.join(tmp, 'rename/rename-map.json');
  const original = fs.readFileSync(mapPath, 'utf8');
  const map = JSON.parse(original);
  const semantic = map.batches.find((b) => b.id === 'variable-semantic');
  // Distinct Figma names, one identifier: both flatten to `textPrimaryDefault`.
  semantic.renames[0].to = 'text/primary/default';
  semantic.renames[1].to = 'text/primary-default';
  fs.writeFileSync(mapPath, JSON.stringify(map, null, 2));
  const result = run('check.mjs', [], tmp);
  fs.writeFileSync(mapPath, original);
  assert.equal(result.ok, false, 'check should have failed');
  assert.match(result.out, /Identifier collision/);
});

test('emit-figma prints a validate-then-mutate script with the real ids', () => {
  acceptEverything(tmp);
  const result = run('emit-figma.mjs', ['--batch', 'variable-semantic'], tmp);
  assert.equal(result.ok, true, result.out);
  assert.match(result.out, /getVariableByIdAsync/);
  assert.match(result.out, /"VariableID:1:1", "color\/text-primary", "text\/primary\/default"/);
  assert.match(result.out, /Refusing to rename/);
  assert.match(result.out, /mutatedNodeIds/);
  assert.equal(/__rn_tmp_/.test(result.out), false, 'no chain here, so no staging');
  assertParses(result.out, 'the emitted variable script');
});

test('emit-figma --reverse swaps the direction for rollback', () => {
  acceptEverything(tmp);
  markFigmaApplied(tmp, 'variable-semantic');
  const result = run('emit-figma.mjs', ['--batch', 'variable-semantic', '--reverse'], tmp);
  assert.equal(result.ok, true, result.out);
  assert.match(result.out, /"VariableID:1:1", "text\/primary\/default", "color\/text-primary"/);
  assert.match(result.out, /reversed: true/);
});

test('emit-figma --with-code-syntax records the code name back into Figma', () => {
  // Its own project: the shared one has a batch mid-flight by now, and the
  // one-batch-at-a-time guard would (correctly) refuse a second forward emit.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'figma-rename-syntax-'));
  fs.mkdirSync(path.join(dir, 'rename'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'rename.config.json'), JSON.stringify(config, null, 2));
  fs.writeFileSync(path.join(dir, 'rename/inventory.json'), JSON.stringify(inventory, null, 2));
  assert.equal(run('plan.mjs', [], dir).ok, true);
  acceptEverything(dir);
  const result = run('emit-figma.mjs', ['--batch', 'variable-semantic', '--with-code-syntax'], dir);
  assert.equal(result.ok, true, result.out);
  assert.match(result.out, /var\(--text-primary-default\)/);
  assert.match(result.out, /setVariableCodeSyntax/);
  assertParses(result.out, 'the emitted code-syntax script');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('emit-figma stages a rename chain through temporary names', () => {
  const chainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'figma-rename-chain-'));
  fs.mkdirSync(path.join(chainDir, 'rename'), { recursive: true });
  fs.writeFileSync(path.join(chainDir, 'rename.config.json'), JSON.stringify(config, null, 2));
  fs.writeFileSync(path.join(chainDir, 'rename/inventory.json'), JSON.stringify(inventory, null, 2));
  fs.writeFileSync(
    path.join(chainDir, 'rename/rename-map.json'),
    JSON.stringify(
      {
        version: MAP_VERSION,
        fileKey: 'FILEKEY0000000000000000',
        batches: [
          {
            id: 'chain',
            kind: 'variable',
            scope: 'Semantic',
            status: 'planned',
            renames: [
              { id: 'VariableID:1:1', from: 'color/text-primary', to: 'color/bg-raised', decision: 'accepted' },
              { id: 'VariableID:1:2', from: 'color/bg-raised', to: 'text/primary/default', decision: 'accepted' },
            ],
          },
        ],
      },
      null,
      2,
    ),
  );
  const result = run('emit-figma.mjs', ['--batch', 'chain'], chainDir);
  assert.equal(result.ok, true, result.out);
  assert.match(result.out, /__rn_tmp_/);
  assert.match(result.out, /staged: true/);
  assertParses(result.out, 'the emitted staged script');
  fs.rmSync(chainDir, { recursive: true, force: true });
});

test('a component batch carries its page, and emit-figma switches to it once', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'figma-rename-node-'));
  fs.mkdirSync(path.join(dir, 'rename'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'rename.config.json'),
    JSON.stringify(
      {
        ...config,
        kinds: ['componentSet'],
        convention: {
          separator: '/',
          segmentCase: 'pascal',
          aliases: { btn: 'Button' },
          rules: [{ match: '*', to: '$1' }],
        },
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(
    path.join(dir, 'rename/inventory.json'),
    JSON.stringify({
      entries: [
        { kind: 'componentSet', id: '1:44', name: 'btn primary', scope: 'Components', pageId: '0:12' },
        { kind: 'componentSet', id: '1:45', name: 'btn ghost', scope: 'Components', pageId: '0:12' },
      ],
    }),
  );

  const planned = run('plan.mjs', [], dir);
  assert.equal(planned.ok, true, planned.out);
  const map = JSON.parse(fs.readFileSync(path.join(dir, 'rename/rename-map.json'), 'utf8'));
  assert.equal(map.batches[0].pageId, '0:12');
  // A component's code symbol is a suggestion, never applied automatically.
  assert.ok(map.batches[0].renames[0].codeSuggestion);
  assert.equal(map.batches[0].renames[0].code, undefined);

  acceptEverything(dir);
  const emitted = run('emit-figma.mjs', ['--batch', map.batches[0].id], dir);
  assert.equal(emitted.ok, true, emitted.out);
  assert.match(emitted.out, /setCurrentPageAsync/);
  assert.equal(emitted.out.match(/setCurrentPageAsync/g).length, 1, 'exactly one page switch per call');
  assert.match(emitted.out, /figma\.getNodeByIdAsync/);
  assertParses(emitted.out, 'the emitted node script');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('apply-code dry run changes nothing on disk', () => {
  applyInFigma(tmp);
  const before = fs.readFileSync(path.join(tmp, 'src/app/button.css'), 'utf8');
  const result = run('apply-code.mjs', [], tmp);
  assert.equal(result.ok, true, result.out);
  assert.match(result.out, /would rewrite/);
  assert.equal(fs.readFileSync(path.join(tmp, 'src/app/button.css'), 'utf8'), before);
});

test('apply-code --write rewrites consumers and leaves generated files to the generator', () => {
  applyInFigma(tmp);
  const result = run('apply-code.mjs', ['--write'], tmp);
  assert.equal(result.ok, true, result.out);

  const css = fs.readFileSync(path.join(tmp, 'src/app/button.css'), 'utf8');
  assert.match(css, /var\(--text-primary-default\)/);
  assert.match(css, /var\(--surface-raised\)/);
  // A longer name that merely starts with a renamed one must survive untouched.
  assert.match(css, /var\(--color-text-primary-hover\)/);

  const dart = fs.readFileSync(path.join(tmp, 'src/app/theme.dart'), 'utf8');
  // `color/` splits into text/, surface/ and palette/, so there is no single
  // class rename — the member moved, the class name is left for the compiler.
  assert.match(dart, /AppColorColors\.primaryDefault/);
  assert.match(result.out, /splits into/);
  assert.match(dart, /final b = surfaceRaised;/);
  assert.match(dart, /final c = myColorTextPrimary;/);

  const generated = fs.readFileSync(path.join(tmp, 'src/tokens/tokens.css'), 'utf8');
  assert.match(generated, /--color-text-primary:/, 'generated files are rebuilt, not patched');
});

test('check --after catches a codemod that ran without regenerating', () => {
  // The generated file still holds the old names because figma-token-export
  // has not run yet. That IS the bug this check exists to catch.
  const result = run('check.mjs', ['--after'], tmp);
  assert.equal(result.ok, false, 'check --after should have failed');
  assert.match(result.out, /src\/tokens\/tokens\.css/);
});

test('check --after passes once the generated file has been rebuilt', () => {
  fs.writeFileSync(
    path.join(tmp, 'src/tokens/tokens.css'),
    ':root { --text-primary-default: #111; --surface-raised: #fff; }\n',
  );
  const result = run('check.mjs', ['--after'], tmp);
  assert.equal(result.ok, true, result.out);
  assert.match(result.out, /OK/);
});

test('check --after fails while a stale spelling is still in code', () => {
  const file = path.join(tmp, 'src/app/leftover.css');
  fs.writeFileSync(file, '.x { color: var(--color-text-primary); }\n');
  const result = run('check.mjs', ['--after'], tmp);
  fs.rmSync(file);
  assert.equal(result.ok, false, 'check --after should have failed');
  assert.match(result.out, /stale name still in code/);
});

fs.rmSync(tmp, { recursive: true, force: true });

// ------------------------------------------------------- artefact protection

section('artefact protection');

test('apply-code --write never rewrites the map or the inventory', () => {
  // Deliberately uses the SHIPPED defaults for code.include/exclude — the
  // end-to-end fixture above excludes `**/rename/**` by hand, which is exactly
  // what hid this bug. The default include matches `**/*.json`, the artefacts
  // are full of old names, and `figmaPath` is a default spelling: without the
  // forced exclusion the codemod rewrites the map's own `from` fields, and
  // then `check --after` passes vacuously because every pair has collapsed.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'figma-rename-artefact-'));
  fs.mkdirSync(path.join(dir, 'rename'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'rename.config.json'),
    JSON.stringify({ figma: { fileKey: 'K' }, kinds: ['variable'], convention: { segmentCase: 'kebab' } }),
  );
  fs.writeFileSync(
    path.join(dir, 'rename/inventory.json'),
    JSON.stringify({
      entries: [{ kind: 'variable', id: 'V1', name: 'color/text-primary', scope: 'S', resolvedType: 'COLOR', value: { r: 0, g: 0, b: 0, a: 1 } }],
    }),
  );
  const mapJson = JSON.stringify({
    version: MAP_VERSION,
    batches: [{
      id: 'b', kind: 'variable', scope: 'S', status: 'figma-applied',
      renames: [{ id: 'V1', from: 'color/text-primary', to: 'text/primary/default', source: 'manual', decision: 'accepted' }],
    }],
    needsReview: [],
  });
  fs.writeFileSync(path.join(dir, 'rename/rename-map.json'), mapJson);
  fs.writeFileSync(path.join(dir, 'src/a.css'), '.a { color: var(--color-text-primary); }\n');

  const result = run('apply-code.mjs', ['--write'], dir);
  assert.equal(result.ok, true, result.out);
  assert.match(fs.readFileSync(path.join(dir, 'src/a.css'), 'utf8'), /--text-primary-default/, 'code should be rewritten');
  assert.match(
    fs.readFileSync(path.join(dir, 'rename/rename-map.json'), 'utf8'),
    /"from":\s*"color\/text-primary"/,
    'the map must still carry the OLD name, or nothing can be reversed or verified',
  );
  assert.match(
    fs.readFileSync(path.join(dir, 'rename/inventory.json'), 'utf8'),
    /"name":\s*"color\/text-primary"/,
    'the inventory is the record of what the names WERE',
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the artefact exclusion cannot be overridden away', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'figma-rename-artefact2-'));
  fs.mkdirSync(path.join(dir, 'rename'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'rename.config.json'),
    JSON.stringify({
      figma: { fileKey: 'K' },
      // A project trying (or forgetting) to protect its artefacts.
      code: { exclude: [] },
    }),
  );
  fs.writeFileSync(path.join(dir, 'rename/inventory.json'), JSON.stringify({ entries: [] }));
  fs.writeFileSync(
    path.join(dir, 'rename/rename-map.json'),
    JSON.stringify({ version: MAP_VERSION, batches: [], needsReview: [] }),
  );
  const result = run('plan.mjs', ['--print-config'], dir);
  const printed = JSON.parse(result.out.slice(result.out.indexOf('{')));
  assert.ok(
    printed.code.exclude.some((p) => p.startsWith('rename/')),
    `expected a forced rename/ exclusion, got ${JSON.stringify(printed.code.exclude)}`,
  );
  assert.ok(printed.code.exclude.includes('rename.config.json'));
  fs.rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------------ handoff to token-export

section('handoff');

/** A project with both configs, so the cross-check has something to compare. */
function handoffProject(renameCode, tokensConfig, rules = [{ match: 'palette/**', to: 'primitive/$1' }]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'figma-rename-handoff-'));
  fs.mkdirSync(path.join(dir, 'rename'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'rename.config.json'),
    JSON.stringify({
      figma: { fileKey: 'K' },
      kinds: ['variable'],
      convention: { segmentCase: 'kebab', rules },
      code: renameCode,
    }),
  );
  if (tokensConfig) fs.writeFileSync(path.join(dir, 'tokens.config.json'), JSON.stringify(tokensConfig));
  fs.writeFileSync(
    path.join(dir, 'rename/inventory.json'),
    JSON.stringify({ entries: [{ kind: 'variable', id: 'V1', name: 'palette/red/500', scope: 'S', resolvedType: 'COLOR', value: { r: 0.9, g: 0.2, b: 0.2, a: 1 } }] }),
  );
  run('plan.mjs', [], dir);
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('a cssPrefix that disagrees with the generator is an error, not a silent no-op', () => {
  const p = handoffProject(
    { cssPrefix: 'ds-', generated: ['src/tokens/**'] },
    { targets: [{ type: 'web', out: 'src/tokens', cssPrefix: '' }] },
  );
  const result = run('check.mjs', [], p.dir);
  assert.equal(result.ok, false);
  assert.match(result.out, /code\.cssPrefix is "ds-"/);
  assert.match(result.out, /matched nothing/);
  p.cleanup();
});

test('flutterPrefix is compared against `prefix`, which is what that config calls it', () => {
  const p = handoffProject(
    { flutterPrefix: 'App', generated: ['lib/tokens/**'] },
    { targets: [{ type: 'flutter', out: 'lib/tokens', prefix: 'Rz' }] },
  );
  const result = run('check.mjs', [], p.dir);
  assert.equal(result.ok, false);
  assert.match(result.out, /flutterPrefix/);
  assert.match(result.out, /`prefix`/);
  p.cleanup();
});

test('a generated directory the config forgot is a warning', () => {
  const p = handoffProject(
    { cssPrefix: '', generated: [] },
    { targets: [{ type: 'web', out: 'src/tokens', cssPrefix: '' }] },
  );
  const result = run('check.mjs', [], p.dir);
  assert.equal(result.ok, true, result.out);
  assert.match(result.out, /does not cover "src\/tokens"/);
  assert.match(result.out, /the next regenerate will erase the patch/);
  p.cleanup();
});

test('a rename that orphans a layers glob is warned about', () => {
  // The trap: layers are matched on token NAMES, so moving a first segment
  // makes the glob match nothing and the tokens fall into `other`.
  const p = handoffProject(
    { cssPrefix: '', generated: ['src/tokens/**'] },
    {
      targets: [{ type: 'web', out: 'src/tokens', cssPrefix: '', layers: ['primitive'] }],
      layers: { primitive: ['palette/**'], semantic: ['color/**'] },
    },
  );
  const result = run('check.mjs', [], p.dir);
  assert.equal(result.ok, true, result.out);
  assert.match(result.out, /layer "primitive" matches "palette\/\*\*"/);
  assert.match(result.out, /fall/);
  p.cleanup();
});

test('matching configs cross-check cleanly', () => {
  const p = handoffProject(
    { cssPrefix: '', generated: ['src/tokens/**'] },
    { targets: [{ type: 'web', out: 'src/tokens', cssPrefix: '' }], layers: { semantic: ['color/**'] } },
  );
  const result = run('check.mjs', [], p.dir);
  assert.equal(result.ok, true, result.out);
  assert.equal(/cssPrefix is/.test(result.out), false, result.out);
  p.cleanup();
});

test('generated paths with no generator to explain them are flagged', () => {
  // The shipped example ships a non-empty `generated`; a project with
  // hand-written tokens would have the codemod skip exactly what needs renaming.
  const p = handoffProject({ cssPrefix: '', generated: ['src/tokens/**'] }, null);
  const result = run('check.mjs', [], p.dir);
  assert.equal(result.ok, true, result.out);
  assert.match(result.out, /no tokens\.config\.json/);
  assert.match(result.out, /skip the very files that need renaming/);
  p.cleanup();
});

test('an explicit tokensConfig that does not exist is an error', () => {
  const p = handoffProject({ cssPrefix: '', tokensConfig: 'nope.json' }, null);
  const result = run('check.mjs', [], p.dir);
  assert.equal(result.ok, false);
  assert.match(result.out, /code\.tokensConfig points at/);
  p.cleanup();
});

// --------------------------------------------------------------- components

section('components');

const componentSig = (over) => ({
  width: 0, height: 0, aspectRatio: 1, childCount: 0, directChildCount: 0, totalDescendants: 0,
  layoutMode: 'NONE', hasAutoLayout: false, cornerRadius: 0, hasFill: false, hasSolidFill: false,
  hasStroke: false, hasImageFill: false, hasGradientFill: false, textNodes: [], childTypes: [],
  childNames: [], smallInstances: 0, variantProps: [], ...over,
});

/** A project set up for component renaming, extending aurora. */
function componentProject(entries, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'figma-rename-comp-'));
  fs.mkdirSync(path.join(dir, 'rename'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'rename.config.json'),
    JSON.stringify({ extends: 'aurora', figma: { fileKey: 'K' }, kinds: ['componentSet', 'component'], ...overrides }),
  );
  fs.writeFileSync(path.join(dir, 'rename/inventory.json'), JSON.stringify({ fileKey: 'K', entries }));
  return {
    dir,
    readMap: () => JSON.parse(fs.readFileSync(path.join(dir, 'rename/rename-map.json'), 'utf8')),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

test('the token structure no longer sends every component to needsReview', () => {
  // Under aurora's TOKEN structure (2 segments, token categories) a component
  // called `Button` failed both tests — the shipped example admitted it with
  // `"kinds": ["variable"]`.
  const p = componentProject([
    { kind: 'component', id: 'C1', name: 'btn primary', scope: 'Components', pageId: '0:1' },
  ]);
  const result = run('plan.mjs', ['--dry-run'], p.dir);
  assert.equal(result.ok, true, result.out);
  assert.match(result.out, /btn primary {2}-> {2}BtnPrimary/, result.out);
  p.cleanup();
});

test('a component convention is separate from the token one', () => {
  const conventions = compileConventions({
    segmentCase: 'kebab',
    structure: { minSegments: 2, categories: ['palette'] },
    components: { segmentCase: 'pascal', structure: { minSegments: 1 } },
  });
  // The same name, judged by each side.
  assert.equal(proposeName('Button', conventions.for('variable')).status, 'needsReview');
  assert.equal(proposeName('btn primary', conventions.for('component')).to, 'BtnPrimary');
});

test('with no components block, components get spelling only — not the token structure', () => {
  const conventions = compileConventions({
    segmentCase: 'kebab',
    structure: { minSegments: 2, categories: ['palette'] },
    rules: [{ match: '**', to: 'palette/$1' }],
  });
  const result = proposeName('btn primary', conventions.for('component'));
  assert.equal(result.status, 'normalized', JSON.stringify(result));
  assert.equal(result.to, 'btn-primary', 'token rules must not reach components');
});

test('a shape suggests a component name, with its evidence', () => {
  const p = componentProject([
    {
      kind: 'component', id: 'C1', name: 'Component 7', scope: 'Components', pageId: '0:1',
      signature: componentSig({ width: 400, height: 320, hasClose: true, hasOverlay: true, childCount: 4, totalDescendants: 12, textNodes: [{ text: 'Confirm', fontSize: 20 }, { text: 'Sure?', fontSize: 14 }] }),
    },
  ]);
  const result = run('plan.mjs', [], p.dir);
  assert.equal(result.ok, true, result.out);
  const row = p.readMap().batches.flatMap((b) => b.renames)[0];
  assert.equal(row.to, 'Modal');
  assert.equal(row.source, 'shape');
  assert.match(row.reason, /Structure: 400×320/);
  assert.equal(row.confidence, 'high');
  p.cleanup();
});

test('a component with no captured shape gets spelling only, and is told so', () => {
  const p = componentProject([
    { kind: 'component', id: 'C1', name: 'thing 9', scope: 'Components', pageId: '0:1' },
  ]);
  const result = run('plan.mjs', [], p.dir);
  assert.match(result.out, /have no captured shape/);
  assert.equal(p.readMap().batches.flatMap((b) => b.renames)[0].to, 'Thing9');
  p.cleanup();
});

test('two components whose shapes read alike go to review, not to a suffix', () => {
  const button = componentSig({ width: 120, height: 40, cornerRadius: 8, hasFill: true, hasSolidFill: true, childCount: 1, totalDescendants: 1, textNodes: [{ text: 'Save', fontSize: 14 }] });
  const p = componentProject([
    { kind: 'component', id: 'C1', name: 'btn one', scope: 'Components', pageId: '0:1', signature: button },
    { kind: 'component', id: 'C2', name: 'btn two', scope: 'Components', pageId: '0:1', signature: button },
  ]);
  const result = run('plan.mjs', [], p.dir);
  assert.equal(result.ok, true, result.out);
  const map = p.readMap();
  const rows = map.batches.flatMap((b) => b.renames);
  assert.equal(rows.some((r) => /Button ?2|Button-2/.test(r.to)), false, 'a numeric suffix tells nobody which is which');
  assert.equal(map.needsReview.length, 2, JSON.stringify(map.needsReview));
  assert.match(map.needsReview[0].why, /cannot say which is which/);
  p.cleanup();
});

test('a component that already conforms is not dragged into a clash', () => {
  const button = componentSig({ width: 120, height: 40, cornerRadius: 8, hasFill: true, hasSolidFill: true, childCount: 1, totalDescendants: 1, textNodes: [{ text: 'Save', fontSize: 14 }] });
  const p = componentProject([
    { kind: 'component', id: 'C1', name: 'btn primary', scope: 'Components', pageId: '0:1', signature: button },
    // aurora's components.conforming already accepts Button/**
    { kind: 'component', id: 'C2', name: 'Button/Primary', scope: 'Components', pageId: '0:1', signature: button },
  ]);
  const result = run('plan.mjs', [], p.dir);
  const map = p.readMap();
  assert.equal(map.needsReview.length, 1, JSON.stringify(map.needsReview.map((i) => i.name)));
  assert.equal(map.needsReview[0].name, 'btn primary');
  assert.match(result.out, /conforming {2}1/);
  p.cleanup();
});

test('the classifier can be retuned from the shared standard', () => {
  const button = componentSig({ width: 120, height: 40, cornerRadius: 8, hasFill: true, hasSolidFill: true, childCount: 1, totalDescendants: 1, textNodes: [{ text: 'Save', fontSize: 14 }] });
  const p = componentProject(
    [{ kind: 'component', id: 'C1', name: 'Component 3', scope: 'Components', pageId: '0:1', signature: button }],
    { convention: { components: { classifier: { priorities: { Tooltip: 999 } } } } },
  );
  const result = run('plan.mjs', [], p.dir);
  assert.equal(result.ok, true, result.out);
  // Retuned without editing the installed skill — which is the whole point.
  assert.equal(p.readMap().batches.flatMap((b) => b.renames)[0].to, 'Tooltip');
  p.cleanup();
});

test('a classifier override naming a rule that does not exist is refused', () => {
  const p = componentProject(
    [{ kind: 'component', id: 'C1', name: 'Component 3', scope: 'Components', pageId: '0:1', signature: componentSig({ width: 10, height: 10 }) }],
    { convention: { components: { classifier: { priorities: { Buton: 10 } } } } },
  );
  const result = run('plan.mjs', [], p.dir);
  assert.equal(result.ok, false);
  assert.match(result.out, /do not exist: Buton/);
  p.cleanup();
});

test('an unknown key inside the components block is refused', () => {
  const p = componentProject([], { convention: { components: { segmentCases: 'pascal' } } });
  const result = run('plan.mjs', ['--print-config'], p.dir);
  assert.equal(result.ok, false);
  assert.match(result.out, /`convention\.components\.segmentCases` is not a setting/);
  p.cleanup();
});

test('a hand-written signature is refused at load', () => {
  const p = componentProject([
    { kind: 'component', id: 'C1', name: 'x', scope: 'C', signature: { width: 10 } },
  ]);
  const result = run('plan.mjs', [], p.dir);
  assert.equal(result.ok, false);
  assert.match(result.out, /signature is missing width\/textNodes|references\/inventory\.md/);
  p.cleanup();
});

test('every capture script in inventory.md is valid JavaScript', () => {
  // These run inside use_figma, where a syntax error surfaces as a failed Figma
  // call rather than as a broken doc.
  const doc = fs.readFileSync(path.resolve(HERE, '../references/inventory.md'), 'utf8');
  const blocks = [...doc.matchAll(/```js\n([\s\S]*?)```/g)].map((m) => m[1]);
  assert.ok(blocks.length >= 5, `expected several capture scripts, found ${blocks.length}`);
  let checked = 0;
  for (const block of blocks) {
    if (block.includes('…as above…')) continue; // deliberately elided
    assertParses(block, 'a capture script in references/inventory.md');
    checked++;
  }
  assert.ok(checked >= 5);
});

// ------------------------------------------------------- config and errors

section('config and errors');

/** Writes a config and returns what plan.mjs says about it. */
function configSays(config, argv = ['--print-config']) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'figma-rename-cfg-'));
  fs.mkdirSync(path.join(dir, 'rename'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'rename.config.json'), JSON.stringify(config));
  fs.writeFileSync(
    path.join(dir, 'rename/inventory.json'),
    JSON.stringify({ entries: [{ kind: 'variable', id: 'V1', name: 'x/a', scope: 'S', resolvedType: 'COLOR', value: { r: 0, g: 0, b: 1, a: 1 } }] }),
  );
  const result = run('plan.mjs', argv, dir);
  fs.rmSync(dir, { recursive: true, force: true });
  return result;
}

test('a string where transform wants an array is refused, not silently ignored', () => {
  // `for (const p of "palette")` iterates characters and does nothing at all.
  const result = configSays({ figma: { fileKey: 'K' }, convention: { transform: { stripPrefix: 'palette' } } });
  assert.equal(result.ok, false);
  assert.match(result.out, /stripPrefix must be an ARRAY/);
});

test('an object where transform.replace wants an array names the key', () => {
  const result = configSays({ figma: { fileKey: 'K' }, convention: { transform: { replace: { find: 'a', with: 'b' } } } });
  assert.equal(result.ok, false);
  assert.match(result.out, /replace must be an ARRAY/);
});

test('a misplaced key inside transform points at where it belongs', () => {
  const result = configSays({ figma: { fileKey: 'K' }, convention: { transform: { segmentCase: 'kebab' } } });
  assert.equal(result.ok, false);
  assert.match(result.out, /convention\.segmentCase/);
});

test('an unknown setting is refused with the list of real ones', () => {
  const result = configSays({ figma: { fileKey: 'K' }, conventions: { segmentCase: 'kebab' } });
  assert.equal(result.ok, false);
  assert.match(result.out, /`conventions` is not a setting/);
  assert.match(result.out, /convention/);
});

test('a setting in the wrong block is refused', () => {
  // sizeNaming belongs inside `convention`; at the top level it did nothing.
  const result = configSays({ figma: { fileKey: 'K' }, sizeNaming: 'numeric' });
  assert.equal(result.ok, false);
  assert.match(result.out, /`sizeNaming` is not a setting/);
});

test('sizeNaming and colorGroup are validated', () => {
  assert.match(configSays({ figma: { fileKey: 'K' }, convention: { sizeNaming: 'Numeric' } }).out, /must be "semantic" or "numeric"/);
  assert.match(configSays({ figma: { fileKey: 'K' }, convention: { colorGroup: 'my colors' } }).out, /not usable as a name segment/);
});

test('extends must be a string, and says what a string looks like', () => {
  const result = configSays({ extends: ['aurora'], figma: { fileKey: 'K' } });
  assert.equal(result.ok, false);
  assert.match(result.out, /`extends` must be a string/);
  assert.match(result.out, /aurora/);
});

test('a broken rule names the file it lives in, not just an index', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'figma-rename-src-'));
  fs.mkdirSync(path.join(dir, 'rename'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'rename.config.json'), JSON.stringify({ extends: './team.json', figma: { fileKey: 'K' } }));
  fs.writeFileSync(
    path.join(dir, 'team.json'),
    JSON.stringify({ convention: { segmentCase: 'kebab', rules: [{ match: 'a/*', to: 'b/$1' }, { match: 'c/x', to: 'd/$2' }] } }),
  );
  fs.writeFileSync(path.join(dir, 'rename/inventory.json'), JSON.stringify({ entries: [{ kind: 'variable', id: 'V1', name: 'a/x', scope: 'S' }] }));
  const result = run('plan.mjs', [], dir);
  assert.equal(result.ok, false);
  assert.match(result.out, /team\.json convention\.rules\[1\]/, result.out);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a mistyped flag is refused before anything is written', () => {
  // --dryrun used to parse into an ignored key, and plan WROTE THE MAP while
  // the user believed they were previewing.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'figma-rename-flag-'));
  fs.mkdirSync(path.join(dir, 'rename'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'rename.config.json'), JSON.stringify({ figma: { fileKey: 'K' }, kinds: ['variable'], convention: { segmentCase: 'kebab' } }));
  fs.writeFileSync(
    path.join(dir, 'rename/inventory.json'),
    JSON.stringify({ entries: [{ kind: 'variable', id: 'V1', name: 'Color 1', scope: 'S', resolvedType: 'COLOR', value: { r: 0.2, g: 0.5, b: 0.9, a: 1 } }] }),
  );
  const result = run('plan.mjs', ['--dryrun'], dir);
  assert.equal(result.ok, false);
  assert.match(result.out, /Unknown flag --dryrun/);
  assert.match(result.out, /Did you mean --dry-run/);
  assert.equal(fs.existsSync(path.join(dir, 'rename/rename-map.json')), false, 'nothing may be written on a bad flag');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a flag that needs a value fails instead of reaching Node', () => {
  const result = configSays({ figma: { fileKey: 'K' } }, ['--config']);
  assert.equal(result.ok, false);
  assert.match(result.out, /--config needs a value/);
});

test('--min-confidence and --kind are validated with a suggestion', () => {
  const conf = configSays({ figma: { fileKey: 'K' }, kinds: ['variable'] }, ['--min-confidence', 'hgh']);
  assert.equal(conf.ok, false);
  assert.match(conf.out, /is not a level/);
  const kind = configSays({ figma: { fileKey: 'K' } }, ['--kind', 'component-set']);
  assert.equal(kind.ok, false);
  assert.match(kind.out, /is not a kind/);
  assert.match(kind.out, /componentSet/);
});

// ------------------------------------------------------------ plan integrity

section('plan integrity');

/** A project whose config the caller shapes. */
function planProject(convention, entries, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'figma-rename-plan-'));
  fs.mkdirSync(path.join(dir, 'rename'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'rename.config.json'),
    JSON.stringify({ figma: { fileKey: 'K' }, kinds: ['variable'], convention, ...extra }),
  );
  fs.writeFileSync(path.join(dir, 'rename/inventory.json'), JSON.stringify({ entries }));
  return {
    dir,
    readMap: () => JSON.parse(fs.readFileSync(path.join(dir, 'rename/rename-map.json'), 'utf8')),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

const colourEntry = (id, name, scope = 'S') => ({
  kind: 'variable', id, name, scope, resolvedType: 'COLOR', value: { r: 0.2, g: 0.5, b: 0.9, a: 1 },
});

test('convention.ignore is not overridden by a value-based suggestion', () => {
  // The bug: only `renamed` blocked a suggestion, so a generic leaf inside an
  // ignored group got planned and renamed — the opposite of what ignore means.
  const p = planProject(
    { segmentCase: 'kebab', ignore: ['_wip/**'] },
    [colourEntry('V1', '_wip/Color 3')],
  );
  const result = run('plan.mjs', [], p.dir);
  assert.equal(result.ok, true, result.out);
  const rows = p.readMap().batches.flatMap((b) => b.renames);
  assert.equal(rows.length, 0, `ignore means out of scope entirely; got ${JSON.stringify(rows)}`);
  assert.equal(p.readMap().needsReview.length, 0, 'nor should it become an open question');
  assert.match(result.out, /ignored {5}1/);
  p.cleanup();
});

test('convention.conforming is not overridden by a value-based suggestion', () => {
  const p = planProject(
    { segmentCase: 'kebab', conforming: ['palette/**'] },
    [colourEntry('V1', 'palette/Color 3')],
  );
  const result = run('plan.mjs', [], p.dir);
  assert.equal(result.ok, true, result.out);
  const rows = p.readMap().batches.flatMap((b) => b.renames);
  assert.equal(rows.length, 0, `conforming means hands off; got ${JSON.stringify(rows)}`);
  assert.match(result.out, /conforming {2}1/);
  p.cleanup();
});

test('--only scopes the suggestions, but shade ladders still learn from the whole file', () => {
  // Calibration must read every ramp or `--only` would produce different shade
  // names than a full run; the RESULTS are what gets scoped.
  const ramp = ['010', '100', '300', '500', '700', '900'].map((shade, i) =>
    colourEntry(`R${i}`, `palette/red/${shade}`, 'Primitive'),
  );
  ramp[0].value = { r: 1, g: 0.97, b: 0.97, a: 1 };
  ramp[1].value = { r: 1, g: 0.82, b: 0.82, a: 1 };
  ramp[2].value = { r: 0.99, g: 0.65, b: 0.65, a: 1 };
  ramp[3].value = { r: 0.94, g: 0.27, b: 0.27, a: 1 };
  ramp[4].value = { r: 0.73, g: 0.11, b: 0.11, a: 1 };
  ramp[5].value = { r: 0.5, g: 0.11, b: 0.11, a: 1 };
  const p = planProject({ segmentCase: 'kebab' }, [...ramp, colourEntry('X1', 'Color 9', 'Other')]);
  const result = run('plan.mjs', ['--only', 'Color*'], p.dir);
  assert.equal(result.ok, true, result.out);
  assert.match(result.out, /learned from \d+ shade\(s\) in this file/, 'calibration must still see the ramp');
  const rows = p.readMap().batches.flatMap((b) => b.renames);
  assert.ok(rows.every((r) => r.id === 'X1'), `only the scoped entry may be planned; got ${JSON.stringify(rows.map((r) => r.id))}`);
  p.cleanup();
});

test('an out-of-scope duplicate does not land in needsReview', () => {
  const p = planProject({ segmentCase: 'kebab' }, [
    colourEntry('A1', 'Color 1', 'Wanted'),
    // Same value twice in a collection the user did not ask about.
    colourEntry('B1', 'Other 1', 'Ignored'),
    colourEntry('B2', 'Other 2', 'Ignored'),
  ]);
  const result = run('plan.mjs', ['--only', 'Color*'], p.dir);
  assert.equal(result.ok, true, result.out);
  const ids = p.readMap().needsReview.map((i) => i.id);
  assert.equal(ids.includes('B1'), false, `out-of-scope items must not be raised; got ${JSON.stringify(ids)}`);
  p.cleanup();
});

test('the plan reports what the file itself looks like', () => {
  const p = planProject({ segmentCase: 'kebab' }, [
    colourEntry('V1', 'colorTextPrimary'),
    colourEntry('V2', 'colorTextSecondary'),
  ]);
  const result = run('plan.mjs', ['--dry-run'], p.dir);
  assert.match(result.out, /the file itself: 2 name\(s\)/);
  assert.match(result.out, /camelCase/);
  p.cleanup();
});

test('segmentCase "preserve" actually preserves', () => {
  assert.equal(caseSegment('Text Primary', 'preserve'), 'Text Primary');
  assert.equal(caseSegment('Text Primary', 'kebab'), 'text-primary');
});

test('two scopes that slug alike get distinct batch ids and a warning', () => {
  const p = planProject({ segmentCase: 'kebab', rules: [{ match: 'x/**', to: 'y/$1' }] }, [
    colourEntry('V1', 'x/a', '1. Primitive'),
    colourEntry('V2', 'x/b', '1 Primitive'),
  ]);
  const result = run('plan.mjs', [], p.dir);
  assert.equal(result.ok, true, result.out);
  assert.match(result.out, /slug to the batch id/);
  const ids = p.readMap().batches.map((b) => b.id);
  assert.equal(new Set(ids).size, ids.length, `ids must be unique; got ${JSON.stringify(ids)}`);
  p.cleanup();
});

// ---------------------------------------------------------- batch lifecycle

section('batch lifecycle');

/** A two-batch project, the shape every multi-batch defect needed. */
function lifecycleProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'figma-rename-life-'));
  fs.mkdirSync(path.join(dir, 'rename'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'rename.config.json'),
    JSON.stringify({
      figma: { fileKey: 'K' },
      kinds: ['variable'],
      convention: {
        segmentCase: 'kebab',
        rules: [
          { match: 'color/text-*', to: 'text/$1/default' },
          { match: 'color/bg-*', to: 'surface/$1' },
        ],
      },
      code: { roots: ['.'], include: ['**/*.css'], exclude: [], generated: [] },
    }),
  );
  const writeInventory = (names) =>
    fs.writeFileSync(
      path.join(dir, 'rename/inventory.json'),
      JSON.stringify({
        entries: [
          { kind: 'variable', id: 'V1', name: names.v1, scope: 'S1', resolvedType: 'COLOR', value: { r: 0, g: 0, b: 0, a: 1 } },
          { kind: 'variable', id: 'V2', name: names.v2, scope: 'S2', resolvedType: 'COLOR', value: { r: 1, g: 1, b: 1, a: 1 } },
        ],
      }),
    );
  writeInventory({ v1: 'color/text-primary', v2: 'color/bg-raised' });
  fs.writeFileSync(path.join(dir, 'src/a.css'), '.a{color:var(--color-text-primary);background:var(--color-bg-raised)}\n');
  const readMap = () => JSON.parse(fs.readFileSync(path.join(dir, 'rename/rename-map.json'), 'utf8'));
  return { dir, readMap, writeInventory, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('check --code can run for a namespace the generator special-cases', () => {
  // Renaming colors/** is one of the most ordinary things anyone will do, and
  // it made `check --code` — the command whose entire job is to run BEFORE
  // anything is touched — impossible to run: AppColors maps to two new class
  // names at once. apply-code always had the escape hatch; check did not.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'figma-rename-amb-'));
  fs.mkdirSync(path.join(dir, 'rename'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'rename.config.json'),
    JSON.stringify({
      figma: { fileKey: 'K' },
      kinds: ['variable'],
      convention: { segmentCase: 'kebab', rules: [{ match: 'colors/**', to: 'palette/$1' }] },
      code: { roots: ['.'], include: ['**/*.css'], exclude: [], generated: [], flutterPrefix: 'App' },
    }),
  );
  fs.writeFileSync(
    path.join(dir, 'rename/inventory.json'),
    JSON.stringify({
      entries: [{ kind: 'variable', id: 'V1', name: 'colors/red/500', scope: 'S', resolvedType: 'COLOR', value: { r: 1, g: 0, b: 0, a: 1 } }],
    }),
  );
  fs.writeFileSync(path.join(dir, 'src/a.css'), '.a{color:var(--colors-red-500)}\n');
  run('plan.mjs', [], dir);

  const blocked = run('check.mjs', ['--code'], dir);
  assert.equal(blocked.ok, false, 'the ambiguity is real and must still be refused by default');
  assert.match(blocked.out, /Ambiguous rewrite/);
  // and the refusal has to name the way out, or it is a dead end
  assert.match(blocked.out, /--no-namespace-classes/);

  const allowed = run('check.mjs', ['--code', '--no-namespace-classes'], dir);
  assert.equal(allowed.ok, true, allowed.out);
  assert.match(allowed.out, /namespace-class rewrites skipped/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a rename that DOES change a code spelling is never called regrouping-only', () => {
  // The first version of the regrouping report compared a pair's `from` (a code
  // spelling, `--colors-red-500`) against the rename's `from` (a Figma name,
  // `colors/red/500`). Two different alphabets, so nothing ever matched and
  // every rename was reported as changing no code — while the rewrite happened
  // anyway. A reviewer reading "no code changes" would have approved blind.
  const p = lifecycleProject();
  run('plan.mjs', [], p.dir);
  run('review.mjs', ['accept', '--batch', 'variable-s1', '--all'], p.dir);
  run('review.mjs', ['mark', 'variable-s1', '--figma-applied'], p.dir);
  const result = run('apply-code.mjs', ['--batch', 'variable-s1'], p.dir);
  assert.equal(result.ok, true, result.out);
  assert.match(result.out, /would rewrite [1-9]/);
  assert.doesNotMatch(result.out, /regrouping only/);
  p.cleanup();
});

test('plan says when every naming decision was inherited, not chosen', () => {
  // Reported from a real run: the skill renamed 20 components without ever
  // asking what the names should look like. A config that extends a preset and
  // overrides nothing is the fingerprint of that run — the output still reads
  // as decided, which is exactly what makes it hard to catch by eye.
  const inherited = projectExtending('aurora', {});
  const bare = run('plan.mjs', [], inherited);
  assert.equal(bare.ok, true, bare.out);
  assert.match(bare.out, /came from "aurora"/);
  assert.match(bare.out, /case per segment/);
  fs.rmSync(inherited, { recursive: true, force: true });

  // One deliberate format decision is enough to mean someone looked.
  const chosen = projectExtending('aurora', { convention: { segmentCase: 'kebab' } });
  const quiet = run('plan.mjs', [], chosen);
  assert.equal(quiet.ok, true, quiet.out);
  assert.doesNotMatch(quiet.out, /overrode none of them/);
  fs.rmSync(chosen, { recursive: true, force: true });
});

test('a project with no Figma behind it can still rename to the standard', () => {
  // Some projects hand-write their tokens — insureplus-frontend has 531 CSS
  // custom properties and nothing upstream. The naming standard still applies;
  // only the transport differs. One gate stood in the way: apply-code waited
  // for a Figma leg that does not exist.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'figma-rename-codesrc-'));
  fs.mkdirSync(path.join(dir, 'rename'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'app'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'rename.config.json'),
    JSON.stringify({
      source: 'code',
      kinds: ['variable'],
      convention: { segmentCase: 'kebab', rules: [{ match: 'foreground/**', to: 'surface/$1' }] },
      code: {
        roots: ['.'], include: ['app/**'], exclude: [], generated: [],
        spellings: ['cssVar', 'tailwind'], cssPrefix: '',
      },
    }),
  );
  fs.writeFileSync(
    path.join(dir, 'rename/inventory.json'),
    JSON.stringify({
      entries: [{ kind: 'variable', id: 'css:foreground/base/action', name: 'foreground/base/action', scope: 'insure.css' }],
    }),
  );
  fs.writeFileSync(path.join(dir, 'app/insure.css'), ':root{--foreground-base-action:#123}\n');
  fs.writeFileSync(path.join(dir, 'app/x.tsx'), '<div className="bg-foreground-base-action" />\n');

  run('plan.mjs', [], dir);
  const map = JSON.parse(fs.readFileSync(path.join(dir, 'rename/rename-map.json'), 'utf8'));
  const batch = map.batches[0].id;
  run('review.mjs', ['accept', '--batch', batch, '--all'], dir);

  const applied = run('apply-code.mjs', ['--batch', batch, '--write'], dir);
  assert.equal(applied.ok, true, applied.out);
  assert.match(fs.readFileSync(path.join(dir, 'app/insure.css'), 'utf8'), /--surface-base-action/);
  assert.match(fs.readFileSync(path.join(dir, 'app/x.tsx'), 'utf8'), /bg-surface-base-action/);

  // and the Figma half says why it has nothing to do, rather than half-working
  const emitted = run('emit-figma.mjs', ['--batch', batch], dir);
  assert.equal(emitted.ok, false);
  assert.match(emitted.out, /no Figma file to emit to/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a figma-source project without a fileKey is refused, not half-run', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'figma-rename-nokey-'));
  fs.mkdirSync(path.join(dir, 'rename'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'rename.config.json'),
    JSON.stringify({ kinds: ['variable'], convention: { segmentCase: 'kebab' }, code: { roots: ['.'], include: ['**/*.css'], exclude: [], generated: [] } }),
  );
  fs.writeFileSync(path.join(dir, 'rename/inventory.json'), JSON.stringify({ entries: [] }));
  const result = run('plan.mjs', [], dir);
  assert.equal(result.ok, false);
  assert.match(result.out, /figma\.fileKey is required/);
  assert.match(result.out, /"source": "code"/, 'and it names the alternative');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a Tailwind utility class is a place a token name lives', () => {
  // Measured on a real project (insureplus-frontend): 531 tokens, 254 var()
  // references, and 1,242 references through Tailwind utility classes. Without
  // this spelling a rename rewrites the definitions and leaves every class name
  // pointing at a token that no longer exists — and an unknown Tailwind class
  // produces no style and no error, so the failure is silent and visual.
  const rename = { from: 'foreground/base/action', to: 'surface/base/action', kind: 'variable' };
  const pairs = spellingsFor(rename, { spellings: ['cssVar', 'kebab', 'tailwind'], cssPrefix: '' });
  const replacer = buildReplacer(pairs);

  const rewrites = (src) => rewrite(src, replacer).total > 0;
  // reached through a colour utility, with or without variants
  assert.ok(rewrites('className="bg-foreground-base-action"'));
  assert.ok(rewrites('className="hover:bg-foreground-base-action"'));
  assert.ok(rewrites('className="data-[state=on]:text-foreground-base-action"'));
  assert.ok(rewrites("cn('border-foreground-base-action', x)"));
  // a different token that merely starts the same way
  assert.equal(rewrites('className="bg-foreground-base-action-hover"'), false);
  // a utility that is not a colour utility, and a word that merely contains it
  assert.equal(rewrites('className="my-foreground-base-action"'), false);
  assert.equal(rewrites('const myforeground-base-action = 1'), false);
  // the CSS side still works, from the same replacer
  assert.ok(rewrites('  --foreground-base-action: #123;'));
});

test('one name can carry more than one guard', () => {
  // cssVar and tailwind derive the same text with different guards. The
  // replacer keyed only on the text, so the second guard was dropped without a
  // word and the run reported a clean rewrite having touched half the sites.
  const pairs = spellingsFor(
    { from: 'a/b', to: 'c/d', kind: 'variable' },
    { spellings: ['kebab', 'tailwind'], cssPrefix: '' },
  );
  assert.equal(pairs.length, 2, 'both spellings are produced');
  assert.equal(pairs[0].from, pairs[1].from, 'and they share the text');
  const replacer = buildReplacer(pairs);
  assert.equal(replacer.pairs.length, 2, 'so both must survive into the regex');
});

test('every CLI answers --help without a config, and exits 0', () => {
  // --help was in the accepted-flag list and did nothing: it fell through to
  // config loading, so asking for help returned "rename.config.json not found".
  // It also forced the manual to carry every flag list itself, at a token cost
  // paid on every run rather than only when someone asks.
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'figma-rename-help-'));
  for (const cli of ['plan.mjs', 'review.mjs', 'check.mjs', 'emit-figma.mjs', 'apply-code.mjs']) {
    const result = run(cli, ['--help'], empty);
    assert.equal(result.ok, true, `${cli} --help should exit 0, got: ${result.out}`);
    assert.doesNotMatch(result.out, /not found|Could not read/, `${cli} --help must not need a config`);
    assert.match(result.out, /--config/, `${cli} --help should list its flags`);
  }
  fs.rmSync(empty, { recursive: true, force: true });
});

test('check says so when the project is not in git', () => {
  // The rollback story is "one batch, one commit, git revert" — stated in the
  // manual, the README and SKILL.md — and nothing verified the precondition.
  // A real run applied 20 renames to a shared Figma file from a plain folder.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'figma-rename-nogit-'));
  fs.mkdirSync(path.join(dir, 'rename'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'rename.config.json'),
    JSON.stringify({
      figma: { fileKey: 'K' },
      kinds: ['variable'],
      convention: { segmentCase: 'kebab', rules: [{ match: 'colors/**', to: 'palette/$1' }] },
      code: { roots: ['.'], include: ['**/*.css'], exclude: [], generated: [] },
    }),
  );
  fs.writeFileSync(
    path.join(dir, 'rename/inventory.json'),
    JSON.stringify({ entries: [{ kind: 'variable', id: 'V1', name: 'colors/red/500', scope: 'S', resolvedType: 'COLOR' }] }),
  );
  fs.writeFileSync(path.join(dir, 'src/a.css'), '.a{color:var(--colors-red-500)}\n');
  run('plan.mjs', [], dir);

  const loose = run('check.mjs', [], dir);
  assert.equal(loose.ok, true, 'it is a warning, not a refusal — the work is still legitimate');
  assert.match(loose.out, /not in a git repository/);

  // os.tmpdir() is not inside a work tree, so a .git here is the only signal.
  fs.mkdirSync(path.join(dir, '.git'));
  const versioned = run('check.mjs', [], dir);
  assert.equal(versioned.ok, true, versioned.out);
  assert.doesNotMatch(versioned.out, /not in a git repository/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a component named only by the classifier does not crash the plan', () => {
  // `result.to` is null when the convention had no opinion and the name came
  // from the classifier — the normal path for a component. Building the code
  // suggestion off it crashed the whole run: on a real file, 1,222 entries
  // planned and one already-well-named component took the entire plan with it.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'figma-rename-shape-'));
  fs.mkdirSync(path.join(dir, 'rename'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'rename.config.json'),
    JSON.stringify({
      figma: { fileKey: 'K' },
      kinds: ['componentSet'],
      convention: { components: { segmentCase: 'pascal' } },
      code: { roots: ['.'], include: ['**/*.css'], exclude: [], generated: [] },
    }),
  );
  // "Avatar" is already pascal, so the convention leaves it alone (result.to is
  // null) while the classifier reads the shape and proposes something else.
  const signature = sig({
    width: 20, height: 20, cornerRadius: 9999, hasFill: true, hasSolidFill: true,
    childCount: 1, totalDescendants: 1, hasIcon: true, smallInstances: 1,
  });
  fs.writeFileSync(
    path.join(dir, 'rename/inventory.json'),
    JSON.stringify({
      entries: [{ kind: 'componentSet', id: '1:1', name: 'Avatar', scope: 'Avatar', pageId: '0:1', signature }],
    }),
  );
  const result = run('plan.mjs', [], dir);
  assert.equal(result.ok, true, result.out);
  const map = JSON.parse(fs.readFileSync(path.join(dir, 'rename/rename-map.json'), 'utf8'));
  const row = map.batches[0].renames[0];
  assert.equal(row.source, 'shape');
  // the code suggestion is built from the row's target, not from the convention
  // "Icon Button" -> "IconButton": the code symbol follows the row's target.
  assert.equal(row.codeSuggestion[0].to, row.to.replace(/[^A-Za-z0-9]/g, ''));
  assert.equal(row.codeSuggestion[0].from, 'Avatar');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('token-side rules written for a layer pass are called out, not ignored', () => {
  // layer/component/componentSet read convention.components.*, so a rule in
  // convention.rules never fires for them. The run still succeeds and the names
  // come back merely normalized — there is nothing in the output to suggest the
  // rule you wrote was skipped.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'figma-rename-layerrule-'));
  fs.mkdirSync(path.join(dir, 'rename'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'rename.config.json'),
    JSON.stringify({
      figma: { fileKey: 'K' },
      kinds: ['layer'],
      convention: { segmentCase: 'kebab', rules: [{ match: 'Ellipse 2', to: 'indicator' }] },
      code: { roots: ['.'], include: ['**/*.css'], exclude: [], generated: [] },
    }),
  );
  fs.writeFileSync(
    path.join(dir, 'rename/inventory.json'),
    JSON.stringify({
      entries: [{ kind: 'layer', id: '1:1', name: 'Ellipse 2', scope: 'Button', parentId: '1:0', type: 'ELLIPSE' }],
    }),
  );
  const result = run('plan.mjs', [], dir);
  assert.equal(result.ok, true, result.out);
  assert.match(result.out, /convention\.components/);
  assert.match(result.out, /do not apply/);

  // Moved to the right block, the rule fires and the warning goes away.
  fs.writeFileSync(
    path.join(dir, 'rename.config.json'),
    JSON.stringify({
      figma: { fileKey: 'K' },
      kinds: ['layer'],
      convention: { components: { segmentCase: 'kebab', rules: [{ match: 'Ellipse 2', to: 'indicator' }] } },
      code: { roots: ['.'], include: ['**/*.css'], exclude: [], generated: [] },
    }),
  );
  fs.rmSync(path.join(dir, 'rename/rename-map.json'), { force: true });
  const fixed = run('plan.mjs', [], dir);
  assert.equal(fixed.ok, true, fixed.out);
  assert.doesNotMatch(fixed.out, /do not apply/);
  const map = JSON.parse(fs.readFileSync(path.join(dir, 'rename/rename-map.json'), 'utf8'));
  assert.equal(map.batches[0].renames[0].to, 'indicator');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a file-level style batch is named for the file, not the kind twice', () => {
  // Styles have no collection to group by, and the old fallback spelled the
  // kind into the id a second time: `effectStyle-effectstyle`, which is the
  // string you then type into --batch on every command in the loop.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'figma-rename-style-'));
  fs.mkdirSync(path.join(dir, 'rename'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'rename.config.json'),
    JSON.stringify({
      figma: { fileKey: 'K' },
      kinds: ['effectStyle'],
      convention: { segmentCase: 'kebab', rules: [{ match: 'shadow/**', to: 'elevation/$1' }] },
      code: { roots: ['.'], include: ['**/*.css'], exclude: [], generated: [] },
    }),
  );
  // Exactly what the shipped capture script returns — no scope of its own.
  fs.writeFileSync(
    path.join(dir, 'rename/inventory.json'),
    JSON.stringify({
      entries: [{ kind: 'effectStyle', id: 'S:abc,', name: 'shadow/xs', remote: false }],
    }),
  );
  fs.writeFileSync(path.join(dir, 'src/a.css'), '.c{box-shadow:var(--shadow-xs)}\n');
  const result = run('plan.mjs', [], dir);
  assert.equal(result.ok, true, result.out);
  const map = JSON.parse(fs.readFileSync(path.join(dir, 'rename/rename-map.json'), 'utf8'));
  assert.equal(map.batches[0].id, 'effectStyle-file');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a rename that only regroups segments says so instead of reporting zero', () => {
  // Found on TestDSDS: font-family/heading -> font/family/heading. Every code
  // spelling flattens "/" and "-" identically, so the identifier does not move
  // and there is genuinely nothing to rewrite. Reporting a bare "0 occurrences"
  // reads as a broken scan — I misread it that way myself before tracing it.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'figma-rename-inert-'));
  fs.mkdirSync(path.join(dir, 'rename'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'rename.config.json'),
    JSON.stringify({
      figma: { fileKey: 'K' },
      kinds: ['variable'],
      convention: { segmentCase: 'kebab', rules: [{ match: 'font-family/**', to: 'font/family/$1' }] },
      code: { roots: ['.'], include: ['**/*.css'], exclude: [], generated: [] },
    }),
  );
  fs.writeFileSync(
    path.join(dir, 'rename/inventory.json'),
    JSON.stringify({
      entries: [{ kind: 'variable', id: 'V1', name: 'font-family/heading', scope: 'S', resolvedType: 'STRING' }],
    }),
  );
  fs.writeFileSync(path.join(dir, 'src/a.css'), ':root{font-family:var(--font-family-heading)}\n');

  run('plan.mjs', [], dir);
  run('review.mjs', ['accept', '--batch', 'variable-s', '--all'], dir);
  const map = JSON.parse(fs.readFileSync(path.join(dir, 'rename/rename-map.json'), 'utf8'));
  const batchId = map.batches[0].id;
  run('review.mjs', ['accept', '--batch', batchId, '--all'], dir);
  run('review.mjs', ['mark', batchId, '--figma-applied'], dir);

  const result = run('apply-code.mjs', ['--batch', batchId], dir);
  assert.equal(result.ok, true, result.out);
  assert.match(result.out, /regrouping only/);
  assert.match(result.out, /font-family\/heading {2}-> {2}font\/family\/heading/);
  // And it must not ALSO be reported as a spelling that matched nothing.
  assert.doesNotMatch(result.out, /matched nothing/);
  // The CSS variable keeps its name, so the file is untouched either way.
  assert.match(fs.readFileSync(path.join(dir, 'src/a.css'), 'utf8'), /--font-family-heading/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('plan marks every new row pending', () => {
  const p = lifecycleProject();
  assert.equal(run('plan.mjs', [], p.dir).ok, true);
  const rows = p.readMap().batches.flatMap((b) => b.renames);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.decision === 'pending'), JSON.stringify(rows));
  p.cleanup();
});

test('emit-figma refuses a batch with undecided rows', () => {
  const p = lifecycleProject();
  run('plan.mjs', [], p.dir);
  const result = run('emit-figma.mjs', ['--batch', 'variable-s1'], p.dir);
  assert.equal(result.ok, false);
  assert.match(result.out, /undecided/);
  assert.match(result.out, /review\.mjs accept/);
  p.cleanup();
});

test('apply-code --write refuses a batch Figma has not applied', () => {
  const p = lifecycleProject();
  run('plan.mjs', [], p.dir);
  run('review.mjs', ['accept', '--batch', 'variable-s1', '--all'], p.dir);
  const result = run('apply-code.mjs', ['--batch', 'variable-s1', '--write'], p.dir);
  assert.equal(result.ok, false);
  assert.match(result.out, /has not been renamed in Figma yet/);
  assert.equal(fs.readFileSync(path.join(p.dir, 'src/a.css'), 'utf8').includes('--text-primary-default'), false);
  p.cleanup();
});

test('emit-figma refuses a second batch while one is in flight', () => {
  const p = lifecycleProject();
  run('plan.mjs', [], p.dir);
  run('review.mjs', ['accept', '--batch', 'variable-s1', '--all'], p.dir);
  run('review.mjs', ['accept', '--batch', 'variable-s2', '--all'], p.dir);
  run('review.mjs', ['mark', 'variable-s1', '--figma-applied'], p.dir);
  const blocked = run('emit-figma.mjs', ['--batch', 'variable-s2'], p.dir);
  assert.equal(blocked.ok, false);
  assert.match(blocked.out, /already applied in Figma but not in code/);
  // --force is the documented escape, and it must actually work.
  assert.equal(run('emit-figma.mjs', ['--batch', 'variable-s2', '--force'], p.dir).ok, true);
  p.cleanup();
});

test('mark refuses to skip a step', () => {
  const p = lifecycleProject();
  run('plan.mjs', [], p.dir);
  run('review.mjs', ['accept', '--batch', 'variable-s1', '--all'], p.dir);
  const jump = run('review.mjs', ['mark', 'variable-s1', '--applied'], p.dir);
  assert.equal(jump.ok, false);
  assert.match(jump.out, /one step at a time/);
  p.cleanup();
});

test('mark --figma-applied refuses undecided rows', () => {
  const p = lifecycleProject();
  run('plan.mjs', [], p.dir);
  const result = run('review.mjs', ['mark', 'variable-s1', '--figma-applied'], p.dir);
  assert.equal(result.ok, false);
  assert.match(result.out, /undecided/);
  p.cleanup();
});

test('check --after with no --batch ignores batches that have not gone out', () => {
  // The defect: after applying batch 1 of 2, batch 2's old names are still in
  // code (correctly), and a bare `check --after` reported them as stale.
  const p = lifecycleProject();
  run('plan.mjs', [], p.dir);
  run('review.mjs', ['accept', '--batch', 'variable-s1', '--all'], p.dir);
  run('review.mjs', ['accept', '--batch', 'variable-s2', '--all'], p.dir);
  run('review.mjs', ['mark', 'variable-s1', '--figma-applied'], p.dir);
  run('apply-code.mjs', ['--batch', 'variable-s1', '--write'], p.dir);
  const result = run('check.mjs', ['--after'], p.dir);
  assert.equal(result.ok, true, result.out);
  const css = fs.readFileSync(path.join(p.dir, 'src/a.css'), 'utf8');
  assert.match(css, /--text-primary-default/, 'batch 1 rewritten');
  assert.match(css, /--color-bg-raised/, 'batch 2 deliberately untouched');
  p.cleanup();
});

test('check --after says so when nothing has been applied', () => {
  const p = lifecycleProject();
  run('plan.mjs', [], p.dir);
  const result = run('check.mjs', ['--after'], p.dir);
  assert.equal(result.ok, true, result.out);
  assert.match(result.out, /nothing has been applied/);
  p.cleanup();
});

test('check passes on a re-captured inventory with an applied batch', () => {
  // The other half of the same defect: the manual says re-capture before every
  // planning pass, and doing so used to hard-error on work already finished.
  const p = lifecycleProject();
  run('plan.mjs', [], p.dir);
  run('review.mjs', ['accept', '--batch', 'variable-s1', '--all'], p.dir);
  run('review.mjs', ['accept', '--batch', 'variable-s2', '--all'], p.dir);
  run('review.mjs', ['mark', 'variable-s1', '--figma-applied'], p.dir);
  p.writeInventory({ v1: 'text/primary/default', v2: 'color/bg-raised' });
  const result = run('check.mjs', [], p.dir);
  assert.equal(result.ok, true, result.out);
  p.cleanup();
});

test('check warns when an applied name was renamed again in Figma', () => {
  const p = lifecycleProject();
  run('plan.mjs', [], p.dir);
  run('review.mjs', ['accept', '--batch', 'variable-s1', '--all'], p.dir);
  run('review.mjs', ['accept', '--batch', 'variable-s2', '--all'], p.dir);
  run('review.mjs', ['mark', 'variable-s1', '--figma-applied'], p.dir);
  p.writeInventory({ v1: 'someone/renamed/it', v2: 'color/bg-raised' });
  const result = run('check.mjs', [], p.dir);
  assert.equal(result.ok, true, result.out);
  assert.match(result.out, /renamed again outside this tool/);
  p.cleanup();
});

test('re-plan freezes an applied batch and keeps its id', () => {
  const p = lifecycleProject();
  run('plan.mjs', [], p.dir);
  run('review.mjs', ['accept', '--batch', 'variable-s1', '--all'], p.dir);
  run('review.mjs', ['mark', 'variable-s1', '--figma-applied'], p.dir);
  p.writeInventory({ v1: 'text/primary/default', v2: 'color/bg-raised' });
  const result = run('plan.mjs', [], p.dir);
  assert.equal(result.ok, true, result.out);
  assert.match(result.out, /1 applied batch\(es\) frozen/);
  const frozen = p.readMap().batches.find((b) => b.id === 'variable-s1');
  assert.equal(frozen.status, 'figma-applied');
  assert.equal(frozen.renames[0].from, 'color/text-primary', 'the old name must survive for rollback');
  p.cleanup();
});

test('emit-figma --reverse still resolves an applied batch after a re-plan', () => {
  const p = lifecycleProject();
  run('plan.mjs', [], p.dir);
  run('review.mjs', ['accept', '--batch', 'variable-s1', '--all'], p.dir);
  run('review.mjs', ['mark', 'variable-s1', '--figma-applied'], p.dir);
  p.writeInventory({ v1: 'text/primary/default', v2: 'color/bg-raised' });
  run('plan.mjs', [], p.dir);
  run('plan.mjs', [], p.dir);
  const result = run('emit-figma.mjs', ['--batch', 'variable-s1', '--reverse'], p.dir);
  assert.equal(result.ok, true, result.out);
  assert.match(result.out, /"V1", "text\/primary\/default", "color\/text-primary"/);
  p.cleanup();
});

test('re-plan does not resurrect a rejected rename', () => {
  const p = lifecycleProject();
  run('plan.mjs', [], p.dir);
  run('review.mjs', ['reject', '--batch', 'variable-s2', '--all', '--note', 'keep it'], p.dir);
  const result = run('plan.mjs', [], p.dir);
  assert.match(result.out, /1 rejection\(s\) kept/);
  const row = p.readMap().batches.find((b) => b.id === 'variable-s2').renames[0];
  assert.equal(row.decision, 'rejected');
  assert.equal(row.note, 'keep it');
  p.cleanup();
});

test('re-plan preserves a hand-edited target', () => {
  const p = lifecycleProject();
  run('plan.mjs', [], p.dir);
  run('review.mjs', ['set-to', 'V1', '--to', 'text/brand/default'], p.dir);
  const result = run('plan.mjs', [], p.dir);
  assert.match(result.out, /1 decision\(s\) carried/);
  const row = p.readMap().batches.flatMap((b) => b.renames).find((r) => r.id === 'V1');
  assert.equal(row.to, 'text/brand/default');
  assert.equal(row.decision, 'accepted');
  assert.equal(row.source, 'human');
  p.cleanup();
});

test('re-plan resets a decision when the convention changes the target', () => {
  const p = lifecycleProject();
  run('plan.mjs', [], p.dir);
  run('review.mjs', ['accept', '--batch', 'variable-s2', '--all'], p.dir);
  // The team changes the standard: bg-* now lands somewhere else.
  const cfg = JSON.parse(fs.readFileSync(path.join(p.dir, 'rename.config.json'), 'utf8'));
  cfg.convention.rules[1].to = 'background/$1';
  fs.writeFileSync(path.join(p.dir, 'rename.config.json'), JSON.stringify(cfg));
  const result = run('plan.mjs', [], p.dir);
  assert.match(result.out, /1 reset \(target changed\)/);
  const row = p.readMap().batches.flatMap((b) => b.renames).find((r) => r.id === 'V2');
  assert.equal(row.decision, 'pending', 'a verdict on one name must not carry to another');
  assert.match(row.note, /target changed/);
  p.cleanup();
});

test('check refuses a map planned under a different convention', () => {
  const p = lifecycleProject();
  run('plan.mjs', [], p.dir);
  run('review.mjs', ['accept', '--batch', 'variable-s1', '--all'], p.dir);
  const cfg = JSON.parse(fs.readFileSync(path.join(p.dir, 'rename.config.json'), 'utf8'));
  cfg.convention.segmentCase = 'snake';
  fs.writeFileSync(path.join(p.dir, 'rename.config.json'), JSON.stringify(cfg));
  const result = run('check.mjs', [], p.dir);
  assert.equal(result.ok, false);
  assert.match(result.out, /planned under a different convention/);
  assert.equal(run('check.mjs', ['--allow-convention-drift'], p.dir).ok, true, 'the escape hatch must work');
  p.cleanup();
});

test('rejected rows are invisible to emit, apply-code and check --after', () => {
  const p = lifecycleProject();
  run('plan.mjs', [], p.dir);
  run('review.mjs', ['accept', '--batch', 'variable-s1', '--all'], p.dir);
  run('review.mjs', ['reject', '--batch', 'variable-s2', '--all'], p.dir);
  run('review.mjs', ['mark', 'variable-s1', '--figma-applied'], p.dir);
  const emitted = run('emit-figma.mjs', ['--batch', 'variable-s1'], p.dir);
  assert.equal(emitted.out.includes('color/bg-raised'), false, 'a rejected row must not be emitted');
  run('apply-code.mjs', ['--write'], p.dir);
  const css = fs.readFileSync(path.join(p.dir, 'src/a.css'), 'utf8');
  assert.match(css, /--color-bg-raised/, 'a rejected rename must not touch code');
  assert.equal(run('check.mjs', ['--after'], p.dir).ok, true);
  p.cleanup();
});

test('a batch with every row rejected cannot be marked applied', () => {
  const p = lifecycleProject();
  run('plan.mjs', [], p.dir);
  run('review.mjs', ['reject', '--batch', 'variable-s1', '--all'], p.dir);
  const result = run('review.mjs', ['mark', 'variable-s1', '--figma-applied'], p.dir);
  assert.equal(result.ok, false);
  assert.match(result.out, /nothing accepted/);
  p.cleanup();
});

test('check refuses one id renamed by two pending batches', () => {
  const p = lifecycleProject();
  run('plan.mjs', [], p.dir);
  const map = p.readMap();
  map.batches[1].renames.push({ ...map.batches[0].renames[0], decision: 'accepted' });
  fs.writeFileSync(path.join(p.dir, 'rename/rename-map.json'), JSON.stringify(map, null, 2));
  const result = run('check.mjs', [], p.dir);
  assert.equal(result.ok, false);
  assert.match(result.out, /renamed by both/);
  p.cleanup();
});

test('review list prints every row, and status names the open questions', () => {
  const p = lifecycleProject();
  run('plan.mjs', [], p.dir);
  const list = run('review.mjs', ['list', '--batch', 'variable-s1'], p.dir);
  assert.equal(list.ok, true, list.out);
  assert.match(list.out, /color\/text-primary {2}-> {2}text\/primary\/default/);
  assert.match(list.out, /id: V1/);
  const json = run('review.mjs', ['list', '--batch', 'variable-s1', '--json'], p.dir);
  assert.equal(JSON.parse(json.out).renames.length, 1);
  p.cleanup();
});

test('review accept --rule decides a whole group at once', () => {
  const p = lifecycleProject();
  run('plan.mjs', [], p.dir);
  const rule = p.readMap().batches[0].renames[0].rule;
  const result = run('review.mjs', ['accept', '--batch', 'variable-s1', '--rule', rule], p.dir);
  assert.equal(result.ok, true, result.out);
  assert.equal(p.readMap().batches[0].renames[0].decision, 'accepted');
  const missing = run('review.mjs', ['accept', '--batch', 'variable-s1', '--rule', 'nope'], p.dir);
  assert.equal(missing.ok, false);
  assert.match(missing.out, /Rules in this batch/);
  p.cleanup();
});

test('review refuses to decide on a batch that has already gone out', () => {
  const p = lifecycleProject();
  run('plan.mjs', [], p.dir);
  run('review.mjs', ['accept', '--batch', 'variable-s1', '--all'], p.dir);
  run('review.mjs', ['mark', 'variable-s1', '--figma-applied'], p.dir);
  const result = run('review.mjs', ['reject', '--batch', 'variable-s1', '--all'], p.dir);
  assert.equal(result.ok, false);
  assert.match(result.out, /already gone out/);
  p.cleanup();
});

test('a skipped needsReview item survives a re-plan', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'figma-rename-skip-'));
  fs.mkdirSync(path.join(dir, 'rename'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'rename.config.json'),
    JSON.stringify({
      figma: { fileKey: 'K' },
      kinds: ['variable'],
      convention: { segmentCase: 'kebab', structure: { minSegments: 2 } },
    }),
  );
  fs.writeFileSync(
    path.join(dir, 'rename/inventory.json'),
    JSON.stringify({ entries: [{ kind: 'variable', id: 'V9', name: 'brand', scope: 'S', resolvedType: 'COLOR', value: { r: 1, g: 0, b: 0, a: 1 } }] }),
  );
  run('plan.mjs', [], dir);
  const before = JSON.parse(fs.readFileSync(path.join(dir, 'rename/rename-map.json'), 'utf8'));
  assert.equal(before.needsReview.length, 1, JSON.stringify(before.needsReview));
  assert.equal(run('review.mjs', ['skip', 'V9', '--note', 'brand is fine'], dir).ok, true);
  const result = run('plan.mjs', [], dir);
  assert.match(result.out, /1 skip\(s\) preserved/);
  const after = JSON.parse(fs.readFileSync(path.join(dir, 'rename/rename-map.json'), 'utf8'));
  assert.equal(after.needsReview.filter((i) => (i.decision ?? 'pending') === 'pending').length, 0, 'must not be asked again');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('review resolve moves an open question into a batch as accepted', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'figma-rename-resolve-'));
  fs.mkdirSync(path.join(dir, 'rename'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'rename.config.json'),
    JSON.stringify({
      figma: { fileKey: 'K' },
      kinds: ['variable'],
      convention: { segmentCase: 'kebab', structure: { minSegments: 2 } },
    }),
  );
  fs.writeFileSync(
    path.join(dir, 'rename/inventory.json'),
    JSON.stringify({ entries: [{ kind: 'variable', id: 'V9', name: 'brand', scope: 'S', resolvedType: 'COLOR', value: { r: 1, g: 0, b: 0, a: 1 } }] }),
  );
  run('plan.mjs', [], dir);
  const result = run('review.mjs', ['resolve', 'V9', '--to', 'palette/brand'], dir);
  assert.equal(result.ok, true, result.out);
  const map = JSON.parse(fs.readFileSync(path.join(dir, 'rename/rename-map.json'), 'utf8'));
  assert.equal(map.needsReview.length, 0);
  const row = map.batches.flatMap((b) => b.renames).find((r) => r.id === 'V9');
  assert.equal(row.to, 'palette/brand');
  assert.equal(row.decision, 'accepted');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a v1 map is refused with an explanation, not upgraded silently', () => {
  const p = lifecycleProject();
  fs.writeFileSync(
    path.join(p.dir, 'rename/rename-map.json'),
    JSON.stringify({ version: 1, batches: [], needsReview: [] }),
  );
  const result = run('check.mjs', [], p.dir);
  assert.equal(result.ok, false);
  assert.match(result.out, /version 1/);
  assert.match(result.out, /delete it and run plan\.mjs again/);
  p.cleanup();
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
