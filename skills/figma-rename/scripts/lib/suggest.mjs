// Value-based name suggestion: what a variable IS, read off its value.
//
// This is the half of naming that does not need an LLM and should not use one.
// `{r:0.231, g:0.510, b:0.965}` is blue at 60% lightness — that is arithmetic,
// and arithmetic is right every time, runs on 700 variables instantly, and can
// state its reason. An agent eyeballing hex codes is slower and occasionally
// wrong, which is the worst combination for a bulk rename.
//
// What this module deliberately does NOT do is decide MEANING. It can tell you
// a colour is `red/500`; it cannot tell you whether that red is the brand or
// an error state. Those come back with no name and a reason, and a human (or
// an agent reading the codebase) answers them.
//
// The shade ladders are the part most likely to be wrong for a given file, so
// the built-in ones are a fallback: `calibrateShades()` learns the real
// lightness→shade mapping from ramps the file already has. Verified necessary:
// one production palette here numbers its ramp 010/025/050/075/100…925/975 and
// puts `500` at L=47%, where a Tailwind-shaped table puts 600/700.

// ---------------------------------------------------------------- colour maths

/** sRGB (0–1) to HSL. h 0–360, s 0–100, l 0–100. */
export function rgbToHsl(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const delta = max - min;
  if (delta === 0) return { h: 0, s: 0, l: l * 100 };

  const s = delta / (1 - Math.abs(2 * l - 1));
  let h;
  if (max === r) h = 60 * (((g - b) / delta) % 6);
  else if (max === g) h = 60 * ((b - r) / delta + 2);
  else h = 60 * ((r - g) / delta + 4);
  if (h < 0) h += 360;

  return { h, s: s * 100, l: l * 100 };
}

/**
 * Hue ranges. The last entry wraps back to red — without it every crimson
 * above 345° falls off the end of the table and gets the wrong name, which is
 * the single most visible way a colour namer looks broken.
 */
export const HUE_RANGES = [
  { min: 0, max: 15, name: 'red' },
  { min: 15, max: 40, name: 'orange' },
  { min: 40, max: 65, name: 'yellow' },
  { min: 65, max: 80, name: 'lime' },
  { min: 80, max: 160, name: 'green' },
  { min: 160, max: 185, name: 'teal' },
  { min: 185, max: 200, name: 'cyan' },
  { min: 200, max: 240, name: 'blue' },
  { min: 240, max: 260, name: 'indigo' },
  { min: 260, max: 280, name: 'violet' },
  { min: 280, max: 300, name: 'purple' },
  { min: 300, max: 320, name: 'magenta' },
  { min: 320, max: 345, name: 'pink' },
  { min: 345, max: 360, name: 'red' },
];

/** Hue name plus how close it sits to a boundary — near an edge, the name is a coin flip. */
export function hueName(h) {
  const hue = ((h % 360) + 360) % 360;
  for (const range of HUE_RANGES) {
    if (hue >= range.min && hue < range.max) {
      const margin = Math.min(hue - range.min, range.max - hue);
      return { name: range.name, margin };
    }
  }
  return { name: 'red', margin: 0 };
}

/**
 * Fallback lightness→shade ladders, as `[maxLightness, shade]` ascending.
 *
 * Calibrated against Tailwind and checked shade by shade: every one of
 * blue-50…blue-950 lands on its own name, and likewise gray-50…gray-950.
 * Neutrals need their own ladder — Tailwind's gray-900 sits at L=11% while
 * blue-900 sits at L=33%, so one shared table cannot name both correctly.
 */
export const SHADE_CHROMATIC = [
  [26, '950'], [36, '900'], [44, '800'], [50, '700'], [56, '600'],
  [64, '500'], [73, '400'], [82, '300'], [90, '200'], [95, '100'], [100, '50'],
];

export const SHADE_NEUTRAL = [
  [8, '950'], [14, '900'], [22, '800'], [30, '700'], [40, '600'],
  [55, '500'], [74, '400'], [88, '300'], [93, '200'], [97, '100'], [100, '50'],
];

export function shadeFor(l, ladder) {
  for (const [maxLightness, shade] of ladder) {
    if (l <= maxLightness) return shade;
  }
  return ladder[ladder.length - 1][1];
}

/** max−min of the sRGB channels. The honest measure of "how much colour is here". */
export function chromaOf(value) {
  return Math.max(value.r, value.g, value.b) - Math.min(value.r, value.g, value.b);
}

