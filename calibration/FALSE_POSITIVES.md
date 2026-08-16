# Measured false-positive rate

A manual review of 50 sampled findings was planned. This is a
**census instead of a sample**: every default-path finding the tool produced on
the validation corpus was reviewed by hand, which removes the question of
whether the sample was representative.

Read alongside [`RECALL.md`](RECALL.md). This page answers *"when the tool
speaks, is it right?"*. That one answers *"how much does it walk past?"*.
Neither is sufficient alone, and precision figures published without a recall
figure are the easier half of the problem.

- **Corpus:** 1,029 `SKILL.md` files and 28 context files across 11 public
  GitHub repositories, pinned by commit in `scripts/fetch-corpus.sh`.
- **Reviewed:** all 100 findings produced by the default rule set.
- **Reviewer:** one annotator (the tool author). No second annotator, so there
  is no inter-annotator agreement figure. Treat the number accordingly.
- **Excluded:** `AMB-TRIGGER-OVERLAP`, which is off by default. Its precision is
  measured separately on a labelled pair set — see [`RESULTS.md`](RESULTS.md).

## Result

| Rule | Severity | Findings | True positive | False positive | FP rate |
|---|---|---:|---:|---:|---:|
| `AMB-NO-TRIGGER` | info | 58 | 54 | 4 | 6.9% |
| `AMB-DUPLICATE-NAME` | warn | 24 | 23 | 1 | 4.2% |
| `RED-REPO-OVERVIEW` | warn | 7 | 6 | 1 | 14.3% |
| `RED-STALE-PATH` | info | 6 | 3 | 3 | **50.0%** |
| `BUD-BODY-OUTLIER` | info | 3 | 3 | 0 | 0% |
| `RED-GENERIC` | warn | 2 | 2 | 0 | 0% |
| **Total** | | **100** | **91** | **9** | **9.0%** |

Restricted to rules that affect the default exit code (`warn` and above):
**33 findings, 31 correct, 2 wrong — 6.1%**.

## Judgement criterion

A finding is a **true positive** when the condition the rule claims is actually
present in the file: the description really does state no trigger, the two
skills really do share a name in the same harness namespace, the lines really
are a directory listing, the path really is absent.

It is a **false positive** when the tool asserts something the file does not
support — including when the underlying condition is arguably fine to leave
alone. "This is a real directory listing but I want to keep it" is a true
positive the user chooses to ignore; "this is not a directory listing" is a
false positive.

## Every false positive, by class

**Runtime-created directories — 3 findings, `RED-STALE-PATH`.**
`dispatch/`, `progress/` and `results/` are documented as subdirectories of
`.agenthub/board/`, which an agent creates while running. They are absent from a
clone for a perfectly good reason. A static analyzer cannot distinguish "this
documentation is stale" from "this directory does not exist yet", which is why
the rule is `info` rather than `warn` and why its own finding text says it
cannot tell the two apart. This is the rule's dominant failure mode and it is
not fixable without executing the project.

**Non-English descriptions — 4 findings, `AMB-NO-TRIGGER`.**
Descriptions written in Chinese. At least one
(`a real repository` → `kb-retriever`) ends with
`用户问题涉及"从知识库目录回答问题/检索信息/查资料"时使用。` — literally "use when the
user's question involves …", a perfectly good trigger clause the detector cannot
read. Trigger detection is English-only and there is no plan to change that, so
this is a standing limitation rather than a bug.

**Prescriptive layout specification — 1 finding, `RED-REPO-OVERVIEW`.**
`## Agent File Structure` documents the frontmatter layout an agent file must
have. The heading matches the structure pattern, but the section prescribes what
to create rather than describing what exists, so it is not rediscoverable by
listing the tree. Sections whose path content sits inside a placeholder-bearing
code fence are already suppressed; this one uses no placeholder syntax and so
slips through.

**Nested plugin sub-skill — 1 finding, `AMB-DUPLICATE-NAME`.**
`.codex/skills/init` and `.codex/skills/playwright-pro/skills/init` both declare
`name: init`. They are in the same harness namespace, but the second is bundled
*inside* another skill and is probably not registered as a top-level routable
skill. The tool cannot tell which nested directories a harness registers, so it
treats every `SKILL.md` as routable.

## What earlier versions got wrong

Recorded because the rate above is only meaningful next to what it replaced.
Every one of these passed the unit tests and was found only by running on real
repositories:

| Bug | Effect |
|---|---|
| Tree regex included `` ` `` and `\|` | Matched every code fence and markdown table: ~93% FP on that rule |
| `includes('bun')` matched "bundle" | Produced every conflict finding on the corpus |
| Cross-harness copies compared | 358 duplicate findings where 24 are real |
| Questions parsed as imperatives | 382 conflict findings, effectively all wrong |
| Templates read as directory listings | Proposed deleting required-layout specifications |
| Paths never checked against disk | Could not tell a real directory from `{skill-name}/` |
| Harness assumed to be Claude Code | A Codex repo reported 0 always-on tokens *and* 17 findings about the file it had excluded; the projection read `−Infinity%` |
| Task-to-file checklists read as directory listings | `--fix` proposed deleting a real repository "when adding a partner, update these files" section |
| `<\|endoftext\|>` in any file | Hard crash with a stack trace |

## What this number is not

It measures whether findings are **correct**, not whether acting on them
**improves agent behaviour**. Nothing here demonstrates that deleting a flagged
directory listing raises task success. The ETH Zurich result supports the
weaker, sufficient claim: those sections were measured not to help, and they
cost tokens every session.

## Reproducing

```bash
npm run corpus:fetch
npm run corpus:validate -- corpus
npm run measure:recall -- corpus
```

Findings are emitted in a fixed order with no randomness, so the same corpus
yields the same list.
