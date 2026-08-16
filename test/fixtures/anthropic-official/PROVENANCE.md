# Vendored snapshot

`anthropics/skills` at commit `f6656c1256d5a8adfa37db9110046ef20bac644c`, vendored 2026-08-16.

Used as the conformance corpus (BUILD_SPEC §3.2: "Your parser must handle every
file in this repo without error") and as the tokenizer calibration reference.
Upstream licences are preserved in the per-skill `LICENSE.txt` files and in
`THIRD_PARTY_NOTICES.md`.

Measured here: 18 skills, median discovery cost 68 tokens, total 1,738 tokens
always-on, against 53,899 tokens of skill bodies that load only on trigger.
