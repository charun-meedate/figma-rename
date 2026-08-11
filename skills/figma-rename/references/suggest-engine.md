# The suggest engine: naming a variable from its value


## Contents

- Turning it on
- Rules beat suggestions; normalisation does not
- Colour
- Numbers
- Which names get a suggestion at all
- What goes to review instead
- Reason and confidence are not decoration
- Known limits
- Verifying

---

Half of a rename needs no intelligence at all. `{r:0.231, g:0.510, b:0.965}`
is blue at 60% lightness — that is arithmetic, and arithmetic is right every
time, runs over 700 variables instantly, costs nothing, and can state its
reason. An agent reading hex codes is slower and occasionally wrong, which is
the worst combination for a bulk rename.

The other half needs judgement that no formula has: whether that blue is the
brand, a link colour, or an informational state. The engine does not attempt
it. Anything whose answer is a *role* comes back with **no name and a reason**,
for a human — or an agent reading the codebase — to settle.

That split is the whole design:

```
value  →  what it IS      engine      colors/blue/500, spacing/md, fontWeight/bold
value  →  what it MEANS   not here    primitive/red/500 → semantic/error/default
```

## Turning it on

The engine runs during `plan.mjs` whenever the inventory carries values. It is
not a separate command — a suggestion is just a rename whose `to` came from a
formula instead of a rule, and it flows through `check.mjs`, `emit-figma.mjs`
and `apply-code.mjs` exactly like any other.

```bash
node "$S/plan.mjs"                          # values present → suggestions on
node "$S/plan.mjs" --min-confidence medium  # drop the low-confidence guesses
node "$S/plan.mjs" --no-suggest             # rules only
```

If the inventory has no `value` fields the engine is silently off. That is the
most common reason it appears to do nothing — `references/inventory.md` has the
read script that captures values, `scopes` and alias pointers.

## Rules beat suggestions; normalisation does not

A rule that matched is something the team decided. A suggestion is something a
formula noticed. So:

| situation | winner |
|---|---|
| a `convention.rules` glob matched | the rule |
| only case/alias normalisation applied | the suggestion |
| nothing applied | the suggestion |

The middle row matters more than it looks. Without it, `Color 1` normalises to
`color-1` — tidier, no more meaningful — and that pointless rename shuts out
the suggestion that knows the thing is blue.

## Colour

### Chroma, not HSL saturation

The obvious rule for "is this grey" is *saturation below 10%*. It does not
survive contact with a real design system, because almost every one of them
tints its neutrals:

| Tailwind | hex | HSL saturation | chroma | obviously |
|---|---|---|---|---|
| `gray-500` | `#6b7280` | 9% | 0.08 | grey |
| `gray-900` | `#111827` | **39%** | 0.09 | grey |
| `gray-950` | `#030712` | **72%** | 0.06 | grey |
| `blue-500` | `#3b82f6` | 91% | 0.73 | blue |

HSL saturation blows up as lightness approaches either end, so the same grey
ramp reads 9% at the middle and 72% at the bottom. **Chroma** (`max − min` of
the channels) has no such failure and separates all eleven Tailwind greys from
all eleven blues — except the two palest blues, which carry so little colour
that "pale blue" and "blue-tinted grey" are the same measurement.

Those come back named, at **medium** confidence, with a reason that says why.
That is the correct answer to a question the value genuinely cannot settle.

```
chroma < 0.04   certainly neutral   → white / black / gray/NNN, high
chroma < 0.15   ambiguous           → gray/NNN, medium, reason states the tint
otherwise       chromatic           → hue/NNN
```

There is one escape from the middle band: if the file has a **calibrated ramp
at that hue**, that ramp is evidence the value cannot supply. `#FFE8E4` next to
a red ramp is the top of that ramp, not an off-white — so it is named
`red/050`, at medium confidence, with the ramp cited in the reason.

### Tinted neutrals versus pure greys

A design system often carries both: a pure grey ramp *and* a blue-grey ramp
(`nevada`, `slate`, `zinc` — everyone names it differently). They are not
interchangeable, and telling them apart needs one more distinction than chroma
alone provides.

- A **tinted neutral** ramp keeps its hue. A blue-grey at hue 215 sitting
  beside a real blue ramp at hue 220 must stay on its own ladder — without
  this, every step of it gets pulled onto the blue ladder. Measured on a
  production file: that single mistake cost 11 of 16 steps in one ramp.
- A **pure grey** ramp reports hue 0 only because hue is *undefined* when there
  is no colour. It is noise, not a direction. Families whose members are all
  under 2% chroma are flagged `achromatic` and never match on hue — otherwise
  a grey ramp competes for every pale red and pale blue in the file, which on
  the same production file cost four steps each from red and blue.

