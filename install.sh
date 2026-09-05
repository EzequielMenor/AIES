#!/usr/bin/env bash
set -euo pipefail

REPO="https://github.com/EzequielMenor/AIES.git"
INSTALL_DIR="$HOME/.aies"
BIN_DIR="$HOME/.local/bin"
BIN_NAME="aies"
UPDATE_STRATEGY="${AIES_UPDATE_STRATEGY:-}"
ROLLBACK_BACKUP=""

info()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn()  { printf '\033[1;33mWARN:\033[0m %s\n' "$*"; }
fail()  { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

rollback_on_failure() {
  local status=$?
  if [ "$status" -ne 0 ] && [ -n "$ROLLBACK_BACKUP" ] && [ -d "$ROLLBACK_BACKUP" ]; then
    warn "La actualización no pudo completarse; restaurando la instalación anterior desde $ROLLBACK_BACKUP."
    local failed_dir="$INSTALL_DIR.failed.$(date +%Y%m%d%H%M%S)"
    if [ -e "$INSTALL_DIR" ]; then
      mv "$INSTALL_DIR" "$failed_dir" 2>/dev/null || true
    fi
    if mv "$ROLLBACK_BACKUP" "$INSTALL_DIR" 2>/dev/null; then
      info "Instalación anterior restaurada. La copia incompleta quedó en $failed_dir."
    else
      warn "No se pudo restaurar automáticamente $ROLLBACK_BACKUP; conservá esa copia para recuperar la instalación."
    fi
  fi
  exit "$status"
}

trap rollback_on_failure EXIT

check_node() {
  command -v node >/dev/null 2>&1 || fail "Node.js no encontrado. Instalá Node.js >= 22.19.0: https://nodejs.org"
  local major minor
  major=$(node -v | sed 's/^v//' | cut -d. -f1)
  minor=$(node -v | sed 's/^v//' | cut -d. -f2)
  if [ "$major" -lt 22 ] || { [ "$major" -eq 22 ] && [ "$minor" -lt 19 ]; }; then
    fail "Node.js >= 22.19.0 requerido (tenés $(node -v))"
  fi
  info "Node.js $(node -v)"
}

check_git() {
  command -v git >/dev/null 2>&1 || fail "git no encontrado."
  info "git $(git --version | cut -d' ' -f3)"
}

detect_pm() {
  if command -v pnpm >/dev/null 2>&1; then
    PM="pnpm"
  elif command -v npm >/dev/null 2>&1; then
    PM="npm"
  else
    fail "pnpm o npm requerido."
  fi
  info "Package manager: $PM"
}

clone_or_update() {
  if [ -d "$INSTALL_DIR/.git" ]; then
    info "Actualizando $INSTALL_DIR"
    local prev_short prev_full new_full new_short local_changes upstream strategy
    prev_short=$(git -C "$INSTALL_DIR" rev-parse --short HEAD)
    prev_full=$(git -C "$INSTALL_DIR" rev-parse HEAD)

    local_changes=$(git -C "$INSTALL_DIR" status --porcelain)
    if ! git -C "$INSTALL_DIR" fetch --quiet; then
      fail "No se pudo consultar el remoto de $INSTALL_DIR; la instalación quedó intacta"
    fi
    upstream=$(git -C "$INSTALL_DIR" rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' 2>/dev/null || true)

    local divergent=false
    if [ -z "$upstream" ]; then
      divergent=true
    elif ! git -C "$INSTALL_DIR" merge-base --is-ancestor HEAD "$upstream"; then
      divergent=true
    fi

    if [ -n "$local_changes" ] || [ "$divergent" = true ]; then
      warn "La instalación local tiene cambios o commits que no se pueden sobrescribir automáticamente."
      if [ -n "$local_changes" ]; then
        info "Cambios locales detectados:"
        printf '%s\n' "$local_changes"
      fi
      if [ "$divergent" = true ]; then
        warn "La rama local diverge de ${upstream:-su remoto configurado}."
        git --no-pager -C "$INSTALL_DIR" log --oneline -5 HEAD || true
      fi
      warn "Estrategias: backup (conserva todo y reinstala), stash (solo cambios sin commits locales) o abort."

      strategy="$UPDATE_STRATEGY"
      if [ -z "$strategy" ] && [ -r /dev/tty ] && [ -t 1 ]; then
        printf 'Elegí una estrategia [b]ackup/[s]tash/[a]bort (backup): ' > /dev/tty
        read -r strategy < /dev/tty || strategy="backup"
      fi
      strategy="${strategy:-backup}"
      case "$strategy" in
        b|backup)
          backup_existing_installation
          return 0
          ;;
        s|stash)
          if [ "$divergent" = true ]; then
            warn "stash no resuelve commits divergentes; se usará backup para conservarlos."
            backup_existing_installation
            return 0
          fi
          if ! git -C "$INSTALL_DIR" stash push --include-untracked --message "aies update $(date +%Y%m%d%H%M%S)"; then
            fail "No se pudieron guardar los cambios en stash; la instalación quedó intacta"
          fi
          info "Cambios locales guardados en git stash; la actualización continuará con un árbol limpio."
          ;;
        a|abort)
          fail "Actualización cancelada. Usá AIES_UPDATE_STRATEGY=backup, stash o abort para elegir explícitamente."
          ;;
        *)
          fail "Estrategia desconocida '$strategy'. Usá backup, stash o abort."
          ;;
      esac
    fi

    if ! git -C "$INSTALL_DIR" pull --ff-only --quiet; then
      fail "git pull falló; la instalación quedó intacta. Usá AIES_UPDATE_STRATEGY=backup para reinstalar conservando una copia."
    fi
    new_full=$(git -C "$INSTALL_DIR" rev-parse HEAD)
    new_short=$(git -C "$INSTALL_DIR" rev-parse --short HEAD)
    if [ "$prev_full" = "$new_full" ]; then
      info "Ya estás en la última versión ($prev_short)"
    else
      info "Actualizado $prev_short → $new_short"
      if git -C "$INSTALL_DIR" rev-parse -q --verify "$prev_full^{commit}" >/dev/null 2>&1; then
        git --no-pager -C "$INSTALL_DIR" log --oneline "$prev_full..HEAD"
      else
        warn "No se puede listar el historial completo (clone shallow). Mostrando los últimos 10 commits:"
        git --no-pager -C "$INSTALL_DIR" log --oneline -10 HEAD
      fi
    fi
  else
    if [ -d "$INSTALL_DIR" ]; then
      local backup="$INSTALL_DIR.bak.$(date +%Y%m%d%H%M%S)"
      warn "$INSTALL_DIR existe pero no es un repo git. Moviendo a $backup..."
      mv "$INSTALL_DIR" "$backup"
    fi
    info "Clonando AIES en $INSTALL_DIR"
    git clone --depth 1 --quiet "$REPO" "$INSTALL_DIR"
  fi
}

