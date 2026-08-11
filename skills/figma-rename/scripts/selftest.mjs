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
import { compileConvention, normalizeName, proposeName } from './lib/convention.mjs';
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

test('a namespace that moves whole produces the class pairs', () => {
  const { pairs, advisories } = namespaceClassPairs(
    [{ kind: 'variable', from: 'color/surface/raised', to: 'surface/raised' }],
    { flutterPrefix: 'App', allTokenNames: ['color/surface/raised'] },
  );
  assert.equal(advisories.length, 0);
  assert.equal(pairs.find((p) => p.from === 'AppColorColors').to, 'AppSurfaceColors');
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
  const shared = [...mine.keys()].filter((name) => theirs.has(name));
  assert.ok(shared.length >= 5, `expected to share several functions, found ${shared.length}`);
  for (const name of shared) {
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
  const result = run('emit-figma.mjs', ['--batch', 'variable-semantic', '--reverse'], tmp);
  assert.equal(result.ok, true, result.out);
  assert.match(result.out, /"VariableID:1:1", "text\/primary\/default", "color\/text-primary"/);
  assert.match(result.out, /reversed: true/);
});

test('emit-figma --with-code-syntax records the code name back into Figma', () => {
  const result = run('emit-figma.mjs', ['--batch', 'variable-semantic', '--with-code-syntax'], tmp);
  assert.equal(result.ok, true, result.out);
  assert.match(result.out, /var\(--text-primary-default\)/);
  assert.match(result.out, /setVariableCodeSyntax/);
  assertParses(result.out, 'the emitted code-syntax script');
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
        version: 1,
        fileKey: 'FILEKEY0000000000000000',
        batches: [
          {
            id: 'chain',
            kind: 'variable',
            scope: 'Semantic',
            renames: [
              { id: 'VariableID:1:1', from: 'color/text-primary', to: 'color/bg-raised' },
              { id: 'VariableID:1:2', from: 'color/bg-raised', to: 'text/primary/default' },
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

  const emitted = run('emit-figma.mjs', ['--batch', map.batches[0].id], dir);
  assert.equal(emitted.ok, true, emitted.out);
  assert.match(emitted.out, /setCurrentPageAsync/);
  assert.equal(emitted.out.match(/setCurrentPageAsync/g).length, 1, 'exactly one page switch per call');
  assert.match(emitted.out, /figma\.getNodeByIdAsync/);
  assertParses(emitted.out, 'the emitted node script');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('apply-code dry run changes nothing on disk', () => {
  const before = fs.readFileSync(path.join(tmp, 'src/app/button.css'), 'utf8');
  const result = run('apply-code.mjs', [], tmp);
  assert.equal(result.ok, true, result.out);
  assert.match(result.out, /would rewrite/);
  assert.equal(fs.readFileSync(path.join(tmp, 'src/app/button.css'), 'utf8'), before);
});

test('apply-code --write rewrites consumers and leaves generated files to the generator', () => {
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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
