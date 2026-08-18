# AIES — Modelo de tarea y unidad de trabajo

Este documento define el modelo conceptual de `Task` (tarea) y `Work Unit` (unidad de trabajo) que AIES organiza. Concreta `OBJ-05`, `P-04`, `P-09`, `P-12` y `REQ-F-13`.

No define almacenamiento, representación, comunicación, ejecución ni agentes concretos.

---

## 1. Task (tarea)

**[Hecho]** — Trabajo que el desarrollador solicita a AIES. Es la unidad de intención y el marco de referencia del resultado que se quiere obtener.

### Información mínima

Una `Task` debe disponer, conceptualmente, de:

| Información | Significado |
|---|---|
| **Solicitud / objetivo** | Qué quiere conseguir el desarrollador, expresado de forma comprensible |
| **Alcance** | Qué incluye la tarea y qué queda fuera cuando sea necesario delimitarlo |
| **Restricciones** | Condiciones que deben respetarse durante el trabajo |
| **Información relevante** | Contexto suficiente para entender la tarea y decidir el trabajo necesario |
| **Resultado esperado** | Qué debe quedar al considerar la tarea resuelta |
| **Condición de finalización** | Cómo se determina que el resultado de la tarea es suficiente y verificable |
| **Estado** | Situación actual de la tarea |

La información relevante puede ampliarse durante la ejecución si el bucle de decisión descubre que falta conocimiento (`P-10`, `REQ-F-18`).

---

## 2. Work Unit (unidad de trabajo)

**[Hecho]** — Porción pequeña y bien definida en la que se descompone una `Task`. Debe ser comprensible, verificable y suficientemente limitada para poder revisarse y controlarse (`OBJ-05`, `P-04`).

### Información mínima

Una `Work Unit` debe disponer, conceptualmente, de:

| Información | Significado |
|---|---|
| **Task de origen** | La tarea a la que pertenece |
| **Objetivo** | Qué debe conseguirse en esta unidad, de forma concreta |
| **Alcance** | Límites de lo que incluye y, cuando sea necesario, de lo que no incluye |
| **Información necesaria** | Información suficiente para realizarla sin investigar todo el proyecto (`P-04`) |
| **Resultado esperado** | Qué debe producirse o quedar resuelto |
| **Condición de finalización** | Criterio verificable que permite decidir que la unidad está terminada (`REQ-F-13`, `P-12`) |
| **Estado** | Situación actual de la unidad |

---

## 3. Relación entre Task y Work Unit

**[Propuesta]** — La relación mínima es:

```text
Task (intención del desarrollador)
   │
   │ se descompone en
   ▼
1..n Work Units (trabajo verificable)
```

- Cada `Work Unit` pertenece a una única `Task`.
- Una `Task` tiene una o más `Work Units` cuando se ejecuta; una tarea trivial puede tener una sola y no debe dividirse artificialmente (`Non-Goals §5`).
- La finalización de una `Task` depende de su resultado esperado y de las `Work Units` necesarias para obtenerlo.
- Este modelo define únicamente la relación `Task → Work Unit`; no define unidades anidadas.

La necesidad de re-descomponer una unidad durante la ejecución pertenece al comportamiento adaptativo (`REQ-F-15`) y no cambia la relación conceptual de origen.

---

## 4. Criterios de finalización

### Finalización de una Work Unit

Una `Work Unit` puede considerarse **Terminada** solo cuando:

1. se ha obtenido el resultado esperado;
2. se cumple su condición de finalización;
3. el resultado se ha verificado cuando la tarea lo requiere (`P-12`).

Si no cumple su condición, no puede marcarse como terminada aunque el trabajador haya producido una respuesta o modificado código.

### Finalización de una Task

Una `Task` puede considerarse **Completada** solo cuando:

1. se ha obtenido el resultado esperado de la tarea;
2. se han terminado las `Work Units` necesarias para ese resultado;
3. se cumple la condición de finalización de la tarea;
4. el resultado se ha verificado de forma proporcional al riesgo y complejidad (`P-12`, `RNF-15`).

Una `Work Unit` fallida no implica automáticamente que la `Task` falle: el orquestador puede corregir, re-delegar, obtener información o cambiar la descomposición (`P-13`).

---

## 5. Estados necesarios

Los estados describen la situación conceptual del trabajo. Las transiciones pertenecen a `04-Behavior/Lifecycle.md`.

### Estados de una Task

| Estado | Significado |
|---|---|
| **Recibida** | La solicitud existe, pero el trabajo todavía no ha comenzado |
| **En curso** | AIES está evaluando, obteniendo información, ejecutando o verificando trabajo |
| **Completada** | Se cumplen los criterios de finalización de la tarea |
| **Fallida** | No existe una continuación viable o el desarrollador ha detenido la tarea |

El fin de una sesión no cambia por sí solo el estado de una `Task` (`ADR-003`).

### Estados de una Work Unit

| Estado | Significado |
|---|---|
| **Pendiente** | La unidad está definida, pero todavía no se ha ejecutado |
| **En curso** | La unidad ha sido delegada y se está realizando |
| **Terminada** | Cumple su resultado y condición de finalización |
| **Fallida** | No cumple su condición de finalización o no pudo realizarse |

Una `Work Unit` en estado **Fallida** vuelve al bucle de decisión; no se elimina ni convierte automáticamente la tarea en fallida (`P-13`).

---

## 6. Qué NO define este documento

- Cómo se representan o almacenan `Task` y `Work Unit`.
- Cómo se transporta la información entre agentes.
- Qué agente realiza la descomposición, ejecución o verificación.
- Qué comprobación concreta corresponde a cada tarea.
- Las transiciones y reglas temporales detalladas, definidas en `04-Behavior/Lifecycle.md`.

---

## 7. Cuestiones abiertas

1. **Granularidad óptima** — Qué tamaño de unidad equilibra verificabilidad y sobrecarga de coordinación (`H-01`, `H-02`).
2. ~~**Re-descomposición**~~ — Resuelto en `ADR-006-re-descomposicion.md` (señales de necesidad y reglas de conservación).
3. **Condiciones concretas de verificación** — Qué comprobación es adecuada para cada tipo de resultado; la capacidad de verificación ya está definida en `ADR-002`.
