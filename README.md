<div align="center">

# ⚡ AIES
### *Autonomous Software Engineering Harness & Runtime*

[![Version](https://img.shields.io/badge/version-0.3.0--beta-38bdf8?style=flat-square)](./runtime/package.json)
[![Architecture](https://img.shields.io/badge/spec-P--01..P--20-3fb950?style=flat-square)](./01-Concept/Principles.md)
[![Decisions](https://img.shields.io/badge/ADRs-10%20accepted-d2a8ff?style=flat-square)](./05-Decisions/)
[![Research](https://img.shields.io/badge/research-H--01%20%7C%20H--02-ffa657?style=flat-square)](./06-research/)
[![License](https://img.shields.io/badge/license-MIT-gray?style=flat-square)](LICENSE)

**AIES** es un harness y runtime de ingeniería de software que orquesta agentes de IA mediante **descomposición adaptativa de tareas**, **aislamiento estricto de contexto** y **verificación continua**, eliminando el desperdicio de tokens y la burocracia innecesaria.

[¿Qué es AIES?](#-qué-es-aies) • [Problemas que resuelve](#-el-problema-del-agente-único) • [Arquitectura](#-arquitectura-y-bucle-de-decisión) • [Instalación y Uso](#-quickstart) • [Investigación](#-evidencia-empírica) • [Estructura](#-mapa-del-repositorio)

</div>

---

## 💡 ¿Qué es AIES?

> *"AIES organiza el trabajo; los agentes realizan el trabajo."*

La mayoría de herramientas delegan todo el ciclo de desarrollo a un único agente que acumula cientos de miles de tokens en historial, o fuerzan flujos SDD hiper-burocráticos para cambios de una sola línea. 

**AIES introduce un runtime estructurado:**
1. **Orquestador Puro (No-Tools):** No lee archivos, no ejecuta bash ni escribe código. Su única responsabilidad es evaluar el estado y decidir el siguiente paso en un contrato estructurado y validado.
2. **Subagentes Especializados Efímeros:** *Explorer* (solo lectura), *Implementer* (edición mínima) y *Verifier* (comprobación objetiva). Cada uno recibe únicamente el contexto que necesita y se destruye al finalizar su unidad.
3. **Flujo Adaptativo Proporcional:** Si pides cambiar una línea o añadir una función simple, AIES va directo a ejecución en 1 turno sin ceremonia. Si la tarea es compleja, descompone, explora y verifica en fases controladas.

---

## 🥊 El Problema del Agente Único

| Enfoque Tradicional (Monolítico) | Enfoque AIES (Harness & Runtime) |
| :--- | :--- |
| **Saturación de contexto:** Un único chat acumula búsquedas, lecturas de miles de líneas y errores, degradando el razonamiento. | **Contexto intencional:** Cada worker arranca con contexto limpio. El orquestador solo conoce el estado (`RuntimeState`). |
| **Burocracia fija o caos total:** O se fuerza un plan de 5 pasos para todo, o el agente edita sin rumbo ni control. | **Proceso adaptativo:** Cero sobrecarga en tareas triviales; descomposición rigurosa solo en tareas complejas. |
| **Falsa verificación:** El mismo agente que escribe el bug asume que funciona sin comprobarlo objetivamente. | **Verificación desacoplada:** Pruebas directas con veredictos formales (`PASS` / `FAIL`) antes de dar la tarea por completada. |
| **Cajas negras y dashboards pesados:** UI saturadas de pestañas o terminales mudas que ocultan lo que ocurre. | **Stream nativo de terminal:** Salida vertical limpia y legible con información en tiempo real y telemetría por turno. |

---

## 🏛️ Arquitectura y Bucle de Decisión

El motor central opera bajo un bucle determinista regido por el estado explícito:

```text
 ┌──────────────────────────────────────────────────────────────────┐
 │                          AIES RUNTIME                            │
 │                                                                  │
 │   ┌──────────────┐     Decisión JSON      ┌──────────────────┐   │
 │   │ Orchestrator │ ─────────────────────► │  Core Loop (TS)  │   │
 │   │  (No-Tools)  │ ◄───────────────────── │ (RuntimeState)   │   │
 │   └──────────────┘     Estado Actual      └─────────┬────────┘   │
 │                                                     │            │
 │                                            Delega   ▼            │
 │                   ┌──────────────────────────────────────────┐   │
 │                   │      Subagentes Efímeros (Workers)       │   │
 │                   ├─────────────┬──────────────┬─────────────┤   │
 │                   │  Explorer   │ Implementer  │  Verifier   │   │
 │                   │ (Read-only) │ (Edit/Write) │ (Test/Lint) │   │
 │                   └─────────────┴──────────────┴─────────────┘   │
 └──────────────────────────────────────────────────────────────────┘
```

### El Ciclo del Runtime:
1. **Estado (`RuntimeState`):** Contiene la tarea, información conocida, unidades de trabajo (`WorkUnit`) y resultados.
2. **Decidir (`decide`):** El orquestador evalúa el estado y emite una operación válida (`obtener información`, `ejecutar una unidad`, `comunicar al desarrollador`, `terminar`).
3. **Ejecutar (`execute`):** El bucle invoca al subagente correspondiente con una allowlist estricta de herramientas.
4. **Observar (`observe`):** El resultado se incorpora al estado, alimentando la siguiente decisión sin acumular historial conversacional muerto.

---

## ✨ Características Principales

* 🎯 **Zod Trust-Boundary:** Todas las salidas de los modelos se validan estrictamente contra esquemas antes de tocar el sistema. Los fallos de formato no rompen el ciclo; se gestionan de forma controlada.
* 🛡️ **Límites de Ejecución e Irrecuperabilidad (ADR-005):** Control estricto de iteraciones máximas, tiempo y consumo de tokens. Sin bucles infinitos silenciosos.
* 🌲 **Re-descomposición Dinámica (ADR-006):** Si una unidad resulta ser demasiado compleja durante su ejecución, se divide en sub-unidades sin perder el trabajo completado con éxito.
* 💻 **Stream UI de Alto Contraste:** Presentación nativa de terminal optimizada para temas oscuros, con spinners de línea única y árboles de ejecución claros.
* 🔌 **CLI Standalone con Persistencia:** Binario `aies` propio con modos `oneshot` y `REPL`, estado serializable entre sesiones y recuperación automática ante corrupciones.

---

## 🚀 Quickstart

### Instalación rápida (recomendado)
```bash
curl -fsSL https://raw.githubusercontent.com/EzequielMenor/AIES/main/install.sh | bash
```

Esto clona AIES en `~/.aies`, instala dependencias, compila y enlaza el binario `aies` en `~/.local/bin`.

Para actualizar una instalación existente:

```bash
aies update
```

El chequeo automático de nuevas versiones se puede desactivar con `AIES_NO_UPDATE_CHECK=1`.

### Instalación manual

#### Prerrequisitos
* Node.js `>= 20.0.0`
* pnpm o npm

#### 1. Clonar y Build
```bash
git clone https://github.com/EzequielMenor/AIES.git
cd AIES/runtime
pnpm install
pnpm run build
```

### 2. Comandos Disponibles (CLI)
* `aies "<tarea>"`: Ejecuta una tarea y termina.
* `aies`: Inicia el REPL interactivo.
* `aies update`: Actualiza AIES mediante el instalador oficial.
* `aies --version`: Muestra la versión y el commit actual.

---

## 📊 Evidencia Empírica

AIES sigue el principio **P-19 (Evidencia frente a intuición)**. El directorio [`06-research/`](./06-research/) alberga experimentos reproducibles frente a baselines de agente único:

* **Hipótesis H-01 (Aislamiento de Contexto):** Reducción de hasta un **40–60% de tokens innecesarios** en tareas multi-archivo al no arrastrar búsquedas y lecturas al hilo principal.
* **Hipótesis H-02 (Coste vs Complejidad):** En tareas de complejidad baja (L1–L2), el overhead de orquestación se reduce al mínimo, igualando la velocidad de un agente directo pero manteniendo la garantía de verificación.

---

## 📂 Mapa del Repositorio

El repositorio está estructurado por capas de abstracción y trazabilidad:

```text
AIES/
├── 01-Concept/         # Visión, Problema, Metas y los 20 Principios fundamentales
├── 02-Requirements/    # Requisitos funcionales (REQ-F), no funcionales (RNF) y modelos
├── 03-Architecture/    # Contexto del sistema, modelo de agentes, runtime y componentes
├── 04-Behavior/        # Ciclo de vida y máquina de estados
├── 05-Decisions/       # Registros de Decisiones de Arquitectura (ADR-001 a ADR-010)
├── 06-research/        # Experimentos empíricos, corpus de pruebas y baselines
└── runtime/            # Implementación en TypeScript (Bucle, CLI standalone, Telemetría)
```

---

## 🗺️ Mapa de Lectura Recomendado

1. [`01-Concept/Vision.md`](01-Concept/Vision.md) — Filosofía y alcance de AIES.
2. [`01-Concept/Principles.md`](01-Concept/Principles.md) — Las 20 reglas que guían el diseño.
3. [`05-Decisions/ADR-010-extension-de-pi.md`](05-Decisions/ADR-010-extension-de-pi.md) — Arquitectura de ejecución actual.
4. [`runtime/README.md`](runtime/README.md) — Detalles técnicos de la implementación del runtime.

---

## 📄 Licencia

Este proyecto está bajo la Licencia [MIT](LICENSE).