Both rules were found by running against a real file, not by reasoning, and
both have tests pinned to the values that exposed them.

### Hue

`HUE_RANGES` covers the circle and **wraps**: red is `0–15` *and* `345–360`.
Without the second entry every crimson above 345° falls off the end of the
table and gets the wrong name, which is the most visible way a colour namer
looks broken.

A hue within 5° of a range boundary is offered at medium confidence — at that
distance the name is honestly a coin flip.

### Shade ladders, and why they are learned

The lightness→shade mapping is the part most likely to be wrong for any given
file, so the built-in ladders are a **fallback**, not the answer.

The built-ins are calibrated against Tailwind and checked step by step: every
one of `blue-50…blue-950` lands on its own name, and likewise `gray-50…gray-950`
(neutrals need a separate ladder — Tailwind's `gray-900` sits at L=11% while
`blue-900` sits at L=33%, so one shared table cannot name both).

But a table calibrated against Tailwind is worth very little against a design
system that is not Tailwind. Measured against one production palette here:

```
its ramp:   010 025 050 075 100 200 … 900 925 950 975     (not Tailwind's vocabulary)
its 500:    L=47%                                          (Tailwind's 500 is L=60%)
built-in ladder on that ramp:   010→50, 025→100, 050→100    wrong the whole way down
```

So `calibrateShades()` learns the real mapping from ramps the file already has.
A design system that numbers its ramp at all has already answered "which
lightness is 500 here", and its answer beats any table shipped in a script.

Calibration is **per ramp**, not pooled over the file: a yellow and a blue at
the same shade number sit at very different lightnesses. On that production
palette, pooled calibration round-trips 215 of 240 steps; per-ramp gets 228
(95%), across 15 ramps learned automatically.

Measured again on a second, unrelated production file (16 ramps, 256 numbered
steps):

```
learned from the file : 234/256  (91%)   → 201/208 (97%) once the genuinely
                                            ambiguous steps are set aside
built-in ladder       :  59/256  (23%)
```

Two files, two different shade vocabularies, the same conclusion: a shipped
table is not usable on its own.

The remaining misses are of three kinds, and none of them is fixable by a
better table:

- **Steps one or two lightness points apart** (`010` at 98%, `025` at 97%). No
  lightness-only ladder can separate those.
- **Two ramps at the same hue** — see below.
- **A ramp that is not monotone.** On that second file, `925` is *darker* than
  `950` in three of sixteen ramps. A ladder built from lightness cannot
  reproduce an ordering the source does not have; the ramp itself is what needs
  fixing. Worth checking for in any file before blaming the shades.

### When two ramps share a hue

`palette/red` and `palette/brand-primary` on that file sit **one degree apart**
in hue, and their `500` steps are at L=60% and L=39%. A colour at h=357 L=39%
is honestly `red/700` **or** `brand-primary/500` — the value cannot say which
ramp it belongs to, and neither can any amount of arithmetic.

Picking one silently is the failure mode. Instead both readings are named, and
the confidence drops to `low`:

```
palette/brand-primary/500 -> colors/red/700  [low]
  Red hue (357°), L:39% — but this file has two ramps at this hue that
  disagree: palette/red/700 or palette/brand-primary/500. The value cannot
  say which one this belongs to
```

The same applies across the neutral boundary: a pale blue-grey is honestly
`nevada/010` or `blue/050` when the file holds both ramps. On that file 48 of
256 steps were flagged this way — which is the honest count of "this file's
own palette is ambiguous here", not a failure rate.

`plan.mjs` prints which path was taken:

```
[plan] shade ladders — chromatic: learned from 13 shade(s) in this file; neutral: learned from 16
[plan]   15 ramp(s) calibrated individually
```

Seeing `built-in ladder (no ramp to learn from)` on a file that clearly has
ramps means the inventory did not capture values, or the ramps are not named
with a numeric last segment.

### Alpha

Any alpha below opaque earns a `/alpha-NN` suffix — not only the
near-transparent ones. Two variables identical except for alpha must not
suggest the same name, and the palette measured here has six such variants per
ramp.

## Numbers

### The signal order is the design

`8` is a legal spacing **and** a legal radius. `0.5` is a legal opacity **and**
a legal half-pixel. The value alone can never settle that, so it is consulted
last:

```
1. collection name    "Spacing"                strong
2. variable scopes    GAP, CORNER_RADIUS       strong
3. name keywords      "radius", "gap"          strong
4. value range        0–1, 100–900, ×4         weak — never better than low
```

Confidence follows directly: two or more strong signals agreeing is `high`,
exactly one is `medium`, value-range alone is `low`. A `low` suggestion is
still worth showing — it is often right — but it is labelled as the guess it is.