/**
 * Neutral, chromatic, or genuinely ambiguous.
 *
 * The spec's rule — HSL saturation < 10% means grey — does not survive contact
 * with a real design system, because almost every one of them tints its
 * neutrals. Tailwind's `gray-900` (#111827) reads as saturation 39%, and
 * `gray-950` as 72%, purely because HSL saturation blows up as lightness
 * approaches either end. Both are obviously greys.
 *
 * Chroma does not have that failure, and separates all eleven Tailwind greys
 * from all eleven blues except the two palest blues, which carry so little
 * colour that "pale blue" and "blue-tinted grey" are the same measurement.
 * Those come back as `ambiguous` and are named with medium confidence and a
 * reason that says why — which is the correct answer to a question the value
 * genuinely cannot settle.
 */
export function classifyChroma(value) {
  const chroma = chromaOf(value);
  if (chroma < 0.04) return { kind: 'neutral', chroma, certain: true };
  if (chroma < 0.15) return { kind: 'neutral', chroma, certain: false };
  return { kind: 'chromatic', chroma, certain: true };
}

/**
 * Learns the real lightness→shade mapping from ramps already in the file.
 *
 * A design system that numbers its ramp at all has already answered "which
 * lightness is 500 here", and its answer beats any table shipped in a script.
 * Needs at least `minShades` distinct numeric shades to be trusted; below that
 * the built-in ladder is used and `source` says so.
 */
export function calibrateShades(entries, { minShades = 4 } = {}) {
  // Calibrate PER RAMP, not over the whole file. A yellow and a blue at the
  // same shade number sit at very different lightnesses — pooling them yields
  // a ladder that fits neither. Measured on one production palette: pooled
  // calibration round-trips 11 of 16 steps, per-ramp gets nearly all of them.
  const ramps = new Map();

  for (const entry of entries) {
    if (entry.kind !== 'variable' || entry.resolvedType !== 'COLOR') continue;
    const value = entry.value;
    if (!value || typeof value.r !== 'number') continue;
    const parts = entry.name.split('/');
    const shade = parts.pop();
    if (!/^\d{1,4}$/.test(shade)) continue;
    // An alpha variant shares its base hex, so it would pull the median for a
    // shade it does not actually define.
    if (value.a !== undefined && value.a < 0.99) continue;

    const prefix = parts.join('/');
    if (!ramps.has(prefix)) ramps.set(prefix, []);
    const { h, l } = rgbToHsl(value.r, value.g, value.b);
    const classified = classifyChroma(value);
    ramps.get(prefix).push({ shade, h, l, chroma: classified.chroma, neutral: classified.kind === 'neutral' });
  }

  const buildLadder = (points) => {
    const median = (xs) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];
    const byShade = new Map();
    for (const p of points) {
      if (!byShade.has(p.shade)) byShade.set(p.shade, []);
      byShade.get(p.shade).push(p.l);
    }
    const steps = [...byShade.entries()]
      .map(([shade, ls]) => ({ shade, l: median(ls) }))
      .sort((a, b) => a.l - b.l);
    const ladder = steps.map((step, i) => {
      const next = steps[i + 1];
      // The boundary sits halfway to the next step up, so each ramp step owns
      // the lightness band around itself.
      return [next ? (step.l + next.l) / 2 : 100, step.shade];
    });
    return { ladder, shades: steps.length };
  };

  const families = [];
  for (const [prefix, points] of ramps) {
    const distinct = new Set(points.map((p) => p.shade));
    if (distinct.size < minShades) continue;
    const neutral = points.filter((p) => p.neutral).length > points.length / 2;
    const built = buildLadder(points);
    families.push({
      prefix,
      neutral,
      // Circular mean, so a red ramp straddling 0°/360° does not average to cyan.
      //
      // Neutral ramps get a hue too, and that matters: a design system with a
      // blue-grey ramp (`nevada`, hue ~215) alongside a real blue ramp (hue
      // ~220) needs them told apart. Without a hue on the neutral family every
      // blue-grey gets pulled onto the blue ladder — measured on a production
      // file, that alone cost 11 of 16 steps in one ramp.
      meanHue: circularMean(points.map((p) => p.h)),
      // A ramp of pure greys has a hue of 0 only because hue is undefined for
      // an achromatic colour — it is noise, not a direction. Treating it as a
      // real hue lets a grey ramp compete for every pale red, which measurably
      // wrecked two ramps on a production file. Flag it and never match on it.
      achromatic: points.every((p) => p.chroma < 0.02),
      ...built,
    });
  }

  const pooled = (predicate, fallback) => {
    const points = [...ramps.values()].flat().filter(predicate);
    const distinct = new Set(points.map((p) => p.shade));
    if (distinct.size < minShades) return { ladder: fallback, source: 'builtin', shades: 0 };
    return { ...buildLadder(points), source: 'calibrated' };
  };

  return {
    families,
    chromatic: pooled((p) => !p.neutral, SHADE_CHROMATIC),
    neutral: pooled((p) => p.neutral, SHADE_NEUTRAL),
  };
}

