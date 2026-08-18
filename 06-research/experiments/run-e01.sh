#!/usr/bin/env bash
# run-e01.sh — E-01 (H-01): brazo AIES + baseline agente-único sobre copias frescas de seeds.
# Reconstruido desde E-01-H-01-contexto-vs-baseline.md §§3-4. Réplicas: REPLICAS="1 2 3" (defecto 1).
# Antes de correr: exportar ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, MINIMAX_API_KEY u OPENCODE_API_KEY.
# Sin SIGINT ni intervención durante las corridas. Config: AIES_CONFIG (defecto: v0).
set -u

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DATA="$ROOT/06-research/experiments/e01-data"
SEEDS="$ROOT/06-research/experiments/seeds"
NODE="${NODE:-node}"
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
REPLICAS="${REPLICAS:-1}"

if [ -z "${ANTHROPIC_API_KEY:-}" ] && [ -z "${ANTHROPIC_AUTH_TOKEN:-}" ] && [ -z "${MINIMAX_API_KEY:-}" ] && [ -z "${OPENCODE_API_KEY:-}" ]; then
	echo "run-e01: SIN CREDENCIALES. Exporta ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, MINIMAX_API_KEY u OPENCODE_API_KEY y vuelve a correr." >&2
	exit 3
fi

# Objetivos canónicos (mismos que E-02; t01 = literal de E-02 §4).
OBJ1='añade greet(name) a src/math.js que devuelva `hello ${name}`'
OBJ2="añade clamp(n, min, max) a src/math.js (n acotado a [min,max]: si n<min → min; si n>max → max; resto → n) y capitalize(s) a src/strings.js (primera letra en mayúscula, resto igual; vacío → '') sin tocar add/multiply/upper"
OBJ3="la lógica de acotación Math.min(Math.max(x, min), max) está duplicada en src/math.js (clampReport) y src/format.js (formatRange); extrae clamp(n, min, max) a un módulo nuevo src/range.js y úsala desde ambos ficheros sin cambiar el comportamiento público (no tocar package.json)"
OBJ4="corrige countWords(s) en src/count.js para que cuente bien con más de un espacio en blanco ('a  b' → 2) sin cambiar los resultados de los casos que ya pasan (mínimo cambio, solo src/count.js)"

# Comandos "Cómo verificar" de cada AGENTS.md, literales (dobles internas escapadas; \t de t04 literal).
VER1="node -e \"import('./src/math.js').then(m => { const r = m.greet('aies'); if (r === 'hello aies') console.log('PASS'); else throw new Error('greet(aies)=' + r); })\""
VER2="node -e \"Promise.all([import('./src/math.js'), import('./src/strings.js')]).then(([m, s]) => { const checks = [ [m.clamp(5, 0, 10), 5], [m.clamp(-1, 0, 10), 0], [m.clamp(11, 0, 10), 10], [m.clamp(4, 4, 4), 4], [s.capitalize('hola mundo'), 'Hola mundo'], [s.capitalize('aBc'), 'ABc'], [s.capitalize(''), ''] ]; for (const [got, want] of checks) if (got !== want) throw new Error(JSON.stringify({ got, want })); console.log('PASS'); })\""
VER3="node -e \"Promise.all([import('./src/math.js'), import('./src/format.js')]).then(([m, f]) => { const checks = [ [m.add(2, 3), 5], [m.clampReport(15, 0, 10), '[10/0..10]'], [m.clampReport(-3, 0, 10), '[0/0..10]'], [m.clampReport(7, 0, 10), '[7/0..10]'], [f.formatRange(7, 0, 10), '[7/0..10]'], [f.formatRange(-2, 0, 10), '[0/0..10]'] ]; for (const [got, want] of checks) if (got !== want) throw new Error(JSON.stringify({ got, want })); console.log('PASS'); })\""
VER4="node -e \"import('./src/count.js').then(m => { const checks = [ [m.countWords('hola mundo'), 2], [m.countWords('hola  mundo'), 2], [m.countWords('  hola  '), 1], [m.countWords('tab\tatab'), 2], [m.countWords(''), 0] ]; for (const [got, want] of checks) if (got !== want) throw new Error(String(got)); console.log('PASS'); })\""

hash_cwd() {
	"$NODE" -e "const {createHash} = require('node:crypto'); process.stdout.write(createHash('sha1').update(process.argv[1]).digest('hex').slice(0,16))" "$1"
}

run_one() {
	local r="$1" t="$2" obj="$3" ver="$4"
	local rd="$DATA/r$r"
	local aies="$rd/$t-aies" base="$rd/$t-base"
	mkdir -p "$rd"
	rm -rf "$aies" "$base"
	cp -R "$SEEDS/$t" "$aies"
	cp -R "$SEEDS/$t" "$base"
	local h
	h="$(hash_cwd "$aies")"
	local st="$AGENT_DIR/aies/$h/state.json" lf="$AGENT_DIR/aies/$h/log.jsonl"

	echo "=== [r$r] $t / AIES (cwd $aies) ==="
	rm -f "$st" "$lf"
	"$NODE" "$ROOT/runtime/dist/cli.js" run --cwd "$aies" "$obj" > "$rd/$t-aies-cli.out" 2>&1
	local rc=$?
	local log_path
	log_path="$(sed -n 's/.*log\.jsonl *: //p' "$rd/$t-aies-cli.out" | tail -1 | sed 's/  ([0-9]* entradas) *$//')"
	if [ -z "$log_path" ] || [ ! -f "$log_path" ]; then
		echo "run-e01: WARN [r$r] $t AIES sin log.jsonl (rc=$rc). Primeras líneas:" >&2
		head -20 "$rd/$t-aies-cli.out" >&2
	else
		"$NODE" "$ROOT/runtime/dist/research/metrics.js" "$log_path" > "$rd/$t-aies-metrics.json"
		echo "AIES rc=$rc log=$log_path metrics=-> $rd/$t-aies-metrics.json"
	fi

	echo "=== [r$r] $t / verificación externa sobre copia *-aies ==="
	( cd "$aies" && sh -c "$ver" ) > "$rd/$t-aies-verify.txt" 2>&1
	local vrc=$?
	echo "ext_verify rc=$vrc (arma $rd/$t-aies-verify.txt)"

	echo "=== [r$r] $t / baseline (cwd $base) ==="
	"$NODE" "$ROOT/runtime/dist/research/baseline.js" --cwd "$base" --verify "$ver" "$obj" > "$rd/$t-base.json" 2>&1
	local brc=$?
	echo "base rc=$brc (arma $rd/$t-base.json)"
}

for r in $REPLICAS; do
	run_one "$r" t01-greet "$OBJ1" "$VER1"
	run_one "$r" t02-clamp-capitalize "$OBJ2" "$VER2"
	run_one "$r" t03-refactor "$OBJ3" "$VER3"
	run_one "$r" t04-count "$OBJ4" "$VER4"
done

echo "=== run-e01 terminado. Réplicas: $REPLICAS. Dataset: $DATA/r<r> ==="