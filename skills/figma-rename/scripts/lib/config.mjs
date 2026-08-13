// Loads and validates rename.config.json.
//
// Every path in the config resolves relative to the config file itself, so the
// scripts run from any working directory — from the project root, from a
// subfolder, or from CI — without a cwd convention people will get wrong.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CASE_STYLES } from './convention.mjs';

const CONFIG_NAME = 'rename.config.json';

const PRESETS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../presets');

const VALID_KINDS = new Set(['variable', 'component', 'componentSet', 'layer', 'textStyle', 'effectStyle', 'paintStyle']);

// Where the names come from. "figma" is the normal case: Figma is upstream and
// a batch lands there before it lands in code. "code" is for a project whose
// tokens are hand-written with no Figma behind them — the naming standard still
// applies, there is simply no Figma leg to gate on. Explicit rather than
// inferred from a missing fileKey: the lifecycle differs, so a typo must not
// choose it.
const VALID_SOURCES = new Set(['figma', 'code']);

const VALID_SPELLINGS = new Set(['figmaPath', 'cssVar', 'kebab', 'camel', 'camelMember', 'pascal', 'snake', 'dot', 'tailwind']);

const DEFAULTS = {
  source: 'figma',
  inventoryPath: 'rename/inventory.json',
  renameMapPath: 'rename/rename-map.json',
};

const CODE_DEFAULTS = {
  roots: ['.'],
  include: ['**/*.{ts,tsx,js,jsx,css,scss,dart,kt,kts,swift,json,md,html,vue,svelte}'],
  exclude: ['**/node_modules/**', '**/.git/**', '**/build/**', '**/.dart_tool/**', '**/dist/**'],
  generated: [],
  spellings: ['figmaPath', 'cssVar', 'camel', 'camelMember', 'pascal'],
  cssPrefix: '',
  flutterPrefix: 'App',
};

export async function findConfigPath(startDir = process.cwd()) {
  let dir = path.resolve(startDir);
  for (;;) {
    const candidate = path.join(dir, CONFIG_NAME);
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) {
        throw new Error(
          `${CONFIG_NAME} not found in ${startDir} or any parent directory. ` +
            'Copy rename.config.example.json to your project root and edit it.',
        );
      }
      dir = parent;
    }
  }
}

/**
 * Where a shared naming standard lives.
 *
 * A convention copy-pasted into every project is not a standard — it is several
 * standards that happen to agree today, until the first project edits its copy.
 * `extends` points every project at one file instead:
 *
 *   "extends": "aurora"                          a preset shipped with this skill
 *   "extends": "../design-system/naming.json"    a file the team owns
 *
 * The project keeps only what it genuinely differs on — usually just
 * `figma.fileKey` and `code.*`, which are per-repo facts, not naming decisions.
 */
async function resolveExtends(value, rootDir, seen = []) {
  const looksLikePath = value.includes('/') || value.endsWith('.json');
  const target = looksLikePath ? path.resolve(rootDir, value) : path.join(PRESETS_DIR, `${value}.json`);

  if (seen.includes(target)) {
    throw new Error(`Circular \`extends\`: ${[...seen, target].join(' -> ')}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(target, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') {
      let available = [];
      try {
        available = (await fs.readdir(PRESETS_DIR))
          .filter((f) => f.endsWith('.json'))
          .map((f) => f.replace(/\.json$/, ''));
      } catch {
        /* a skill copy may ship without presets */
      }
      throw new Error(
        `\`extends\` could not find "${value}" (looked for ${target}).` +
          (available.length ? `\nPresets in this skill: ${available.join(', ')}` : '') +
          "\nUse a preset name, or a relative path to your team's shared naming file.",
      );
    }
    throw new Error(`Could not parse ${target}: ${err.message}`);
  }

  // Tag the rules with where they came from. After a merge, "rules[3]" is an
  // index into a combined array that may belong to a preset, a team file, or the
  // project — and the error used to name none of them.
  const label = looksLikePath ? path.relative(rootDir, target) : `preset "${value}"`;
  for (const rule of parsed.convention?.rules ?? []) {
    if (rule && typeof rule === 'object' && !rule.$src) rule.$src = label;
  }

  if (parsed.extends) {
    const base = await resolveExtends(parsed.extends, path.dirname(target), [...seen, target]);
    return mergeConfig(base, parsed);
  }
  return parsed;
}

