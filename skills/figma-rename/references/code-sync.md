# Bringing the code across


## Contents

- Order of operations
- Which spellings move
- One pass, not one pass per pair
- Generated files are skipped
- Namespace classes
- Reading the dry run
- What the codemod cannot reach
- Which spellings a project needs
- Tailwind, and where the name really lives
- Verifying

---

```bash
node "$S/apply-code.mjs"                        # dry run — always first
node "$S/apply-code.mjs" --batch <id> --write
node "$S/check.mjs" --after
```

## Order of operations

```
1. rename in Figma          (emit-figma.mjs → use_figma)
2. regenerate token files   (figma-token-export: sync.mjs)
3. rewrite consumers        (apply-code.mjs --write)
4. build / analyze / test
5. commit — all of it, one commit
```

Between 1 and 3 the tree does not compile. That is fine; what must never happen
is committing in that state. If the project has no generated token files —
tokens are hand-written, or another tool owns them — skip step 2 and let
`apply-code.mjs` cover everything by leaving `code.generated` empty.

## Which spellings move

One Figma name is several strings once it reaches a codebase. `code.spellings`
selects which ones the codemod knows about:

| spelling | example | guard |
|---|---|---|
| `figmaPath` | `text/primary/default` | not inside a longer path |
| `cssVar` | `--text-primary-default` | not inside a longer var |
| `kebab` | `text-primary-default` | word boundary incl. `-` |
| `tailwind` | `bg-text-primary-default`, `hover:border-text-primary-default` | Tailwind v4 turns a custom property into a utility class, so the token text sits behind `bg-` / `text-` / `border-` and friends. Off by default — on a project without Tailwind it would match any hyphenated word following one of those prefixes. Measured on one real app: 254 `var()` references against 1,242 through utility classes. |
| `camel` | `textPrimaryDefault` | identifier boundary |
| `camelMember` | `.primaryDefault` | **only after a dot** |
| `pascal` | `TextPrimaryDefault` | identifier boundary |
| `snake` | `text_primary_default` | word boundary |
| `dot` | `text.primary.default` | not inside a longer path |

`camelMember` exists because `figma-token-export` groups tokens into one class
or object per namespace, and drops the namespace from the field name:

```dart
AppTextColors.primaryDefault      // not AppTextColors.textPrimaryDefault
```

`primaryDefault` on its own is far too generic to rewrite safely, so that
spelling only matches immediately after a `.`. That guard is what lets the
codemod move `AppTextColors.primaryDefault` while leaving a local variable of
the same name alone.

`cssPrefix` and `flutterPrefix` must match the corresponding target settings in
`tokens.config.json`. If the web target sets `"cssPrefix": "ds-"`, the CSS
custom property is `--ds-text-primary-default` and a codemod configured without
the prefix silently matches nothing.

## One pass, not one pass per pair

All pairs go into a single alternation regex and are replaced in one traversal.
Replacing pair by pair would apply the rename to its own output:

```
map:  x/a -> x/b,  x/b -> x/c
naive: pass 1 makes every --x-a into --x-b; pass 2 makes them all --x-c
```

A straight swap (`a → b`, `b → a`) has the same problem and the same fix. Both
are covered in `selftest.mjs`.

## Generated files are skipped

Anything matching `code.generated` is left alone: those files are rebuilt from
`tokens.json` by `figma-token-export`. Patching them here is either erased by
the next `generate` or — worse — is not, and then disagrees with `tokens.json`
in a way `generate --check` reports as drift with no obvious cause.

`check.mjs --after` deliberately scans them **anyway**. A clean consumer
rewrite plus a stale `tokens.css` means someone skipped step 2, and that is
precisely the state worth failing on.

## Namespace classes

Moving a token's first segment moves it into a different generated class:

```dart
AppColorColors.textPrimary   →   AppTextColors.primaryDefault
```

The member rename is derived and applied. The **class** rename is applied only
when the namespace moves whole — every `color/**` token going to `text/**` and
none staying behind. Two cases are reported instead of rewritten:

- **split** — `color/**` becomes both `text/**` and `surface/**`. There is no
  single new class; picking one would point half the call sites at the wrong
  place.
- **partial** — some `color/**` tokens stay. `AppColorColors` still exists for
  them, so renaming it breaks the ones that did not move.

In both cases the compiler names every affected line precisely, which is a
better tool than a guess. `apply-code.mjs` prints the advisory so it is not a
surprise.

## Reading the dry run

The output is the point. Three things to look at:

