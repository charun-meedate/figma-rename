// The naming convention engine: old Figma name -> proposed new Figma name.
//
// Everything here is MECHANICAL and reversible. It changes how a name is
// spelled and where its segments sit; it never invents meaning. A name whose
// correct new form requires knowing what the token is *for* comes back as
// `needsReview` with `to: null`, so a human answers it instead of the script
// guessing and a reviewer rubber-stamping the guess.
//
// Two layers, applied in this order:
//
//   1. rules       — first matching glob wins; the template decides the name
//   2. normalizers — separator, per-segment case, segment aliases
//
// Rules run first so a template can produce "Text/Primary Default" without
// caring about case; the normalizers make it "text/primary-default".

const REGEX_SPECIAL = /[.+^${}()|[\]\\?]/;

/**
 * Compiles a glob over a slash path into a regex with one capture per wildcard.
 *   "color/text-*"   -> /^color\/text\-([^/]*)$/i     $1 = the * part
 *   "color/**"       -> /^color\/(.*)$/i              $1 = everything after
 * Case-insensitive, because Figma names are inconsistently cased and a rule
 * that silently misses on case is a rule nobody trusts.
 */
export function compileGlob(pattern) {
  let source = '';
  let captures = 0;
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === '*') {
      if (pattern[i + 1] === '*') {
        source += '(.*)';
        i++;
      } else {
        source += '([^/]*)';
      }
      captures++;
    } else if (REGEX_SPECIAL.test(char)) {
      source += `\\${char}`;
    } else {
      source += char;
    }
  }
  return { re: new RegExp(`^${source}$`, 'i'), captures };
}

/** True when `name` matches any of the compiled globs. */
export function matchesAny(name, compiled) {
  return compiled.some(({ re }) => re.test(name));
}

/** Splits one path segment into words: "textPrimary", "text_primary", "Text Primary" -> [text, primary]. */
export function splitWords(segment) {
  return segment
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s_-]+/)
    .filter(Boolean);
}

const CASERS = {
  kebab: (words) => words.map((w) => w.toLowerCase()).join('-'),
  snake: (words) => words.map((w) => w.toLowerCase()).join('_'),
  lower: (words) => words.map((w) => w.toLowerCase()).join(''),
  camel: (words) =>
    words
      .map((w, i) => (i === 0 ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1).toLowerCase()))
      .join(''),
  pascal: (words) => words.map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase()).join(''),
  // Genuinely leaves the segment alone. The old version split into words and
  // rejoined with "-", so "Text Primary" came out "Text-Primary" — a caser
  // named `preserve` that changed the name.
  preserve: (words, original) => original,
};

export const CASE_STYLES = Object.keys(CASERS);

/** Applies the configured case to one segment. Pure-digit segments are left alone ("8", "500"). */
export function caseSegment(segment, style) {
  if (/^\d+$/.test(segment)) return segment;
  const caser = CASERS[style];
  if (!caser) throw new Error(`Unknown segmentCase "${style}" — use one of: ${CASE_STYLES.join(', ')}`);
  const words = splitWords(segment);
  return words.length ? caser(words, segment) : segment;
}

/**
 * Substitutes segment aliases ("bg" -> "background"). Matching is on the whole
 * segment, case-insensitively — a substring rule would turn "background" into
 * "backgroundground" the second time it ran, and renames get re-run.
 */
function applyAliases(segment, aliases) {
  const hit = aliases[segment.toLowerCase()];
  return hit === undefined ? segment : hit;
}

/**
 * The plain operations, for when a glob rule is more machinery than the job needs.
 *
 * Most renames are not a re-architecture — they are "drop the `palette/`
 * prefix", "we write `/` not `-`", "make it all kebab". Expressing those as
 * capture-group templates is possible, and nobody enjoys it. `transform` says
 * them directly, and runs AFTER any matching rule so the two compose.
 *
 *   { "stripPrefix": ["palette"], "addPrefix": "primitive",
 *     "separator": { "from": "-", "to": "/" },
 *     "replace": [{ "find": "btn", "with": "button" }] }
 *
 * The order is fixed and load-bearing: separator first (so prefixes are
 * matched against the final shape), then strip, then add, then replacements.
 */
export function applyTransform(name, transform) {
  if (!transform) return name;
  let out = name;

  // A hierarchy separator swap has to happen before anything looks at segments.
  if (transform.separator?.from) {
    out = out.split(transform.separator.from).join(transform.separator.to ?? '/');
  }

  let segments = out.split('/').filter(Boolean);
  const parts = (value) => String(value).replace(/^\/|\/$/g, '').split('/').filter(Boolean);

  for (const prefix of transform.stripPrefix ?? []) {
    const wanted = parts(prefix);
    const matches = wanted.every((p, i) => (segments[i] ?? '').toLowerCase() === p.toLowerCase());
    // Never strip a name down to nothing — a token called exactly "palette"
    // has no name left afterwards.
    if (matches && segments.length > wanted.length) {
      segments = segments.slice(wanted.length);
      break; // one strip per pass; stripping twice is almost never intended
    }
  }

  for (const suffix of transform.stripSuffix ?? []) {
    const wanted = parts(suffix);
    const at = segments.length - wanted.length;
    const matches = at > 0 && wanted.every((p, i) => (segments[at + i] ?? '').toLowerCase() === p.toLowerCase());
    if (matches) {
      segments = segments.slice(0, at);
      break;
    }
  }

  if (transform.addPrefix) {
    const add = parts(transform.addPrefix);
    // Adding a prefix that is already there would produce primitive/primitive/…
    // on the second run, and these configs do get run twice.
    const already = add.every((p, i) => (segments[i] ?? '').toLowerCase() === p.toLowerCase());
    if (!already) segments = [...add, ...segments];
  }

  // Replacements match a WHOLE segment, like aliases — a substring rule turns
  // "button" into "buttonton" the second time it runs.
  for (const { find, with: replacement } of transform.replace ?? []) {
    if (!find || replacement === undefined) continue;
    segments = segments.map((s) => (s.toLowerCase() === String(find).toLowerCase() ? replacement : s));
  }

  return segments.join('/');
}

