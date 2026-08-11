# Renaming a design system, in Figma and in code

<!-- The operating manual for the figma-rename skill. `SKILL.md` next to this
     file carries the frontmatter Claude Code's loader reads and points here;
     keep the two in sync when the scope of the skill changes. -->


## Contents

- Where the scripts live
- Step 0 — agree the scope and the convention before touching anything
- Step 1 — inventory: what is actually in the file
- Step 2 — plan: propose, do not decide
- Step 3 — check: refuse before applying
- Step 4 — apply the batch in Figma
- Step 5 — bring the code across
- Step 6 — verify, then commit the batch
- Rolling a batch back
- Pitfalls worth knowing before they cost an afternoon
- Verifying the tooling itself
- Reference files

---

Renaming is the one design-system change that is trivially safe on one side and
breaking on the other:

- **In Figma**, every binding is by internal ID. Rename `color/text-primary` to
  `text/primary/default` and not one layer changes appearance. Instances stay
  attached, variable bindings stay bound, published libraries keep working.
- **In code**, every reference is by name. `var(--color-text-primary)`,
  `AppColorColors.textPrimary`, a Code Connect entry, a comment in a README —
  all of them point at a string that no longer exists.

So the unit of work is never "rename in Figma". It is **one batch renamed on
both sides, verified, and committed together**. Everything below exists to make
that one unit small enough to review and cheap enough to undo.

```
Figma ──inventory──▶ inventory.json ──plan──▶ rename-map.json ──┬──▶ use_figma  (Figma)
       (read-only)    (committed)             (reviewed, committed)  └──▶ apply-code (repo)
```

`rename-map.json` is the contract. Both sides derive from the same list of
pairs, which is what stops the Figma names and the code names from drifting
apart — there is one list, not two.

## Where the scripts live

**The scripts ship inside this skill, not in the user's project.** Resolve the
path before running anything, and use it in every command below — a bare
`node scripts/plan.mjs` from a project root fails with "module not found",
which reads like a broken tool when it is only a wrong path.

```bash
# installed into the project (install.sh, the usual case)
S=".claude/skills/figma-rename/scripts"

# or the skill repo checked out next to the project
S="../design-tokens-skill/skills/figma-rename/scripts"

# or installed for the user only
S="$HOME/.claude/skills/figma-rename/scripts"

node "$S/check.mjs" --help 2>/dev/null || node "$S/plan.mjs" --dry-run   # confirm the path resolves
```

Everything the scripts read or write — `rename.config.json`, `inventory.json`,
`rename-map.json`, the codebase — lives in the **project**, resolved relative to
`rename.config.json`. Only the code lives in the skill.

## Step 0 — agree the scope and the convention before touching anything

Two questions decide the whole run, and both are the user's to answer. Ask with
`AskUserQuestion` rather than assuming.

**Which kinds are in scope?** (multi-select) — Figma variables, components and
component sets, layers inside components, text/effect styles. They have
different blast radii: a variable rename reaches every line of token-consuming
code; a layer rename inside a component reaches almost nothing (and matters
mostly for design-to-code output). Doing them in one pass makes the diff
unreadable, so scope narrowly and repeat.

**What is the target convention?** The convention has to be written down
*before* the first rename, because it is what makes the result reviewable — the
question at review time is "does this match the rule", not "do I like this
name". `references/naming-convention.md` covers the segment model
(system · component · category · concept · property · variant · scale) and how
to express it as rules in the config.

If the team already has a convention — an MD file, a Confluence page, an
existing well-named collection — read it and encode that. Do not invent a
second one.

Then copy `$S/rename.config.example.json` to the project root as
`rename.config.json` and fill it in. Every path resolves relative to that file.

## Step 1 — inventory: what is actually in the file

```
use_figma (read-only) ──▶ rename/inventory.json
```

The inventory is a flat list of `{kind, id, name, scope, value, scopes}`
captured straight out of Figma. **Capture the values, not just the names** —
they are what the suggest engine reads and what it calibrates shade ladders
against. A name-only inventory silently turns the engine off. It is captured with `use_figma` read scripts — **you** run those, the
scripts here cannot reach Figma. `references/inventory.md` has one script per
kind, plus the page fan-out rule (one `setCurrentPageAsync` per call; parallel
calls for multiple pages).

