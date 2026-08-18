# h02-t03 — refactor con acotación duplicada

Micro-repo del corpus de H-02 (`06-research/experiments/E-02-H-02-coste-tiempo-vs-complejidad.md`), nivel de complejidad a priori **L3**.

## Alcance

- La lógica de acotación `Math.min(Math.max(x, min), max)` está duplicada en `src/math.js` (`clampReport`) y en `src/format.js` (`formatRange`).
- Extraer esa lógica a un módulo compartido nuevo `src/range.js` con una función `clamp(n, min, max)` y usarla desde ambos ficheros, eliminando la duplicación.
- El comportamiento público no cambia: `add`, `clampReport` y `formatRange` devuelven exactamente lo mismo que antes.

## Convenciones

- ESM puro (`"type": "module"`); sin pasos de build (no tocar `package.json`).
- Funciones puras, exports nombrados.
- Verificación: `node -e` importa el módulo y comprueba resultados concretos; sin framework de tests.
- No alterar la semántica de formato: `clampReport(n, min, max)` sigue devolviendo `` `[c/min..max]` `` con `c` acotado.

## Cómo verificar

```bash
node -e "Promise.all([import('./src/math.js'), import('./src/format.js')]).then(([m, f]) => { const checks = [ [m.add(2, 3), 5], [m.clampReport(15, 0, 10), '[10/0..10]'], [m.clampReport(-3, 0, 10), '[0/0..10]'], [m.clampReport(7, 0, 10), '[7/0..10]'], [f.formatRange(7, 0, 10), '[7/0..10]'], [f.formatRange(-2, 0, 10), '[0/0..10]'] ]; for (const [got, want] of checks) if (got !== want) throw new Error(JSON.stringify({ got, want })); console.log('PASS'); })"
```