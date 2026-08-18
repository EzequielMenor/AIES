# h02-t01 — añadir función simple

Micro-repo del corpus de H-02 (`06-research/experiments/E-02-H-02-coste-tiempo-vs-complejidad.md`), nivel de complejidad a priori **L1**.

## Alcance

- Añadir a `src/math.js` una función `greet(name)` que devuelva `` `hello ${name}` ``.
- No tocar lo existente (`add`).

## Convenciones

- ESM puro (`"type": "module"`); sin pasos de build.
- Funciones puras, exports nombrados.
- Verificación: `node -e` importa el módulo y comprueba resultados concretos; sin framework de tests.

## Cómo verificar

```bash
node -e "import('./src/math.js').then(m => { const r = m.greet('aies'); if (r === 'hello aies') console.log('PASS'); else throw new Error('greet(aies)=' + r); })"
```