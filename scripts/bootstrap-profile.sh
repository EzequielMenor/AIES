#!/usr/bin/env bash
#
# Make the isolated AIES Pi profile match this repository. Idempotent, and safe
# to run before every launch.
#
# Repo-owned resources are linked into the profile so pi auto-discovers them
# from the isolated agent dir. Runtime state written by pi is never touched.
#
# Note: skills are deliberately NOT linked. AIES runs pi with --no-skills and
# adds its own skills directory explicitly, so global cross-harness skills
# (~/.agents/skills, not isolated by PI_CODING_AGENT_DIR) stay out.
#
set -euo pipefail

AIES_REPO="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"

AIES_HOME="${AIES_HOME:-$HOME/.local/share/aies}"
case "$AIES_HOME" in "~/"*) AIES_HOME="$HOME/${AIES_HOME#\~/}" ;; esac
AIES_AGENT_DIR="$AIES_HOME/agent"

mkdir -p "$AIES_AGENT_DIR"

link_resource() {
  local name="$1" src="$AIES_REPO/$1" dst="$AIES_AGENT_DIR/$1"

  [ -d "$src" ] || return 0

  if [ -L "$dst" ]; then
    # Already correct, or stale because the repository moved: relink either way.
    [ "$(readlink "$dst")" = "$src" ] && return 0
    rm -f "$dst"
  elif [ -e "$dst" ]; then
    # A real directory that pi (or the user) created. Never destroy it.
    printf 'aies: %s exists and is not a symlink; leaving it untouched\n' "$dst" >&2
    return 0
  fi

  ln -s "$src" "$dst"
}

for resource in agents extensions prompts themes; do
  link_resource "$resource"
done

# Seed settings.json once. From then on pi owns it (aies install, /settings).
# profile/aies.json is intentionally NOT copied: repository policy permits only
# profile/settings.json to be seeded, and a fresh profile starts with built-in
# defaults, creating its own aies.json only after a user saves a child role.
if [ ! -e "$AIES_AGENT_DIR/settings.json" ]; then
  cp "$AIES_REPO/profile/settings.json" "$AIES_AGENT_DIR/settings.json"
fi

# Reconcile the declared package list and the declared MCP servers. Pi installs
# the declared package itself on its next launch; this script never touches the
# network. Idempotent: a second run rewrites nothing.
if command -v node >/dev/null 2>&1; then
  node "$AIES_REPO/scripts/seed-profile-config.mjs" "$AIES_REPO/profile" "$AIES_AGENT_DIR" \
    || printf 'aies: profile reconciliation failed; continuing with the existing profile\n' >&2
else
  printf 'aies: node not found; skipping profile reconciliation\n' >&2
fi
