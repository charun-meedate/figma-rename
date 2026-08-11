# Maintaining figma-rename — for people running the scripts or changing the skill

> [ภาษาไทย](MAINTAINING.md) · English
> Just using it, not running scripts → [GETTING-STARTED.en.md](GETTING-STARTED.en.md)
> Why it works the way it does → [REFERENCE.en.md](REFERENCE.en.md)

---

## Layout

```
skills/figma-rename/
├── SKILL.md                     what Claude Code loads (frontmatter + pointer)
├── figma-rename.md              the full manual — the substance lives here
├── references/                  loaded on demand
│   ├── naming-convention.md     the segment model + writing it as rules
│   ├── suggest-engine.md        naming from values + what it refuses to guess
│   ├── inventory.md             use_figma read scripts, per kind
│   ├── figma-apply.md           applying a batch, atomicity, chains, rollback
│   ├── components.md            component / variant property / layer / Code Connect
│   ├── code-sync.md             the spellings in code + generated vs hand-written
│   └── rename-map.md            the rename-map.json contract
└── scripts/                     Node 18+, no dependencies
```

**The scripts live inside the skill, not in the project.** The data files
(`rename.config.json`, `rename/inventory.json`, `rename/rename-map.json`) live
in the **project** and resolve relative to `rename.config.json`, not the cwd —
so you can run them from anywhere.

```bash
S=".claude/skills/figma-rename/scripts"          # installed into the project
# S="$HOME/.claude/skills/figma-rename/scripts"  # installed with --global
```

---

## Running the scripts yourself

```bash
cp "$S/rename.config.example.json" rename.config.json    # once per project

# 1. inventory — cannot be run here; it goes through use_figma (references/inventory.md)

# 2. propose names
node "$S/plan.mjs"                          # every kind in config.kinds
node "$S/plan.mjs" --kind variable          # variables only
node "$S/plan.mjs" --only "color/**"        # one slice of names
node "$S/plan.mjs" --max-batch 25           # smaller batches
node "$S/plan.mjs" --min-confidence medium  # drop low-confidence suggestions
node "$S/plan.mjs" --no-suggest             # convention rules only
node "$S/plan.mjs" --dry-run                # print the summary, write nothing

# 3. refuse before touching anything
node "$S/check.mjs"           # against the inventory
node "$S/check.mjs" --code    # + scan the repo for how many places will change

# 4. build the Figma script
node "$S/emit-figma.mjs" --batch <id>
node "$S/emit-figma.mjs" --batch <id> --with-code-syntax   # write code names back into Figma
node "$S/emit-figma.mjs" --batch <id> --reverse            # rollback

# 5. codemod
node "$S/apply-code.mjs" --batch <id>                    # dry run (default)
node "$S/apply-code.mjs" --batch <id> --write
node "$S/apply-code.mjs" --batch <id> --write --no-namespace-classes

# 6. verify
node "$S/check.mjs" --after   # no old spelling may survive anywhere
```

Step 4 prints JS on stdout — paste it into `use_figma` yourself (or let Claude
do it). Logs go to stderr, so the output pipes cleanly.

---

## Minimum config

```json
{
  "figma": { "fileKey": "SjE7hLqGcKYLy4XMgXGhlM" },
  "convention": {
    "segmentCase": "kebab",
    "rules": [{ "match": "color/text-*", "to": "text/$1/default" }],
    "conforming": ["spacing/**", "radius/**"]
  },
  "code": {
    "generated": ["src/tokens/**"],
    "cssPrefix": "",
    "flutterPrefix": "App"
  }
}
```

**`cssPrefix` and `flutterPrefix` must match `tokens.config.json`** from
`figma-token-export`. If they do not, the codemod matches nothing and silently
does no work.

`generated` lists the files the generator writes — the codemod skips them,
because regenerating overwrites them anyway.

---

## The order that must not be swapped

```
1. rename in Figma
2. regenerate token files   (sync.mjs from figma-token-export)
3. codemod the consumers    (apply-code.mjs --write)
4. build / test
5. commit — all of it, one commit
```

Between 1 and 3 the tree does not compile. That is fine; committing in that
state is not. `check.mjs --after` deliberately scans generated files too,
because "clean consumers but a stale `tokens.css`" means someone skipped step 2.

---

## Troubleshooting

| message | cause | what to do |
|---|---|---|
| `rename.config.json not found` | run outside the project, or config not copied yet | copy it from the example into the project root |
| `Could not read …/inventory.json` | the inventory has not been captured | capture it through `use_figma` (references/inventory.md) |
| `re-capture the inventory` | names changed in Figma after the capture | re-read, re-plan — do not force the apply |
| `"X" would be the name of both A and B` | two things landing on one name in one collection | Figma rejects this anyway; fix the map |
| `Identifier collision` | different Figma names flatten to one identifier in code | rename one of them differently |
| `Ambiguous rewrite` | one literal asked to become two different things | the map cannot be applied; fix it, not the ordering |
| `X spelling(s) matched nothing` | the codebase spells tokens differently from `code.spellings` | check `cssPrefix` / `spellings` before `--write` |
| `built-in ladder (no ramp to learn from)` | the inventory has no `value`, or ramps do not end in a number | capture values, or colour shades will be off |
| `stranded __rn_tmp_` in Figma | a staged batch stopped halfway | re-capture the inventory and plan from the real state |

---

## Confirmed limits

- **The team is on the Organization plan, not Enterprise** — the REST Variables
  API is unavailable for both read and write. The working path is MCP
  `use_figma` (Plugin API), which is what this skill uses.
- **Library (remote) entities cannot be renamed from a consuming file.** Open
  the source file.
- **`use_figma` is atomic** — a script that throws is not executed at all,
  which is why the generated script validates every id before mutating the
  first one.
- **The codemod only reaches literal text.** Names assembled at runtime
  (`'--' + kind + '-' + variant`) are invisible to it; grep for the fragments
  after a batch.
- **Never run against a real production Figma file yet.** The Figma side is
  tested to the level of "the generated script is correct and parses on every
  branch".

---

## Changing the skill

```bash
node skills/figma-rename/scripts/selftest.mjs     # 60 cases, all must pass
```

Things to be careful about:

**`lib/naming.mjs` must not drift from `figma-token-export`'s copy** — the
codemod has to spell identifiers exactly the way the generator writes them. The
selftest compares the shared functions byte for byte (and skips itself if the
export skill is not checked out alongside). **Change one, change the other.**

**Adding a new code spelling** (Kotlin, Swift, …) — edit `spellingsFor` in
`lib/codemod.mjs`, add a guard to `GUARDS`, and register the name in
`VALID_SPELLINGS` in `lib/config.mjs`.

**Adding a new number category** (z-index, duration, …) — edit
`lib/suggest.mjs`: add entries to `NAME_CATEGORY` and `SCOPE_CATEGORY`, plus
the semantic table for that category.

**Adjusting the colour tables** — `HUE_RANGES` / `SHADE_CHROMATIC` /
`SHADE_NEUTRAL` in `lib/suggest.mjs`. Before you do, check whether calibration
already solves the problem: the built-in tables are only a fallback for files
with no ramp to learn from.

The selftest is bound to real palettes, not invented values — all eleven
Tailwind blue and grey steps, and a non-Tailwind production ramp, including a
case asserting that the built-in ladder **visibly fails** on that ramp so the
tests catch calibration being silently switched off.

---

## Further reading

- Why it works the way it does → [REFERENCE.en.md](REFERENCE.en.md)
- The full manual Claude reads → `skills/figma-rename/figma-rename.md`
- The rename-map.json contract → `skills/figma-rename/references/rename-map.md`
