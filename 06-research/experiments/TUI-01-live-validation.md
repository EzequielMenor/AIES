# Validación Empírica TUI-01: Auto-recuperación, Zod Trust-Boundary y Stream Rendering

**Fecha:** 2026-08-25  
**Modelo:** `minimax/MiniMax-M2.7`  
**Entorno:** AIES REPL v0.1 (`runtime/src/cli.ts`)  
**Objetivo de la prueba:** Evaluar en ejecución real el comportamiento del StreamRenderer tras el rediseño de usabilidad (P0/P1), la resiliencia del trust-boundary de Zod ante errores de schema del modelo y la capacidad de autorrecuperación del orquestador ante discrepancias de contrato.

---

## 1. Tarea Ejecutada

```text
crea un módulo src/string-utils.ts con una función truncate(str, maxLen) y sus tests en src/string-utils.test.ts, y verifícalos ejecutando vitest
```

---

## 2. Traza Real Completa de la Ejecución

```text
❯  node dist/cli.js
aies: provider=minimax modelo=MiniMax-M2.7 — ok.
┌──────────────────────────────────────────────────┐
│  AIES — Autonomous Software Engineering Harness │
│  Escribe tu tarea o /help para comandos       │
└──────────────────────────────────────────────────┘
❯ crea un módulo src/string-utils.ts con una función truncate(str, maxLen) y sus tests en src/string-utils.test.ts, y verifícalos ejecutando vitest
(escribe para intervenir · ESC para parar · Ctrl+C para salir)

── AIES Orchestrator ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
▶ Objetivo : crea un módulo src/string-utils.ts con una función truncate(str, maxLen) y sus tests en src/string-utils.test.ts, y verifícalos ejecutando vitest
✓ Decisión : Ejecutar implementer (u0) · plan: 1 unidades
  Motivo   : Tarea simple y bien definida: crear 2 archivos y verificar. Una unidad de implementer es suficiente.

┌─ ● Implementer (u0: Crear módulo truncate con tests y verificar con vitest)
└─ Resultado: **Cambio realizado:** Creé `src/truncate.ts` (función truncate con soporte para ellipsis custom) y `src/truncate.test.ts` (4 tests). Verificado con vitest — 4/4 tests pasan.
· iter 1/12 · 181.8k tok · $0.033 · ctx 6% · verify 1/1

✓ Decisión : Comunicar al desarrollador
  Motivo   : Discrepancia entre los nombres de archivos creados y los especificados en la tarea. La implementación funciona pero no cumple exactamente el contrato del objetivo.

· iter 2/12 · 185.1k tok · $0.034 · ctx 2% · verify 1/1

💬 Orquestador: La función truncate está implementada y verificada (4/4 tests pasan), pero los archivos fueron creados con nombres diferentes a los especificados:

- Creado: `src/truncate.ts` y `src/truncate.test.ts`
- Pedido: `src/string-utils.ts` y `src/string-utils.test.ts`

Dado que la tarea menciona específicamente `string-utils` (módulo utilities), ¿deseas que renombre los archivos a los correctos, o prefieres mantener la nomenclatura `truncate.ts` por ser más específica?

▲ Fallo de parseo del orquestador (1/3): schema: ajustePlan: Invalid input
▲ Fallo de parseo del orquestador (2/3): schema: ajustePlan: Invalid input
✓ Decisión : Ejecutar implementer (u0) · plan: 1 unidades
  Motivo   : La tarea especifica explícitamente los nombres string-utils.ts y string-utils.test.ts. El implementer hizo buen trabajo funcionalmente pero usó nombres diferentes. La corrección es trivial (solo renombrar) por lo que no requiere descomposición adicional.

┌─ ● Implementer (u0: Crear módulo truncate con tests y verificar con vitest)
└─ Resultado: **Cambio realizado:** Creé `src/truncate.test.ts` con 5 tests para la función `truncate` existente, y la agregué al array `include` de `vitest.config.ts`. Verificado: 5/5 tests pasan.
· iter 3/12 · 293.5k tok · $0.051 · ctx 5% · verify 2/2

✓ Decisión : Ejecutar unidad (u1)
  Motivo   : u1 está pendiente y es la única unidad restante para completar la tarea. Los archivos actuales (truncate.ts/truncate.test.ts) no coinciden con los nombres especificados (string-utils.ts/string-utils.test.ts).

┌─ ● Implementer (u1: Renombrar archivos truncate a string-utils según lo especificado en la tarea)
└─ Resultado: **Cambio realizado:** Renombré `src/truncate.ts` → `src/string-utils.ts` y `src/truncate.test.ts` → `src/string-utils.test.ts`. Actualicé la referencia del import en el test y la inclusión en `vitest.config.ts`. Tests verificados: 5/5 pasan.
· iter 4/12 · 358.2k tok · $0.059 · ctx 4% · verify 3/3

✓ Decisión : Terminar
  Motivo   : Las unidades u0 y u1 completaron exitosamente: src/string-utils.ts y src/string-utils.test.ts existen con los nombres correctos, la función truncate está implementada, los 5 tests pasan en vitest.

· iter 5/12 · 361.7k tok · $0.060 · ctx 2% · verify 3/3

── ✓ TASK COMPLETED (03:14 · 5 · $0.060) ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
Resumen: Tarea completada: módulo string-utils.ts con función truncate(str, maxLen) creado, tests en string-utils.test.ts verificados con vitest (5/5 tests pasan).
```

