#!/usr/bin/env bash
#
# Fetches the validation corpus at pinned commits.
#
# The corpus is NOT vendored into this repository — it is ~1,000 skills across
# eleven third-party projects with their own licences. Pinning commit SHAs makes
# the published measurements reproducible without redistributing other people's
# work: anyone can re-run `npm run corpus:fetch && npm run corpus:validate` and
# get the same numbers from the same bytes.
#
# Two repositories in the list contain zero SKILL.md files (they catalogue
# skills by link rather than vendoring them). They are kept in the list because
# removing them after seeing the result would be selecting sources on outcome.
#
# Usage: npm run corpus:fetch [target-dir]
set -euo pipefail

TARGET="${1:-corpus}"
mkdir -p "$TARGET"

# repo<TAB>commit  — pinned 2026-08-16
REPOS=$(cat <<'EOF'
ConardLi/garden-skills	aaf9a82f5efd73e87cc0998edc398e75bfc35901
GuDaStudio/skills	d0e8b1d4bed2f1aaf77185aece1f17b78933feb2
Jeffallan/claude-skills	882ef55e377dbf9a4dbe496bb41ac6ccd0e555cf
VoltAgent/awesome-agent-skills	b729ad068c38bb186ca8ad09cc12223b3e9e250c
alirezarezvani/claude-skills	aa8d778811a557a2c28ccadda4cf3d0bd028a4cc
anthropics/skills	f6656c1256d5a8adfa37db9110046ef20bac644c
hashicorp/agent-skills	4451ceca5456e79cc776efee96a744f7ac96e5bf
lixiaolin94/skills	ee7e9c50049bf9278b7810c3cd00802cfa401138
samber/cc-skills-golang	30cdf15cde8db8730c42a2918d7cdb4505f5ff54
softaworks/agent-toolkit	3027f20f3181758385a1bb8c022d4041dfb4de84
utkusen/sast-skills	db52227eab1043bf122cbff7206fac6708b4d6c9
EOF
)

while IFS=$'\t' read -r repo commit; do
  [ -z "$repo" ] && continue
  dir="$TARGET/$(echo "$repo" | tr '/' '_')"

  if [ -d "$dir/.git" ]; then
    echo "· $repo already present"
  else
    echo "↓ $repo"
    git init --quiet "$dir"
    git -C "$dir" remote add origin "https://github.com/$repo.git"
  fi

  # Fetch exactly the pinned commit rather than a branch tip, so the corpus
  # cannot drift under the published numbers.
  git -C "$dir" fetch --quiet --depth 1 origin "$commit"
  git -C "$dir" checkout --quiet FETCH_HEAD
done <<< "$REPOS"

echo
echo "SKILL.md files: $(find "$TARGET" -name SKILL.md | wc -l | tr -d ' ')"
echo "Now run: npm run corpus:validate -- $TARGET"