backup_existing_installation() {
  local backup="$INSTALL_DIR.bak.$(date +%Y%m%d%H%M%S)"
  while [ -e "$backup" ]; do
    backup="$INSTALL_DIR.bak.$(date +%Y%m%d%H%M%S).$RANDOM"
  done
  warn "Moviendo la instalación local a $backup (no se perderán cambios)."
  mv "$INSTALL_DIR" "$backup"
  ROLLBACK_BACKUP="$backup"
  info "Clonando AIES limpio en $INSTALL_DIR"
  git clone --depth 1 --quiet "$REPO" "$INSTALL_DIR"
}

install_deps() {
  info "Instalando dependencias ($PM install)"
  if [ "$PM" = "pnpm" ]; then
    pnpm --loglevel=silent --dir "$INSTALL_DIR/runtime" install
  else
    npm --silent install --prefix "$INSTALL_DIR/runtime"
  fi
}

build() {
  info "Compilando (tsc — puede tardar ~30s)…"
  if [ "$PM" = "pnpm" ]; then
    pnpm --loglevel=silent --dir "$INSTALL_DIR/runtime" --config.verify-deps-before-run=false run build
  else
    npm --silent run build --prefix "$INSTALL_DIR/runtime"
  fi
}

link_bin() {
  mkdir -p "$BIN_DIR"
  local src="$INSTALL_DIR/runtime/dist/cli.js"
  local dst="$BIN_DIR/$BIN_NAME"

  [ -f "$src" ] || fail "Build falló: $src no existe"

  chmod +x "$src"
  ln -sf "$src" "$dst"
  info "Binario enlazado: $dst"

  case ":$PATH:" in
    *":$BIN_DIR:"*) ;;
    *)
      local shell_rc=""
      case "${SHELL:-}" in
        */zsh)  shell_rc="$HOME/.zshrc" ;;
        */bash) shell_rc="$HOME/.bashrc" ;;
      esac
      if [ -n "$shell_rc" ]; then
        if ! grep -qF "$BIN_DIR" "$shell_rc" 2>/dev/null; then
          printf '\nexport PATH="%s:$PATH"\n' "$BIN_DIR" >> "$shell_rc"
          info "Añadido $BIN_DIR al PATH en $shell_rc"
          warn "Reiniciá la terminal o ejecutá: source $shell_rc"
        fi
      else
        warn "Añadí $BIN_DIR a tu PATH manualmente"
      fi
      ;;
  esac
}

