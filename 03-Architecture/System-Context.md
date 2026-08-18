# AIES — Contexto del sistema y drivers de arquitectura

Este documento define **el terreno** sobre el que se tomarán las decisiones de arquitectura: qué está dentro de AIES, qué está fuera, y qué fuerzas (drivers) debe respetar toda decisión posterior.

No define componentes, ni mecanismos, ni resuelve decisiones. Las cuestiones que requieren decisión quedan señaladas como pendientes de ADR, explícitamente.

---

## 1. Frontera de AIES

### Qué es AIES

**[Hecho]** — El harness que organiza y controla el trabajo de los agentes durante tareas de desarrollo: reglas, entorno, estado, coordinación y mecanismos para dividir, ejecutar, verificar y continuar el trabajo. *(Non-Goals §13)*

```text
                    ┌──────────────────────────┐
                    │          AIES            │
  Desarrollador ───▶│  (harness: organización, │
                    │   estado, coordinación)  │
                    │                          │
                    │   agentes trabajando      │──▶ Código del proyecto
                    │   sobre el proyecto       │
                    └──────────────────────────┘
```

### Entidades externas a AIES

**[Hecho]** — Todas derivadas de `01-Concept/`:

| Entidad externa | Relación con AIES | Fuente |
|---|---|---|
| **Desarrollador** | Solicita tareas, recibe visibilidad, interviene, establece límites | Non-Goals §6, OBJ-04 |
| **Modelos / proveedores** | Recurso consumido según el trabajo; reemplazable, no parte de la identidad de AIES | Non-Goals §2, P-15 |
| **Código del proyecto** | Objeto del trabajo (lectura/escritura por los agentes que ejecutan) | P-01 |
| **Sistema de control de versiones** | Utilizado durante la ejecución; no reemplazado | Non-Goals §10 |
| **Sistema de gestión de proyectos** | Puede ser origen de tareas; no gestionado por AIES | Non-Goals §9 |

### Fronteras decididas

**[Decidido en ADR-001]** — La línea entre AIES y su entorno de ejecución quedó trazada:

1. **Harness y runtime son el mismo sistema** — AIES. "Harness" es el nombre de identidad/diseño; "runtime", el sistema en operación.
2. **Entorno de ejecución concreto** (p. ej. **pi (v0)** en la implementación v0, decidido en `ADR-009`) — sistema externo que hospeda a los agentes; intercambiable y separado de AIES (`Non-Goals §11`).

### Fronteras resueltas

**[Resuelto en `ADR-009`]** — La **ubicación física del harness en el host concreto**, que `ADR-001` dejó fuera de su alcance, queda fijada: pi vía SDK embebido en proceso; AIES-core es el entrypoint dueño del bucle; pi es el motor de ejecución de workers y el `ModelRuntime` multi-provider.

La definición conceptual de sesión quedó resuelta en `ADR-003`: es un periodo de trabajo del desarrollador con AIES y no equivale ni a una tarea ni al entorno de ejecución. El mecanismo de continuidad entre sesiones se resuelve en `ADR-008`.

---

## 2. Drivers de arquitectura

Toda decisión de arquitectura posterior debe poder justificarse contra estas fuerzas. Cada una lleva su fuente; no se reformulan, se referencian.

### D-1. Problemas que la arquitectura debe mitigar

Derivados de `Problem.md`:

- D-1.1 Context overload — el contexto de cada agente debe mantenerse controlado.
- D-1.2 Excessive process overhead — el proceso debe ser proporcional a la tarea.
- D-1.3 Lack of visibility and control — el desarrollador no debe perder visibilidad.
- D-1.4 Context and project memory — continuidad entre sesiones.
- D-1.5 Uneven model capabilities — asignar modelos según el trabajo.
- D-1.6 Large tasks are difficult to control — tareas pequeñas y verificables.

### D-2. Objetivos funcionales

`OBJ-01`…`OBJ-10` (`Goals.md §2`), operacionalizados en `REQ-F-01`…`REQ-F-27` (`Functional-Requirements.md`).

### D-3. Objetivos de calidad

`Goals.md §3` (Claridad, Control, Eficiencia, Robustez, Observabilidad, Extensibilidad), operacionalizados en `RNF-01`…`RNF-20` (`Non-Functional-Requirements.md`).

### D-4. Principios

`P-01`…`P-20` (`Principles.md`). Los que más condicionan la arquitectura:

- **P-01 / P-02** — el orquestador coordina, no ejecuta.
- **P-07** — contexto intencional y aislado.
- **P-09** — estado explícito.
- **P-14 / P-16** — capacidades separadas de agentes; trabajadores sustituibles.
- **P-15** — modelo según el trabajo.
- **P-17** — complejidad progresiva.
- **P-19** — evidencia frente a intuición.

### D-5. No-metas como restricciones

`Non-Goals.md` actúa como límite negativo: la arquitectura no debe convertir AIES en un agente, un workflow fijo, un sistema de memoria, un gestor de proyectos ni un sistema de control de versiones.

### D-6. Hipótesis que la arquitectura debe poder medir

`H-01`…`H-06` (`Non-Functional-Requirements.md §4`). La arquitectura debe permitir obtener las mediciones necesarias para validarlas (`P-19`), aunque los experimentos se diseñen en `06-research/`.

### D-7. Crecimiento progresivo

La primera arquitectura debe ser la mínima que satisfaga los drivers, con espacio para crecer sin rediseño (`P-17`, `RNF-13`, `RNF-14`).

---

## 3. Qué NO define este documento

- La composición interna de AIES (componentes, responsabilidades, flujos) → siguiente documento.
- La resolución de las fronteras pendientes → ADRs específicos.
- El ciclo de vida de la unidad de trabajo → `04-behavior/` o ADR.

---

## 4. Cuestiones abiertas (sin resolver aquí)

1. ~~Ubicación física del harness en el host concreto~~ — **Resuelto en `ADR-009-integracion-con-pi.md`** (pi vía SDK embebido en proceso; AIES-core dueño del bucle).

Resueltas: relación `harness`/`runtime` y papel del entorno de ejecución (`ADR-001`); ubicación física del harness en el host (`ADR-009`); límites conceptuales de una sesión (`ADR-003`); mecanismo de continuidad entre sesiones (`ADR-008`).
