#!/usr/bin/env bash
set -euo pipefail

REPO="https://github.com/EzequielMenor/AIES.git"
INSTALL_DIR="$HOME/.aies"
BIN_DIR="$HOME/.local/bin"
BIN_NAME="aies"

info()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn()  { printf '\033[1;33mWARN:\033[0m %s\n' "$*"; }
fail()  { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

check_node() {
  command -v node >/dev/null 2>&1 || fail "Node.js no encontrado. Instalá Node.js >= 20: https://nodejs.org"
  local version
  version=$(node -v | sed 's/^v//' | cut -d. -f1)
  [ "$version" -ge 20 ] || fail "Node.js >= 20 requerido (tenés $(node -v))"
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
    git -C "$INSTALL_DIR" pull --ff-only
  else
    if [ -d "$INSTALL_DIR" ]; then
      warn "$INSTALL_DIR existe pero no es un repo git. Eliminando..."
      rm -rf "$INSTALL_DIR"
    fi
    info "Clonando AIES en $INSTALL_DIR"
    git clone --depth 1 "$REPO" "$INSTALL_DIR"
  fi
}

install_deps() {
  info "Instalando dependencias ($PM install)"
  if [ "$PM" = "pnpm" ]; then
    pnpm install --dir "$INSTALL_DIR/runtime"
  else
    npm install --prefix "$INSTALL_DIR/runtime"
  fi
}

build() {
  info "Compilando (tsc)"
  if [ "$PM" = "pnpm" ]; then
    pnpm run build --dir "$INSTALL_DIR/runtime"
  else
    npm run build --prefix "$INSTALL_DIR/runtime"
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

main() {
  info "AIES Installer"
  check_node
  check_git
  detect_pm
  clone_or_update
  install_deps
  build
  link_bin
  info "AIES instalado. Ejecutá: aies"
}

main
