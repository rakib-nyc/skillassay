# Changelog

## v0.1.2 — 2026-08-16

No functional change. The registry serves a package's README, description and
keywords from its published tarball, so presentation changes need a version to
travel — this is that version.

- The README leads with both ways the tool is used — the CLI and the installable
  Agent Skill — rather than treating the skill as a footnote, and states the
  per-client install locations.
- `.agents/skills/**` is documented as counted for every harness in the support
  table, which is where readers look for it.
- Keywords cover skill-authoring intent (`agent-skill`, `claude-skills`,
  `skill`); the package description names the skill and the four harnesses.
- Packed tarballs are excluded from the published repository. npm hosts them,
  and `release/skillassay-0.1.0.tgz` had already been committed.

## v0.1.1 — 2026-08-16

Fixes.1.0 binary against 54 adversarial
scenarios rather than against the development tree.

- **`--json` no longer truncates when piped.** Node writes to a pipe
  asynchronously, and the CLI called `process.exit()` without waiting for the
  buffer to drain, so any report larger than the operating system's 64 KiB pipe
  capacity lost everything past that point. `assay . --json > file.json` was
  complete while `assay . --json | jq` silently received a prefix — which is how
  every agent consumes the tool. A 40-skill repository is enough to cross the
  line. Every output path now flushes before exiting.
- **A reader that closes early exits quietly.** `assay . --json | head -1` raised
  an unhandled `EPIPE` over the caller's output instead of stopping.
- **The compiled CLI is built on `prepack`, not `prepublishOnly`.** `npm pack`
  runs the first and skips the second, so a tarball built for review or handed
  to someone else to publish contained the sources and no `dist/` — six files
  instead of sixty, with no error and a bin entry pointing at nothing. A test
  now asserts the lifecycle hook and that every `bin` target lies under `files`.
- **`--exclude` warns when a fragment matched nothing.** It compares literal
  repository-relative path prefixes, so a glob such as `**/name/**` silently
  excluded nothing and the run reported a budget that still contained the files
  the caller believed they had removed. The help text now states the semantics.

Verified on Node 20.11 and 24, and against the 1,029-file corpus with
measurements unchanged.

## v0.1.0 — 2026-08-16

Research project. Apache-2.0. Provided as is, without warranties or conditions
of any kind; see the Disclaimer in README.md.

First release, published to npm as `skillassay`. Install with `npx skillassay .`.

### Agent Skills specification conformance, and usability as a skill

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

### Scope

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