1. **Files and counts.** A rename you expect to touch 40 call sites touching 2
   means the codebase spells that token some other way.
2. **"matched nothing".** Expected for unused tokens; suspicious for anything
   you know is used. That is the signal that `code.spellings`, `cssPrefix` or
   `include` is wrong — and it is much cheaper to learn now.
3. **Namespace classes moved.** One pair here rewrites many call sites. Read
   them individually.

`check.mjs --code` gives the same counts before you have committed to a batch,
plus one thing the dry run cannot: whether a **new** spelling is *already*
taken by something unrelated. Renaming onto an occupied name compiles and means
the wrong thing, which no test will catch.

## What the codemod cannot reach

- **Dynamic construction.** `'--' + kind + '-' + variant`, a token name built
  from a map key, a name arriving from an API. Nothing textual can find those.
  Grep for the *fragments* after a batch if the codebase does this.
- **Files outside `include`.** Binary assets, `.env`, CI YAML, Figma plugin
  code in another repo, design docs in Notion.
- **Other repositories.** If the design system is consumed by more than one
  repo, `apply-code.mjs` runs once per repo, off the same committed
  `rename-map.json`. Add the map to the design-system repo and reference it —
  do not copy it, or the copies drift.

Say what is out of reach explicitly in the PR description. A rename that is
"done" in one repo and unannounced in three others is worse than one that was
never started.


## Which spellings a project needs

The prose below explains each shape. This is the lookup, from six real projects:

| shape | how you know | capture | `code.spellings` |
|---|---|---|---|
| Figma upstream, web/Flutter generated | a `tokens.config.json` and generated files | `use_figma` read scripts | `figmaPath, cssVar, camel, camelMember, pascal` |
| …**with `tailwind: 3\|4` declared** | that key in the web target | `use_figma` read scripts | the above **plus `tailwind`** — and see the note below |
| Tailwind **v4** | `@theme` in a stylesheet | `capture-css.mjs <file>` | `cssVar, tailwind` |
| Tailwind v4 from **shadcn** | `@theme inline` mapping `var(--x)` values from `:root` | `capture-css.mjs <file> --layer color- --flat` | `cssVar, tailwind` |
| Tailwind **v3** | `tailwind.config.js` | `capture-css.mjs <the value file>` | `cssVar` + an explicit `code` pair with guard `tailwindGroup` |
| Flutter, `static const` class | `pubspec.yaml`, `app_colors.dart` | `capture-dart.mjs <file>` | `camel` |
| Flutter, `ThemeExtension` | `class X extends ThemeExtension` | `capture-dart.mjs <file>` | `camel` |

`plan.mjs` prints a NOTE when it recognises the shape and the config does not
cover it. It suggests only — writing the config is a decision.

**Generated Tailwind spells its classes differently from its tokens.** Measured
against the generator rather than reasoned about:

```
token   color/surface/primary
:root   --surface-primary          ← the leading namespace is dropped
@theme  --color-surface-primary    ← what `cssVar` matches
class   bg-surface-primary         ← what hand-written code types
```

`cssVar` covers the `@theme` line, and the generated files are excluded from the
codemod anyway because the generator rewrites them. What is left uncovered is
the **class in hand-written code**: the `tailwind` spelling looks for the full
`color-surface-primary`, so it matches nothing there. Promote an explicit `code`
pair with guard `tailwind`, using the name as the class actually spells it.
`check.mjs` says this out loud when `tokens.config.json` declares the major.

Two traps the table cannot carry:

- **shadcn's stock names are not yours to rename.** `background`, `card`,
  `primary`, `ring`, `chart-1…5`, `sidebar-*` are the contract every component
  and every future `shadcn add` is written against. `convention.ignore` them.
- **`DEFAULT` in Tailwind v3 is a sentinel**, not a name: `primary.DEFAULT` is
  what produces `text-primary`. A convention that tidies it into
  `primary/default` produces a class nobody writes. `**/DEFAULT` in `ignore`.

## Tailwind, and where the name really lives

Two Tailwind projects can need completely different work, because the version
decides which artefact holds the token's identity.

**Tailwind v4** keeps it in CSS custom properties, and `@theme` turns each one
into a utility class. The name in the CSS *is* the name in the class, so
`cssVar` plus the `tailwind` spelling reaches both. Nothing else is needed.

### The shadcn shape: two layers in one file

A v4 project scaffolded from shadcn does not put its tokens in `@theme`
directly. It keeps raw values in `:root` and maps them into Tailwind's namespace
separately:

