// Loads and validates rename.config.json.
//
// Every path in the config resolves relative to the config file itself, so the
// scripts run from any working directory — from the project root, from a
// subfolder, or from CI — without a cwd convention people will get wrong.
import fs from 'node:fs/promises';
import path from 'node:path';

import { CASE_STYLES } from './convention.mjs';

const CONFIG_NAME = 'rename.config.json';

const VALID_KINDS = new Set(['variable', 'component', 'componentSet', 'layer', 'textStyle', 'effectStyle', 'paintStyle']);

const VALID_SPELLINGS = new Set(['figmaPath', 'cssVar', 'kebab', 'camel', 'camelMember', 'pascal', 'snake', 'dot']);

const DEFAULTS = {
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

export async function loadConfig(explicitPath) {
  const configPath = explicitPath ? path.resolve(explicitPath) : await findConfigPath();
  const rootDir = path.dirname(configPath);

  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(configPath, 'utf8'));
  } catch (err) {
    throw new Error(`Could not parse ${configPath}: ${err.message}`);
  }

  const config = { ...DEFAULTS, ...parsed };
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
      roots: config.code.roots.map((r) => path.resolve(rootDir, r)),
      tokensConfig: config.code.tokensConfig ? path.resolve(rootDir, config.code.tokensConfig) : null,
    },
  };
}

/** Minimal flag parser: `--key value` and `--flag`. */
export function parseArgs(argv = process.argv.slice(2)) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const item = argv[i];
    if (item.startsWith('--')) {
      const key = item.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        args[key] = true;
      } else {
        args[key] = next;
        i++;
      }
    } else {
      args._.push(item);
    }
  }
  return args;
}

export { VALID_KINDS, VALID_SPELLINGS };
