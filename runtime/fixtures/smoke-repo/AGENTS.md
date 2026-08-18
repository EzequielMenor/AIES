# smoke-repo

Micro-repo de prueba para el smoke de arranque de AIES-core v0 (`MVP-v0-Scope.md §9`).
Módulo ESM de funciones puras, sin dependencias externas.

## Alcance

- Una sola unidad funcional: `src/math.js` con exports nombrados de funciones puras.
- La tarea de smoke consiste en añadir una función y verificarla sin tocar lo existente.

## Convenciones

- ESM puro (`"type": "module"`); sin pasos de build.
- Funciones puras, exports nombrados (p. ej. `export function add(a, b) { return a + b; }`).
- Verificación: `node -e` importa el módulo y comprueba resultados concretos; sin framework de tests.

## Cómo verificar un cambio

```bash
node -e "import('./src/math.js').then(m => { if (m.greet && m.greet() === 'hello') console.log('PASS'); else throw new Error('greet fail'); })"
```