---

## 3. Hallazgos Arquitecturales y Empíricos

### 3.1 Detección de Discrepancias de Contrato y Autorrecuperación
- **Hecho:** En la iteración 1, el worker `Implementer` creó la función solicitada pero nombró los archivos como `src/truncate.ts` y `src/truncate.test.ts`.
- **Comportamiento del orquestador:** En la iteración 2, el orquestador puro (sin herramientas, evaluando únicamente el `RuntimeState`) detectó la discrepancia semántica entre el objetivo explícito (`string-utils.ts`) y el resultado reportado por el worker.
- **Acción autónoma:** Al continuar la ejecución, planificó la unidad `u1` con el objetivo específico de renombrar los archivos, actualizar los imports del test y el array `include` de `vitest.config.ts`, logrando la convergencia total sin intervención manual.

### 3.2 Resiliencia del Zod Trust-Boundary ante Salidas Inválidas
- **Hecho:** En la iteración 3, MiniMax emitió dos payloads consecutivos que violaban la validación de Zod (`schema: ajustePlan: Invalid input`).
- **Comportamiento del harness:** El bucle `runLoop` interceptó los fallos de parseo, emitió los avisos visibles `(1/3)` y `(2/3)` manteniendo la sesión intacta y re-emitió el turno al orquestador. En el tercer intento, el modelo generó una decisión válida, evitando cualquier crash no controlado.

### 3.3 Integridad Visual del StreamRenderer (P0/P1)
- **Hecho:** En todas las iteraciones con workers (`u0` y `u1`), el bloque del worker se mantuvo limpio y contiguo (`┌─ ● Implementer ... └─ Resultado: ...`).
- **Comportamiento:** La telemetría por iteración (`· iter N/max · ...`) se emitió tras cerrar el bloque del worker, eliminando la interferencia visual observada en versiones anteriores.

---

## 4. Métricas de la Ejecución

| Métrica | Valor |
|---|---|
| **Iteraciones Totales** | 5 |
| **Tokens Consumidos** | 361.7k tok |
| **Coste Total** | $0.060 |
| **Tiempo de Ejecución** | 03:14 min |
| **Verificaciones Superadas** | 3 / 3 (5/5 tests unitarios en vitest) |
| **Archivos Producidos** | `runtime/src/string-utils.ts`, `runtime/src/string-utils.test.ts` |
| **Resultado de la Tarea** | `Completada` |
