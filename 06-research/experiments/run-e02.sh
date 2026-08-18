#!/usr/bin/env bash
# run-e02.sh — E-02 (H-02): 4 tareas AIES con cwd = copia fresca de seed por réplica.
# Réplicas: REPLICAS="1 2 3" (defecto 1). E-01 usa seeds también (cada réplica recopia),
# así que este runbook NO contamina el corpus h-02-corpus (que queda como referencia).
# Antes de correr: exportar ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, MINIMAX_API_KEY u OPENCODE_API_KEY.
set -u

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DATA="$ROOT/06-research/experiments/e02-data"
SEEDS="$ROOT/06-research/experiments/seeds"
NODE="${NODE:-node}"
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
REPLICAS="${REPLICAS:-1}"

if [ -z "${ANTHROPIC_API_KEY:-}" ] && [ -z "${ANTHROPIC_AUTH_TOKEN:-}" ] && [ -z "${MINIMAX_API_KEY:-}" ] && [ -z "${OPENCODE_API_KEY:-}" ]; then
	echo "run-e02: SIN CREDENCIALES. Exporta ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, MINIMAX_API_KEY u OPENCODE_API_KEY y vuelve a correr." >&2
	exit 3
fi

OBJ1='añade greet(name) a src/math.js que devuelva `hello ${name}`'
OBJ2="añade clamp(n, min, max) a src/math.js (n acotado a [min,max]: si n<min → min; si n>max → max; resto → n) y capitalize(s) a src/strings.js (primera letra en mayúscula, resto igual; vacío → '') sin tocar add/multiply/upper"
OBJ3="la lógica de acotación Math.min(Math.max(x, min), max) está duplicada en src/math.js (clampReport) y src/format.js (formatRange); extrae clamp(n, min, max) a un módulo nuevo src/range.js y úsala desde ambos ficheros sin cambiar el comportamiento público (no tocar package.json)"
OBJ4="corrige countWords(s) en src/count.js para que cuente bien con más de un espacio en blanco ('a  b' → 2) sin cambiar los resultados de los casos que ya pasan (mínimo cambio, solo src/count.js)"

hash_cwd() {
	"$NODE" -e "const {createHash} = require('node:crypto'); process.stdout.write(createHash('sha1').update(process.argv[1]).digest('hex').slice(0,16))" "$1"
}

run_one() {
	local r="$1" t="$2" obj="$3"
	local rd="$DATA/r$r"
	local cwd="$rd/$t"
	mkdir -p "$rd"
	rm -rf "$cwd"
	cp -R "$SEEDS/$t" "$cwd"
	local h
	h="$(hash_cwd "$cwd")"
	local st="$AGENT_DIR/aies/$h/state.json" lf="$AGENT_DIR/aies/$h/log.jsonl"

	echo "=== [r$r] $t (cwd $cwd) ==="
	rm -f "$st" "$lf"
	"$NODE" "$ROOT/runtime/dist/cli.js" run --cwd "$cwd" "$obj" > "$rd/$t-cli.out" 2>&1
	local rc=$?
	local log_path
	log_path="$(sed -n 's/.*log\.jsonl *: //p' "$rd/$t-cli.out" | tail -1 | sed 's/  ([0-9]* entradas) *$//')"
	if [ -z "$log_path" ] || [ ! -f "$log_path" ]; then
		echo "run-e02: WARN [r$r] $t sin log.jsonl (rc=$rc). Primeras líneas:" >&2
		head -20 "$rd/$t-cli.out" >&2
	else
		"$NODE" "$ROOT/runtime/dist/research/metrics.js" "$log_path" > "$rd/$t-metrics.json"
		echo "$t rc=$rc log=$log_path metrics=-> $rd/$t-metrics.json"
	fi
}

for r in $REPLICAS; do
	run_one "$r" t01-greet "$OBJ1"
	run_one "$r" t02-clamp-capitalize "$OBJ2"
	run_one "$r" t03-refactor "$OBJ3"
	run_one "$r" t04-count "$OBJ4"
done

echo "=== run-e02 terminado. Réplicas: $REPLICAS. Dataset: $DATA/r<r> ==="