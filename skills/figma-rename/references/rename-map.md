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
  "version": 1,
  "fileKey": "abc123…",
  "convention": { "…echo of the config that produced this…" },
  "batches": [
    {
      "id": "variable-2-semantic",
      "kind": "variable",
      "scope": "2. Semantic",
      "bucket": "variable:2. Semantic",
      "pageId": null,
      "renames": [
        {
          "id": "VariableID:1:23",
          "from": "color/text-primary",
          "to": "text/primary/default",
          "source": "rule",
          "rule": "color/text-* -> text/$1/default"
        },
        {
          "id": "VariableID:1:31",
          "from": "Value 1",
          "to": "spacing/md",
          "source": "generic",
          "reason": "collection \"Spacing\"; scope GAP; value 16 is a multiple of 4",
          "confidence": "high"
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
| `renames[].id` | yes | the Plugin API id. The rename is applied to **this**, not to the name |
| `renames[].from` | yes | the current name. Validated against the inventory *and* against Figma at apply time |
| `renames[].to` | yes | the new name |
| `renames[].source` | no | where the name came from: `rule`, `value`, or `generic` |
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

`guard` picks the boundary rule — `ident` (default), `kebab`, `cssvar`, `path`,
`member`, `dot`. Check the symbol exists before promoting it:

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
