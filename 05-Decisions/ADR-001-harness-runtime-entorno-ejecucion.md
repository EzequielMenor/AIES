# ADR-001 — Relación entre harness, runtime y entorno de ejecución

- **Estado:** Aceptada
- **Fecha:** 2026-08-13
- **Resuelve:** cuestiones abiertas nº 1 y 2 de `Glossary.md`; pendientes de `System-Context.md §1`

---

## Contexto

`01-Concept/` usa los términos **harness**, **runtime** y **entorno de ejecución concreto** sin delimitar su relación:

- `Vision.md` llama a AIES "una configuración... el harness".
- `Non-Goals.md §13` dice que AIES proporciona "el entorno, las reglas, el estado, la coordinación y los mecanismos".
- `Non-Goals.md §11` dibuja `AIES → runtime / harness` y `pi (v0) → entorno de ejecución concreto`, sugiriendo que runtime/harness son una sola cosa y el entorno de ejecución es otra.
- `P-09`, `P-13`, `P-16`, `P-17` y `Goals.md §3` usan "runtime" en sentido operativo (el sistema que ejecuta y observa).

Esta ambigüedad afecta a la frontera de AIES (`System-Context.md`) y a la ubicación de las relaciones `R-3`…`R-8` del `Component-Model.md`. Es la primera decisión que debe tomarse porque condiciona el resto del modelo.

---

## Opciones consideradas

### Opción A — Harness y runtime son el mismo sistema; el entorno de ejecución es externo

- **Harness**: nombre de identidad/diseño de AIES (reglas, estado, coordinación, mecanismos).
- **Runtime**: nombre del mismo sistema **en operación** (el harness ejecutándose y observando, sentido de `P-09`, `P-16`, `P-17`).
- **Entorno de ejecución concreto**: sistema externo que hospeda a los agentes (herramientas, permisos, acceso a modelos), intercambiable (`Non-Goals §11`).

Ventajas: un solo concepto (mínimo, `P-17`); coherente con `Non-Goals §11` y `§13`; no divide AIES en capas sin requisito que lo exija.

Inconvenientes: dos nombres para una misma cosa pueden volver a confundir. Se mitiga fijando una convención de uso.

### Opción B — El runtime es un componente interno del harness

Harness = reglas/configuración estática; runtime = motor que ejecuta y observa.

Ventajas: distingue diseño de ejecución.

Inconvenientes: ningún requisito exige esa separación; añade una capa y una frontera interna que hoy no aporta valor (`P-06`, `P-17`).

### Opción C — El harness es solo configuración sobre un runtime externo

AIES = configuración; el runtime es el sistema externo.

Ventajas: mínima cantidad de sistema propio; se apoya en la palabra "configuración" de `Vision.md`.

Inconvenientes: contradice `Non-Goals §13` (AIES proporciona estado, coordinación y mecanismos, no solo configuración) y `P-20` (el harness limita la autonomía de los agentes). La palabra "configuración" en `Vision.md` es lenguaje informal frente a la definición más precisa de `Non-Goals §13`.

---

## Decisión

**Opción A.**

- Harness y runtime son el mismo sistema: AIES.
- "Entorno de ejecución concreto" designa al sistema externo que hospeda a los agentes.

Convención terminológica a partir de ahora:

- **harness** → identidad y diseño del sistema;
- **runtime** → el sistema en operación (ejecutando, observando, decidiendo);
- **entorno de ejecución concreto** → host externo intercambiable.

---

## Consecuencias

- No se crean componentes ni capas adicionales (consistente con `P-17`).
- La separación conceptual `AIES ↔ host externo` se mantiene (`Non-Goals §11`).
- Documentos afectados, actualizados en consecuencia: `Glossary.md`, `System-Context.md`, `Component-Model.md`, `02-Requirements/README.md`.
- **Fuera del alcance de este ADR** ~~(la ubicación física del harness dentro del host concreto —proceso, configuración, distribución— sigue abierta y se decidirá cuando se elija el entorno de implementación)~~ → **resuelto en `ADR-009-integracion-con-pi.md`**: la ubicación física es pi vía SDK embebido en proceso.

---

## Referencias

- `Vision.md` — AIES como configuración/harness.
- `Non-Goals.md §11, §13` — separación conceptual; qué proporciona AIES.
- `Principles.md P-09, P-16, P-17, P-18` — sentido operativo de "runtime"; crecimiento progresivo; justificación de decisiones.
- `Glossary.md §2, §9` — términos afectados.
- `System-Context.md §1` — frontera afectada.
