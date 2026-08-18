# AIES — Modelo de componentes

Este documento define los **elementos arquitectónicos** de AIES: sus responsabilidades y sus relaciones. No define implementación, tecnologías, modelos concretos ni mecanismos internos.

Deriva de `01-Concept/`, de los requisitos (`02-Requirements/`) y del contexto (`System-Context.md`). Todo elemento debe poder trazarse a un principio u objetivo.

---

## 1. Convenciones

- **[Hecho]** — Impuesto por `01-Concept/` o por requisitos validados.
- **[Propuesta]** — Elemento propuesto que necesita validación.
- **[Pendiente]** — Aspecto del elemento que requiere una decisión (ADR) o un documento posterior.

---

## 2. Elementos conceptuales

### 2.1 El harness (elemento contenedor)

**[Hecho]** — AIES proporciona: el **entorno**, las **reglas**, el **estado**, la **coordinación** y los **mecanismos** necesarios para dividir, ejecutar, verificar y continuar el trabajo. *(Non-Goals §13)*

**[Propuesta]** — En el modelo de componentes, "harness" no es un componente más, sino el **contenedor** de los elementos 2.2–2.7. No se le asigna comportamiento propio.

### 2.2 Orquestador

**[Hecho]** — El coordinador. Responsabilidades (P-01):

- entender el estado de la tarea;
- decidir qué debe hacerse;
- seleccionar la capacidad necesaria;
- delegar el trabajo;
- recibir resultados;
- comunicar el progreso y el resultado al desarrollador.

**[Hecho / restricción]** — No realiza el trabajo delegable: no usa herramientas de lectura, escritura o modificación del proyecto para ello. *(P-01, REQ-F-03)*

**[Resuelto en `ADR-007`]** — El orquestador es **único fijo en v0** (una configuración de `AgentSession` sin tools + salida estructurada); el "rol intercambiable" queda habilitado como cambio de config, sin rediseño (`P-14`, `P-15`).

### 2.3 Subagente (trabajador)

**[Hecho]** — El ejecutor. Responsabilidades:

- recibir una unidad de trabajo y el contexto intencional necesario (P-07);
- realizarla usando sus capacidades;
- devolver el resultado al orquestador.

**[Hecho]** — Es reemplazable: otro subagente que proporcione la misma capacidad puede sustituirlo sin cambiar el proceso. *(P-16, REQ-F-26)*

**[Pendiente]** — Qué subagentes concretos existen (explorer, planner, implementer, verifier…) es decisión posterior; los nombres que aparecen en `P-01` son ilustrativos. `ADR-002` fija que un trabajador proporciona la capacidad de verificación, pero no crea un verificador dedicado ni selecciona el trabajador concreto.

### 2.4 Capacidades (dimensión "qué debe hacerse")

**[Hecho]** — Lo que puede hacerse, separado de quién lo hace. *(P-14)*

Capacidades citadas en `01-Concept/`: explorar, planificar, implementar, verificar, revisar, depurar, investigar. *(P-03, P-14)*

**[Propuesta]** — Las capacidades no son componentes: son **la dimensión por la que el orquestador selecciona** a quién delegar. Un subagente ofrece una o más capacidades.

**[Pendiente]** — El catálogo formal de capacidades y sus límites se definirá cuando exista necesidad (P-17); de momento queda como conjunto abierto.

### 2.5 Estado de la tarea

**[Hecho]** — Representación explícita de la situación del trabajo, no implícita en conversaciones. *(P-09, REQ-F-14)*

Contiene, al menos conceptualmente:

- qué tarea se está resolviendo;
- qué información se conoce;
- qué se ha hecho;
- qué resultados se han obtenido;
- cuántas iteraciones se han realizado;
- qué debe hacerse a continuación.

**[Hecho]** — Los resultados intermedios alimentan el estado y son la entrada de la siguiente decisión. *(P-13, REQ-F-17)*

**[Resuelto conceptualmente]** — La estructura conceptual del estado se define en `Runtime-Model.md §3`; su representación física queda para la implementación.

### 2.6 Tarea y unidades de trabajo

**[Hecho]** — Los objetos de trabajo definidos en `Task-Model.md`: una tarea se descompone en 1..n unidades de trabajo con objetivo, alcance, información necesaria, resultado esperado y condición de finalización.

**[Pendiente]** — Su ciclo de vida (pendiente, en curso, terminada, fallida) → `04-behavior/`.