verify_installation() {
  local src="$INSTALL_DIR/runtime/dist/cli.js"
  local dst="$BIN_DIR/$BIN_NAME"
  local expected_version actual_version

  [ -f "$src" ] || fail "Verificación falló: build incompleto ($src no existe)"
  [ -L "$dst" ] || fail "Verificación falló: $dst no es un symlink"
  [ "$(readlink "$dst")" = "$src" ] || fail "Verificación falló: $dst no apunta al build nuevo"

  expected_version=$(node -e 'const fs = require("node:fs"); const p = process.argv[1]; process.stdout.write(JSON.parse(fs.readFileSync(p, "utf8")).version)' "$INSTALL_DIR/runtime/package.json") \
    || fail "No se pudo leer la versión de runtime/package.json"
  actual_version=$("$dst" --version 2>&1) \
    || fail "El binario actualizado no responde a --version"
  case "$actual_version" in
    "aies $expected_version ("*) ;;
    *) fail "Verificación falló: se esperaba aies $expected_version y se obtuvo '$actual_version'" ;;
  esac
  info "Verificado: build, binario y $actual_version"
}

install_codegraph() {
  if command -v codegraph >/dev/null 2>&1; then
    info "codegraph ya instalado: $(command -v codegraph)"
    return 0
  fi
  info "Instalando codegraph (npm global)…"
  if command -v npm >/dev/null 2>&1; then
    if npm i -g @colbymchenry/codegraph 2>/dev/null; then
      info "codegraph instalado vía npm."
      return 0
    fi
    warn "npm install -g @colbymchenry/codegraph falló (puede requerir permisos o red)."
  else
    warn "npm no encontrado — saltando instalación de codegraph."
  fi
  return 1
}

install_projectmem() {
  if command -v pjm >/dev/null 2>&1; then
    info "projectmem ya instalado: $(command -v pjm)"
    return 0
  fi
  info "Instalando projectmem (requiere Python)…"
  if command -v uv >/dev/null 2>&1; then
    if uv tool install projectmem 2>/dev/null; then
      info "projectmem instalado vía uv."
      return 0
    fi
    warn "uv tool install projectmem falló."
  fi
  if command -v pipx >/dev/null 2>&1; then
    if pipx install projectmem 2>/dev/null; then
      info "projectmem instalado vía pipx."
      return 0
    fi
    warn "pipx install projectmem falló."
  fi
  if command -v pip >/dev/null 2>&1 || command -v pip3 >/dev/null 2>&1; then
    local pip_cmd
    pip_cmd="$(command -v pip3 || command -v pip)"
    if $pip_cmd install --user projectmem 2>/dev/null; then
      warn "projectmem instalado vía pip --user. Si no aparece en PATH, añadí ~/.local/bin al PATH."
      return 0
    fi
    warn "pip install --user projectmem falló."
  fi
  warn "Ninguna cadena de instalación funcionó (uv/pipx/pip no disponibles o sin red)."
  warn "projectmem es opcional. AIES funciona sin él (las tools informarán indisponibilidad)."
  return 1
}

install_extras() {
  install_codegraph || true
  install_projectmem || true
  info "Herramientas externas: codegraph=$(command -v codegraph >/dev/null 2>&1 && echo OK || echo MISSING), projectmem=$(command -v pjm >/dev/null 2>&1 && echo OK || echo MISSING)"
}

main() {
  info "AIES Installer"
  check_node
  check_git
  detect_pm
  clone_or_update
  install_deps
  build
  link_bin
  verify_installation
  install_extras
  info "AIES instalado. Ejecutá: aies"
}

main
