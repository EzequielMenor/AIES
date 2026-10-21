#!/usr/bin/env bash
#
# Create the AIES-owned virtualenv that holds ProjectMem (D42), pinned.
#
#   AIES_HOME=<profile> bash scripts/memory-bootstrap.sh
#
# The venv lives at $AIES_HOME/memory/_venv. The global `pjm`, the user's
# ~/.projectmem and any ambient Python environment are never read or written:
# the script installs one pinned package into the AIES venv and runs nothing
# from it. Idempotent: an existing venv with the pinned version is left alone.
#
# Optional by design: AIES works without memory when this script was never run.
set -euo pipefail

PROJECTMEM_VERSION="0.3.4"

if [ -z "${AIES_HOME:-}" ]; then
  printf 'memory-bootstrap: AIES_HOME is not set; refusing to guess a profile\n' >&2
  exit 2
fi

case "$AIES_HOME" in
  /*) ;;
  *)
    printf 'memory-bootstrap: AIES_HOME must be an absolute path\n' >&2
    exit 2
    ;;
esac

memory_dir="$AIES_HOME/memory"
venv_dir="$memory_dir/_venv"

# A symlinked memory directory could redirect the install out of the profile.
if [ -L "$memory_dir" ] || [ -L "$venv_dir" ]; then
  printf 'memory-bootstrap: %s or its venv is a symlink; refusing\n' "$memory_dir" >&2
  exit 1
fi

installed_version() {
  [ -x "$venv_dir/bin/python" ] || return 0
  "$venv_dir/bin/python" -I -c 'import importlib.metadata as m; print(m.version("projectmem"))' 2>/dev/null || true
}

if [ "$(installed_version)" = "$PROJECTMEM_VERSION" ]; then
  printf 'memory-bootstrap: projectmem==%s already installed in %s\n' "$PROJECTMEM_VERSION" "$venv_dir"
  exit 0
fi

mkdir -p -- "$memory_dir"

# No ambient pip configuration may redirect the install or leave the venv.
unset PIP_REQUIRE_VIRTUALENV PIP_TARGET PIP_USER PIP_PREFIX PIP_INDEX_URL PIP_EXTRA_INDEX_URL PIP_CONFIG_FILE
# Defence in depth: nothing here runs pjm, but if it ever did it must not use the real registry.
export PROJECTMEM_HOME="$memory_dir/_home"

if command -v uv >/dev/null 2>&1; then
  uv venv --quiet --seed "$venv_dir"
  uv pip install --quiet --python "$venv_dir/bin/python" "projectmem==$PROJECTMEM_VERSION"
elif command -v python3 >/dev/null 2>&1; then
  python3 -m venv "$venv_dir"
  "$venv_dir/bin/python" -m pip install --quiet --disable-pip-version-check --no-input "projectmem==$PROJECTMEM_VERSION"
else
  printf 'memory-bootstrap: neither uv nor python3 is available\n' >&2
  exit 1
fi

found="$(installed_version)"
if [ "$found" != "$PROJECTMEM_VERSION" ]; then
  printf 'memory-bootstrap: expected projectmem==%s, found "%s"\n' "$PROJECTMEM_VERSION" "$found" >&2
  exit 1
fi

printf 'memory-bootstrap: projectmem==%s installed in %s\n' "$PROJECTMEM_VERSION" "$venv_dir"