### 2.7 Conocimiento persistente del proyecto

**[Hecho]** — Información selectiva que sobrevive a las sesiones: arquitectura, decisiones, convenciones, estado relevante, aprendizajes y problemas conocidos. *(P-08, OBJ-06, REQ-F-19/20)*

**[Hecho / restricción]** — No es una base de conocimiento general ni un "segundo cerebro": solo lo que tenga valor para continuar el trabajo. *(Non-Goals §7)*

**[Resuelto en `ADR-008`]** — Qué se persiste (`state.json` + `log.jsonl`), dónde (fuera del repo, bajo `agentDir` de pi, keyed-by-cwd) y cómo se recupera (restauración al arranque + `DefaultResourceLoader` para el conocimiento del repo).

---

## 3. Relaciones

```text
Desarrollador
      │  tarea / visibilidad / límites
      ▼
┌─────────────────────────────────────────────┐
│  HARNESS                                     │
│                                             │
│   ┌──────────────┐   delega (unidad +       │
│   │ Orquestador  │   contexto intencional)  │
│   │ (coordina,   │ ───────────────────────▶ │  ┌──────────────┐
│   │  no ejecuta) │                          │  │  Subagente   │
│   └──────────────┘  ◀───────────────────────│  │  (ejecuta)   │
│         │              resultado            │  └──────────────┘
│         │  lee/actualiza                         │
│         ▼                                        │ usa herramientas
│   ┌──────────────┐   conocimiento      ┌────────▼─────────┐
│   │   Estado     │ ◀─────────────────▶ │ Código del       │
│   │ de la tarea  │     persistente     │ proyecto         │
│   └──────────────┘   (entre sesiones)  │ (externo)        │
│                                        └──────────────────┘
└─────────────────────────────────────────────┘
```

| Relación | Quién → quién | Qué fluye | Fuente |
|---|---|---|---|
| R-1 | Desarrollador → Orquestador | Tarea solicitada, límites, intervenciones | Non-Goals §6 |
| R-2 | Orquestador → Desarrollador | Progreso, decisiones, resultado | OBJ-04, P-11 |
| R-3 | Orquestador → Subagente | Unidad de trabajo + contexto intencional | P-01, P-07 |
| R-4 | Subagente → Orquestador | Resultado (éxito/fallo) | P-13 |
| R-5 | Orquestador → Estado | Lectura y actualización del estado | P-09 |
| R-6 | Subagente → Código del proyecto | Lectura/escritura del trabajo concreto | P-01 |
| R-7 | Estado ↔ Conocimiento persistente | Lo relevante sobrevive a la sesión; se recupera al inicio | P-08, OBJ-06 |
| R-8 | Subagente → Modelos/proveedores | Consumo del modelo adecuado al trabajo | P-15 |

**[Resuelto en `ADR-009`]** — Harness y runtime son el mismo sistema, y el entorno de ejecución es externo. La ubicación física de cada relación dentro del host concreto queda fijada: pi vía SDK embebido en proceso (AIES-core dueño del bucle; pi = motor de workers y `ModelRuntime`).

---

## 4. Qué NO define este documento

- Qué subagentes existen y con qué capacidades → ADR.
- Estructura y ciclo de vida del estado → `04-behavior/`, ADR.
- Contenido y mecanismo del conocimiento persistente → ADR.
- Tecnologías, modelos, formatos de comunicación entre elementos → implementación.

---

## 5. Cuestiones abiertas

1. ~~Orquestador: ¿agente único o rol intercambiable?~~ — **Resuelto en `ADR-007-orquestador-unico-o-rol.md`** (único fijo en v0; rol intercambiable habilitado como cambio de config).
2. Catálogo formal de capacidades → cuando exista necesidad demostrada (`P-17`).
3. Ciclo de vida de tarea, unidad de trabajo y estado → `04-behavior/`.
4. ~~Alcance y mecanismo del conocimiento persistente~~ — **Resuelto en `ADR-008-persistencia-entre-sesiones.md`** (dos tiers: estado bajo `agentDir` keyed-by-cwd + conocimiento del repo leído al arranque).
5. ~~Ubicación física de las relaciones dentro del host concreto~~ — **Resuelto en `ADR-009-integracion-con-pi.md`** (pi SDK embebido; frontera conceptual ya fijada en `ADR-001`).
