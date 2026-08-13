# Asking — the five rounds, in the user's own names

Step 0 of `figma-rename.md` is the whole of this file compressed to five
sentences. Open this before the first `AskUserQuestion` of a run: the wording
of each round, what each answer costs, and the recommendation to lead with are
what decide whether the answer is a decision or a shrug.

## Contents

- Round 1 — is there already a standard?
- Round 2 — what is in scope
- Round 3 — the format, shown with their own names
- Round 4 — the review, which is the one part only a person can do
- Round 5 — before applying
- Say where the run is going

---

### Round 1 — is there already a standard?

**"Does your team already have a naming standard, or is this the first time?"**

This decides everything downstream, because it decides whether the project gets
its own convention or inherits the shared one.

| answer | what to do |
|---|---|
| there is a shared standard | `"extends": "aurora"`, or a path to the team's file |
| there is a document, not a config | encode it once as a preset or shared file, then extend that |
| there is nothing yet | `"extends": "starter"`, and tighten it as answers arrive |

Say the consequence in one line: **a convention that lives inside one project
is a convention that will disagree with the next project.** Encoding a document
into the project's own config is how a standard quietly becomes two.

The project should then override almost nothing — normally just
`figma.fileKey` and `code.*`, which are facts about the repo rather than naming
decisions. `node "$S/plan.mjs" --print-config` shows the merged result and
which file the base came from.

### Round 2 — what is in scope

**"What should I rename this time?"** (multi-select) — variables/tokens,
components and component sets, layers inside a component, text/effect styles.

Say what each costs, because the blast radii are nothing alike: a variable
rename reaches every line of token-consuming code; a layer rename inside a
component reaches almost nothing. Recommend one kind and the smallest
collection for a first run.

**"Everything, or one collection?"** Recommend one. A thousand-variable file is
not reviewable in a single pass, and one batch is one commit is one rollback.

### Round 3 — the format, shown with their own names

Do this **after** the inventory, never before. By then the options can be shown
as what they actually produce:

```
now                        kebab                    camel
color/bg-raised         →  color/surface/raised     color/surfaceRaised
palette/red/500         →  palette/red/500          palette/red/500
```

(Case applies per segment, so the slashes stay. `colorSurfaceRaised` is the CODE
spelling that `figma-token-export` derives — it is not an option for the Figma
name, and offering it as one invites a file named the way the code is.)

Ask only about what this file actually needs — never offer a menu of options
the file has no examples of:

| ask about | where the answer goes |
|---|---|
| **case per segment** — kebab, camel, Pascal, snake | `convention.segmentCase` |
| **prefix** — strip `palette/`, add `primitive/` | `convention.transform.stripPrefix` / `.addPrefix` |
| **separator** — only if the file mixes `-` and `/` for hierarchy | `convention.transform.separator` |
| **number scale** — `spacing/md` or `spacing/4` | `convention.sizeNaming` |

None of them needs a glob rule. The two `transform` ones also take
`stripSuffix` and `replace` (whole-segment find/replace). Getting the block
wrong used to be silent — a string where an array belongs did nothing at all —
so it is validated now and says which key you meant.

If an answer differs from the shared standard, say so out loud: it is either a
project exception worth writing down, or a change the standard should absorb.

### Round 4 — the review, which is the one part only a person can do

`emit-figma` refuses a batch with undecided rows, so this round is not optional
and cannot be skipped by saying yes to something else. **You are the checkbox
UI**: read the full list, group it, and record every answer through
`review.mjs` — never by editing the JSON, which a re-plan would overwrite.

```bash
node "$S/review.mjs" status                     # what is open
node "$S/review.mjs" list --batch <id> --json   # every row, untruncated
```

Group before asking. Three hundred rows collapse into a handful of questions:

- **by rule** — "28 rows come from `color/text-* → text/$1/default`; here are 3
  of them. Accept the group?" A rule is a decision the team already made, so the
  question is whether the rule did what they meant, asked once.
  → `review.mjs accept --batch <id> --rule "<rule>"`
- **by confidence tier** — high as one group; medium in chunks with samples;
  **low one at a time**, because those are the guesses.
  → `review.mjs accept --batch <id> --min-confidence high`
- **the open questions, individually.** These are the ones no formula could
  answer, and they are the reason this round exists:

```
Color 5      alias of colors/blue/500 — a semantic token, so its name is its ROLE
             (brand? error? surface?), which the value cannot tell you
Color 1      same value as "primary" — both would be colors/blue/500
brand        1 segment, minSegments is 2
btn primary  its shape reads as "Button", and so does "Button/Primary"
```

Ask each one plainly, offer what you would pick, then record it:

```bash
node "$S/review.mjs" resolve <id> --to palette/brand      # answer it
node "$S/review.mjs" skip <id> --note "brand is fine"     # leave it alone, permanently
node "$S/review.mjs" set-to <id> --to <name>              # fix a proposal
node "$S/review.mjs" reject --batch <id> --ids A,B        # not this one
```

Skips and hand-written names survive re-planning; a deleted JSON row does not.

### Round 5 — before applying

**"Start with this batch?"** Name the batch, its size, and what will happen:
Figma, then re-capture dumps, then regenerate, then code, then one commit.
Confirm the project is on a branch with a clean tree.

### Say where the run is going

Renaming is not the point. **Matching the standard so the exported code is
predictable is the point** — and saying that is what makes the questions above
feel worth answering:

```
figma-rename        names match the shared standard
      ↓
figma-token-export  those names become --color-surface-raised / AppColors.surfaceRaised
```

Which is also why `cssPrefix` and `flutterPrefix` in `code.*` must match that
project's `tokens.config.json`. If they do not, the codemod matches nothing and
silently does no work. Check it while asking, not afterwards.