Commit it. Two reasons, both load-bearing:

1. It is the only record of what the names **were**. Six months later the
   rename map alone does not tell you what else was in the file.
2. `check.mjs` refuses a rename map whose `from` names no longer match the
   inventory. That is what catches "a designer renamed three of these while we
   were planning" — the failure mode that otherwise renames the wrong variable
   and reports success.

Re-capture the inventory before every planning pass. It is one read call.

## Step 2 — plan: propose, do not decide

```bash
node "$S/plan.mjs"                          # every kind in config.kinds
node "$S/plan.mjs" --kind variable          # one kind
node "$S/plan.mjs" --only "color/**"        # one slice
node "$S/plan.mjs" --max-batch 25           # smaller batches
node "$S/plan.mjs" --min-confidence medium  # drop low-confidence suggestions
node "$S/plan.mjs" --no-suggest             # convention rules only
```

`plan.mjs` walks the inventory through the convention and writes
`rename-map.json`. What it does is strictly mechanical: apply the first
matching rule, then normalise separator, case, and segment aliases. Every
proposal records the rule that produced it.

What it deliberately does **not** do is decide meaning. A name the convention
cannot resolve — too few segments, a first segment that is not one of the
declared categories — comes back under `needsReview` with `to: null` and the
reason. Those are for a human to fill in. A script that guessed there would be
producing exactly the plausible-but-wrong names that a reviewer waves through.

The statuses it reports:

| status | meaning |
|---|---|
| `renamed` | a rule matched |
| `suggested` | the value-based engine named it (see below) |
| `normalized` | no rule matched, but case/alias normalisation changed the name |
| `unchanged` | already correct |
| `conforming` | matched `convention.conforming` — deliberately left alone |
| `ignored` | matched `convention.ignore` — out of scope this pass |
| `needsReview` | nothing will decide it mechanically; `to` is null |

### Names the values already know

When the inventory carries values, a second source feeds the plan: a
value-based engine that reads what a variable **is**.

```
Value 1      -> spacing/md       [high]   collection "Spacing"; scope GAP; value 16 is a multiple of 4
weight-bold  -> fontWeight/bold  [high]   scope FONT_WEIGHT; name contains "weight-bold"; value 700 …
dark bg      -> colors/gray/900  [medium] Low chroma (9%) with a blue tint, L:11% — tinted neutral or a very pale blue
Variable 3   -> opacity/50       [low]    value 0.5 is in the 0–1 range
```

`{r:0.231, g:0.510, b:0.965}` is blue at 60% lightness. That is arithmetic —
right every time, instant across 700 variables, and able to state its reason.
An agent eyeballing hex codes is slower and occasionally wrong, which is the
worst combination for a bulk rename.

Three properties are worth knowing before trusting it:

- **Rules outrank suggestions**, but bare normalisation does not. A rule is a
  decision the team wrote down; turning `Color 1` into `color-1` is not, and
  letting it win would shut out the suggestion that knows the thing is blue.
- **Shade ladders are learned from the file**, not shipped. A palette that
  numbers its ramp `010…975` and puts `500` at L=47% gets named on its own
  ladder; a built-in table would be wrong the whole way down. Check the line
  `[plan] shade ladders — …` before trusting shades.
- **Meaning is out of scope.** An alias, or two variables sharing one value,
  come back as `needsReview` with the reason — never as a confident guess.

Everything the engine proposes carries a `reason` and a `confidence`, which is
what makes a 300-line map reviewable: the question becomes "is this reason
true", not "do I like this name". `references/suggest-engine.md` has the
thresholds, the tables, and the limits.

**Read the map before going further.** It is a proposal, and the review is the
point of the artefact. Edit names by hand freely — nothing downstream cares
whether a name came from a rule or from you.

Batches are grouped by kind and collection/page, and split at `--max-batch`
(default 40). One batch is one `use_figma` call and one commit. This is the
deck's "แบ่งแก้ทีละหมวด" made mechanical: a 400-token rename that fails at
token 380 is unreviewable and unrevertable; ten batches of 40 are both.