/** Mean of angles in degrees, correct across the 0/360 wrap. */
export function circularMean(degrees) {
  if (!degrees.length) return null;
  let x = 0;
  let y = 0;
  for (const d of degrees) {
    x += Math.cos((d * Math.PI) / 180);
    y += Math.sin((d * Math.PI) / 180);
  }
  const mean = (Math.atan2(y / degrees.length, x / degrees.length) * 180) / Math.PI;
  return (mean + 360) % 360;
}

/** Shortest angular distance between two hues. */
export function hueDistance(a, b) {
  const diff = Math.abs(a - b) % 360;
  return diff > 180 ? 360 - diff : diff;
}

/**
 * Picks the calibrated ramp closest to this colour, falling back to the pooled
 * ladder and then to the built-in one. Nearest hue is the right selector: a new
 * red belongs on the red ramp's lightness ladder, not on the file average.
 */
const nearestByHue = (families, hue) =>
  families.length
    ? families.reduce((best, f) => (hueDistance(f.meanHue, hue) < hueDistance(best.meanHue, hue) ? f : best))
    : null;

/**
 * The calibrated ramp this colour most likely belongs to.
 *
 * Neutrals need the extra `achromatic` split: a file can hold a pure grey ramp
 * and a blue-grey ramp at once, and they are not interchangeable. A pure grey
 * belongs on the pure grey ladder; a blue-grey belongs on the blue-grey one.
 */
export function nearestFamily(ladders, { hue, neutral, achromatic = false }) {
  const pool = (ladders.families ?? []).filter((f) => f.neutral === neutral && f.meanHue !== null);
  if (!pool.length) return null;
  if (!neutral) return nearestByHue(pool.filter((f) => !f.achromatic), hue);

  const tinted = pool.filter((f) => !f.achromatic);
  const plain = pool.filter((f) => f.achromatic);
  if (achromatic) return plain[0] ?? nearestByHue(tinted, hue);
  return nearestByHue(tinted, hue) ?? plain[0] ?? null;
}

/**
 * Two ramps at the same hue that disagree about this lightness.
 *
 * A production file here has both `palette/red` and `palette/brand-primary`,
 * one degree apart in hue, whose `500` steps sit at L=60% and L=39%. A colour
 * at h=357 L=39% is honestly `red/700` OR `brand-primary/500` — the value
 * cannot say which ramp it belongs to. Picking one silently is the failure
 * mode; naming both is the answer.
 */
export function competingFamilies(ladders, { hue, lightness, neutral, tolerance = 12 }) {
  const near = (ladders.families ?? []).filter(
    (f) =>
      f.neutral === neutral &&
      f.meanHue !== null &&
      !f.achromatic &&
      hueDistance(f.meanHue, hue) <= tolerance,
  );
  if (near.length < 2) return null;
  const shades = new Map();
  for (const f of near) shades.set(f.prefix, shadeFor(lightness, f.ladder));
  const distinct = new Set(shades.values());
  if (distinct.size < 2) return null;
  return [...shades.entries()].map(([prefix, shade]) => `${prefix}/${shade}`);
}

/** Picks the calibrated ramp closest to this colour, then the pooled ladder, then the built-in. */
export function ladderFor(ladders, { hue, neutral, achromatic = false }) {
  const family = nearestFamily(ladders, { hue, neutral, achromatic });
  if (family) return family.ladder;
  return neutral ? ladders.neutral.ladder : ladders.chromatic.ladder;
}

/**
 * A colour value to a name, or null when there is nothing defensible to say.
 * `ladders` comes from `calibrateShades`.
 */
