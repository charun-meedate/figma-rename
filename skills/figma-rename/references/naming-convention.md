# The convention: deciding it, then writing it down


## Contents

- The segment model
- Case and separator
- Writing it as rules
- Scoping the pass
- Making the script refuse instead of guess
- Recording it for next time

---

A rename is only reviewable if the convention exists **before** the first name
changes. Otherwise every line of the diff is a fresh argument, and the review
degenerates into taste. With a convention written down, the review question is
narrow and answerable: *does this name follow the rule?*

## The segment model

A token name is not one word, it is an ordered stack of decisions. Nathan
Curtis's *Naming Tokens in Design Systems* (EightShapes, Oct 2020) is the
reference the team's PoC deck used, and its vocabulary is worth adopting
wholesale because it gives each segment a job:

```
$esds  -  color     -  feedback  -  background  -  error
system    category     concept      property       variant
                                                   → the background of an error state

$esds  -  marquee    -  space     -  inset    -  2-x   -  media-query  -  s
system    component     category     concept     scale    category        scale
                                                   → inset spacing of the marquee at breakpoint s
```

Not every system needs every segment. What matters is that a segment always
means the same thing at the same position, so a reader can decompose a name
without knowing the system.

Practical starting points for a product design system:

| segment | holds | examples |
|---|---|---|
| system | namespace, only when tokens from several systems coexist | `esds`, `aurora` |
| component | which component owns it, for component-layer tokens | `button`, `marquee` |
| category | what kind of thing | `color`, `space`, `radius`, `typography` |
| concept | the semantic role | `text`, `surface`, `border`, `feedback` |
| property | which property it paints | `background`, `foreground`, `border` |
| variant | the state or flavour | `primary`, `error`, `hover`, `disabled` |
| scale | position in a scale | `500`, `2-x`, `sm` |

Two rules that save more pain than any of the above:

- **Name by function, not by appearance.** `text/primary` survives a rebrand;
  `text/dark-blue` becomes a lie the first time the brand colour changes. The
  same rule is why the PoC deck calls out `IconLabel` over a name describing
  what it looks like.
- **A variant does not change the level.** `Button` with a `size` variant is
  still one component; do not encode variants into separate names when the
  design tool already has a variant axis for them.

## Case and separator

- **The separator is `/` and nothing else.** Figma builds the group tree in the
  Variables and Styles panels from slashes only. `rename.config.json` rejects
  any other separator, because a name using `.` or `-` as a hierarchy marker
  looks structured in JSON and collapses into one flat list in the Figma UI.
- **Case is per segment**, set once as `convention.segmentCase`. `kebab` is the
  safe default: it survives the round trip to every target this toolchain emits
  (CSS `--text-primary-default`, Dart `textPrimaryDefault`, Pascal classes),
  and it is unambiguous to split back into words.

The generator derives every code spelling from the Figma name, so the case
chosen here does **not** need to match the code's case. Choosing `camel` in
Figma to "match the code" only makes the Figma panel harder to scan.

## Writing it as rules

The config expresses the convention in two layers, applied in this order.

**1. Rules** — first match wins. `*` captures one segment, `**` captures the
rest, and `$1..$9` are the captures in order. Omit `to` to only normalise.

```json
"rules": [
  { "match": "color/text-*",  "to": "text/$1/default" },
  { "match": "color/bg-*",    "to": "surface/$1" },
  { "match": "color/**",      "to": "palette/$1" },
  { "match": "space/**",      "to": "spacing/$1" }
]
```

Order from most specific to least. `color/text-primary` matches both the first
and the third rule above; the specific one is declared first, so it wins.

**2. Normalisers** — applied to whatever the rules produced:

```json
"separator": "/",
"segmentCase": "kebab",
"aliases": { "bg": "background", "txt": "text", "btn": "button", "err": "error" }
```

Aliases match a **whole segment**, case-insensitively. That is deliberate: a
substring rule would turn `background` into `backgroundground` the second time
it ran, and renames do get re-run.

Normalisation is idempotent, which is what makes the whole thing safe to run
twice. `normalize(normalize(x)) === normalize(x)` is asserted in `selftest.mjs`.

## Scoping the pass

Two lists keep a pass small enough to review:

```json
"conforming": ["text/**", "surface/**", "spacing/**"],
"ignore":     ["_wip/**", "deprecated/**"]
```

- `conforming` — already correct. Reported as `conforming`, never proposed.
  This is the fastest way to shrink a run to only what is actually wrong.
- `ignore` — out of scope entirely: someone's sandbox, a deprecated group about
  to be deleted.

## Making the script refuse instead of guess

```json
"structure": {
  "minSegments": 2,
  "maxSegments": 5,
  "categories": ["text", "surface", "border", "icon", "palette", "spacing", "radius"]
}
```

A proposal that violates this comes back as `needsReview` with `to: null`, the
reason, and the name it *would* have produced as a suggestion. Nothing is
applied for those until a human writes the name in.

This is the most valuable part of the config, and the easiest to skip. A
one-word token like `brand` or `mystery` has no mechanical correct answer:
without `structure` the script would confidently normalise it to `brand` and
report success, and the pass would silently leave the exact names that needed a
decision untouched and unflagged.

## Recording it for next time

Once a pass lands, write the convention into the project — the deck's step 7.
`rename.config.json` already *is* that record, in executable form, so the
cheapest thing that works is to commit it with a short prose header in the
project README explaining the intent behind the rules.

Next run then starts at step 1 instead of step 0.
