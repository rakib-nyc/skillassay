# Research notes

Before any rule citing a source was written, each source was fetched and read
in full, and what it actually says was compared against the summaries in
circulation. Every discrepancy is recorded below.

Every source below was fetched and read on **2026-08-16** before any rule citing
it was written. Where a circulating summary disagreed with the source, the
source won and the disagreement is recorded here.

---

## arXiv:2602.11988 — Gloaguen, Mündler, Müller, Raychev & Vechev, *Evaluating AGENTS.md*

Fetched: full text via `arxiv.org/html/2602.11988`. Published 2026-02-12.
Author list and affiliation as the summary describes.

### Confirmed

| Spec claim | Status |
|---|---|
| Context files do not generally improve task success | **Confirmed** — abstract states it directly |
| Inference cost increases >20% on average | **Confirmed** — "increasing inference cost by over 20% on average"; §4 gives 20% and 23% for the two conditions, p<0.001% |
| Instructions are followed faithfully | **Confirmed** — "instructions provided in context files are well followed" |
| SWE-bench Lite: 300 tasks, 11 Python repos | **Confirmed** |
| New benchmark: 138 instances, 12 repositories | **Confirmed** — from 5,694 PRs |
| Claude Code is the exception where developer files fail to beat no-file | **Confirmed** — "they improve performance for all agents but Claude Code" |
| Repository overviews specifically are unhelpful | **Confirmed, and stated repeatedly** — "they do not function as effective repository overviews" |

### Discrepancies

**1. The benchmark is called CTXbench, not "AGENTbench"/"AgentBench".**
The summary hedged between two names. Neither is right.

**2. Human-written files show +2.4%, not "roughly +4%" — and it is not significant.**
The paper: *"Developer-provided context files improve agent performance by 2.4%
on average (p=21%)"*. The summary's ~+4% overstates the effect, and omits that
p=0.21 means the result is not statistically significant. **No rule in this tool
relies on that figure.**

**3. The +2.7% ablation result is specifically about LLM-generated files.**
This is the most important correction, because the summary calls it "the most
important result" and builds the redundancy rules on it. The paper:

> In this setting, where context files are the only source of documentation
> available, we find that **LLM-generated** context files not only consistently
> improve performance by 2.7% on average, but also outperform developer-written
> ones across settings.

The summary drops the "LLM-generated" qualifier and reads the result as "context
files are worth exactly the information the agent cannot get elsewhere". The
direction of that reading survives, but it is **not** what this sentence says,
so the redundancy rules do not cite it. They cite two other statements that do
support them directly, both quoted verbatim in `RULES.md`:

> Human-written context files should only include instructions required for
> coding agents that are not already present in the README.

> …repository overviews, although popular and recommended by model providers,
> are not helpful.

**4. The "mentioning `uv` increased `uv` usage ~1.6×" figure was not located.**
The general claim it supports (instructions are followed) is confirmed
elsewhere, so nothing depends on the specific multiplier. Not cited.

---

## arXiv:2602.08004 — Ling, Zhong & Huang, *Agent Skills: A Data-Driven Analysis*

Fetched: full text via `arxiv.org/html/2602.08004`. Published 2026-02-08.

Note the full title is *"Agent Skills: A Data-Driven Analysis of Claude Skills
for Extending Large Language Model Functionality"* — longer than the summary's
version. The summary attributes it to "Bosch Research + CMU"; affiliations were not
checked and are not cited anywhere in this tool.

### Confirmed

| Spec claim | Status |
|---|---|
| 40,285 skills, collected to 2026-02-05 | **Confirmed** |
| Growth 2,179 (16 Jan) → 40,285 (5 Feb) | **Confirmed** — "a net increase of 38,106 skills in 20 days" |
| ~46.3% name-based near-duplicates | **Confirmed** — "Skills that appear once account for 53.7%, while skills that appear more than once account for 46.3%", under "Name based redundancy distribution" |
| Median skill length 1,414 tokens | **Confirmed** — mean 1,895 |
| Documented supply/demand imbalance | **Confirmed** |

### Discrepancies