export function suggestColorName(value, { ladders, group = 'colors' } = {}) {
  if (!value || typeof value.r !== 'number') return null;
  const { h, s, l } = rgbToHsl(value.r, value.g, value.b);
  const alpha = value.a === undefined ? 1 : value.a;

  // Any alpha below opaque earns a suffix, not just the near-transparent ones:
  // two variables identical except for alpha must not suggest the same name.
  const suffix = alpha < 0.99 ? `/alpha-${Math.round(alpha * 100)}` : '';
  const round = (n) => Math.round(n);

  let chroma = classifyChroma(value);
  const hue = hueName(h);

  // A pale tint carries little chroma, which on its own is indistinguishable
  // from a tinted neutral. But if the file has a calibrated ramp sitting at
  // this hue, that ramp is evidence the value cannot supply: `#FFE8E4` beside
  // a red ramp is the top of that ramp, not an off-white. Only the genuinely
  // achromatic (`certain`) stay neutral.
  if (chroma.kind === 'neutral' && !chroma.certain) {
    const chromaticRamp = nearestFamily(ladders, { hue: h, neutral: false });
    // Only a TINTED neutral ramp can hold this colour back. A pure grey ramp
    // has no hue to compare, so letting it compete would drag every pale red
    // and pale blue onto the grey ladder.
    const neutralRamp = nearestFamily(ladders, { hue: h, neutral: true, achromatic: false });
    const toChromatic = chromaticRamp && hueDistance(chromaticRamp.meanHue, h) <= 20;
    const neutralIsNearer =
      neutralRamp &&
      !neutralRamp.achromatic &&
      (!chromaticRamp || hueDistance(neutralRamp.meanHue, h) <= hueDistance(chromaticRamp.meanHue, h));
    if (toChromatic && !neutralIsNearer) {
      chroma = { ...chroma, kind: 'chromatic', viaRamp: chromaticRamp.prefix };
    }
  }

  // Thresholds are deliberately tight. At L>=98 you are still inside most
  // neutral ramps — Tailwind's `gray-50` (#f9fafb) sits at exactly 98% — and
  // naming it `white` steals a step out of the ramp.
  if (chroma.kind === 'neutral' && chroma.certain && l >= 99) {
    return { name: `${group}/white${suffix}`, reason: `Pure white (L:${round(l)}%)`, confidence: 'high' };
  }
  if (chroma.kind === 'neutral' && chroma.certain && l <= 1) {
    return { name: `${group}/black${suffix}`, reason: `Pure black (L:${round(l)}%)`, confidence: 'high' };
  }
  if (chroma.kind === 'neutral') {
    const neutralFamily = nearestFamily(ladders, { hue: h, neutral: true, achromatic: chroma.certain });
    const shade = shadeFor(l, neutralFamily ? neutralFamily.ladder : ladders.neutral.ladder);

    // The same reading can belong to a tinted-neutral ramp or to the pale end
    // of a coloured one — `nevada/100` and `blue/050` are both true statements
    // about a pale blue-grey. When the file holds both, say so.
    const rival = chroma.certain ? null : nearestFamily(ladders, { hue: h, neutral: false });
    const crossPool =
      rival && neutralFamily && hueDistance(rival.meanHue, h) <= 20
        ? [`${neutralFamily.prefix}/${shade}`, `${rival.prefix}/${shadeFor(l, rival.ladder)}`]
        : null;

    return {
      name: `${group}/gray/${shade}${suffix}`,
      reason: crossPool
        ? `Low chroma (${round(chroma.chroma * 100)}%) with a ${hue.name} tint, L:${round(l)}% — this file has both a ` +
          `tinted-neutral and a coloured ramp here: ${crossPool.join(' or ')}. The value cannot say which`
        : chroma.certain
          ? `Neutral (chroma ${round(chroma.chroma * 100)}%), L:${round(l)}%`
          : `Low chroma (${round(chroma.chroma * 100)}%) with a ${hue.name} tint, L:${round(l)}% — a tinted neutral or a very pale ${hue.name}; check which`,
      confidence: crossPool ? 'low' : chroma.certain ? 'high' : 'medium',
      competing: crossPool ?? undefined,
    };
  }

  const shade = shadeFor(l, ladderFor(ladders, { hue: h, neutral: false }));
  const label = `${hue.name[0].toUpperCase()}${hue.name.slice(1)}`;
  const competing = competingFamilies(ladders, { hue: h, lightness: l, neutral: false });
  return {
    name: `${group}/${hue.name}/${shade}${suffix}`,
    reason: competing
      ? `${label} hue (${round(h)}°), L:${round(l)}% — but this file has two ramps at this hue that disagree: ` +
        `${competing.join(' or ')}. The value cannot say which one this belongs to`
      : chroma.viaRamp
        ? `Pale ${hue.name} (chroma ${round(chroma.chroma * 100)}%, L:${round(l)}%) sitting on the "${chroma.viaRamp}" ramp`
        : `${label} hue (${round(h)}°), L:${round(l)}%`,
    // Within a few degrees of a boundary the hue could honestly be named
    // either way, so the suggestion says so instead of sounding certain.
    confidence: competing ? 'low' : chroma.viaRamp || hue.margin < 5 ? 'medium' : 'high',
    competing: competing ?? undefined,
  };
}