`scopes` is the cheapest big win here, and it is free if the inventory captured
it. `GAP` alone turns a low-confidence guess into a medium-confidence one.

### Scales

| category | table | example |
|---|---|---|
| spacing | `SPACING_SEMANTIC` (default) or `SPACING_NUMERIC` | `16 → spacing/md` / `spacing/4` |
| radius | `RADIUS_SEMANTIC` | `8 → radius/lg`, `9999 → radius/full` |
| fontSize | `FONTSIZE_SEMANTIC` | `24 → fontSize/2xl` |
| fontWeight | `FONTWEIGHT_NAMES` | `700 → fontWeight/bold` |
| opacity | computed | `0.5 → opacity/50` |

Pick the spacing style in config — teams genuinely differ:

```json
"convention": { "sizeNaming": "semantic" }   // or "numeric"
```

A value that is not on the scale is **not** a failure. `18` in a spacing
collection becomes `spacing/18` with the confidence dropped one level and a
reason saying so. Inventing a nearest step would be worse than saying nothing.

## Which names get a suggestion at all

```js
valueBasedApplies(name)  →  isGenericName(name) || !name.includes('/')
```

A name that already carries a group path is a decision somebody made —
`text/primary/default` means something the value cannot see. Proposing
`colors/gray/900` for it would put noise on every well-named token in the file.

Generic names are detected on the **leaf** segment, so `palette/Color 4` counts:

```
Variable 1 · Color 12 · Value 3 · Token 2 · Untitled · New 5 · 404
```

## What goes to review instead

Two things get no name, on purpose.

**Aliases.** A variable whose value points at another variable is a semantic
token, and its correct name is its role — brand? error? surface? — which the
value cannot reveal. The spec this engine was built from suggests
`primary/default` for such a case; that is a guess wearing a suggestion's
clothes, and at 300 rows nobody catches it. It becomes:

```
Color 5 — alias of colors/blue/500 — a semantic token, so the name is its role
          (brand? error? surface?), which the value cannot tell you
```

**Duplicates.** When two variables would get the same name, that is not a
naming collision to paper over with a numeric suffix — it means they hold the
same value:

```
Color 1 — same value as "primary" — both would be "colors/blue/500".
          Merge them, or make one an alias of the other
```

A `colors/blue/500-2` would hide the actual problem and ship it.

Both land in the map's `needsReview`, and both are excluded from the batches
entirely — so neither picks up a stray normalisation rename on top of its open
question.

## Reason and confidence are not decoration

Every suggestion carries both into `rename-map.json`:

```json
{
  "id": "VariableID:1:23",
  "from": "Value 1",
  "to": "spacing/md",
  "source": "generic",
  "reason": "collection \"Spacing\"; scope GAP; value 16 is a multiple of 4",
  "confidence": "high"
}
```

This is what makes a 300-line map reviewable. The question at review time
becomes *"is this reason true"*, which a person can answer in a second, instead
of *"do I like this name"*, which they cannot answer 300 times. A suggestion
with no reason is not reviewable at all — it can only be approved wholesale,
which is worse than not suggesting.

`source` says where the name came from: `rule`, `value`, or `generic` (a
value-based name for something that had no real name to begin with).

## Known limits

- **Two ramp steps within ~2% lightness cannot be told apart.** Nothing that
  reads only lightness can. They appear as neighbouring-shade misses.
- **Two ramps at the same hue cannot be told apart either.** Both readings are
  named and the confidence drops; there is no correct single answer to give.
- **A ramp that is not ordered by lightness cannot be reproduced.** Check the
  source ramp before treating this as a naming bug.
- **A very pale or very dark tint is ambiguous by measurement**, not by
  implementation. Calibrated ramps resolve most of these; the rest are labelled.
- **Meaning is out of scope**, permanently. Roles, states, brand — those need
  the codebase and the team's intent, which is the agent's job, not this file's.
- **The built-in ladders assume a Tailwind-shaped palette.** If the file has no
  numbered ramp to learn from and is not Tailwind-shaped, shades will be off.
  The plan output says which ladder was used; check it before trusting shades.
- **STRING and BOOLEAN variables get no suggestion.** A font family or a flag
  has no value-derived name worth proposing.

## Verifying

```bash
node "$S/selftest.mjs"
```

The engine's cases assert on real palettes rather than invented ones: all
eleven Tailwind blues and greys against the built-in ladders, a non-Tailwind
production ramp against calibration (including that the built-in ladder
*visibly fails* there, so the test would catch calibration silently switching
off), hue wrap-around, the alpha suffix, the signal-order rules, and both
review paths.
