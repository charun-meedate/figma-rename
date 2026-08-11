# Bringing the code across


## Contents

- Order of operations
- Which spellings move
- One pass, not one pass per pair
- Generated files are skipped
- Namespace classes
- Reading the dry run
- What the codemod cannot reach
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

## Verifying

```bash
node "$S/check.mjs" --after      # zero old spellings anywhere in the repo
<build / analyze / test>
```

`--after` fails with `file:line` for every survivor. A clean run plus a green
build is the pair of facts that says a batch is finished. Neither alone does:
the build passes while a stale name sits in a Markdown file, and `--after`
passes while the code compiles into something that renders wrong.