// ---------------------------------------------------------------- number maths

export const SPACING_SEMANTIC = {
  0: 'none', 2: '3xs', 4: '2xs', 8: 'xs', 12: 'sm', 16: 'md',
  24: 'lg', 32: 'xl', 40: '2xl', 48: '3xl', 64: '4xl', 80: '5xl', 96: '6xl',
};

export const SPACING_NUMERIC = {
  0: '0', 1: 'px', 2: '0.5', 4: '1', 6: '1.5', 8: '2', 10: '2.5', 12: '3',
  14: '3.5', 16: '4', 20: '5', 24: '6', 28: '7', 32: '8', 36: '9', 40: '10',
  44: '11', 48: '12', 56: '14', 64: '16', 72: '18', 80: '20', 96: '24',
  112: '28', 128: '32',
};

export const RADIUS_SEMANTIC = {
  0: 'none', 2: 'xs', 4: 'sm', 6: 'md', 8: 'lg', 12: 'xl', 16: '2xl',
  24: '3xl', 9999: 'full',
};

export const FONTSIZE_SEMANTIC = {
  12: 'xs', 14: 'sm', 16: 'base', 18: 'lg', 20: 'xl', 24: '2xl', 30: '3xl',
  36: '4xl', 48: '5xl', 60: '6xl', 72: '7xl',
};

export const FONTWEIGHT_NAMES = {
  100: 'thin', 200: 'extralight', 300: 'light', 400: 'regular', 500: 'medium',
  600: 'semibold', 700: 'bold', 800: 'extrabold', 900: 'black',
};

/** Figma variable scopes that name a category outright. */
const SCOPE_CATEGORY = {
  GAP: 'spacing',
  CORNER_RADIUS: 'radius',
  WIDTH_HEIGHT: 'size',
  STROKE_FLOAT: 'borderWidth',
  OPACITY: 'opacity',
  FONT_SIZE: 'fontSize',
  FONT_WEIGHT: 'fontWeight',
  LINE_HEIGHT: 'lineHeight',
  LETTER_SPACING: 'letterSpacing',
  PARAGRAPH_SPACING: 'spacing',
  PARAGRAPH_INDENT: 'spacing',
};

const NAME_CATEGORY = [
  [/(^|[^a-z])(space|spacing|gap|padding|margin|inset)([^a-z]|$)/i, 'spacing'],
  [/(radius|corner|rounded)/i, 'radius'],
  [/(font-?size|text-?size|type-?size)/i, 'fontSize'],
  [/(font-?weight|weight)/i, 'fontWeight'],
  [/(opacity|alpha|transparen)/i, 'opacity'],
  [/(line-?height|leading)/i, 'lineHeight'],
  [/(letter-?spacing|tracking)/i, 'letterSpacing'],
  [/(border-?width|stroke|outline)/i, 'borderWidth'],
  [/(width|height|size)/i, 'size'],
];

/**
 * Which category a FLOAT belongs to, and how strong the evidence is.
 *
 * Order matters and is the fix for the ambiguity the spec leaves open: `8` is
 * a legal spacing AND a legal radius, `0.5` is a legal opacity AND a legal
 * half-pixel. The value alone can never settle that, so it is consulted last
 * and, on its own, never produces better than low confidence.
 */
