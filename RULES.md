# Rules

Generated from `src/rules/index.ts` by `npm run docs:rules`. Do not edit by hand.

Every rule carries at least one citation with a quoted sentence from the source, and a statement of what the rule does **not** establish. Run `assay --explain <RULE-ID>` to print any of this from the CLI.

| Rule | Severity | Default | Title |
|---|---|---|---|
| [`SPEC-NAME-INVALID`](#spec-name-invalid) | error | on | Skill name violates the Agent Skills specification |
| [`SPEC-NAME-DIR-MISMATCH`](#spec-name-dir-mismatch) | error | on | Skill name does not match its parent directory |
| [`SPEC-DESCRIPTION-TOO-LONG`](#spec-description-too-long) | error | on | Description exceeds the specification limit |
| [`SPEC-BODY-TOO-LARGE`](#spec-body-too-large) | warn | on | Skill body exceeds the recommended size |
| [`RED-REPO-OVERVIEW`](#red-repo-overview) | warn | on | Context file describes repository structure |
| [`RED-TECHSTACK`](#red-techstack) | warn | on | Context file restates the dependency manifest |
| [`RED-GENERIC`](#red-generic) | warn | on | Context file contains generic programming advice |
| [`RED-LINTER`](#red-linter) | warn | on | Context file restates a rule a linter already enforces |
| [`RED-STALE-PATH`](#red-stale-path) | info | on | Context file references a path that is not present |
| [`AMB-DUPLICATE-NAME`](#amb-duplicate-name) | warn | on | Two skills share a canonical name |
| [`AMB-TRIGGER-OVERLAP`](#amb-trigger-overlap) | warn | opt-in | Two skills declare overlapping trigger conditions |
| [`AMB-NO-TRIGGER`](#amb-no-trigger) | info | on | Skill description states no trigger condition |
| [`CFL-CONTRADICTION`](#cfl-contradiction) | warn | on | Two skills give opposed instructions on the same subject |

## SPEC-NAME-INVALID

**Skill name violates the Agent Skills specification** · default severity `error`

### Why this is a finding

The specification constrains `name` to 1-64 lowercase alphanumeric characters and single hyphens. A name outside that set is not a style preference: compliant clients reject the skill, so it never appears in the catalogue and never triggers. The failure is silent, which is why a linter is the only thing likely to catch it.

### Sources

- **Agent Skills specification, `name` field (fetched 2026-08-16)** — <https://agentskills.io/specification>
  > Must be 1-64 characters. May only contain unicode lowercase alphanumeric characters (a-z, 0-9) and hyphens (-). Must not start or end with a hyphen. Must not contain consecutive hyphens. Must match the parent directory name.

### What this rule does not establish

Checks the format the specification defines. It cannot confirm that any particular client enforces every clause — some may be more permissive — only that a conforming client is entitled to reject the skill.

## SPEC-NAME-DIR-MISMATCH

**Skill name does not match its parent directory** · default severity `error`

### Why this is a finding

The specification requires the declared `name` to match the directory containing `SKILL.md`. Clients that key on the directory will not find the skill under the name it advertises, and clients that key on the name will not find its resources.

### Sources

- **Agent Skills specification, `name` field (fetched 2026-08-16)** — <https://agentskills.io/specification>
  > Must be 1-64 characters. May only contain unicode lowercase alphanumeric characters (a-z, 0-9) and hyphens (-). Must not start or end with a hyphen. Must not contain consecutive hyphens. Must match the parent directory name.

### What this rule does not establish

Not reported when the name was inferred from the directory in the first place, where the comparison would be circular.

## SPEC-DESCRIPTION-TOO-LONG

**Description exceeds the specification limit** · default severity `error`

### Why this is a finding

The specification caps `description` at 1024 characters. Beyond it a conforming client may reject the skill outright, and since the description is always-on context in every session, an oversized one is also the most expensive kind of text in the file.

### Sources

- **Agent Skills specification, `description` field (fetched 2026-08-16)** — <https://agentskills.io/specification>
  > Must be 1-1024 characters. Should describe both what the skill does and when to use it.
- **Anthropic, "Agent Skills" overview (fetched 2026-08-16)** — <https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview>
  > Claude loads this metadata at startup and includes it in the system prompt. until a Skill is triggered, only its name and description occupy context.

### What this rule does not establish

Measures characters, as the specification does. It does not judge whether the description is well written, only whether it is legal.

## SPEC-BODY-TOO-LARGE

**Skill body exceeds the recommended size** · default severity `warn`

### Why this is a finding

Published guidance recommends a body under 500 lines and 5,000 tokens, with reference material moved to files that load on demand. This is conditional cost rather than always-on, so it is a recommendation rather than a hard limit — but a body this large is loaded in full every time the skill triggers.

### Sources

- **Agent Skills, best practices for skill creators (fetched 2026-08-16)** — <https://agentskills.io/skill-creation/best-practices>
  > The specification recommends keeping SKILL.md under 500 lines and 5,000 tokens — just the core instructions the agent needs on every run. When a skill legitimately needs more content, move detailed reference material to separate files in references/ or similar.
- **Ling, Zhong & Huang (2026), arXiv:2602.08004, §3.1** — <https://arxiv.org/abs/2602.08004>
  > The top 1% of skills exceed 9,253 tokens, and the maximum reaches 116,239 tokens, which can consume prompt budgets and hinder reliable selection and auditing when loaded in full
- **Anthropic, "Agent Skills" overview (fetched 2026-08-16)** — <https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview>
  > Claude loads this metadata at startup and includes it in the system prompt. until a Skill is triggered, only its name and description occupy context.

### What this rule does not establish

A recommendation, not a constraint: the skill still loads. A long body is not itself a defect, and some skills legitimately need one.

## RED-REPO-OVERVIEW

**Context file describes repository structure** · default severity `warn`

### Why this is a finding

Directory listings and repository overviews are the single context-file pattern the ETH Zurich study tested and found unhelpful. The agent can read the tree; the description costs tokens every session and goes stale silently.

### Sources

- **Gloaguen et al. (2026), arXiv:2602.11988, §4** — <https://arxiv.org/abs/2602.11988>
  > instructions in the context files are well followed by coding agents, repository overviews, although popular and recommended by model providers, are not helpful
- **Gloaguen, Mündler, Müller, Raychev & Vechev (2026), arXiv:2602.11988, §1** — <https://arxiv.org/abs/2602.11988>
  > providing context files does not generally improve task success rates, while increasing inference cost by over 20% on average

### What this rule does not establish

The study measured that overviews do not help; it did not measure that removing an existing one improves success. The defensible claim is cost reduction at no measured benefit loss, not a success-rate gain.

## RED-TECHSTACK

**Context file restates the dependency manifest** · default severity `warn`

### Why this is a finding

The named dependency already appears in a manifest the agent can read. This is information the agent can obtain elsewhere, which the study identifies as the category that should not be in a context file.

### Sources

- **Gloaguen et al. (2026), arXiv:2602.11988, §5** — <https://arxiv.org/abs/2602.11988>
  > Human-written context files should only include instructions required for coding agents that are not already present in the README
- **Gloaguen, Mündler, Müller, Raychev & Vechev (2026), arXiv:2602.11988, §1** — <https://arxiv.org/abs/2602.11988>
  > providing context files does not generally improve task success rates, while increasing inference cost by over 20% on average

### What this rule does not establish

Only fires when the exact dependency name appears in a manifest in the analysis root. A stack claim about tooling not listed in a manifest is not detected.

## RED-GENERIC

**Context file contains generic programming advice** · default severity `warn`

### Why this is a finding

Advice that would apply to any repository carries no repository-specific information, so it cannot be the "non-standard coding practice" the study found context files are good for, while still incurring the measured per-session cost.

### Sources

- **Gloaguen et al. (2026), arXiv:2602.11988, §5** — <https://arxiv.org/abs/2602.11988>
  > Human-written context files should only include instructions required for coding agents that are not already present in the README
- **Gloaguen, Mündler, Müller, Raychev & Vechev (2026), arXiv:2602.11988, §1** — <https://arxiv.org/abs/2602.11988>
  > providing context files does not generally improve task success rates, while increasing inference cost by over 20% on average

### What this rule does not establish

Matches a fixed phrase list. It detects the clichés on that list and nothing else; a novel phrasing of the same empty advice will pass.

## RED-LINTER

**Context file restates a rule a linter already enforces** · default severity `warn`

### Why this is a finding

A formatter or linter enforces the rule mechanically on every file. Restating it as a prose instruction adds per-session tokens and is strictly less reliable than the tool that is already configured.

### Sources

- **Gloaguen et al. (2026), arXiv:2602.11988, §5** — <https://arxiv.org/abs/2602.11988>
  > Human-written context files should only include instructions required for coding agents that are not already present in the README
- **Gloaguen, Mündler, Müller, Raychev & Vechev (2026), arXiv:2602.11988, §1** — <https://arxiv.org/abs/2602.11988>
  > providing context files does not generally improve task success rates, while increasing inference cost by over 20% on average

### What this rule does not establish

Detects that a linter config file exists and that the instruction is style-shaped. It does not parse the linter config, so it cannot prove that specific rule is enabled.

## RED-STALE-PATH

**Context file references a path that is not present** · default severity `info`

### Why this is a finding

The study measured that agents follow context-file instructions faithfully. A path that is not in the repository is therefore not inert: the agent is led to look somewhere that does not exist, spending steps and inference cost on a dead end. Unlike every other rule here this one is a checkable fact rather than a judgement — the path is either on disk or it is not.

### Sources

- **Gloaguen et al. (2026), arXiv:2602.11988, §4** — <https://arxiv.org/abs/2602.11988>
  > instructions provided in context files are well followed
- **Gloaguen, Mündler, Müller, Raychev & Vechev (2026), arXiv:2602.11988, §1** — <https://arxiv.org/abs/2602.11988>
  > providing context files does not generally improve task success rates, while increasing inference cost by over 20% on average

### What this rule does not establish

A missing path is a fact; a *stale* path is an inference, and this rule cannot tell the two apart. Directories created at runtime are absent for a good reason — on the validation corpus that was the entire residual false-positive class. Paths listed in .gitignore are suppressed, as are illustrative trees whose root does not exist and package names that merely look path-shaped. It cannot see build-generated paths or paths that are correct on another branch.

## AMB-DUPLICATE-NAME

**Two skills share a canonical name** · default severity `warn`

### Why this is a finding

Near-identical names are the dominant redundancy pattern in the public corpus. Two skills with the same canonical name compete for the same routing slot, and the model has only the descriptions to tell them apart.

### Sources

- **Ling, Zhong & Huang (2026), arXiv:2602.08004, §3.2** — <https://arxiv.org/abs/2602.08004>
  > Skills that appear once account for 53.7%, while skills that appear more than once account for 46.3%
- **Anthropic, "Agent Skills" overview (fetched 2026-08-16)** — <https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview>
  > The description is what Claude matches your request against when determining whether to trigger the Skill, so it must say both what the Skill does and when to use it.

### What this rule does not establish

Name identity is evidence of duplication, not proof of mis-routing. Two identically named skills with genuinely disjoint descriptions may route correctly.

## AMB-TRIGGER-OVERLAP

**Two skills declare overlapping trigger conditions** · default severity `warn`

> **Off by default.** Enable with `--experimental-ambiguity`. Measured precision **62.2%** and recall **96.2%** at threshold 0.14 on the hand-labelled set in [calibration/RESULTS.md](calibration/RESULTS.md). Roughly two in five findings from this rule are wrong.

### Why this is a finding

The description is the routing rule. When two descriptions claim the same triggering conditions, the model has no documented basis for choosing between them, so which one loads is not determined by the library author.

### Sources

- **Anthropic, "Agent Skills" overview (fetched 2026-08-16)** — <https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview>
  > The description is what Claude matches your request against when determining whether to trigger the Skill, so it must say both what the Skill does and when to use it.
- **Ling, Zhong & Huang (2026), arXiv:2602.08004, §3.2** — <https://arxiv.org/abs/2602.08004>
  > Skills that appear once account for 53.7%, while skills that appear more than once account for 46.3%

### What this rule does not establish

OFF BY DEFAULT (--experimental-ambiguity). Measured precision is 62% and recall 96% on a 124-pair hand-labelled set, meaning roughly two in five flagged pairs are wrong. Nine scorer variants were tried and none exceeded 64% precision; the dominant failure is sibling skills that differ only by a named entity (/ar:loop vs /ar:status, spf13/cobra vs spf13/viper). It is lexical, and it does not observe real routing.

## AMB-NO-TRIGGER

**Skill description states no trigger condition** · default severity `info`

### Why this is a finding

Anthropic documents that a description must state both what the skill does and when to use it. A description with no "when" clause gives the router nothing to match a request against beyond topical resemblance.

### Sources

- **Anthropic, "Agent Skills" overview (fetched 2026-08-16)** — <https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview>
  > The description is what Claude matches your request against when determining whether to trigger the Skill, so it must say both what the Skill does and when to use it.

### What this rule does not establish

Detects a trigger clause by a fixed set of lead-in phrases derived from a real corpus. A description that conveys its trigger through unusual phrasing will be flagged even though a reader would understand it.

## CFL-CONTRADICTION

**Two skills give opposed instructions on the same subject** · default severity `warn`

### Why this is a finding

The ETH Zurich study measured that agents follow context instructions faithfully. Faithful following of two opposed instructions has no defined outcome, so which one wins is not controlled by the author. Severity is higher when the two skills also have overlapping triggers, because only then can both be loaded at once.

### Sources

- **Gloaguen et al. (2026), arXiv:2602.11988, §4** — <https://arxiv.org/abs/2602.11988>
  > instructions provided in context files are well followed
- **Anthropic, "Agent Skills" overview (fetched 2026-08-16)** — <https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview>
  > The description is what Claude matches your request against when determining whether to trigger the Skill, so it must say both what the Skill does and when to use it.

### What this rule does not establish

The study measured instruction-following, not conflict outcomes. That contradictions are harmful is an inference from that finding, not a separately measured result. Measured detection precision is poor: 0 findings across 1,022 corpus skills and 1 correct out of 3 across 33 repositories, the failures being qualified permissions read as prohibitions. Capped at `warn` for that reason, and it misses paraphrased conflicts entirely.

