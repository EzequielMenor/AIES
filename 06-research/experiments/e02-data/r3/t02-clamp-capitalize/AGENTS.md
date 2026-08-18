# h02-t02 — dos funciones con validación de bordes

Micro-repo del corpus de H-02 (`06-research/experiments/E-02-H-02-coste-tiempo-vs-complejidad.md`), nivel de complejidad a priori **L2**.

## Alcance

- Añadir a `src/math.js` una función `clamp(n, min, max)` que devuelva `n` acotado a `[min, max]`: si `n < min` → `min`; si `n > max` → `max`; en cualquier otro caso → `n`.
- Añadir a `src/strings.js` una función `capitalize(s)` que devuelva la cadena con la primera letra en mayúscula y el resto igual (`'hola mundo'` → `'Hola mundo'`); cadena vacía → `''`.
- No tocar lo existente (`add`, `multiply`, `upper`).

## Convenciones

- ESM puro (`"type": "module"`); sin pasos de build.
- Funciones puras, exports nombrados.
- Verificación: `node -e` importa el módulo y comprueba resultados concretos; sin framework de tests.

## Cómo verificar

```bash
node -e "Promise.all([import('./src/math.js'), import('./src/strings.js')]).then(([m, s]) => { const checks = [ [m.clamp(5, 0, 10), 5], [m.clamp(-1, 0, 10), 0], [m.clamp(11, 0, 10), 10], [m.clamp(4, 4, 4), 4], [s.capitalize('hola mundo'), 'Hola mundo'], [s.capitalize('aBc'), 'ABc'], [s.capitalize(''), ''] ]; for (const [got, want] of checks) if (got !== want) throw new Error(JSON.stringify({ got, want })); console.log('PASS'); })"
```