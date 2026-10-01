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

CANONICAL_AIES_HOME="$HOME/.local/share/aies"
AIES_HOME="${AIES_HOME:-}"

allow_ephemeral=0
explicit_home=""

while [ $# -gt 0 ]; do
  case "$1" in
    --aies-ephemeral)
      allow_ephemeral=1
      shift
      ;;
    --aies-home)
      if [ $# -lt 2 ]; then
        printf 'bootstrap-profile: --aies-home requires a path\n' >&2
        exit 2
      fi
      explicit_home="$2"
      shift 2
      ;;
    --aies-home=*)
      explicit_home="${1#--aies-home=}"
      shift
      ;;
    *)
      shift
      ;;
  esac
done

# Profile resolution precedence:
# 1. Explicit CLI flag: --aies-home <path> (always respected, interactive or non-interactive)
# 2. Explicit ephemeral opt-in: --aies-ephemeral or AIES_EPHEMERAL=1 (allows temporary paths in interactive sessions)
# 3. Inherited persistent/non-temp custom AIES_HOME (e.g. ~/my-profile, always respected)
# 4. Inherited suspicious temporary AIES_HOME (/tmp/*, etc.) in interactive use ([ -t 0 ]) without (1) or (2):
#    sanitized with warning, falls back to CANONICAL_AIES_HOME ($HOME/.local/share/aies).
# 5. Default: CANONICAL_AIES_HOME ($HOME/.local/share/aies)
if [ -n "$explicit_home" ]; then
  AIES_HOME="$explicit_home"
elif [ -n "${AIES_HOME:-}" ]; then
  case "$AIES_HOME" in "~/"*) AIES_HOME="$HOME/${AIES_HOME#\~/}" ;; esac
  case "$AIES_HOME" in
    /tmp/*|/private/tmp/*|/var/folders/*|${TMPDIR:-/tmp}/*)
      if [ "$allow_ephemeral" -eq 0 ] && [ "${AIES_EPHEMERAL:-0}" -ne 1 ] && [ -t 0 ]; then
        AIES_HOME="$CANONICAL_AIES_HOME"
      fi
      ;;
  esac
else
  AIES_HOME="$CANONICAL_AIES_HOME"
fi
case "$AIES_HOME" in "~/"*) AIES_HOME="$HOME/${AIES_HOME#\~/}" ;; esac
export AIES_HOME
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
