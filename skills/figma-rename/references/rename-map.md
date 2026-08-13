# The `rename-map.json` contract


## Contents

- Shape
- Fields
- `from` is a guard, not an input
- `code` vs `codeSuggestion`
- `reason` and `confidence` are the review surface
- `calibration`
- Editing by hand
- What is deliberately absent

---

One file, read by both sides of the rename. `emit-figma.mjs` turns it into a
Figma script; `apply-code.mjs` turns it into a codemod. There is one list of
pairs, which is the whole reason the two sides cannot drift.

Commit it. It is the reviewable artefact — the thing a designer and a developer
can read together, and the thing that makes the change explainable later.

## Shape

```json
{
  "version": 2,
  "fileKey": "abc123…",
  "convention": { "…echo of the config that produced this…" },
  "batches": [
    {
      "id": "variable-2-semantic",
      "kind": "variable",
      "scope": "2. Semantic",
      "pageId": null,
      "status": "planned",
      "renames": [
        {
          "id": "VariableID:1:23",
          "from": "color/text-primary",
          "to": "text/primary/default",
          "source": "rule",
          "rule": "color/text-* -> text/$1/default",
          "decision": "accepted"
        },
        {
          "id": "VariableID:1:31",
          "from": "Value 1",
          "to": "spacing/md",
          "source": "generic",
          "reason": "collection \"Spacing\"; scope GAP; value 16 is a multiple of 4",
          "confidence": "high",
          "decision": "pending"
        }
      ]
    }
  ],
  "needsReview": [
    {
      "kind": "variable",
      "id": "VariableID:1:99",
      "name": "brand",
      "scope": "1. Primitive",
      "suggestion": "brand",
      "why": "1 segment(s), convention.structure.minSegments is 2"
    }
  ]
}
```

## Fields

| field | required | meaning |
|---|---|---|
| `version` | yes | `1`. A mismatch is refused rather than best-guessed. |
| `fileKey` | no | the Figma file, echoed into `emit-figma.mjs`'s hint |
| `convention` | no | a copy of the rules that produced this map, for the record |
| `batches[].id` | yes | unique; the unit of `--batch`, of one `use_figma` call, and of one commit |
| `batches[].kind` | yes | `variable`, `component`, `componentSet`, `layer`, `textStyle`, `effectStyle`, `paintStyle` |
| `batches[].scope` | no | collection or page name — what the batch was grouped by |
| `batches[].pageId` | no | node kinds only; `emit-figma.mjs` emits the page switch from it |
| `batches[].status` | no | `planned` → `figma-applied` → `applied`. Defaults to `planned`; only `review.mjs mark` moves it |
| `renames[].decision` | no | `pending` / `accepted` / `rejected`. Defaults to `pending`, and `emit-figma` refuses a batch that still has any |
| `conventionHash` | no | fingerprint of the convention this was planned under; `check.mjs` refuses a mismatch |
| `renames[].id` | yes | the Plugin API id. The rename is applied to **this**, not to the name |
| `renames[].from` | yes | the current name. Validated against the inventory *and* against Figma at apply time |
| `renames[].to` | yes | the new name |
| `renames[].source` | no | where the name came from: `rule`, `value`, `shape`, `generic`, `human` |
| `renames[].rule` | no | which convention rule produced it; provenance for review |
| `renames[].reason` | no | why the suggest engine chose this name — the thing review actually checks |
| `renames[].confidence` | no | `high` / `medium` / `low`, from how many signals agreed |
| `renames[].code` | no | explicit literal pairs for the codemod (see below) |
| `renames[].codeSuggestion` | no | a *proposal* for `code`, ignored by every tool |
| `needsReview[]` | no | what the convention refused to decide |

## `from` is a guard, not an input

The rename targets `id`. `from` exists so the operation can refuse: if the
entity is not currently called that, someone changed the file since the
inventory was captured, and applying the map would rename the wrong thing while
reporting success.

It is checked twice — by `check.mjs` against `inventory.json`, and again inside
the generated Figma script against live Figma. The second check is the one that
catches a designer working in the file while the plan was being reviewed.

## `code` vs `codeSuggestion`

For token kinds every code spelling is **derived** — the generator performs
exactly that transform, so it can be reversed with certainty. Nothing needs to
be written here.

For components and layers the code symbol is a **convention of that codebase**,
not a derivation. `plan.mjs` writes its PascalCase guess into `codeSuggestion`,
which every downstream tool ignores. Promoting it to `code` is a human act:

```json
"code": [
  { "from": "BtnPrimary", "to": "ButtonPrimary" },
  { "from": "btn-primary", "to": "button-primary", "guard": "kebab" }
]
```

`guard` picks the boundary rule. All eight, exactly as spelled — the casing is
inconsistent for historical reasons, which is why a typo is refused rather than
quietly accepted:

| guard | matches |
|---|---|
| `ident` (default) | a whole identifier — no word character either side |
| `cssvar` | a CSS custom property; `--a-b` never matches inside `--a-b-c` |
| `kebab` | a hyphenated name at a boundary |
| `path` | a slash path, e.g. a Figma name in a Code Connect entry |
| `tailwind` | the token text behind a Tailwind utility prefix (`bg-`, `text-`, …) |
| `tailwindGroup` | same, but lets a suffix follow — for moving a whole group |
| `member` | only after a dot: `AppColors.primary` |
| `dot` | a DTCG dot path |