## Step 3 — check: refuse before applying

```bash
node "$S/check.mjs"           # against the inventory
node "$S/check.mjs" --code    # also: how many places in code will change
```

Every failure here is cheap; the same failure after applying is not.

- **Stale map** — a `from` that no longer matches the inventory. Re-capture and
  re-plan.
- **Duplicate target** — two things landing on one name. Figma *rejects* a
  duplicate variable name inside a collection outright, so this would throw
  mid-batch; duplicate component names are legal but make the picker a guessing
  game, so they warn.
- **Illegal names** — leading/trailing `/`, empty segments, stray whitespace.
- **Identifier collision** — the one that is invisible on the Figma side:
  `text/primary/default` and `text/primary-default` are two perfectly good
  Figma names that flatten to one `textPrimaryDefault` in generated code. One
  of the two tokens then silently disappears. This check runs the same
  `naming.mjs` the generators use, over the **post-rename** name set.
- **Rename chains** — `a → b` where something else is `b → c`. Reported as a
  warning only: `emit-figma.mjs` stages those through temporary names.

`--code` additionally scans the repo and reports occurrence counts per
spelling. Read the "matched nothing" list: a token you know is used appearing
there means the codebase spells it in a way `code.spellings` does not cover,
and finding that out **before** the rewrite is the entire point of running it.

## Step 4 — apply the batch in Figma

```bash
node "$S/emit-figma.mjs" --batch variable-color-semantic
```

This prints a script to pass to `use_figma`. Generate it — do not hand-write
one. A batch is 20–40 id/name pairs, and a mistyped id renames the wrong
variable with no error at all.

The generated script has three properties worth knowing, because they are what
make a batch safe:

1. **It resolves and validates every id before assigning any name.** If any id
   is missing, or its current name is not what the map says, it throws before
   mutating anything. `use_figma` does not execute a script that throws, so a
   rejected batch leaves the file untouched.
2. **It stages rename chains through temporary names** (`__rn_tmp_0`, …) so no
   intermediate state collides with a name still in use.
3. **It returns every `{id, from, to}` it touched**, which is the record that
   makes rollback trustworthy.

Load the `figma-use` skill before calling `use_figma` — it is a mandatory
prerequisite of that tool, and `references/figma-apply.md` covers the parts
specific to renaming: page context for node renames, why `figma.notify()` will
throw, and what a partial failure looks like.

Optional but recommended for variables:

```bash
node "$S/emit-figma.mjs" --batch <id> --with-code-syntax
```

That also writes `variable.setVariableCodeSyntax(...)` so Figma's Dev Mode
shows the exact code spelling (`var(--text-primary-default)`,
`textPrimaryDefault`). It is the cheapest possible defence against the next
person guessing the code name from the Figma name.

## Step 5 — bring the code across

Order matters, and it is not the obvious one. Do all three before building:

```bash
# 1. regenerate the token files from the renamed Figma (figma-token-export)
node ".claude/skills/figma-token-export/scripts/sync.mjs" dumps/*.json

# 2. rewrite everything that REFERENCES those tokens
node "$S/apply-code.mjs" --batch <id>            # dry run first — always
node "$S/apply-code.mjs" --batch <id> --write

# 3. build / analyze / test
```

Between step 1 and step 2 the tree does not compile. That is expected and fine
— what must never happen is *committing* in that state.

`apply-code.mjs` is dry-run by default. The interesting output is not "it
worked", it is the file list and the per-spelling counts. It skips everything
in `code.generated`, because those files are rebuilt from `tokens.json` and
patching them here either gets erased by the next generate or, worse, does not
and then disagrees with `tokens.json`.

One Figma name is several spellings in code, and all of them move at once:

| | example |
|---|---|
| Figma path | `text/primary/default` |
| CSS custom property | `--text-primary-default` |
| Dart/TS field | `textPrimaryDefault` |
| member in a namespace class | `AppTextColors.primaryDefault` |
| DTCG / JSON path | `text.primary.default` |

