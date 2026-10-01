#!/usr/bin/env bash
#
# Explicit test harness for AIES (EZE-493).
#
# One command, usable as-is against the working tree and against any other
# checkout (e.g. the base ref), on the host and inside Verify's OS sandbox:
#
#   bash scripts/test-harness.sh [harness options] [--] [node --test args...]
#
# Harness environment:
#   AIES_TEST_REPO=<dir>    run `node --test` in that checkout instead of this
#                         script's own repository. The script is self-
#                           contained, so the same command runs the base ref and
#                           the worktree under identical conditions:
#                             AIES_TEST_REPO=/tmp/aies-base bash scripts/test-harness.sh
#
# Per execution it guarantees:
#   * a fresh temporary AIES_HOME profile, removed on exit: no run resolves or
#     writes the real profile (~/.local/share/aies);
#   * the ambient PI_CODING_AGENT_DIR / PI_CODING_AGENT_SESSION_DIR /
#     AIES_EPHEMERAL pointers are stripped from the test process, and the two Pi
#     pointers are then pinned to controlled paths inside that temporary
#     profile: left undefined, Pi resolves ~/.pi/agent and touches the real
#     profile from the tests and from every child they spawn (the tests
#     re-inject hostile ambient values per spawn where the launcher's override
#     is what is being asserted);
#   * the exit code of `node --test` propagates unchanged: real failures fail
#     this harness.
#
# Harness options:
#   --nested-sandbox      export AIES_TEST_NESTED_SANDBOX=1: tests that execute
#                         OS sandbox enforcement report themselves as skipped
#                         (never as passed). Use when the suite itself already
#                         runs inside an outer sandbox.
#   --no-nested-sandbox   export AIES_TEST_NESTED_SANDBOX=0: force those
#                         enforcement tests to run even under an outer sandbox.
#                         They fail loudly there; use only to reproduce a
#                         failure, never to get green.
#   -h, --help            print this help and exit.
#
# Without an option the tests decide from the marker that
# @anthropic-ai/sandbox-runtime stamps on sandboxed children
# (SANDBOX_RUNTIME=1), so `npm test`, `npm run check:isolation` and this harness
# behave identically and the same command works in every context.
set -euo pipefail

usage() {
  cat <<'EOF'
usage: bash scripts/test-harness.sh [--nested-sandbox|--no-nested-sandbox|-h] [--] [node --test args...]

Runs `node --test` with a temporary AIES profile for this execution and a
sanitized environment. Extra arguments are passed to node --test unchanged
(for example a list of test files to run a focused subset).

Environment: AIES_TEST_REPO=<dir> runs `node --test` in that checkout instead
of this script's own repository (base-ref comparison with identical conditions).
EOF
}

nested_sandbox=""
while [ $# -gt 0 ]; do
  case "$1" in
    --nested-sandbox)
      nested_sandbox=1
      shift
      ;;
    --no-nested-sandbox)
      nested_sandbox=0
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      break
      ;;
  esac
done

# Resolve the target checkout after option parsing so `--help` never depends on
# AIES_TEST_REPO. Wrong directory: fail loudly instead of testing this repo.
if [ -n "${AIES_TEST_REPO:-}" ]; then
  AIES_REPO="$(cd -- "$AIES_TEST_REPO" 2>/dev/null && pwd -P)" || {
    printf 'test-harness: AIES_TEST_REPO is not a directory: %s\n' "$AIES_TEST_REPO" >&2
    exit 2
  }
else
  AIES_REPO="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
fi

# Temporary profile for this execution (EZE-493): every bootstrap and session
# write lands here and is removed when the run ends.
HARNESS_HOME="$(mktemp -d "${TMPDIR:-/tmp}/aies-test-home.XXXXXX")"

cleanup() {
  status=$?
  if [ -n "${HARNESS_HOME:-}" ] && [ -d "$HARNESS_HOME" ]; then
    rm -rf -- "$HARNESS_HOME" || true
  fi
  exit "$status"
}
trap cleanup EXIT

export AIES_HOME="$HARNESS_HOME"

# Strip first: no inherited pointer survives (EZE-493). Then pin the Pi
# pointers to controlled paths inside this execution's temporary profile —
# with PI_CODING_AGENT_DIR undefined Pi falls back to ~/.pi/agent (auth.json,
# its lock and sessions in the real profile), which the suite must never touch.
# The directories are created here so Pi never has to create them elsewhere.
unset PI_CODING_AGENT_DIR PI_CODING_AGENT_SESSION_DIR AIES_EPHEMERAL
export PI_CODING_AGENT_DIR="$AIES_HOME/agent"
export PI_CODING_AGENT_SESSION_DIR="$AIES_HOME/agent/sessions"
mkdir -p -- "$PI_CODING_AGENT_DIR" "$PI_CODING_AGENT_SESSION_DIR"

if [ -n "$nested_sandbox" ]; then
  export AIES_TEST_NESTED_SANDBOX="$nested_sandbox"
fi

cd "$AIES_REPO"
# Under `set -e` a failing node --test exits the script with node's status and
# still runs the EXIT trap, so the harness exit code IS the test exit code.
node --test "$@"
