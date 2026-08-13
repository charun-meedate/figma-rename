# Maintaining figma-rename — for people running the scripts or changing the skill

> [ภาษาไทย](MAINTAINING.md) · English
> Just using it, not running scripts → [GETTING-STARTED.en.md](GETTING-STARTED.en.md)
> Why it works the way it does → [REFERENCE.en.md](REFERENCE.en.md)

## สารบัญ

- [Layout](#layout)
- [Running the scripts yourself](#running-the-scripts-yourself)
- [Minimum config](#minimum-config)
- [The order that must not be swapped](#the-order-that-must-not-be-swapped)
- [Troubleshooting](#troubleshooting)
- [Confirmed limits](#confirmed-limits)
- [Changing the skill](#changing-the-skill)
- [Further reading](#further-reading)

---

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

Every script takes `--help` and answers without a config — the full flag list
lives there. Below are the ones used often.

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

# 3. decide (review.mjs is the only writer of decision/status)
node "$S/review.mjs" status                            # every batch: status + counts
node "$S/review.mjs" list --batch <id> --pending       # the full list, untruncated
node "$S/review.mjs" accept --batch <id> --rule <rule-name>
node "$S/review.mjs" accept --batch <id> --min-confidence medium
node "$S/review.mjs" reject --batch <id> --ids a,b,c
node "$S/review.mjs" set-to <id> --to "text/primary"   # edit a proposal (source: human)
node "$S/review.mjs" resolve <id> --to "brand/primary" # needsReview → into the batch
node "$S/review.mjs" skip <id>                         # leave it; survives a re-plan

# 4. refuse before touching anything
node "$S/check.mjs"           # against the inventory
node "$S/check.mjs" --code    # + scan the repo for how many places will change
node "$S/check.mjs" --code --no-namespace-classes   # skip generated class names

# 5. build the Figma script
node "$S/emit-figma.mjs" --batch <id>
node "$S/emit-figma.mjs" --batch <id> --with-code-syntax   # write code names back into Figma
node "$S/emit-figma.mjs" --batch <id> --reverse            # rollback
node "$S/review.mjs" mark <id> --figma-applied            # after use_figma succeeds

# 6. re-capture dumps → regenerate → codemod
node "$S/apply-code.mjs" --batch <id>                    # dry run (default)
node "$S/apply-code.mjs" --batch <id> --write
node "$S/apply-code.mjs" --batch <id> --write --no-namespace-classes

# 7. verify
node "$S/check.mjs" --after
node "$S/review.mjs" mark <id> --applied   # no old spelling may survive anywhere
```

Step 5 prints JS on stdout — paste it into `use_figma` yourself (or let Claude
do it). Logs go to stderr, so the output pipes cleanly.

---

## Minimum config

```json
{
  "extends": "aurora",
  "figma": { "fileKey": "SjE7hLqGcKYLy4XMgXGhlM" },
  "code": {
    "generated": ["src/tokens/**"],
    "cssPrefix": "",
    "flutterPrefix": "App"
  }
}
```

**`extends` is what makes this work across projects.** The convention lives in
one file — a preset shipped with the skill, or the team's own — and each project
overrides only what it genuinely differs on, normally just `figma.fileKey` and
`code.*`. See the merged result with `node "$S/plan.mjs" --print-config`.

A convention copy-pasted into every project is not a standard; it is several
standards that happen to agree today.

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


## When the skill itself misbehaves

The table above fixes problems with a *run*. This one fixes problems with the
*skill* — when the scripts are all correct and the agent still does not follow
what is written. Adapted from
[make-skill-great](https://github.com/punnaruthaphi/make-skill-great).

| Symptom | Usual cause | Where to fix it |
|---|---|---|
| never invoked | `description` lacks the words users actually type | the `description` in `SKILL.md`, not the body |
| invoked for unrelated work | triggers too broad, or forceful language | collapse triggers to genuinely distinct cases, lower the intensity |
| stops while unfinished | vague completion conditions | that step's **Done when** line in `figma-rename.md` |
| does the thing you forbade | a prohibition makes the behaviour more salient | rewrite leading with what to do, keeping the prohibition as the exception |
| never opens a `references/` file | the pointer is worded weakly | reword the pointer before pulling the content back inline |
| skips a step entirely | the instruction sits too deep to be read | move it into `SKILL.md`, the one file always loaded |
| grows without improving | sediment, until what matters is buried | run a full prune pass — see the next section |

The bottom two both happened to this skill: the MCP shortcut during inventory,
and the convention questions being skipped. Both times the guidance was already
correct and three files too deep. **What worked was moving it up, not saying it
louder.**
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
- **Verified against a real Figma file.** 1,148 variables read, one renamed,
  then reversed. Fourteen semantic tokens still pointed at the renamed variable
  afterwards — which is the claim this whole skill rests on, measured rather
  than assumed.

---

## Changing the skill

Two things have to pass, and they check different things:

```bash
node skills/figma-rename/scripts/selftest.mjs     # 170 cases — the scripts are right
```

and the **evals** in `skills/figma-rename/evals/`, which check that the *agent
walks the process correctly* — does it ask about the convention first, does it
capture values or only names, does it stop for `needsReview`, does it
regenerate before the codemod. Passing the selftest says nothing about those.
How to run and score them: [evals/README.md](../skills/figma-rename/evals/README.md)

Things to be careful about:

**`lib/naming.mjs` must not drift from `figma-token-export`'s copy** — the
codemod has to spell identifiers exactly the way the generator writes them. The
`naming.lock.json` pins a hash of every shared function, so the selftest catches
drift even with the other repo nowhere on the machine. Re-lock deliberately with
`--relock`, **then make the same change in figma-token-export.**

**Adding your team's preset** — drop a file at
`skills/figma-rename/presets/<name>.json`, same shape as `aurora.json`, and a
project refers to it with `"extends": "<name>"`. No code change. A preset may
itself extend another (nesting is allowed), and a shared file outside this repo
is referenced by path, resolved from the config that names it.

**Retuning the classifier** — do not fork `lib/classify.mjs`; put it in the
preset:

```jsonc
"components": { "classifier": {
  "minConfidence": "medium",
  "priorities": { "Tooltip": 139 },      // override that rule's priority
  "disable": ["Radio Button"],           // switch off a rule that misfires here
  "pageHints": { "Forms": ["Text Input", "Checkbox"] }
} }
```

Higher priority wins. Move one rule at a time and run the selftest — its cases
come from real components that were once classified wrong (a button read as
Tooltip, a numeric badge read as Radio Button), so an over-eager shove breaks
them immediately.

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
