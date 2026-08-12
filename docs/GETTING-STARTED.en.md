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

## Claude asks in five rounds — answer what you know

Every question arrives with **Claude's own recommendation first**. "Go with
your suggestion" is always a valid answer; you do not need the vocabulary
before you can start.

**Round 1 — where does the standard come from?** (before anything is touched)

This is the most important question, and the one people skip. Three ways to
answer:

| What your team has | What to say | What you get |
|---|---|---|
| A convention doc already | Hand over the MD file or Confluence link | Claude encodes it as a **shared file** this project `extends` |
| No doc, but you know what you want | Five to ten real before/after pairs | Claude works backwards to rules and saves them as that shared file |
| No idea | Say so | `"extends": "starter"` as a starting point, adjustable later |

**Do not let the rules live in this project's `rename.config.json`.** When the
second project does the same thing, you have two standards that agree today and
drift quietly afterwards. The project file should hold only this project's
facts — the file key, the code prefixes, where generated files land.

```jsonc
{ "extends": "../design-system/naming.json",   // the standard lives here
  "figma": { "fileKey": "…" },                  // everything else is local truth
  "code":  { "cssPrefix": "", "flutterPrefix": "App" } }
```

**Round 2 — what gets renamed** — tokens / components / layers / styles, and
which collection goes first. Always start with the smallest one.

**Round 3 — the name format** (asked only after the inventory is captured) —
case · prefixes to strip · separator · whether sizes read `sm/md/lg` or
`100/200/300`. Every option is shown against real names pulled from your file,
not invented examples.

**Round 4 — what the machine could not decide** — see the next section.

**Round 5 — confirm before anything ships** — how many names in this batch, how
many code files it reaches, how to undo it.

> If you are renaming **components**, Claude reads each one's structure (does it
> contain a button? an input? how deeply is it nested?) and infers what it is —
> a `Frame 427` holding text on a rounded fill comes back proposed as `Button`,
> with the reason attached. Tune how eager that is under `components.classifier`
> in the preset.

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

**Claude will not walk you through 300 rows one at a time.** It groups them by
the rule that produced them and asks per group:

```
Rule "strip the color/ prefix" matched 214 names — take the whole group?
   color/text-primary → text/primary     color/bg-raised → surface/raised   … 212 more
```

Take the group, drop the group, or take only some of it. Every answer is
written into `rename-map.json` as you give it, not held in the conversation —
you can stop for the day and pick it up tomorrow, and re-planning will not
discard what you already decided.

Anything still undecided **cannot ship to Figma**. The script refuses it; it
does not merely warn.

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
2. record that Figma is done       ← skip it and step 4 refuses to run
3. re-capture from Figma, then regenerate the token files
4. rewrite every place in code that used the old names
5. build / test
6. record the batch as finished, then commit
```

**Step 3 re-captures first.** Regenerating from the dumps you already had means
regenerating the old names — quietly, with everything else looking green.

Between steps 1 and 4 the code does not compile. That is expected — the only
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

## Four things not to do

1. **Do not let it rename the whole file at once.** Nobody can review 400 names
   in one go, and there is nothing to roll back to. Start with a collection of
   10–20, especially the first time.
2. **Do not mix a rename with a value change in one batch.** When something
   looks wrong afterwards there is no way to tell which half caused it.
3. **Do not rush past `needsReview`.** That is the pile the machine gave up on
   and handed to a person. Skipping it gets you names that look right and mean
   the wrong thing — worse than not renaming at all.
4. **Do not hand-edit `rename-map.json`.** It is a record of state, not a config
   file. Tell Claude which name you want changed and let it record the decision —
   edits you make yourself are lost on the next re-plan.

---

## If Claude says it is stuck, it means...

| message | meaning | what to do |
|---|---|---|
| `re-capture the inventory` | someone renamed things in Figma while we were planning | re-read and re-plan; safer than forcing it |
| `Identifier collision` | two different Figma names become one name in code | rename one of them differently |
| `library (remote) entity` | that one lives in another file | go rename it in its source file |
| `built-in ladder (no ramp to learn from)` | colour shades were guessed from a generic table, not learned from your palette | check the inventory captured **values**; if not, shade names may be off |
| `has pending decisions` | something in the batch has not been accepted or rejected yet | answer them — the script will not ship an undecided name |
| `planned under a different convention` | the rules changed after this plan was made | re-plan; the decisions you already made survive |
| `another batch is in flight` | the previous batch never finished | finish it first — two in flight means neither can be rolled back |
| `not in a git repository` | `git revert` is not available, so a batch cannot be undone that way | `git init` if you can; if not, guard `rename/rename-map.json` — losing it means losing the way back |
| `Ambiguous rewrite` | generated class names collide — common when renaming `colors/**` | if the project has no generated Dart, add `--no-namespace-classes`; the error says so |
| `cssPrefix mismatch` | the prefix here disagrees with `tokens.config.json` | make them agree, or the generated code and the codemod will use different names |
| `namespace splits into…` | one group split into several, so no single new class name is right | let the compiler point at the call sites |

---

## Going deeper

- Why it works the way it does → [REFERENCE.en.md](REFERENCE.en.md)
- Running the scripts yourself / changing the skill → [MAINTAINING.en.md](MAINTAINING.en.md)
- Naming from values (colour → hue/shade, number → scale) →
  `skills/figma-rename/references/suggest-engine.md`
