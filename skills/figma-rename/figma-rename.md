# Renaming a design system, in Figma and in code

<!-- The operating manual for the figma-rename skill. `SKILL.md` next to this
     file carries the frontmatter Claude Code's loader reads and points here;
     keep the two in sync when the scope of the skill changes. -->


## Contents

- Where the scripts live
- Step 0 — ask, at every point where there is a choice
  (every step ends with a **Done when** line — that is the test for whether it is finished)
- Step 1 — inventory: what is actually in the file (Figma, or the codebase)
- Step 2 — plan: propose, and leave the deciding to a person
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

Copy this into your reply at the start of **each batch** and tick as you go.
A rename lands on two systems at once, so a step skipped here leaves Figma and
the code disagreeing — the exact state this skill exists to prevent.

```
Batch <id> progress:
- [ ] 2 · plan — rename-map.json written, every status counted
- [ ] 3 · check.mjs exits 0 — errors cleared, warnings read — if not, back to 2
- [ ] 4 · applied in Figma, pair count matches, marked --figma-applied
- [ ] 5 · dumps RE-CAPTURED AFTER the Figma rename, tokens regenerated, apply-code --write
- [ ] 6 · check.mjs --after exits 0, build and tests pass, marked --applied, one commit
```

Step 5's capital letters are there because regenerating from older dumps
restores the old names and every check still comes back green.

## Where the scripts live

**The scripts ship inside this skill, not in the user's project.** Resolve the
path before running anything, and use it in every command below — a bare
`node scripts/plan.mjs` from a project root fails with "module not found",
which reads like a broken tool when it is only a wrong path.

```bash
# installed into the project (install.sh, the usual case)
S=".claude/skills/figma-rename/scripts"

# or the skill repo checked out next to the project
S="../figma-rename/skills/figma-rename/scripts"

# or installed for the user only
S="$HOME/.claude/skills/figma-rename/scripts"

# Confirms the path AND that the config is readable, in one command.
node "$S/plan.mjs" --print-config
```

Everything the scripts read or write — `rename.config.json`, `inventory.json`,
`rename-map.json`, the codebase — lives in the **project**, resolved relative to
`rename.config.json`. Only the code lives in the skill.

Every script takes `--help` and answers without needing a config, so the flag
lists are not repeated below. This manual covers what the flags are *for*; the
scripts cover what they are called.

## Step 0 — ask, at every point where there is a choice

This skill exists so that several projects end up agreeing on one set of names.
That only works if the person running it understands what they are agreeing to,
and most of them will not have read any of this. **Ask rather than assume, ask
in plain language, and always say what you would pick and why.** A user who
answers "whatever you think" has at least been told what they are getting.

Use `AskUserQuestion`, one round at a time, recommendation first and marked
`(recommended)`. Never ask an abstract question when you could ask it with the
user's own names in front of them.

**Ask in the language the user is writing in.** This manual is in English; most
of the people running it are not. A question they have to translate before they
can answer is a question that gets "whatever you think".

The six rounds, in order. Each one's wording, the options, what each answer
costs, and the recommendation to lead with are in
[`references/asking.md`](references/asking.md) — open it before the first
question of a run, because a round asked in the abstract gets "whatever you
think", which is the answer that produces a convention nobody agreed to.

| round | decides |
|---|---|
| 0 · where do the names live today? | Figma upstream, hand-written in the repo, or both and drifting — it sets `source` and decides whether the run has a Figma leg at all |
| 1 · is there already a standard? | whether the project extends a shared convention or invents its own |
| 2 · what is in scope? | variables · components · inner layers · styles — blast radius differs enormously |
| 3 · the format | shown with the user's own names, never as an abstract pattern |
| 4 · the review | the one part only a person can do |
| 5 · before applying | batch size, and where the run is going |


**Done when:** every round has an answer on record — including "whatever you think" — the config names the standard it extends, and the user has seen the batch size they are agreeing to. A run where nothing was asked is not done, it is unstarted.

## Step 1 — inventory: what is actually in the file

```
source: figma   use_figma (read-only) ──────▶ rename/inventory.json
source: code    capture-css.mjs / capture-dart.mjs ──▶ rename/inventory.json
```

Where it comes from depends on Round 0's answer. **With `source: "code"` the
capture is a script in this skill** — `capture-css.mjs` for CSS custom
properties (`--layer color- --flat` for a shadcn-shaped file where `@theme`
holds the names and `:root` only holds values), `capture-dart.mjs` for a Dart
token class or a `ThemeExtension`. Both take `--dry-run`, and both print the
names they derived, because turning `-` into `/` is a guess about the project.
`references/inventory.md` covers each. The rest of this step is the Figma path.