/**
 * Child wins, one level deep on the objects that matter.
 *
 * Arrays are REPLACED, never concatenated. A project overriding `conforming`
 * means "these, not those"; appending would silently keep rules it was trying
 * to drop, and the result would look like the shared standard misbehaving
 * rather than the merge.
 */
function mergeConfig(base, child) {
  const merged = { ...base, ...child };
  for (const key of ['figma', 'convention', 'code']) {
    if (base[key] && child[key]) merged[key] = { ...base[key], ...child[key] };
  }
  for (const key of ['structure', 'transform', 'components']) {
    if (base.convention?.[key] && child.convention?.[key]) {
      merged.convention[key] = { ...base.convention[key], ...child.convention[key] };
    }
  }
  if (base.convention?.components?.classifier && child.convention?.components?.classifier) {
    merged.convention.components.classifier = {
      ...base.convention.components.classifier,
      ...child.convention.components.classifier,
    };
  }
  delete merged.extends;
  return merged;
}

export async function loadConfig(explicitPath) {
  const configPath = explicitPath ? path.resolve(explicitPath) : await findConfigPath();
  const rootDir = path.dirname(configPath);

  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(configPath, 'utf8'));
  } catch (err) {
    throw new Error(`Could not parse ${configPath}: ${err.message}`);
  }

  let extendsFrom = null;
  let ownConvention = {};
  if (parsed.extends !== undefined && typeof parsed.extends !== 'string') {
    throw new Error(
      `Invalid ${configPath}: \`extends\` must be a string — a preset name ("aurora") or a path ` +
        `("../design-system/naming.json"). Got ${JSON.stringify(parsed.extends)}.`,
    );
  }
  if (parsed.extends) {
    extendsFrom = parsed.extends;
    ownConvention = parsed.convention ?? {};
    parsed = mergeConfig(await resolveExtends(parsed.extends, rootDir), parsed);
  }

  // Which naming decisions this PROJECT made, as opposed to inherited. plan.mjs
  // uses it to tell a first run apart from a considered one: a config that
  // extends a preset and overrides none of these was never discussed with
  // anyone, and the names it produces will look decided when they are not.
  const FORMAT_KEYS = ['segmentCase', 'separator', 'sizeNaming', 'transform', 'rules', 'aliases', 'structure'];
  const ownFormatKeys = extendsFrom
    ? FORMAT_KEYS.filter((k) => ownConvention[k] !== undefined)
    : FORMAT_KEYS;

  const config = { ...DEFAULTS, ...parsed, extendsFrom, ownFormatKeys };
  config.code = { ...CODE_DEFAULTS, ...(parsed.code ?? {}) };
  config.convention = config.convention ?? {};

  const errors = [];

  const { convention } = config;
  if (convention.segmentCase !== undefined && !CASE_STYLES.includes(convention.segmentCase)) {
    errors.push(`convention.segmentCase "${convention.segmentCase}" is not one of: ${CASE_STYLES.join(', ')}.`);
  }
  if (convention.separator !== undefined && convention.separator !== '/') {
    // Figma builds variable/style groups from "/" and nothing else. Allowing
    // another separator here would produce names that look right in the JSON
    // and collapse into one flat group in the Figma UI.
    errors.push('convention.separator must be "/" — Figma groups variables and styles by slash only.');
  }
  if (convention.aliases !== undefined && (typeof convention.aliases !== 'object' || Array.isArray(convention.aliases))) {
    errors.push('convention.aliases must be an object of { "old-segment": "new-segment" }.');
  }
  for (const key of ['rules', 'conforming', 'ignore']) {
    if (convention[key] !== undefined && !Array.isArray(convention[key])) {
      errors.push(`convention.${key} must be an array.`);
    }
  }
  if (convention.structure !== undefined) {
    const s = convention.structure;
    if (typeof s !== 'object' || Array.isArray(s)) {
      errors.push('convention.structure must be an object.');
    } else if (s.categories !== undefined && !Array.isArray(s.categories)) {
      errors.push('convention.structure.categories must be an array of first-segment names.');
    }
  }

  if (convention.transform !== undefined) {
    const t = convention.transform;
    if (typeof t !== 'object' || Array.isArray(t)) {
      errors.push('convention.transform must be an object of { separator, stripPrefix, stripSuffix, addPrefix, replace }.');
    } else {
      for (const key of ['stripPrefix', 'stripSuffix']) {
        if (t[key] !== undefined && !Array.isArray(t[key])) {
          // A string here iterates character by character and silently does
          // nothing — the worst failure shape there is.
          errors.push(`convention.transform.${key} must be an ARRAY of prefixes, e.g. ["palette"] (got ${JSON.stringify(t[key])}).`);
        }
      }
      if (t.addPrefix !== undefined && typeof t.addPrefix !== 'string') {
        errors.push(`convention.transform.addPrefix must be a string, e.g. "primitive" (got ${JSON.stringify(t.addPrefix)}).`);
      }
      if (t.separator !== undefined) {
        if (typeof t.separator !== 'object' || Array.isArray(t.separator) || !t.separator.from) {
          errors.push('convention.transform.separator must be { "from": "-", "to": "/" }.');
        }
      }
      if (t.replace !== undefined) {
        if (!Array.isArray(t.replace)) {
          errors.push('convention.transform.replace must be an ARRAY of { find, with } pairs.');
        } else {
          t.replace.forEach((pair, i) => {
            if (!pair || typeof pair !== 'object' || !pair.find || pair.with === undefined) {
              errors.push(`convention.transform.replace[${i}] needs both \`find\` and \`with\`.`);
            }
          });
        }
      }
      const unknownTransform = Object.keys(t).filter(
        (k) => !k.startsWith('$') && !['separator', 'stripPrefix', 'stripSuffix', 'addPrefix', 'replace'].includes(k),
      );
      if (unknownTransform.length) {
        errors.push(
          `convention.transform has no key(s) ${unknownTransform.join(', ')}. ` +
            'Valid: separator, stripPrefix, stripSuffix, addPrefix, replace. ' +
            '(Case per segment is convention.segmentCase; the number scale is convention.sizeNaming.)',
        );
      }
    }
  }
  if (convention.sizeNaming !== undefined && !['semantic', 'numeric'].includes(convention.sizeNaming)) {
    errors.push(`convention.sizeNaming "${convention.sizeNaming}" must be "semantic" or "numeric".`);
  }
  if (convention.colorGroup !== undefined) {
    if (typeof convention.colorGroup !== 'string' || !/^[A-Za-z0-9/_-]+$/.test(convention.colorGroup)) {
      errors.push(
        `convention.colorGroup "${convention.colorGroup}" is not usable as a name segment — ` +
          'letters, digits, "/", "-" and "_" only.',
      );
    }
  }

  // Unknown keys. A typo'd `conventions`, or `sizeNaming` placed at the top
  // level instead of inside `convention`, used to be silently ignored: the user
  // saw a plan that behaved as if they had never written the setting.
  const KNOWN_TOP = ['extends', 'source', 'figma', 'inventoryPath', 'renameMapPath', 'kinds', 'convention', 'code'];
  const KNOWN_CONVENTION = [
    'separator', 'segmentCase', 'aliases', 'rules', 'conforming', 'ignore', 'structure',
    'transform', 'sizeNaming', 'colorGroup', 'components',
  ];
  const KNOWN_COMPONENTS = [
    'segmentCase', 'aliases', 'rules', 'conforming', 'ignore', 'structure', 'transform', 'classifier',
  ];
  const KNOWN_CLASSIFIER = ['minConfidence', 'priorities', 'pageHints', 'disable', 'includeTextHint'];
  const KNOWN_CODE = [
    'roots', 'include', 'exclude', 'generated', 'spellings', 'cssPrefix', 'flutterPrefix', 'tokensConfig',
  ];
  const unknown = (obj, known, where) =>
    Object.keys(obj ?? {})
      .filter((k) => !k.startsWith('$') && !known.includes(k))
      .map((k) => `${where}${k}\` is not a setting. Valid: ${known.join(', ')}.`);
  errors.push(
    ...unknown(config, [...KNOWN_TOP, 'extendsFrom', 'ownFormatKeys'], '`'),
    ...unknown(config.convention, KNOWN_CONVENTION, '`convention.'),
    ...unknown(config.convention?.components, KNOWN_COMPONENTS, '`convention.components.'),
    ...unknown(config.convention?.components?.classifier, KNOWN_CLASSIFIER, '`convention.components.classifier.'),
    ...unknown(config.code, KNOWN_CODE, '`code.'),
  );

  const classifier = convention.components?.classifier;
  if (classifier) {
    if (classifier.minConfidence !== undefined && !['low', 'medium', 'high'].includes(classifier.minConfidence)) {
      errors.push(`convention.components.classifier.minConfidence "${classifier.minConfidence}" must be low, medium or high.`);
    }
    for (const [key, shape] of [['priorities', 'object'], ['pageHints', 'object']]) {
      if (classifier[key] !== undefined && (typeof classifier[key] !== shape || Array.isArray(classifier[key]))) {
        errors.push(`convention.components.classifier.${key} must be an object.`);
      }
    }
    if (classifier.disable !== undefined && !Array.isArray(classifier.disable)) {
      errors.push('convention.components.classifier.disable must be an array of rule names.');
    }
  }

  if (config.kinds !== undefined) {
    if (!Array.isArray(config.kinds)) {
      errors.push(`kinds must be an array of: ${[...VALID_KINDS].join(', ')}.`);
    } else {
      for (const kind of config.kinds) {
        if (!VALID_KINDS.has(kind)) errors.push(`kinds contains "${kind}", which is not one of: ${[...VALID_KINDS].join(', ')}.`);
      }
    }
  }

  for (const key of ['roots', 'include', 'exclude', 'generated', 'spellings']) {
    if (!Array.isArray(config.code[key])) errors.push(`code.${key} must be an array of strings.`);
  }
  if (!VALID_SOURCES.has(config.source)) {
    errors.push(`source "${config.source}" is not one of: ${[...VALID_SOURCES].join(', ')}.`);
  }
  if (config.source === 'figma' && !config.figma?.fileKey) {
    errors.push(
      'figma.fileKey is required when source is "figma". A project whose tokens are ' +
        'hand-written with no Figma behind them sets `"source": "code"` instead.',
    );
  }

  for (const spelling of config.code.spellings ?? []) {
    if (!VALID_SPELLINGS.has(spelling)) {
      errors.push(`code.spellings contains "${spelling}", which is not one of: ${[...VALID_SPELLINGS].join(', ')}.`);
    }
  }

  if (errors.length) {
    throw new Error(`Invalid ${configPath}:\n- ${errors.join('\n- ')}`);
  }

  return {
    ...config,
    configPath,
    rootDir,
    kinds: config.kinds ?? [...VALID_KINDS],
    inventoryPath: path.resolve(rootDir, config.inventoryPath),
    renameMapPath: path.resolve(rootDir, config.renameMapPath),
    code: {
      ...config.code,
      exclude: withArtifactExcludes(config, rootDir),
      roots: config.code.roots.map((r) => path.resolve(rootDir, r)),
      tokensConfig: config.code.tokensConfig ? path.resolve(rootDir, config.code.tokensConfig) : null,
    },
  };
}

