#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
WORK=$(mktemp -d "${TMPDIR:-/tmp}/aies-installer-test.XXXXXX")
trap 'rm -r "$WORK"' EXIT

REAL_GIT=$(command -v git)
mkdir -p "$WORK/remote" "$WORK/bin" "$WORK/home"

git -c core.hooksPath=/dev/null -C "$WORK/remote" init -q -b main
git -c core.hooksPath=/dev/null -C "$WORK/remote" config user.email test@example.com
git -c core.hooksPath=/dev/null -C "$WORK/remote" config user.name test
mkdir -p "$WORK/remote/runtime"
printf '%s\n' 'packages: [runtime]' > "$WORK/remote/pnpm-workspace.yaml"
printf '%s\n' '{"version":"9.9.9"}' > "$WORK/remote/runtime/package.json"
git -c core.hooksPath=/dev/null -C "$WORK/remote" add .
git -c core.hooksPath=/dev/null -C "$WORK/remote" commit -qm base

cat > "$WORK/bin/git" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
args=("$@")
for i in "${!args[@]}"; do
  if [[ "${args[$i]}" == "https://github.com/EzequielMenor/AIES.git" ]]; then
    args[$i]="${AIES_TEST_REMOTE:?}"
  fi
done
exec "${REAL_GIT:?}" "${args[@]}"
EOF
chmod +x "$WORK/bin/git"

cat > "$WORK/bin/node" <<'EOF'
#!/usr/bin/env bash
if [[ "${1:-}" == "-v" ]]; then
  printf '%s\n' 'v22.19.0'
elif [[ "${1:-}" == "-p" || "${1:-}" == "-e" ]]; then
  printf '%s\n' '9.9.9'
else
  exit 0
fi
EOF
chmod +x "$WORK/bin/node"

cat > "$WORK/bin/pnpm" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
dir=''
args=("$@")
for i in "${!args[@]}"; do
  if [[ "${args[$i]}" == "--dir" ]]; then dir="${args[$((i + 1))]}"; fi
done
if [[ " $* " == *' run build '* ]]; then
  if [[ "${AIES_TEST_FAIL_BUILD:-}" == 1 ]]; then exit 1; fi
  mkdir -p "$dir/dist"
  cat > "$dir/dist/cli.js" <<'CLI'
#!/usr/bin/env bash
printf '%s\n' 'aies 9.9.9 (test-head)'
CLI
  chmod +x "$dir/dist/cli.js"
fi
EOF
chmod +x "$WORK/bin/pnpm"

PATH="$WORK/bin:$PATH" HOME="$WORK/home" AIES_TEST_REMOTE="$WORK/remote" \
  REAL_GIT="$REAL_GIT" bash "$ROOT/install.sh" >/dev/null

printf '%s\n' 'local workspace change' > "$WORK/home/.aies/pnpm-workspace.yaml"
printf '%s\n' 'upstream workspace change' > "$WORK/remote/pnpm-workspace.yaml"
git -c core.hooksPath=/dev/null -C "$WORK/remote" add pnpm-workspace.yaml
git -c core.hooksPath=/dev/null -C "$WORK/remote" commit -qm upstream

set +e
output=$(PATH="$WORK/bin:$PATH" HOME="$WORK/home" AIES_TEST_REMOTE="$WORK/remote" \
  REAL_GIT="$REAL_GIT" bash "$ROOT/install.sh" 2>&1)
status=$?
set -e

if (( status != 0 )); then
  printf '%s\n' "$output"
  printf 'expected dirty installation update to complete safely\n' >&2
  exit 1
fi

grep -q 'pnpm-workspace.yaml' <<< "$output"
grep -q 'backup' <<< "$output"
grep -q 'upstream workspace change' "$WORK/home/.aies/pnpm-workspace.yaml"
backup=$(printf '%s\n' "$WORK/home"/.aies.bak.*)
grep -q 'local workspace change' "$backup/pnpm-workspace.yaml"

printf '%s\n' 'stashed local change' > "$WORK/home/.aies/pnpm-workspace.yaml"
PATH="$WORK/bin:$PATH" HOME="$WORK/home" AIES_TEST_REMOTE="$WORK/remote" \
  REAL_GIT="$REAL_GIT" AIES_UPDATE_STRATEGY=stash bash "$ROOT/install.sh" >/dev/null
grep -q 'upstream workspace change' "$WORK/home/.aies/pnpm-workspace.yaml"
git -C "$WORK/home/.aies" stash list | grep -q 'aies update'

printf '%s\n' 'another local change' > "$WORK/home/.aies/pnpm-workspace.yaml"
set +e
PATH="$WORK/bin:$PATH" HOME="$WORK/home" AIES_TEST_REMOTE="$WORK/remote" \
  REAL_GIT="$REAL_GIT" AIES_UPDATE_STRATEGY=abort bash "$ROOT/install.sh" >/dev/null 2>&1
abort_status=$?
set -e
(( abort_status != 0 ))
grep -q 'another local change' "$WORK/home/.aies/pnpm-workspace.yaml"

set +e
PATH="$WORK/bin:$PATH" HOME="$WORK/home" AIES_TEST_REMOTE="$WORK/remote" \
  REAL_GIT="$REAL_GIT" AIES_UPDATE_STRATEGY=backup AIES_TEST_FAIL_BUILD=1 \
  bash "$ROOT/install.sh" >/dev/null 2>&1
rollback_status=$?
set -e
(( rollback_status != 0 ))
grep -q 'another local change' "$WORK/home/.aies/pnpm-workspace.yaml"
printf '%s\n' 'installer dirty update: ok'