The rewrite is one simultaneous pass, not one pass per pair — otherwise a chain
`a → b` and `b → c` turns every `a` into `c`. Boundaries are guarded, so
`--text-primary` does not match inside `--text-primary-default`, and the member
spelling only matches after a dot. `references/code-sync.md` has the rest,
including why component code symbols come from explicit `code` pairs instead of
being derived.

## Step 6 — verify, then commit the batch

```bash
node "$S/check.mjs" --after     # no old spelling survives anywhere
<the project's build/test command>
git commit -m "rename: <batch id> — <what moved>"
```

`--after` scans the **whole** repo including generated files, which is
deliberate: a clean consumer rewrite plus a stale `tokens.css` means someone
skipped the regenerate step, and that is exactly the state this catches.

Then go back to step 4 with the next batch. One batch, one commit, every time.
The deck's step 6 — "ตรวจก่อนไปหมวดถัดไป, สั่ง commit ทุกรอบ" — is not
ceremony: it is what makes the next paragraph possible.

## Rolling a batch back

```bash
node "$S/emit-figma.mjs" --batch <id> --reverse    # → use_figma
git revert <the batch commit>
```

`--reverse` swaps every pair in the batch, so the same validate-then-mutate
script walks the names back. It validates against the *new* names, so running
it twice by accident fails loudly instead of scrambling anything.

This only works because a batch is one commit and one `use_figma` call. A
400-rename big-bang has no rollback — that is the real argument for batching,
not tidiness.

## Pitfalls worth knowing before they cost an afternoon

- **A rename in Figma is free; a rename in code is a breaking change.** If the
  design system is a published library, consumers only see the new names after
  it is published — and their code breaks then, not now. Renaming a published
  library is a coordinated release, not a cleanup.
- **`check.mjs` cannot see spellings you did not declare.** A codebase that
  writes tokens as `text_primary_default` when `code.spellings` lists only
  `camel` gets a silent no-op. Run `--code` and read the "matched nothing"
  list before the rewrite, not after.
- **A namespace that splits has no class rename.** Moving all of `color/**` to
  `surface/**` renames `AppColorColors` → `AppSurfaceColors` cleanly. Splitting
  `color/**` into `text/**` *and* `surface/**` does not — there is no single
  new class, so `apply-code.mjs` reports it and leaves those references to the
  compiler, which names them precisely.
- **Renaming a variant property is not a node rename.** A component set's
  variant properties come from its children's `Prop=Value` name strings, so
  renaming the property means renaming every child consistently. See
  `references/components.md`.
- **Library (remote) entities cannot be renamed from a consuming file.** Both
  `check.mjs` and the generated script report them rather than half-applying;
  open the source file.
- **Never rename and re-value in the same batch.** A batch whose diff contains
  both is unreviewable, and when something looks wrong afterwards there is no
  way to tell which half did it.
- **`get_metadata`'s page listing can be incomplete.** On at least one
  production file it reports only the cover page. When a page looks empty, ask
  for a node-specific link rather than concluding there is nothing there.
- **Do not hand-edit generated token files to "help".** They are rebuilt from
  `tokens.json`; the help is erased by the next generate.

## Verifying the tooling itself

```bash
node "$S/selftest.mjs"
```

Builds a throwaway project in a temp directory and drives the real CLIs over
it — convention rules and templates, boundary guards, simultaneous chain and
swap rewriting, the `check` refusals (stale map, duplicate target, identifier
collision), `emit-figma` staging and reverse, `apply-code` dry-run vs `--write`,
and `check --after` both passing and failing. Run it after touching anything in
`scripts/`.

It also asserts that every naming function shared with `figma-token-export` is
byte-identical. That check exists because the codemod's whole correctness rests
on producing the same identifiers that skill's generators emit; if the two
drift, the rewrite renames things to spellings nothing generates.

## Reference files

- `references/naming-convention.md` — the segment model, and writing it as rules
- `references/suggest-engine.md` — naming a variable from its value, and what it refuses to guess
- `references/inventory.md` — the read-only `use_figma` scripts, per kind
- `references/figma-apply.md` — applying a batch, atomicity, chains, rollback
- `references/components.md` — components, variant properties, layers, Code Connect
- `references/code-sync.md` — spellings, generated vs hand-written, verification
- `references/rename-map.md` — the `rename-map.json` contract