export function detectNumberCategory({ name = '', collectionName = '', scopes = [], value }) {
  const signals = [];

  const fromCollection = NAME_CATEGORY.find(([re]) => re.test(collectionName));
  if (fromCollection) signals.push({ category: fromCollection[1], why: `collection "${collectionName}"` });

  for (const scope of scopes ?? []) {
    if (SCOPE_CATEGORY[scope]) signals.push({ category: SCOPE_CATEGORY[scope], why: `scope ${scope}` });
  }

  const fromName = NAME_CATEGORY.find(([re]) => re.test(name));
  if (fromName) signals.push({ category: fromName[1], why: `name contains "${name}"` });

  const strong = signals.length;

  if (typeof value === 'number') {
    if (value > 0 && value <= 1) signals.push({ category: 'opacity', why: `value ${value} is in the 0–1 range`, weak: true });
    else if (value >= 100 && value <= 900 && value % 100 === 0) {
      signals.push({ category: 'fontWeight', why: `value ${value} is a 100–900 weight step`, weak: true });
    } else if (value >= 10 && value <= 96) signals.push({ category: 'fontSize', why: `value ${value} is in type-scale range`, weak: true });
    if (value > 0 && value % 4 === 0) signals.push({ category: 'spacing', why: `value ${value} is a multiple of 4`, weak: true });
  }

  if (signals.length === 0) return null;

  const tally = new Map();
  for (const s of signals) tally.set(s.category, (tally.get(s.category) ?? 0) + (s.weak ? 0.5 : 1));
  const [category] = [...tally.entries()].sort((a, b) => b[1] - a[1])[0];

  const agreeing = signals.filter((s) => s.category === category);
  const strongAgreeing = agreeing.filter((s) => !s.weak).length;
  const confidence = strongAgreeing >= 2 ? 'high' : strongAgreeing === 1 ? 'medium' : 'low';

  return { category, confidence, reasons: agreeing.map((s) => s.why), strongSignals: strong };
}

/** A FLOAT value to a name, or null. `sizeNaming` is 'semantic' or 'numeric'. */
export function suggestNumberName(value, context = {}) {
  const detected = detectNumberCategory({ ...context, value });
  if (!detected) return null;

  const { sizeNaming = 'semantic' } = context;
  const { category } = detected;

  const lookup = (table) => table[value];
  const drop = (c) => (c === 'high' ? 'medium' : 'low');

  let leaf = null;
  let exact = true;
  if (category === 'opacity') leaf = String(Math.round(value * 100));
  else if (category === 'fontWeight') leaf = FONTWEIGHT_NAMES[value] ?? String(value);
  else if (category === 'fontSize') leaf = lookup(FONTSIZE_SEMANTIC);
  else if (category === 'radius') leaf = lookup(RADIUS_SEMANTIC);
  else if (category === 'spacing') leaf = lookup(sizeNaming === 'numeric' ? SPACING_NUMERIC : SPACING_SEMANTIC);

  if (leaf === undefined || leaf === null) {
    // Off the scale is not a failure — it is a token the system spells with a
    // raw value. Say so and lower the confidence rather than inventing a step.
    leaf = String(value);
    exact = false;
  }
  if (category === 'fontWeight' && !FONTWEIGHT_NAMES[value]) exact = false;

  const confidence = exact ? detected.confidence : drop(detected.confidence);
  return {
    name: `${category}/${leaf}`,
    reason: `${detected.reasons.join('; ')}${exact ? '' : ' — value is not on the built-in scale'}`,
    confidence,
  };
}

// ------------------------------------------------------------ name inspection

/** Names a design tool hands out when nobody chose one. */
export const GENERIC_PATTERNS = [
  /^Variable\s*\d*$/i,
  /^Color\s*\d*$/i,
  /^Colour\s*\d*$/i,
  /^Value\s*\d*$/i,
  /^Token\s*\d*$/i,
  /^Untitled\s*\d*$/i,
  /^New\s*\d*$/i,
  /^\d+$/,
];

export function isGenericName(name) {
  const leaf = name.split('/').pop().trim();
  return GENERIC_PATTERNS.some((re) => re.test(leaf));
}

