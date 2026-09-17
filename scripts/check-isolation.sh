#!/usr/bin/env bash
#
# One command that proves AIES is isolated from the ambient Pi installation.
#
# Deterministic: no credentials, no model calls, no network. Every check runs
# against a temporary AIES_HOME, so neither profile is modified.
#
set -euo pipefail

AIES_REPO="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"

printf '== resolved isolated profile (aies --aies-info)\n'
probe="$(mktemp -d)"
trap 'rm -rf "$probe"' EXIT
AIES_HOME="$probe" bash "$AIES_REPO/bin/aies" --aies-info
printf '\n'

printf '== automated checks (node --test)\n'
cd "$AIES_REPO"
node --test

cat <<'EOF'

== manual check

  aies                      # footer shows "AIES", startup notice shows the profile
  /aies-info                # prints extension path, agent dir, cwd, mode
  pi                        # your normal Pi must still start unchanged
EOF