```css
:root        { --border: #ddd; }
@theme inline { --color-border: var(--border); }   /* → border-border, bg-border */
```

**Only the second layer names anything.** Tailwind reads `@theme`, strips the
`--color-` namespace, and builds `border-border` from what is left. The `:root`
entry is a value holder whose name nobody outside that file ever types.

Capturing `:root` and switching on the `tailwind` spelling therefore breaks the
project in a way that looks like it worked. Renaming `--border` to `--outline`
rewrites the raw entry, follows the `var()` inside the alias, **and rewrites the
class to `border-outline`** — for which no `--color-outline` exists. The class
silently stops resolving; `--color-border` is still sitting there unused.

The capture that works reads the `@theme` layer, records each name **without**
the namespace, and declares the namespace as `cssPrefix`:

```jsonc
// name captured as "border", not "color/border"
"code": { "cssPrefix": "color-", "spellings": ["cssVar", "tailwind"] }
```

Then one rename moves `--color-border` → `--color-outline` and every
`border-border` / `bg-border` with it, leaves the `:root` value under its own
name, and leaves `--color-border-line` and `border-border-line` alone. Renaming
the `:root` entry as well is a private tidy-up with no user-visible effect —
worth doing in the same commit, worth knowing it changes nothing outward.

Two more things measured on that app (ticket-mutoday-frontend, 75 custom
properties):

- **Most of the set is not yours to rename.** 33 of the names are stock shadcn
  (`background`, `card`, `popover`, `primary`, `muted`, `destructive`, `ring`,
  `chart-1…5`, `sidebar-*`). They are the contract every shadcn component and
  every future `npx shadcn add` is written against. Renaming them makes the next
  component you pull in reference tokens you no longer have. Put them in
  `convention.ignore`; the ones the team actually owns here are two.
- **Fifteen names are a single word** — `main`, `card`, `border`, `ring`.
  A convention with `structure.minSegments: 2` sends every one of them to
  `needsReview`, which is 15 questions that all have the same answer. Decide the
  rule before planning: either the standard accepts one-segment names for this
  layer, or the whole layer is `ignore`d.

**Tailwind v3** keeps it in a JS object in `tailwind.config.js`, and the CSS
custom properties are only values that object points at:

```js
colors: {
  primary: {
    DEFAULT: 'var(--primary-default)',   // → text-primary
    darker:  'var(--primary-darker)',    // → text-primary-darker
    soft_light: 'var(--primary-soft-light)',  // → bg-primary-soft_light
  },
}
```

Three things follow, and all three were measured on a real app
(lotteryplus-frontend: 42 custom properties, 41 colour tokens, ~300 class uses):

- **The object key is the name developers type, not the custom property.**
  Renaming the CSS layer moves 25 occurrences and leaves ~300 class references
  untouched, because they are generated from the key. The run reports success
  and the developer-visible name has not moved.
- **`DEFAULT` is a sentinel, not a name.** It means "the class with no suffix",
  so `primary.DEFAULT` is what produces `text-primary` — 173 of that app's uses.
  A convention that tidies it into `primary/default` produces a class nobody
  writes. Put `**/DEFAULT` in `convention.ignore`.
- **Keys can be snake_case**, and Tailwind takes them verbatim, so a class can
  read `bg-primary-soft_light`. `toKebab` preserves `_` inside a segment, so the
  spellings match — as long as the inventory records the key as it is written
  rather than a tidied version of it.

Moving a whole group in a v3 project is therefore a rename of the **object
key**, which no derived spelling covers. The rename map's explicit `code` pairs
do, with the `tailwindGroup` guard:

```json
{ "id": "css:primary/DEFAULT", "from": "primary/DEFAULT", "to": "primary/DEFAULT",
  "code": [{ "from": "primary", "to": "brand", "guard": "tailwindGroup" }] }
```

That moves `text-primary`, `bg-primary-darker` and `bg-primary-soft_light`
together, and leaves the JS key, prose, and identifiers like `primaryKey` alone
— the key itself is a one-line hand edit, which is the right shape for a change
that renames 300 call sites.
## Verifying

```bash
node "$S/check.mjs" --after      # zero old spellings anywhere in the repo
<build / analyze / test>
```

`--after` fails with `file:line` for every survivor. A clean run plus a green
build is the pair of facts that says a batch is finished. Neither alone does:
the build passes while a stale name sits in a Markdown file, and `--after`
passes while the code compiles into something that renders wrong.