/** What convention the collection actually follows, so outliers can be spotted. */
export function detectNamingConvention(names) {
  const counts = { '/': 0, '-': 0, _: 0, '.': 0 };
  let camel = 0;
  let pascal = 0;
  const depths = [];

  for (const name of names) {
    for (const sep of Object.keys(counts)) if (name.includes(sep)) counts[sep]++;
    depths.push(name.split('/').length);
    const leaf = name.split('/').pop();
    if (/^[a-z]+[A-Z]/.test(leaf)) camel++;
    if (/^[A-Z][a-z]+[A-Z]/.test(leaf)) pascal++;
  }

  const separator = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  const mode = (xs) => {
    const tally = new Map();
    for (const x of xs) tally.set(x, (tally.get(x) ?? 0) + 1);
    return [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 1;
  };

  return {
    separator: separator[1] > 0 ? separator[0] : null,
    groupDepth: mode(depths),
    camelCount: camel,
    pascalCount: pascal,
    total: names.length,
  };
}

/**
 * Whether a value-based rename should even be offered for this name.
 *
 * A name that already carries a group path is a decision somebody made
 * (`text/primary/default` means something the value cannot see), so proposing
 * `colors/gray/900` for it would be noise on every well-named token in the
 * file. Flat and generic names are the ones nobody has named yet.
 */
export function valueBasedApplies(name) {
  return isGenericName(name) || !name.includes('/');
}

// ------------------------------------------------------------------ the engine

/**
 * Suggestions for one collection's worth of inventory entries.
 *
 * Returns `{ suggestions, review, calibration }`.
 *   suggestions — { id, currentName, suggestedName, resolvedType, reason, confidence, source }
 *   review      — things with no defensible mechanical answer: aliases (whose
 *                 name is about role, not value) and values that two variables
 *                 share (a duplicate, not a naming problem)
 */
export function suggestForEntries(entries, options = {}) {
  const { sizeNaming = 'semantic', group = 'colors' } = options;
  const variables = entries.filter((e) => e.kind === 'variable' && !e.remote);
  const ladders = calibrateShades(entries);
  const convention = detectNamingConvention(variables.map((v) => v.name));

  const suggestions = [];
  const review = [];

  for (const entry of variables) {
    if (entry.value === undefined || entry.value === null) continue; // edge case 6

    if (entry.alias) {
      // Edge case 1. An alias points at a primitive, which makes it a semantic
      // token — and its correct name is its ROLE, which no value can reveal.
      review.push({
        id: entry.id,
        name: entry.name,
        why: `alias of ${entry.aliasName ?? entry.alias} — a semantic token, so the name is its role (brand? error? surface?), which the value cannot tell you`,
        suggestion: null,
      });
      continue;
    }

    if (!valueBasedApplies(entry.name)) continue; // edge case 7

    let result = null;
    if (entry.resolvedType === 'COLOR') result = suggestColorName(entry.value, { ladders, group });
    else if (entry.resolvedType === 'FLOAT') {
      result = suggestNumberName(entry.value, {
        name: entry.name,
        collectionName: entry.scope,
        scopes: entry.scopes,
        sizeNaming,
      });
    }
    if (!result || result.name === entry.name) continue;

    suggestions.push({
      id: entry.id,
      currentName: entry.name,
      suggestedName: result.name,
      resolvedType: entry.resolvedType,
      reason: result.reason,
      confidence: result.confidence,
      source: isGenericName(entry.name) ? 'generic' : 'value',
    });
  }

  // Two variables landing on one name is not a naming collision to paper over
  // with a numeric suffix — it means they hold the same value. Say that, and
  // let a human merge them or make one an alias of the other.
  const byName = new Map();
  for (const s of suggestions) {
    if (!byName.has(s.suggestedName)) byName.set(s.suggestedName, []);
    byName.get(s.suggestedName).push(s);
  }
  const kept = [];
  for (const [name, group_] of byName) {
    if (group_.length === 1) {
      kept.push(group_[0]);
      continue;
    }
    for (const s of group_) {
      review.push({
        id: s.id,
        name: s.currentName,
        why: `same value as ${group_.filter((o) => o !== s).map((o) => `"${o.currentName}"`).join(', ')} — both would be "${name}". Merge them, or make one an alias of the other`,
        suggestion: name,
      });
    }
  }

  return {
    suggestions: kept.sort((a, b) => a.suggestedName.localeCompare(b.suggestedName)),
    review,
    calibration: {
      chromatic: { source: ladders.chromatic.source, shades: ladders.chromatic.shades },
      neutral: { source: ladders.neutral.source, shades: ladders.neutral.shades },
      families: ladders.families.length,
    },
    convention,
  };
}
