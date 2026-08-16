# Changelog

## Unreleased

Agent Skills specification conformance, and usability as a skill.

- **`SPEC-*` rules** validate against the published specification: `name`
  format (1–64 chars, lowercase alphanumeric, single hyphens, matching the
  parent directory) and `description` length (≤1024). A skill breaking these is
  rejected silently by compliant clients, so they are `error` severity. Across
  1,022 published skills this finds **37 hard violations**.
- **`.agents/skills/` is now counted for every harness.** It is the cross-client
  convention from the specification's implementation guide; treating it as an
  unknown third-party directory excluded the one location whose purpose is to be
  shared.
- **A single `SKILL.md` is a valid target** — the atomic operation when
  authoring a skill.
- **`conformance.willLoad`** in the JSON: one boolean answering the question
  that precedes every other.
- **`--top`** bounds rendered output and always reports what it withheld.
- **Ships an Agent Skill** in `.agents/skills/skillassay/`, read by Claude Code,
  Codex and Gemini CLI alike. 98 always-on tokens; passes its own audit with
  zero findings, asserted by a test.
- `BUD-BODY-OUTLIER` retired in favour of `SPEC-BODY-TOO-LARGE`, which uses the
  published 500-line / 5,000-token recommendation rather than an
  ecosystem percentile.

## v0.1.0 — 2026-08-16

Research project. Apache-2.0. Provided as is, without warranties or conditions
of any kind; see the Disclaimer in README.md.

First release, published to npm as `skillassay`. Install with `npx skillassay .`.

 Tier 0 budget attribution, redundancy and path rules,
duplicate-name detection, conflict detection and opt-in MCP probing are
implemented and measured. Trigger-overlap detection exists but is opt-in and
not good enough. Empirical mode does not exist.

**Measured, and published because a tool that audits measurement integrity has
to show its own numbers:**

- Parse success rate **99.32%** on 1,029 real `SKILL.md` files
- False-positive rate **9.0%** — a hand census of *all* 100 default findings,
  not a sample; **6.1%** restricted to rules that affect the exit code
- Recall **83.3%** (population) / **100%** (curated positives)
- Collateral **1.3%** — legitimate lines a `--fix` patch would remove
- Runtime **0.49s per 100 skills**
- Verified on 33 real repositories with zero crashes

**Effect size, stated plainly:** median saving across those 33 repositories is
**0 tokens**, and 18 of 33 have nothing to delete. For most repositories this
tool's answer is "your context is already lean". See README → *What it actually
saves you*.

**Known limits:** trigger detection is English-only; `RED-STALE-PATH` cannot
distinguish stale documentation from a runtime-created directory (3/6 measured
precision, ships at `info`); `AMB-TRIGGER-OVERLAP` reaches only 62% precision
and is off by default; Windows is unverified.

Full method and every false positive: `calibration/`.