The inventory is a flat list of `{kind, id, name, scope, value, scopes}`
captured straight out of Figma. **Capture the values, not just the names** —
they are what the suggest engine reads and what it calibrates shade ladders
against. A name-only inventory silently turns the engine off. It is captured with `use_figma` read scripts — **you** run those, the
scripts here cannot reach Figma. `references/inventory.md` has one script per
kind, plus the page fan-out rule (one `setCurrentPageAsync` per call; parallel
calls for multiple pages).

> **Use those scripts. Do not assemble the inventory out of the convenience MCP
> tools** — `get_variable_defs`, `list_file_components_for_code_connect`,
> `get_metadata`. They are the obvious shortcut, and an eval run took it and
> produced a confident audit that nothing downstream could use:
>
> | The capture scripts give you | `get_variable_defs` gives you |
> |---|---|
> | every variable in the file | only the ones **used** by the nodes you queried — 368 of 1,148 |
> | `id` | nothing, so no rename can be addressed and `emit-figma` has no target |
> | `valuesByMode`, every mode | one resolved value from the default mode; Dark is invisible |
> | an alias kept as a pointer | the alias resolved away, so semantic tokens read as raw values |
> | `scopes` (GAP, CORNER_RADIUS…) | nothing — the strongest signal numeric tokens have |
> | `collection` | nothing, so shade ladders cannot be calibrated per ramp |
>
> Every one of those losses is silent: the plan still runs, it just proposes
> worse names and cannot be applied to anything. **If what you captured has
> names but no ids, it is not an inventory** — it is a report.

Commit it. Two reasons, both load-bearing:

1. It is the only record of what the names **were**. Six months later the
   rename map alone does not tell you what else was in the file.
2. `check.mjs` refuses a rename map whose `from` names no longer match the
   inventory. That is what catches "a designer renamed three of these while we
   were planning" — the failure mode that otherwise renames the wrong variable
   and reports success.

Re-capture the inventory before every planning pass. It is one read call.

**Done when:** `rename/inventory.json` exists, every entry carries an `id`, token entries carry values and `scopes`, and it was captured after the last change anyone made to the file. If it has names but no ids, it is a report, not an inventory.

## Step 2 — plan: propose, and leave the deciding to a person

```bash
node "$S/plan.mjs"                    # every kind in config.kinds
node "$S/plan.mjs" --kind variable    # narrow it — see --help for the rest
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

**Done when:** `rename-map.json` exists and `plan.mjs` printed a count for every status. Rows in `needsReview` are expected here — leaving them unanswered is Step 0's Round 4, not a failure of this step.

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

**Done when:** `check.mjs` exits 0. Warnings may remain and each one has been read; errors may not. If it refuses, the fix is the map or the config, never the check.

## Step 4 — apply the batch in Figma

> **`source: "code"` skips this step entirely** — there is no Figma to apply to,
> and `emit-figma` refuses rather than generating a script against a file that
> does not exist. Go straight to Step 5, then record the write with
> `review.mjs mark <id> --applied`.

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

**Done when:** `use_figma` returned the pair list it renamed, its count matches the batch, and `review.mjs mark <id> --figma-applied` has recorded it. Until that mark exists, `apply-code --write` refuses — which is the check on this step, not an obstacle to it.

## Step 5 — bring the code across

> **Under `source: "code"` this step IS the rename**, and its order is different:
> `apply-code --write` runs while the batch is still `planned`, then
> `review.mjs mark <id> --applied` records it, then `check --after` verifies.
> The mark has to come before the check — until it exists, `check --after` cannot
> tell a written batch from an unwritten one. There are no dumps to re-capture
> and nothing to regenerate; re-run `capture-css.mjs` only when the token file
> changes for some other reason.

Order matters, and it is not the obvious one. Four steps, none of them optional
if the project uses `figma-token-export`:

```bash
# 1. RE-CAPTURE the dumps from Figma — the rename just changed the names
#    (use_figma / get_variable_defs, exactly as figma-token-export documents)

