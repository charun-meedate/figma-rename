# figma-rename — reference

> [ภาษาไทย](REFERENCE.md) · English

## Contents

- [What it can rename](#what-it-can-rename)
- [The flow](#the-flow)
- [One standard across projects (`extends`)](#one-standard-across-projects-extends)
- [Naming a component from its structure](#naming-a-component-from-its-structure)
- [Smart Suggest — naming a variable from its own value](#smart-suggest-naming-a-variable-from-its-own-value)
- [Where this skill refuses to guess](#where-this-skill-refuses-to-guess)
- [What is checked before anything is applied (`check.mjs`)](#what-is-checked-before-anything-is-applied-checkmjs)
- [Test status](#test-status)
- [Skill layout](#skill-layout)

---

Rename tokens and components in Figma while keeping the names in code in step.
This document explains how each part works and why.
If you are starting out, read [GETTING-STARTED.en.md](GETTING-STARTED.en.md) first.

Grew out of the Rename Tokens PoC (7 steps in 4 phases), turned into something
repeatable and reversible.

**There is only one real problem:**

```
Figma binds by id     →  renaming breaks nothing
code binds by name    →  renaming breaks everything that referenced it
```

So a rename is never "a job in Figma". It is **one change that has to land on
both sides at once**, and this skill forces it into batches of one commit each
— which is steps 5–6 of the deck, made mechanical.

## What it can rename

Variables (tokens), Component / Component Set, layers inside a component,
Text / Effect / Paint styles.

## The flow

```bash
S=".claude/skills/figma-rename/scripts"
cp "$S/rename.config.example.json" rename.config.json    # point it at the shared standard with extends

# 1. read what exists out of Figma (use_figma read-only → rename/inventory.json)
#    the scripts are in references/inventory.md — Claude runs them

# 2. propose new names → rename-map.json  (a PROPOSAL; read it)
node "$S/plan.mjs" --kind variable

# 3. decide, in groups — nothing undecided can ship
node "$S/review.mjs" list --batch variable-2-semantic
node "$S/review.mjs" accept --batch variable-2-semantic --rule strip-color-prefix

# 4. refuse before touching anything
node "$S/check.mjs" --code

# 5. apply in Figma, one batch at a time (prints a script for use_figma)
node "$S/emit-figma.mjs" --batch variable-2-semantic
node "$S/review.mjs" mark variable-2-semantic --figma-applied   # after use_figma succeeds

# 6. re-capture the dumps from Figma FIRST, then regenerate and rewrite
node ".claude/skills/figma-token-export/scripts/sync.mjs" dumps/*.json
node "$S/apply-code.mjs" --batch variable-2-semantic            # dry run first, always
node "$S/apply-code.mjs" --batch variable-2-semantic --write

# 7. verify, mark, commit
node "$S/check.mjs" --after
node "$S/review.mjs" mark variable-2-semantic --applied
```

A batch moves one way — `planned → figma-applied → applied` — and only by an
explicit command. That state lives in the map, which rides in the same commit as
the code, so `git revert` restores it for free.

Rollback: `node "$S/emit-figma.mjs" --batch <id> --reverse`, then `git revert`
that commit.

## Two shapes of project

`source` says which side the names come from, and it changes exactly one thing:
whether the run has a Figma leg. The standard, the review gate and the codemod
are identical either way — which is the whole point, one standard across both.

| `"source"` | how you know | the loop |
|---|---|---|
| `"figma"` (default) | `figma.fileKey` is required | plan → review → check → **emit-figma → use_figma → mark --figma-applied** → apply-code → check --after → mark --applied |
| `"code"` | tokens are hand-written, nothing upstream | plan → review → check → apply-code --write → **mark --applied** → check --after |

The batch ladder is shorter under `code` — `planned → applied`, with
`figma-applied` not skipped but **invalid**; a map carrying it is refused. The
`source` is stamped into the map itself, the way `conventionHash` is, because a
status already recorded has to be readable from the map alone rather than from a
config that can be edited afterwards.

A `code` project's inventory comes from `capture-css.mjs` or `capture-dart.mjs`,
and rollback is `git revert` on its own.

## One standard across projects (`extends`)

A project's `rename.config.json` should hold only that project's facts. The
naming rules live in one file that every project extends:

```jsonc
{ "extends": "aurora",                       // a preset shipped with the skill
  "extends": "../design-system/naming.json"  // or your team's file, resolved from the config
}
```

The merge is shallow, block by block, and **arrays replace rather than append**.
A project that writes its own `convention.rules` loses the shared file's rules
entirely — they are not added to. That is deliberate: "these, not those" has to
be sayable, and appending silently would keep alive the very rules a project was
trying to drop, which reads as the shared standard misbehaving.

The consequence worth knowing: **do not write a partial `rules` list in a
project.** Adding one rule means restating all of them, at which point you have
copied the convention into the project after all. Add it to the shared file
instead. Each rule is tagged with the file it came from, so a rule that fails to
compile names its source file rather than just `rules[3]`.

Presets included: `starter` (permissive, right for a first file) and `aurora`
(strict, with a full component vocabulary). Drop your team's preset into
`presets/` and refer to it by name.

`convention.transform` is the tidy-up pass that runs before the rules —
`stripPrefix`, `stripSuffix`, `addPrefix`, `separator`, `replace`. All of them
are idempotent, and none will strip a name down to nothing. Case and the number
scale are *not* here: those are `segmentCase` and `sizeNaming`.

## Naming a component from its structure

A token can be named from its value; a component has no value to read. What it
has is structure — what it contains, how deeply, whether there is text, which
way auto-layout runs. `lib/classify.mjs` feeds those signals through 50
priority-ordered rules and answers with a component kind.

```
Frame 427   -> Button      [high]   one text child, rounded fill, no input descendant
Group 12    -> Modal       [medium] overlay + close button + 3 levels of nesting
```

Tune it under `convention.components.classifier` in the preset: `minConfidence`
drops the weak calls, `priorities` moves individual rules up or down,
`pageHints` treats the page name as extra evidence, and `disable` turns off a
rule that misfires on your file. All data — no JS to fork.

These rules need each component's `signature`, captured during inventory (the
script is in `references/inventory.md`). Without a signature, a component gets
no suggestion at all.

## Smart Suggest — naming a variable from its own value

When the inventory captures **values** (not just names), `plan.mjs` gains a
second source of proposals:

```
Value 1      -> spacing/md       [high]   collection "Spacing"; scope GAP; 16 is a multiple of 4
weight-bold  -> fontWeight/bold  [high]   scope FONT_WEIGHT; name contains "weight-bold"; 700 is a 100–900 step
heading      -> fontSize/2xl     [medium] scope FONT_SIZE; 24 is in the type-scale range
dark bg      -> colors/gray/900  [medium] low chroma (9%) with a blue tint, L:11% — tinted neutral or a very pale blue
Variable 3   -> opacity/50       [low]    0.5 is in the 0–1 range
```

`{r:.231, g:.510, b:.965}` is blue at L=60%. That is **arithmetic** — right
every time, 700 variables done instantly, free, and able to state its reason.
An LLM reading hex codes one at a time is slower and occasionally wrong, which
is the worst possible combination for a bulk rename.

**What the engine does not do is MEANING** — whether this blue is the brand or
a link colour, no formula can say. Those come back as **no name plus a reason**
for a person, or an agent reading the codebase, to settle.

### Four places the original spec could not be used as written

| problem | what this does instead |
|---|---|
| `saturation < 10% → gray` fails on real design systems — `#111827` (gray-900) reads **39%** saturation and `#030712` reads **72%**, because HSL saturation blows up near either end of lightness | measure **chroma** instead; separates Tailwind's greys **11/11** (was 4/11) |
| the shade table contradicts its own example — it puts 500 at L≤55%, but the example in the same doc (Tailwind blue-500) sits at L=60% and would come out `blue/400` | recomputed and checked step by step: **blue 9/11, gray 11/11** |
| a fixed table is useless against a real team palette — one numbers its ramp `010/025/075/925/975` and puts `500` at L=47%, where a Tailwind table gives `010→50, 025→100`, wrong the whole way down | **learn the ladder from the ramps in the file**, per ramp — on that palette: 15 ramps learned, round-trip **228/240 (95%)** |
| the example produces duplicate names itself — `Color 1` and `primary` share a value, both become `colors/blue/500`, and the spec says to add a number suffix | no suffix, because that is a **duplicate value, not a name collision** → `needsReview`: *"merge them, or make one an alias of the other"* |

### The rules that keep review possible

- **A rule beats a suggestion** when the rule actually matched (a team decision
  outranks a formula) — but bare normalisation does not, otherwise `Color 1`
  becomes `color-1` and shuts out `colors/blue/500`.
- **Confidence tracks how many signals agree** — collection → scopes → name
  keyword → value range. A value range on its own can never exceed `low`,
  because `8` is a legal spacing *and* a legal radius.
- **Every suggestion carries a `reason`** into the map, so the review question
  becomes "is this reason true" — answerable in a second — instead of "do I
  like this name", which nobody answers honestly 300 times.
- **Names that already have a group path** (`text/primary/default`) are never
  proposed, or every well-named token in the file would be offered
  `colors/gray/900`.

Full detail — tables, thresholds, known limits — is in
`skills/figma-rename/references/suggest-engine.md`.

## Where this skill refuses to guess

- A name the convention cannot decide (too few segments, unknown category)
  comes back as `needsReview` with `to: null` for a human, rather than a guess
  waiting for someone to approve it by reflex.
- **Component names in code are not derived** (`btn primary` → `BtnPrimary` is
  a guess, not a transform). They are offered as `codeSuggestion` for a human
  to confirm — unlike tokens, where the derivation is certain because the
  generator performs exactly the same transform.
- A namespace that **splits into several** gets no class rename (`color/**`
  becoming both `text/**` and `surface/**` has no single correct new class).
  The compiler names those call sites precisely instead.

## What is checked before anything is applied (`check.mjs`)

- the map has gone stale (`from` no longer matches Figma) → re-capture the
  inventory
- duplicate names inside one collection → Figma would reject mid-batch
- **identifier collisions in code** — `text/primary/default` and
  `text/primary-default` are both perfectly good Figma names that flatten to
  one `textPrimaryDefault`, and one of the two then disappears silently
- rename chains (`a→b` while `b→c`) → warned, and `emit-figma` stages them
  through temporary names automatically
- `--code` reports up front how many places each name actually touches. Zero
  hits on a token you know is in use means the config is spelling it wrong —
  much cheaper to learn now than after rewriting 400 files

## Test status

`node skills/figma-rename/scripts/selftest.mjs` — 198 cases, all passing.
Covers convention rules and templates, boundary guards (`--text-primary` must
not match inside `--text-primary-default`; `.primaryDefault` only after a dot),
chains and swaps replaced simultaneously, all four `check` refusals (stale map /
duplicate name / identifier collision / namespace split), `emit-figma` staging,
reverse and page switching, dry-run vs `--write`, and `check --after` both
passing and catching a forgotten regenerate.

The suggest engine is tested against real palettes rather than invented values:
all eleven Tailwind blue and grey steps against the built-in ladders, and a
non-Tailwind production ramp against calibration — including a case asserting
that the built-in ladder **visibly fails** on that ramp, so the tests would
catch calibration being silently switched off. Plus hue wrap-around at 0/360,
the alpha suffix, the number signal ordering, and both `needsReview` paths.

Scripts printed by `emit-figma.mjs` are parsed as an async function body on
every branch (plain / staged / code-syntax / node+page), so a syntax error
never reaches Figma.

Verified against a real Figma file: 1,148 variables read, one renamed, then
reversed. Fourteen semantic tokens still pointed at the renamed variable
afterwards — the claim this whole skill rests on, measured rather than assumed.

## Skill layout

```
skills/figma-rename/
├── SKILL.md                     what Claude Code loads
├── figma-rename.md              the full manual — the substance lives here
├── references/
│   ├── asking.md                wording the six questions Step 0 asks
│   ├── naming-convention.md     the segment model + writing it as rules
│   ├── suggest-engine.md        naming from values + what it refuses to guess
│   ├── inventory.md             use_figma read scripts, per kind
│   ├── figma-apply.md           applying a batch, atomicity, chains, rollback
│   ├── components.md            component / variant property / layer / Code Connect
│   ├── code-sync.md             the spellings in code + generated vs hand-written
│   └── rename-map.md            the rename-map.json contract
├── presets/                     the shared naming standard
├── evals/                       6 behavioural tests
└── scripts/
    ├── capture-css.mjs          inventory from CSS custom properties (source: code)
    ├── capture-dart.mjs         inventory from a Dart token class / ThemeExtension
    ├── plan.mjs                 inventory + convention + suggest → rename-map.json (a proposal)
    ├── review.mjs               accept/reject/resolve + the only writer of batch status
    ├── check.mjs                refuses a map that would break (+ --code, --after)
    ├── emit-figma.mjs           batch → a script for use_figma (+ --reverse)
    ├── apply-code.mjs           codemod across the repo (dry-run by default)
    ├── selftest.mjs             198 cases
    ├── rename.config.example.json
    └── lib/
        ├── suggest.mjs          value → name (colour / number) + calibration
        ├── classify.mjs         component structure → a kind
        ├── handoff.mjs          cross-check against tokens.config.json
        ├── detect.mjs           which shape of project this is
        ├── convention.mjs       rules + normalisers
        ├── codemod.mjs          code spellings + simultaneous replacement
        └── …
```

> `lib/naming.mjs` is duplicated into both skills on purpose — the codemod has
> to spell identifiers exactly the way the generator writes them. If the two
> drift, the codemod renames things to spellings nothing generates, and the
> project breaks in a way that is hard to trace. `figma-rename`'s `selftest.mjs`
> checks the shared functions are byte-identical. **Change one, change the other.**
