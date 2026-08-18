# h02-t04 — corregir caso límite

Micro-repo del corpus de H-02 (`06-research/experiments/E-02-H-02-coste-tiempo-vs-complejidad.md`), nivel de complejidad a priori **L4**.

## Alcance

- `src/count.js` expone `countWords(s)` que devuelve el número de palabras de una cadena.
- Comportamiento esperado (ya correcto en el caso normal): contar palabras separadas por espacios en blanco. Los casos del bloque "Cómo verificar" que devuelven 2 o 1 **ya pasan** y no deben cambiar de resultado.
- **Bug:** con una o más palabras y más de un espacio en blanco intermedio (`'a  b'`), devuelve un recuento erróneo. Corregirlo sin cambiar los resultados de los casos que ya pasan.

## Convenciones

- ESM puro (`"type": "module"`); sin pasos de build (no tocar `package.json`).
- Funciones puras, exports nombrados.
- Verificación: `node -e` importa el módulo y comprueba resultados concretos; sin framework de tests.
- Cambio mínimo: solo `src/count.js`.

## Cómo verificar

```bash
node -e "import('./src/count.js').then(m => { const checks = [ [m.countWords('hola mundo'), 2], [m.countWords('hola  mundo'), 2], [m.countWords('  hola  '), 1], [m.countWords('tab\tatab'), 2], [m.countWords(''), 0] ]; for (const [got, want] of checks) if (got !== want) throw new Error(String(got)); console.log('PASS'); })"
```