/** separator + case + aliases. Idempotent: normalize(normalize(x)) === normalize(x). */
export function normalizeName(name, convention) {
  const { separator = '/', segmentCase = 'kebab', aliases = {} } = convention;
  const lowerAliases = Object.fromEntries(Object.entries(aliases).map(([k, v]) => [k.toLowerCase(), v]));
  return name
    .split(/[/\\]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => caseSegment(applyAliases(s, lowerAliases), segmentCase))
    .join(separator);
}

/** Expands $1..$9 in a rule template from the glob's captures. */
function fillTemplate(template, match) {
  return template.replace(/\$(\d)/g, (_, digit) => match[Number(digit)] ?? '');
}

export function compileConvention(convention = {}) {
  const rules = (convention.rules ?? []).map((rule, i) => {
    if (!rule || typeof rule.match !== 'string') {
      throw new Error(`convention.rules[${i}] needs a \`match\` glob string.`);
    }
    if (rule.to !== undefined && typeof rule.to !== 'string') {
      throw new Error(`convention.rules[${i}].to must be a string template (or omitted to only normalize).`);
    }
    const { re, captures } = compileGlob(rule.match);
    const wanted = [...(rule.to ?? '').matchAll(/\$(\d)/g)].map((m) => Number(m[1]));
    for (const n of wanted) {
      if (n < 1 || n > captures) {
        throw new Error(
          `convention.rules[${i}] uses $${n} but "${rule.match}" has ${captures} wildcard(s).`,
        );
      }
    }
    return { ...rule, re, index: i };
  });
  return {
    ...convention,
    rules,
    conforming: (convention.conforming ?? []).map(compileGlob),
    ignore: (convention.ignore ?? []).map(compileGlob),
  };
}

/**
 * Proposes the new name for one existing name.
 *
 * @returns {{to: string|null, status: string, rule: string|null, why: string|null}}
 *   status is one of:
 *     conforming  — matched `conforming`; already correct, left alone
 *     ignored     — matched `ignore`; out of scope for this pass
 *     unchanged   — no rule applied and normalizing changed nothing
 *     renamed     — a rule matched
 *     normalized  — no rule matched, but case/alias normalizing changed the name
 *     needsReview — the result violates `structure`; `to` is null
 */
export function proposeName(name, compiled) {
  if (matchesAny(name, compiled.ignore)) {
    return { to: null, status: 'ignored', rule: null, why: 'matched convention.ignore' };
  }
  if (matchesAny(name, compiled.conforming)) {
    return { to: null, status: 'conforming', rule: null, why: null };
  }

  let candidate = name;
  let rule = null;
  for (const r of compiled.rules) {
    const match = candidate.match(r.re);
    if (!match) continue;
    if (r.to !== undefined) candidate = fillTemplate(r.to, match);
    rule = `${r.match} -> ${r.to ?? '(normalize only)'}`;
    break;
  }

  const transformed = applyTransform(candidate, compiled.transform);
  if (!rule && transformed !== candidate) rule = '(transform)';
  const to = normalizeName(transformed, compiled);

  const problem = structureProblem(to, compiled.structure);
  if (problem) {
    return { to: null, status: 'needsReview', rule, why: problem, suggestion: to };
  }
  if (to === name) {
    return { to: null, status: 'unchanged', rule, why: null };
  }
  return { to, status: rule ? 'renamed' : 'normalized', rule, why: null };
}

/** Returns a human-readable reason the name violates `structure`, or null. */
function structureProblem(name, structure) {
  if (!structure) return null;
  const parts = name.split('/');
  const { minSegments, maxSegments, categories } = structure;
  if (minSegments !== undefined && parts.length < minSegments) {
    return `${parts.length} segment(s), convention.structure.minSegments is ${minSegments}`;
  }
  if (maxSegments !== undefined && parts.length > maxSegments) {
    return `${parts.length} segment(s), convention.structure.maxSegments is ${maxSegments}`;
  }
  if (Array.isArray(categories) && categories.length) {
    const first = parts[0].toLowerCase();
    if (!categories.some((c) => c.toLowerCase() === first)) {
      return `first segment "${parts[0]}" is not one of convention.structure.categories (${categories.join(', ')})`;
    }
  }
  return null;
}
