# How to use it — for people renaming a whole set of tokens / components

> [ภาษาไทย](GETTING-STARTED.md) · English
> Maintaining the skill / how it works inside → [MAINTAINING.en.md](MAINTAINING.en.md) · [REFERENCE.en.md](REFERENCE.en.md)

You do not run any scripts. **Claude Code does that.** You have exactly two
jobs: **agree what the names should look like**, and **read the proposal before
approving it**. This guide covers what to say, and what you get back.

---

## One thing to understand before starting

```
Figma binds by id     →  renaming breaks nothing
code binds by name    →  renaming breaks everything that referenced it
```

So a rename is not a job inside Figma. It is **one change that has to land on
both sides at once**. That is why this skill forces the work into small
batches, one commit each — not for tidiness, but because it is the only thing
that makes a mistake reversible.

---

## One-time setup

1. Have a Figma file link you can **edit** (not just view)
2. Install the skill into your project:

```bash
git clone <url-of-this-repo> ~/dev/figma-rename
~/dev/figma-rename/install.sh ~/dev/my-project
```

3. **The project must be in git with a clean tree** — the skill commits one
   batch at a time. Uncommitted work makes the diffs unreadable.

---

## First run — tell Claude what to rename

Open Claude Code in your project and type something like this, **with the Figma
link**:

> Rename the tokens in this file to match our convention. Start with the
> Primitive collection.
> https://www.figma.com/design/SjE7hLqGcKYLy4XMgXGhlM/Design-system

Say what is in scope — you can pick several, but **do not take everything at
once**:

| what to rename | good for |
|---|---|
| **Variables (tokens)** | most of the work; the biggest reach into code |
| **Component / Component Set** | the component names themselves |
| **Layers inside a component** | one component at a time, never the whole file |
| **Text / Effect styles** | typography, shadows |

---

## Claude will ask you one thing — the convention

**"What should the names look like?"** Answer this clearly up front, because it
is what makes the result reviewable. At review time the question becomes *"does
this match the rule"* instead of *"do I like this name"*.

Three ways to answer, depending on what your team already has:

**a. You already have a convention doc** — hand Claude the MD file or the
Confluence link. It turns that into rules itself. This is the best case.

**b. No doc, but you know what you want** — five to ten real examples is
enough:

> `color/text-primary` → `text/primary/default`
> `color/bg-raised` → `surface/raised`

Claude works backwards to the rules and applies them to everything else.

**c. No idea, help me think** — say so. Claude will propose a structure for you
to react to (see `naming-convention.md` inside the skill).

---

## Claude stops twice — do not click through

### Stop 1 — the proposed names

```
[plan] 742 inventory entries in scope
[plan]   renamed     354      ← matched the agreed rules
[plan]   suggested    88      ← the value itself says what it is
[plan]   conforming  361      ← already correct, left alone
[plan]   needsReview   9      ← cannot be decided mechanically; your call
```

**`needsReview` is the part you actually have to read.** It is everything no
formula can answer:

```
Color 5 — alias of colors/blue/500 — a semantic token, so its name is its ROLE
          (brand? error? surface?), which the value cannot tell you
Color 1 — same value as "primary" — both would become colors/blue/500.
          Merge them, or make one an alias of the other
```

Answer those before going on. The rest you can skim.

### Stop 2 — how much to trust each name

Names that came from a value always carry a **reason** and a **confidence**:

```
Value 1      -> spacing/md       [high]   collection "Spacing"; scope GAP; 16 is a multiple of 4
heading      -> fontSize/2xl     [medium] scope FONT_SIZE; 24 is in the type-scale range
Variable 3   -> opacity/50       [low]    0.5 is in the 0–1 range
```

Read the `[low]` ones first — those are guesses backed by a single signal. Tell
Claude to drop them (`--min-confidence medium`), or fix those names by hand.

---

## What happens when you approve

Claude works one batch at a time, looping until done:

```
1. rename in Figma (this batch)
2. regenerate the token files
3. rewrite every place in code that used the old names
4. build / test
5. commit
```

Between steps 1 and 3 the code does not compile. That is expected — the only
rule is not to commit in that state, and Claude handles that.

What you end up seeing:

```
[apply-code] rewrote 1,204 occurrence(s) in 87 file(s)
[check] OK — no old spelling survives anywhere
```

---

## If something goes wrong

Tell Claude **"roll back this batch"**. It does two things: runs a reverse
script in Figma to walk the names back, and `git revert`s that commit. This
works only because one batch is exactly one commit.

---

## Three things not to do

1. **Do not let it rename the whole file at once.** Nobody can review 400 names
   in one go, and there is nothing to roll back to. Start with a collection of
   10–20, especially the first time.
2. **Do not mix a rename with a value change in one batch.** When something
   looks wrong afterwards there is no way to tell which half caused it.
3. **Do not rush past `needsReview`.** That is the pile the machine gave up on
   and handed to a person. Skipping it gets you names that look right and mean
   the wrong thing — worse than not renaming at all.

---

## If Claude says it is stuck, it means...

| message | meaning | what to do |
|---|---|---|
| `re-capture the inventory` | someone renamed things in Figma while we were planning | re-read and re-plan; safer than forcing it |
| `Identifier collision` | two different Figma names become one name in code | rename one of them differently |
| `library (remote) entity` | that one lives in another file | go rename it in its source file |
| `built-in ladder (no ramp to learn from)` | colour shades were guessed from a generic table, not learned from your palette | check the inventory captured **values**; if not, shade names may be off |
| `namespace splits into…` | one group split into several, so no single new class name is right | let the compiler point at the call sites |

---

## Going deeper

- Why it works the way it does → [REFERENCE.en.md](REFERENCE.en.md)
- Running the scripts yourself / changing the skill → [MAINTAINING.en.md](MAINTAINING.en.md)
- Naming from values (colour → hue/shade, number → scale) →
  `skills/figma-rename/references/suggest-engine.md`