# 2. regenerate the token files from those fresh dumps
node ".claude/skills/figma-token-export/scripts/sync.mjs" dumps/*.json

# 3. rewrite everything that REFERENCES those tokens
node "$S/apply-code.mjs" --batch <id>            # dry run first — always
node "$S/apply-code.mjs" --batch <id> --write

# 4. build / analyze / test
```

**Step 1 is the one people skip, and it fails silently.** `sync.mjs` reads
whatever is in `dumps/` — if those files were captured before the Figma rename,
it faithfully regenerates the OLD names. The tree then compiles against a
`tokens.css` that disagrees with Figma, `check.mjs --after` reports stale names
in a generated file, and nothing in that message points at the dumps.

**If the project has no `figma-token-export`**, skip steps 1–2 and set
`"generated": []` in `rename.config.json` — otherwise the codemod skips the very
files that need renaming. `check.mjs` warns when `generated` is non-empty and
there is no `tokens.config.json` to explain it.

Between step 1 and step 3 the tree does not compile. That is expected and fine
— what must never happen is *committing* in that state.

### `check.mjs` cross-checks the two configs for you

When a `tokens.config.json` is present (or `code.tokensConfig` points at one),
`check.mjs` compares the settings that have to agree and refuses on a mismatch:

| figma-rename | figma-token-export | why it matters |
|---|---|---|
| `code.cssPrefix` | `targets[type=web].cssPrefix` | wrong ⇒ every CSS var is spelled wrong and the codemod reports "matched nothing" |
| `code.flutterPrefix` | `targets[type=flutter].`**`prefix`** | wrong ⇒ namespace class rewrites target classes that do not exist |
| `code.generated` | `targets[].out` | missing ⇒ the codemod patches files the next generate erases |

Note the asymmetry in the second row — the key is `prefix` there and
`flutterPrefix` here. It is the kind of thing that is obvious once and invisible
forever after, which is why the check does it rather than the reader.

It also warns when a rename moves a first segment that a `layers` glob in
`tokens.config.json` matches. Those globs are matched on **token names**, so
moving `palette/**` to `primitive/**` orphans `"primitive": ["palette/**"]`, the
tokens fall into `other`, and every target selecting that layer quietly stops
containing them. Update the glob in the same commit.

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

**Done when:** dumps were re-captured *after* the Figma rename, tokens were regenerated from them, `apply-code --write` reported the files it changed, and the project builds. Regenerating from older dumps restores the old names and everything still looks green.

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

**Done when:** `check.mjs --after` exits 0, the build and tests pass, `review.mjs mark <id> --applied` has run, and the batch is one commit that contains the map. Then the next batch starts at Step 2, not here.

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

**With `source: "code"` it is simpler, and `emit-figma --reverse` is not part of
it** — it refuses, correctly, because there is no Figma file to walk back:

```bash
git revert <the batch commit>          # the rewrite AND the batch status, together
node "$S/capture-css.mjs" <file>       # the token file moved back; re-read it
```

The status lives in the map, the map is in the commit, so the revert restores
`planned` along with the names. That is the whole reason the status is not kept
in a separate journal. Outside git there is no rollback at all for a code-source
batch — which is what `check`'s not-in-git warning is really telling you.

## Pitfalls worth knowing before they cost an afternoon

- **Under `source: "code"`, record the write before you verify it.** `apply-code
  --write` leaves the batch `planned`; until `mark --applied` runs, `check
  --after` cannot tell it from a batch nobody has touched and will say there is
  nothing to verify. It says which batch to mark, but the order is the fix.
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
- **Keep a batch to renames only.** A batch whose diff contains
  both is unreviewable, and when something looks wrong afterwards there is no
  way to tell which half did it.
- **`get_metadata`'s page listing can be incomplete.** On at least one
  production file it reports only the cover page. When a page looks empty, ask
  for a node-specific link rather than concluding there is nothing there.
- **Let the generator rewrite the token files.** They are rebuilt from
  `tokens.json`; the help is erased by the next generate.

## Verifying the tooling itself

```bash
node "$S/selftest.mjs"          # the scripts still work
```

Run it after touching anything in `scripts/`. What it covers is recorded in the
project's `docs/MAINTAINING.md`.

One assertion in there is worth knowing about: every naming function shared with
`figma-token-export` must be byte-identical. The codemod's correctness rests on
producing exactly the identifiers that skill's generators emit — if the two
drift, the rewrite renames things to spellings nothing generates.

## Reference files

- `references/asking.md` — the six rounds of Step 0, worded for a person who has read none of this
- `references/naming-convention.md` — the segment model, and writing it as rules
- `references/suggest-engine.md` — naming a variable from its value, and what it refuses to guess
- `references/inventory.md` — the read-only `use_figma` scripts, per kind
- `references/figma-apply.md` — applying a batch, atomicity, chains, rollback
- `references/components.md` — components, variant properties, layers, Code Connect
- `references/code-sync.md` — spellings, generated vs hand-written, verification
- `references/rename-map.md` — the `rename-map.json` contract
