---
name: skillassay
description: Audits AI coding-agent context. Measures always-on context-window cost of CLAUDE.md, AGENTS.md and Agent Skills, and reports skills that will not load, stale path references, redundant instructions and duplicate skill names. Use when the user asks to audit, measure or reduce context cost, check whether a skill is valid or will load, review CLAUDE.md or AGENTS.md quality, or find duplicate, conflicting or unused skills.
license: Apache-2.0
metadata:
  homepage: https://github.com/rakib-nyc/skillassay
compatibility: Requires Node.js 20.11+ and network access on first run to fetch the package.
---

# skillassay

Run the `assay` CLI and interpret its report. **All analysis happens in the
CLI.** Never estimate a token count, invent a percentage, or judge a finding
yourself — report what the tool returns.

## Commands

```bash
npx skillassay .                      # whole repository
npx skillassay path/to/SKILL.md       # one skill — use this when authoring
npx skillassay . --json               # structured output, nothing truncated
npx skillassay . --top 10             # bounded human-readable output
npx skillassay . --fix                # unified diff of deletions; never applied
npx skillassay --explain SPEC-NAME-INVALID   # a rule, its source, its limits
```

## Deciding what to do first

Read `conformance.willLoad` from `--json` before anything else.

- **`false`** — one or more skills violate the Agent Skills specification and no
  compliant client will register them. Fix every `SPEC-*` error first; findings
  about verbosity or duplication are moot until then.
- **`true`** — the skills load. Now the `warn` findings are worth acting on.

## Reading the report

- **ALWAYS-ON CONTEXT** — tokens loaded every session before the user types.
  Counted with cl100k_base as a proxy, which the output labels; do not present
  it as an exact Claude count.
- **Found but not counted** — real files this harness does not load. Expected,
  not an error.
- **FINDINGS** — each carries a rule ID, a citation and, where applicable, the
  tokens saved by acting on it.

## Rules for you

- Show the user the `--fix` diff before applying any part of it. The tool never
  writes to files and neither should you without agreement.
- When a finding is `info`, say so. `RED-STALE-PATH` in particular cannot tell a
  stale reference from a directory created at runtime.
- If the user asks why a rule exists, run `--explain <RULE-ID>` rather than
  guessing; it prints the source and what the rule does not establish.
- Skills meant to work across Claude Code, Codex and Gemini CLI belong in
  `.agents/skills/`, which every compliant client reads.