/**
 * The codemod must never rewrite this skill's own bookkeeping.
 *
 * `inventory.json` and `rename-map.json` are full of the old names — that is
 * their job — and the default `code.include` matches `**\/*.json`. Left alone,
 * `apply-code --write` rewrites the map's own `from` fields to equal its `to`
 * fields, which quietly destroys everything downstream: `check` can no longer
 * detect a stale map, `emit-figma --reverse` has no old name to walk back to,
 * and `check --after` goes *vacuously green* because every from/to pair
 * collapses and there is nothing left to search for.
 *
 * So these exclusions are appended unconditionally, after the user's config —
 * a project cannot opt out of them by overriding `code.exclude`, because there
 * is no legitimate reason to want to.
 */
function withArtifactExcludes(config, rootDir) {
  const relative = (p) => path.relative(rootDir, path.resolve(rootDir, p)).split(path.sep).join('/');
  const artifactDirs = new Set(
    [config.inventoryPath, config.renameMapPath].map((p) => path.posix.dirname(relative(p))),
  );

  const forced = [relative(CONFIG_NAME)];
  for (const dir of artifactDirs) {
    // "." means the artefacts sit at the project root — exclude the two files
    // themselves rather than the whole repo.
    if (dir === '.' || dir === '') {
      forced.push(relative(config.inventoryPath), relative(config.renameMapPath));
    } else {
      forced.push(`${dir}/**`, dir);
    }
  }

  const already = new Set(config.code.exclude);
  return [...config.code.exclude, ...forced.filter((p) => !already.has(p))];
}

