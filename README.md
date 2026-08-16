# skillassay — measure what your AI coding agent loads before you type

**A static analyzer for AI coding-agent context.** It measures the always-on
context-window cost of `CLAUDE.md`, `AGENTS.md`, `GEMINI.md` and Agent Skills,
then reports redundant instructions, stale path references, duplicate skill
names and instruction conflicts — with a citation and a token count on every
finding.

Works with **Claude Code**, **Codex**, **Cursor** and **Gemini CLI**. Runs
offline. No API key.

> **This is a research project.** It is published so the method and the numbers
> can be checked, not as a supported product. Provided **as is, without
> warranties or conditions of any kind** — see [Disclaimer](#disclaimer).

---

## Install

```bash
npx skillassay .
```

No install, no API key, no config. Requires Node.js ≥ 20.11.

[![npm](https://img.shields.io/npm/v/skillassay)](https://www.npmjs.com/package/skillassay)
[![license](https://img.shields.io/npm/l/skillassay)](LICENSE)

## Use it as a skill

The package ships an Agent Skill in `.agents/skills/skillassay/` — the
cross-client location that **Claude Code, Codex and Gemini CLI all read**, so one
file serves every harness:

```bash
npm i -D skillassay
mkdir -p .agents/skills
cp -r node_modules/skillassay/.agents/skills/skillassay .agents/skills/
```

It costs **98 always-on tokens** and passes its own audit with zero findings —
asserted by a test, because a linter for skill authors that ships a
non-conformant skill has refuted itself.

The skill is deliberately thin: it invokes the CLI and interprets the result.
All analysis stays in the deterministic binary, so adding the skill does not
turn the tool into the non-deterministic thing it was built to replace.

## What problem this measures

Agent Skills use **progressive disclosure**. Anthropic's documentation is
explicit:

> Claude loads this metadata at startup and includes it in the system prompt.
> […] until a Skill is triggered, only its name and description occupy context.

So the common framing — *"your 100 skills are eating your context window"* — is
wrong about the mechanism. Measured on the 18 official `anthropics/skills`:

| | Tokens |
|---|---:|
| Always-on (all 18 skill frontmatters) | **1,738** |
| Conditional (all 18 bodies, loaded only on trigger) | **53,899** |

A tool that summed bodies into an "always-on" figure would overstate by **31×**.

**Only artifacts that actually co-load are summed.** That sounds obvious and is
easy to get wrong — a naive implementation. On a real monorepo an earlier
version reported **123,567 always-on tokens (61.78% of window)** where the
truthful figure for a Claude Code user at the repository root was **21,086
(10.54%)**: it summed `.gemini/` and `.codex/` skills Claude Code never loads,
plus 21 directory-scoped `CLAUDE.md` files that don't all load at once. The
budget is now a function of *(harness, working directory)*, and everything found
but not counted is itemised with its reason, so the headline reconciles against
the file tree.

## What it reports

**Tier 0 — always-on context budget.** Every token loaded before you type:
context files along the root→cwd chain, your global `~/.claude/CLAUDE.md`, skill
and subagent frontmatter, and — with `--mcp-probe` — real MCP tool-schema cost.

**Conformance — will this skill load at all?** The Agent Skills specification
constrains `name` (1–64 characters, lowercase alphanumeric and single hyphens,
matching the parent directory) and `description` (≤1024 characters). A skill
breaking those is rejected silently by compliant clients. Across 1,022 published
skills this finds **37 hard violations**, including names like `DevOps Engineer`
and `Product Manager` that no client will register.

**Tier 1 — skill selection ambiguity.** Skills competing for the same routing
slot. Duplicate canonical names and missing trigger clauses are on by default;
trigger-surface overlap is **off by default** at 62% measured precision.

**Tier 2 — conditional cost and instruction conflicts.** Body cost per skill,
plus contradiction detection weighted by whether two skills can co-activate.

## Example

```
  skillassay  ·  Claude Sonnet (200K context)
  harness: claude (detected)  ·  at repository root
  ──────────────────────────────────────────────────────────────────

  ALWAYS-ON CONTEXT   145 tokens  0.07% of 200K window
  Counted with approx — cl100k_base proxy, not Claude's own tokenizer

  FINDINGS   6 warning · 1 info

  ▲ [RED-TECHSTACK] Stack claim restates a declared dependency: express, typescript
      CLAUDE.md:3
      → Delete line 3. express, typescript already appear in a manifest
      → the agent can read.
      saves 10 always-on tokens
      source: Gloaguen et al. (2026), arXiv:2602.11988, §5

  ▲ [RED-REPO-OVERVIEW] Documents `src/routes`, which the agent can list
      CLAUDE.md:17

  · [RED-STALE-PATH] References `warehouse`, which is not present in the repository
      CLAUDE.md:18

  PROJECTION
    Applying every deletion above reduces always-on context from 145 to 87 tokens
    (0.07% → 0.04% of window; −58 tokens, −40.0%).
    Measured by counting the exact text each finding proposes deleting.
```

Real output from `test/fixtures/redundancy-bad/`, not a mockup.

Note the last two findings: **path claims are checked against the filesystem.**
`src/routes/` exists, so documenting it duplicates what the agent can list.
`warehouse/` does not exist, so the line points somewhere work will not find.
Same-looking lines, opposite problems, both checkable facts rather than
judgements.

**It reports a clean bill of health when there is nothing to report.**
`test/fixtures/clean/` yields zero findings and exit 0, and a test asserts it.

## Who this is actually for

Measured across 33 real repositories, split by what they are:

| | Skill authors (≥5 skills, n=21) | Application repos (n=12) |
|---|---:|---:|
| Median always-on context | 4,091 tokens | 1,921 tokens |
| Median tokens saved by fixes | 15 | **0** |
| Repos saving >200 tokens | 7 of 21 | **0 of 12** |
| Missing-trigger findings | 279 | 1 |

**If you publish Agent Skills, this is a linter for you** — it tells you which
of your descriptions never state *when* to fire, which Anthropic documents as a
requirement.

**If you have an ordinary application repo, expect it to tell you your context
is already lean.** That is the most common answer and it is a real answer, but
it is not a token-saving story. Stated here rather than discovered later.

## Usage

```bash
assay                          # analyze the current directory
assay --harness codex          # whose budget to compute (claude|codex|gemini|cursor)
assay --cwd packages/api       # which directory-scoped context files compose
assay --no-global              # skip ~/.claude/CLAUDE.md
assay --json                   # machine-readable output
assay --verbose                # every budget line, full citations and limits
assay --target gpt-4o          # different context window
assay --fix                    # print a unified diff of deletions (never applies it)
assay --explain RED-STALE-PATH # the rule, its sources, and what it doesn't prove
assay --baseline b.json        # record a baseline
assay --compare b.json         # diff against one; exit 1 on new findings
assay --fail-on error          # error | warn | info | never
assay --registry ./corpus --markdown   # audit a whole skill corpus
assay path/to/SKILL.md         # check one skill — the atomic authoring operation
assay --top 10                 # bound the output; the total is still reported
assay --mcp-probe              # start MCP servers and measure their tool schemas
assay --experimental-ambiguity # enable the 62%-precision trigger-overlap rule
```

Exit code 0 when nothing is at or above `--fail-on` (default `warn`), else 1.

`--fix` writes a patch to stdout. **Nothing in this tool modifies your files.**

### `--mcp-probe`

MCP tool schemas are plausibly the largest always-on cost for a heavy user, and
they cannot be read from `.mcp.json` — that file says how to *launch* a server;
the schemas arrive at runtime from `tools/list`. By default the tool reports them
as unmeasured rather than guessing.

`--mcp-probe` starts the declared servers and asks. It **executes third-party
programs from a config file**, so it is opt-in, prints every command first, and
requires confirmation (or `--yes`). A server that fails to start or times out is
reported as unmeasured — never as zero, which would make a heavy MCP setup look
free.

## Harness support

Precise, because "multi-harness" is the easiest claim to overstate:

| Harness | Context files | Skills | Global config | MCP |
|---|---|---|---|---|
| **Claude Code** | `CLAUDE.md`, `CLAUDE.local.md`, nested chains | `.claude/skills/**`, `.claude/agents/**` | `~/.claude/CLAUDE.md` | `.mcp.json` |
| **Codex** | `AGENTS.md`, nested chains | `.codex/skills/**` | `~/.codex/AGENTS.md` | — |
| **Gemini CLI** | `GEMINI.md`, nested chains | `.gemini/skills/**` | `~/.gemini/GEMINI.md` | — |
| **Cursor** | `.cursorrules`, `.cursor/rules/*.mdc` | `.cursor/skills/**` | not file-based | — |

The harness is detected from the repository; `--harness` overrides.

**Not supported:** `.claude/hooks/`, plugin manifests, OpenCode, OpenClaw, dsh.
Skills under an unrecognised dot-directory (`.hermes/`) are detected and excluded
from every named harness's budget rather than misattributed.

## Measured accuracy

Reproducible from the repo: `npm run corpus:fetch && npm run corpus:validate -- corpus && npm run measure:recall -- corpus`.

| Measure | Value | Detail |
|---|---|---|
| Parse success rate | **99.32%** | 1,022 of 1,029 real `SKILL.md` files |
| False-positive rate | **9.0%** | hand census of **all** 100 default findings — not a sample |
| …restricted to `warn`+ | **6.1%** | 31 of 33 correct |
| Recall (population) | **83.3%** | 160 context-file lines labelled independently of the tool |
| Recall (curated positives) | **100%** | 15 clear-cut cases |
| Collateral | **1.3%** | legitimate lines a `--fix` patch would remove |
| Trigger-clause coverage | **94.3%** | descriptions whose "when to use" clause is parsed |
| Runtime | **0.49s / 100 skills** | 3.9s for a real 790-skill repository |
| Hard spec violations found | **37** | across the same 1,022 published skills |
| Crash rate | **0 / 33** | real repositories, `npm run wild` |

Precision *and* recall are both published because either alone is the easy half.
Method and every false positive:
[`calibration/FALSE_POSITIVES.md`](calibration/FALSE_POSITIVES.md),
[`calibration/RECALL.md`](calibration/RECALL.md).

## Research basis

Every rule cites a source that was fetched and read in full.
[`RULES.md`](RULES.md) lists all ten with the exact sentence relied on;
`assay --explain <ID>` prints it.

- **Gloaguen, Mündler, Müller, Raychev & Vechev (2026).** *Evaluating AGENTS.md:
  Are Repository-Level Context Files Helpful for Coding Agents?*
  [arXiv:2602.11988](https://arxiv.org/abs/2602.11988)
- **Ling, Zhong & Huang (2026).** *Agent Skills: A Data-Driven Analysis of Claude
  Skills.* [arXiv:2602.08004](https://arxiv.org/abs/2602.08004)
- **Anthropic.** [Agent Skills overview](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview)

[`RESEARCH_NOTES.md`](RESEARCH_NOTES.md) records what these papers actually say
versus what was assumed, including **four places the assumptions were wrong** —
most importantly that the widely-quoted "+4% for human-written context files" is
really **+2.4% at p=0.21**, not statistically significant. No rule depends on it.

## Limitations

**Token counts for Claude are a proxy.** Anthropic ships no offline tokenizer for
current Claude models. Counts use `cl100k_base` — a real BPE encoder over the
real bytes, but not Claude's segmentation. Every figure is labelled in output.

**Trigger-overlap detection is off by default because it is not good enough.** On
124 hand-labelled pairs from 948 real skills, the best of **nine** scorer variants
reached 62% precision at 96% recall. There is no better operating point: where
precision reaches 100%, recall falls below 10%. The dominant failure is sibling
skills differing by one named entity — `/ar:loop` vs `/ar:status`,
`spf13/cobra` vs `spf13/viper`. Full sweep:
[`calibration/RESULTS.md`](calibration/RESULTS.md).

**`RED-STALE-PATH` is `info`, at 3/6 measured precision.** A missing path is a
fact; a *stale* path is an inference. A directory created at runtime is absent
for a good reason and this rule cannot tell the two apart — its own finding text
says so.

**Trigger detection is English-only.** Skills with non-English descriptions are
wrongly reported as having no trigger clause — 4 of the 9 measured false
positives.

**`RED-GENERIC` matches a fixed phrase list.** Its recall is bounded by that list.

**Validation corpus is concentrated.** 797 of 1,029 files come from one
repository, and skill-library repos have unusually purposeful context files. The
published rates may not transfer to typical application repositories.

**Single annotator.** The calibration set, the false-positive census and the
recall labels were all labelled by one person. There is no inter-annotator
agreement figure. Recall labels were revised twice as the criterion sharpened;
both rounds are logged in `calibration/recall-labels.json` with per-item flags,
and round 2 corrected labels that had been scoring in the tool's favour.

**Platforms.** Verified on macOS, Linux (glibc and musl) and Windows via CI
across Node 20, 22 and 24.

**Not implemented, and deliberately absent from the CLI:** `--deep` (local
embedding similarity) and `--empirical` (A/B measurement against a task suite).
There are no flags for them. An earlier iteration printed `+2.1% success` from a
string literal; that is the failure mode this project is organised against.

**Nothing here measures whether acting on a finding improves agent behaviour.**
The rules establish that flagged content is redundant, absent, or ambiguous.
Task-success improvement would need the empirical mode, which does not exist.

## Relationship to agnix

[`agent-sh/agnix`](https://github.com/agent-sh/agnix) is a Rust linter and LSP
that answers *"is this file well-formed?"* per file.

`skillassay` answers *"is this collection costing me more than it returns?"* —
cross-file budget attribution, duplicate detection across a portfolio,
co-activation-weighted conflicts. Different question, different layer. **Use
both.** agnix is more mature and has IDE integration; this does not compete with
it.

## How the numbers are kept honest

- `npm run lint:honesty` fails the build on randomness, demo branches,
  unlabelled token estimates, `TODO`/`FIXME`, simulation language, or a catch
  block that swallows an error and returns a default. `test/honesty.test.ts`
  plants each violation class and asserts the checker rejects it — a check that
  cannot fail is worthless, and one of these was silently dead until that test
  was written.
- Every finding's citation is looked up from the rule registry by ID. A rule with
  no citation does not compile.
- Falsifiability tests: inject a duplicate and assert it appears, remove it and
  assert it disappears; inject 1–8 and assert the count tracks; 20 single-skill
  directories yield zero ambiguity; shuffled discovery order yields
  byte-identical output; 10 runs byte-identical apart from one named `runtime`
  block.
- `--fix` patches are verified by running `git apply`, and a test asserts the
  post-patch token count matches the projection.
- [`SELF_AUDIT.md`](SELF_AUDIT.md) is skillassay run on its own repository,
  regenerated by `npm run self-audit`, which exits non-zero if not clean.

## Development

```bash
npm install
npm test              # 143 tests
npm run verify        # honesty lint + typecheck + tests
npm run calibrate     # re-derive the threshold from the labelled set
npm run measure:recall -- corpus
npm run self-audit
npm run corpus:fetch  # clone the validation corpus at pinned commits
npm run wild -- <dir> # run across a directory of clones; fails on any crash
```

The calibrated threshold and its published precision are asserted against
`calibration/RESULTS.md` by a test, so shipped behaviour cannot drift from the
measurement that justifies it.

## Disclaimer

This is a **research project**, published for inspection and reproduction.

It is provided **"AS IS", without warranties or conditions of any kind**, either
express or implied, including without limitation any warranties of
merchantability, fitness for a particular purpose, accuracy, or
non-infringement. No guarantee is made that the measurements, rates or findings
are correct, complete, or applicable to your repository. You are responsible for
reviewing any change before applying it. See the [LICENSE](LICENSE) for the
governing terms.

`--fix` emits a patch to stdout and never writes to your files. `--mcp-probe`
executes programs declared in your own MCP configuration; review them first.

## Citation

```bibtex
@software{islam_skillassay_2026,
  author  = {Islam, Muhammad Rakibul},
  title   = {skillassay: a static analyzer for AI coding-agent context},
  year    = {2026},
  url     = {https://github.com/rakib-nyc/skillassay}
}
```

## Author

Muhammad Rakibul Islam — <imrakibul@gmail.com>

## License

[Apache License 2.0](LICENSE). See [NOTICE](NOTICE) for bundled third-party
material.