**1. "90% under 3,935 tokens" was not located.**
The paper gives a different tail statistic: *"The top 1% of skills exceed 9,253
tokens, and the maximum reaches 116,239 tokens"*. The 9,253 figure is what
`BUD-BODY-OUTLIER` uses, because it is the one actually in the paper.

**2. The most-duplicated name counts were not verified.**
The summary lists `skill-creator` (251 copies), `front-end-design` (162) and
others. These specific counts were not found in the text read. The aggregate
46.3% is confirmed and is what `AMB-DUPLICATE-NAME` cites; the per-name counts
are not cited anywhere.

---

## Anthropic Agent Skills documentation

Fetched: `platform.claude.com/docs/en/agents-and-tools/agent-skills/overview`.

### Confirmed — and load-bearing for the whole design

> Claude loads this metadata at startup and includes it in the system prompt.

> The description is what Claude matches your request against when determining
> whether to trigger the Skill, so it must say both what the Skill does and when
> to use it.

> …until a Skill is triggered, only its name and description occupy context.

This is the basis for modelling Tier 0 as frontmatter-only, and for
`AMB-NO-TRIGGER` — a description with no "when" clause fails a documented
requirement.

### Discrepancy

**The "~500-line body recommendation" is not on that page.** The summary cites it
(§3.2). It was not present in the fetched document. No rule uses it.

---

## Claims deliberately not used

**The swirlai measurement (~80 tokens median, ~1,700 total across 17 official
skills).** The summary asks for this to be reproduced as a calibration test. The
source is a blog post that was not located and read, so it is treated as
unverified. The calibration test in `test/calibration.test.ts` therefore asserts
an *order of magnitude* rather than those exact figures, and the README publishes
this tool's own measurement instead.

Measured here on the vendored `anthropics/skills` snapshot (18 skills, commit
`f6656c1`):

| Measure | This tool | Blog figure (unverified) |
|---|---:|---:|
| Skills | 18 | 17 |
| Median discovery cost | **68 tokens** | ~80 |
| Total discovery cost | **1,738 tokens** | ~1,700 |
| Range | 21 – 301 | ~55 – ~235 |

The total lands within 3% of the reported figure; the median and the range do
not match as closely. Both are counted with cl100k_base as a proxy for Claude's
tokenizer, and the snapshot has one more skill than the blog measured, so some
divergence is expected. Treat the agreement on the total as consistency, not as
confirmation — the blog post was never read.

The load-bearing point is unaffected by any of it: the entire official skill
library costs **~1.7K tokens** at startup, while the same 18 bodies total
**53,899 tokens**. A tool that summed bodies into an always-on figure would
overstate the cost by 31×. That ratio is the reason Tier 0 and Tier 2 are
modelled separately.

**The Vercel "100% vs 79% eval pass rate" figure.** The summary flags this as
unverified (§3.4) and instructs that it not be cited until a primary source is
read. It was not located. It appears nowhere in this tool.

**Lulla et al. (~29% faster, ~17% fewer output tokens).** Not located, not
cited.

**arXiv:2412.13459 (fake stars).** Not fetched. It informs a design decision —
the registry audit ranks by measured properties and never by stars — but no rule
cites it, so nothing depends on figures from it.

---

## Prior art, re-verified 2026-08-16

Prior-art searches were re-run before any code was written.
Results via the GitHub Search API on 2026-08-16:

| Repo | Stars then (spec) | Stars now | Note |
|---|---:|---:|---|
| `agent-sh/agnix` | 382 | 382 | 32 forks. Still the incumbent linter/LSP. |
| `Zhenyu98/dsh-context-doctor` | 10 | 10 | |
| `riyazsarah/quality-of-my-claude-md` | 5 | 5 | |
| `Anvil-Code/skill-validator` | 3 | 3 | |
| `anthropics/skills` | ~139k | 169,586 | Grown substantially |

The three searches the summary reports as returning zero still return zero:
`skill overlap detector claude`, `skill redundancy duplicate detection agent`,
`AGENTS.md analyzer audit tool`. `skillassay` has 0 GitHub name matches and
returns 404 on the npm registry.

**Conclusion: the gap the summary identifies is still open.** No well-executed
competitor has appeared in the portfolio-level, cross-harness, deterministic
niche.