/**
 * Flag parser with an allow-list.
 *
 * The list is not pedantry. With no list, `--dryrun` parsed into an ignored key
 * and plan WROTE THE MAP while the user believed they were previewing;
 * `--no-suggests` left value-based renames in the plan while they believed they
 * had turned them off. A silently-accepted typo is a tool doing the opposite of
 * what it was told.
 *
 * `wantsValue` names the flags that take one, so `--config` with nothing after
 * it fails here instead of reaching `path.resolve(true)`.
 */
export function parseArgs(argv = process.argv.slice(2), { flags = null, wantsValue = [], usage = null } = {}) {
  // --help was accepted as a flag and then did nothing: it fell through to
  // config loading, so asking for help returned "rename.config.json not found".
  // It also meant the manual had to carry every flag list itself, at a token
  // cost paid on every run rather than only when someone asks.
  if (usage && (argv.includes('--help') || argv.includes('-h'))) {
    console.log(usage.trim());
    process.exit(0);
  }
  const args = { _: [] };
  const needsValue = new Set(wantsValue);
  for (let i = 0; i < argv.length; i++) {
    const item = argv[i];
    if (!item.startsWith('--')) {
      args._.push(item);
      continue;
    }
    const key = item.slice(2);
    if (flags && !flags.includes(key)) {
      const near = flags.filter((f) => f.startsWith(key.slice(0, 3)) || key.startsWith(f.slice(0, 3)));
      throw new Error(
        `Unknown flag --${key}.` +
          (near.length ? ` Did you mean --${near.join(' or --')}?` : '') +
          `\nValid flags: ${flags.map((f) => `--${f}`).join(', ')}`,
      );
    }
    const next = argv[i + 1];
    if (needsValue.has(key)) {
      if (next === undefined || next.startsWith('--')) {
        throw new Error(`--${key} needs a value.`);
      }
      args[key] = next;
      i++;
      continue;
    }
    if (next === undefined || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

/** Flags every CLI accepts. */
export const COMMON_FLAGS = ['config', 'help'];

export { VALID_KINDS, VALID_SPELLINGS };