An unknown guard is a validation error naming these eight. Omitting it is the
documented default, not a typo. Check the symbol exists before promoting it:

```bash
rg -w 'BtnPrimary' --stats
```

## `reason` and `confidence` are the review surface

A rename produced by a rule needs no explanation — the rule is the
explanation, and it is in the config. A rename produced by reading a value
does, because nothing else in the file says why `Value 1` should become
`spacing/md`.

That is what makes a 300-row map reviewable. The question at review time
becomes *"is this reason true"*, which a person answers in a second, instead of
*"do I like this name"*, which nobody answers 300 times honestly. Sort by
confidence and read the `low` ones first; they are the guesses.

`plan.mjs --min-confidence medium` drops the guesses before they reach the map
at all.

## `calibration`

Present when the suggest engine ran. It records which lightness→shade ladder
was used, because that single fact decides whether every colour shade in the
map is right:

```json
"calibration": {
  "chromatic": { "source": "calibrated", "shades": 13 },
  "neutral":   { "source": "calibrated", "shades": 16 },
  "families": 15
}
```

`"source": "builtin"` on a file that obviously has ramps means the inventory
did not capture values, or the ramps are not named with a numeric last
segment — and the shades in this map should not be trusted until that is
fixed. See `references/suggest-engine.md`.

## Editing by hand

Expected and supported. Nothing downstream distinguishes a name that came from
a rule from one you typed. Common edits:

- fix a proposal you disagree with — change `to`
- drop a rename — delete the entry
- resolve a `needsReview` — move it into a batch with a `to` you chose
- split a batch that is too big to review — cut the `renames` array in two and
  give the halves distinct `id`s

Re-run `check.mjs` after any edit. It is the only thing standing between a
hand-edited map and a half-applied rename.

## What is deliberately absent

- **No values.** This file renames; it never changes what a token *is*. A batch
  whose diff contains both is unreviewable, and when something looks wrong
  afterwards there is no way to tell which half caused it.
- **No timestamps.** They make every regeneration a diff, which trains people
  to skim the diff.
- **No results.** What actually landed is the `use_figma` return value; put
  that in the commit message. A file that records both intent and outcome
  invites the two to disagree.

## The lifecycle, and why it is in this file

The ladder is **per source**, and the map records which one applies in its own
top-level `source` field (`"figma"` or `"code"`, defaulting to `"figma"` for maps
written before the key existed). Not read from the config at run time: a status
already recorded has to be interpretable from the map alone, or editing
`rename.config.json` mid-run silently reinterprets finished work. Loading a map
whose stamp disagrees with the config refuses.

`source: "figma"` — three states, because Figma can be ahead of the code:

```
planned ──emit-figma + use_figma──▶ figma-applied ──apply-code + check──▶ applied
   │                                     │                                  │
   └── editable, re-plannable            └── Figma is ahead of the code      └── commit
```

`source: "code"` — two, because there is nothing for the code to be behind.
`figma-applied` is not skipped here, it is **invalid**, and a map carrying it is
refused:

```
planned ──apply-code --write + mark──▶ applied
   │                                      │
   └── editable, re-plannable             └── check --after, then commit
```

**Do not confuse this with `renames[].source`**, which says where a *proposal*
came from (`rule`, `value`, `shape`, `generic`, `human`). Same word, different
question: one is about the project, the other about a single row.

Only `review.mjs mark` moves a batch, one step at a time, and the flip lands
**inside that batch's commit**. So `git revert` on the commit restores the status
at the same moment it restores the code — lifecycle state and code state cannot
disagree across a revert, which is what makes "one batch = one commit = one
rollback" a property rather than a habit.

A side journal (`rename/applied.json`) would have done the same job only if
everyone remembered to stage it. And since re-planning has to merge human edits
regardless, the journal's one advantage — letting plan overwrite freely — was
never real.

**`status` is not an outcome log.** What actually happened in Figma is the
`use_figma` return value, and that belongs in the commit message.

## What re-planning keeps

`plan.mjs` merges; it does not overwrite. Keyed by Figma id, because names are
exactly what is in motion:

| in the old map | after a re-plan |
|---|---|
| a batch that reached Figma | copied through byte-for-byte, id never reused |
| `rejected`, same target | still rejected, note intact |
| a hand-written name (`source: human`) | wins over the fresh proposal |
| `accepted`, but the convention now proposes something else | back to `pending`, with a note saying what it was |
| a `skip`ped open question | never raised again |

`--fresh` discards pending decisions. Nothing discards an applied batch.

## Editing it by hand

Every field above is written by a tool, and `review.mjs` is the only writer of
`decision` and `status`. Hand-edits are not forbidden — it is JSON — but a
re-plan reconciles against decisions, and a row you deleted is a row the next
plan proposes again. Rejecting it records the answer; deleting it does not.

```bash
node "$S/review.mjs" reject  --batch <id> --ids V1 --note "keep the old name"
node "$S/review.mjs" set-to  V2 --to text/brand/default
node "$S/review.mjs" resolve V3 --to palette/brand
node "$S/review.mjs" skip    V4 --note "brand is fine as it is"
```
