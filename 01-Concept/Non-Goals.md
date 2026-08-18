# AIES — Fuera de alcance

Este documento define aquello que AIES **no pretende ser ni resolver directamente**.

Definir estos límites es importante para evitar que el proyecto crezca de forma accidental y para mantener clara la responsabilidad del harness.

---

## 1. AIES no es un agente

AIES no es un agente con el que el desarrollador interactúa directamente para realizar el trabajo.

AIES es el **harness que organiza y controla el trabajo de los agentes**.

La interacción conceptual debe ser:

```text
Desarrollador
      │
      ▼
  Orquestador
      │
      ▼
  Subagentes
```

AIES no pretende convertirse en otro agente autónomo que sustituya al orquestador ni en un agente que realice directamente el trabajo de desarrollo.

---

## 2. AIES no es un modelo de IA

AIES no desarrolla ni entrena modelos.

Tampoco pretende competir con los proveedores de modelos ni determinar qué modelo es universalmente mejor.

Los modelos son un recurso que AIES puede utilizar según las necesidades de una tarea.

La arquitectura debe permitir cambiar los modelos sin cambiar los principios fundamentales del runtime.

---

## 3. AIES no es un workflow fijo

AIES no debe imponer un proceso obligatorio como:

```text
explorar
→ especificar
→ diseñar
→ implementar
→ verificar
```

para todas las tareas.

Ese tipo de flujo puede ser una estrategia válida para determinadas tareas, pero no forma parte de la definición fundamental de AIES.

AIES debe poder utilizar diferentes procesos según la tarea.

---

## 4. AIES no es exclusivamente un sistema SDD

AIES puede utilizar especificaciones, planificación, diseño y otras prácticas propias del desarrollo estructurado, pero no depende de SDD.

SDD debe considerarse una **posible estrategia de trabajo**, no el objetivo ni la identidad del sistema.

Una tarea pequeña no debería requerir necesariamente una especificación completa.

---

## 5. AIES no intenta utilizar múltiples agentes siempre

La existencia de varios agentes no es un objetivo por sí mismo.

Una tarea que pueda resolverse correctamente con un único agente especializado no debería dividirse artificialmente.

La cantidad de agentes debe estar justificada por la tarea.

Por tanto:

```text
más agentes ≠ mejor sistema
```

El objetivo es utilizar **el mínimo trabajo necesario para resolver correctamente la tarea**.

---

## 6. AIES no pretende automatizarlo todo

AIES no tiene como objetivo eliminar completamente la participación del desarrollador.

El desarrollador debe poder:

- comprender el resultado;
    
- conocer las decisiones importantes;
    
- revisar cambios cuando sea necesario;
    
- intervenir cuando una tarea lo requiera;
    
- establecer límites o restricciones.
    

La automatización debe mejorar el trabajo del desarrollador, no eliminar su capacidad de control.

---

## 7. AIES no es un sistema de memoria

AIES puede necesitar mecanismos de persistencia y recuperación de conocimiento para cumplir sus objetivos, pero la memoria no constituye por sí misma el propósito del sistema.

AIES no pretende convertirse en:

- una base de conocimiento general;
    
- un segundo cerebro;
    
- un sistema de almacenamiento de toda la información producida por los agentes.
    

La persistencia debe estar al servicio de la continuidad del trabajo y del conocimiento relevante del proyecto.

---

## 8. AIES no es un sistema de documentación automática

AIES puede producir información que posteriormente pueda documentarse, pero no pretende generar documentación exhaustiva sobre cada acción realizada por los agentes.

La documentación debe centrarse en la información útil para comprender:

- el sistema;
    
- sus decisiones;
    
- su estado;
    
- sus resultados;
    
- su evolución.
    

---

## 9. AIES no es un sistema de gestión de proyectos

AIES no pretende sustituir herramientas de gestión de proyectos, tareas o incidencias.

Conceptos como:

- sprints;
    
- backlog;
    
- prioridades de producto;
    
- planificación empresarial;
    
- asignación de trabajo entre equipos humanos;
    

están fuera del alcance fundamental del runtime.

AIES puede recibir tareas procedentes de estos sistemas, pero no pretende gestionarlos.

---

## 10. AIES no es un sistema de control de versiones

AIES puede utilizar Git u otros sistemas de control de versiones durante la ejecución de tareas, pero no pretende reemplazarlos.

La responsabilidad de AIES consiste en organizar el trabajo de los agentes, no en convertirse en el sistema de historial del código.

---

## 11. AIES no depende de su host (entorno de ejecución concreto)

AIES puede implementarse inicialmente utilizando un host concreto — **pi (v0)** en la implementación v0, decidido en `ADR-009` — y aprovechar sus mecanismos de agentes, herramientas y permisos.

Sin embargo, el entorno de ejecución concreto no debe formar parte de la definición conceptual de AIES.

La arquitectura debe mantener separadas:

```text
AIES
↓
runtime / harness

pi (v0)
↓
entorno de ejecución concreto
```

Esto permitiría adaptar AIES a otros runtimes o entornos si en el futuro fuese necesario.

---

## 12. AIES no pretende resolver todos los problemas de agentes de IA

AIES se centra principalmente en **cómo organizar y controlar el trabajo de agentes durante tareas de desarrollo**.

No pretende resolver de forma general problemas como:

- inteligencia artificial general;
    
- alineamiento de modelos;
    
- entrenamiento de modelos;
    
- razonamiento fundamental de los LLM;
    
- seguridad general de sistemas de IA;
    
- generación de modelos;
    
- evaluación universal de modelos.
    

Estos problemas pueden afectar al funcionamiento de AIES, pero no constituyen su objetivo.

---

## 13. Límite fundamental

El límite conceptual de AIES puede resumirse así:

> **AIES organiza el trabajo; los agentes realizan el trabajo.**

AIES proporciona el entorno, las reglas, el estado, la coordinación y los mecanismos necesarios para que el trabajo pueda dividirse, ejecutarse, verificarse y continuar de forma controlada.

No pretende convertirse en el agente que hace todo.

---

## 14. Principio de alcance

Ante una nueva funcionalidad o componente que se quiera añadir a AIES, debe preguntarse:

> **¿Esto mejora el runtime y la organización del trabajo de los agentes, o estamos construyendo otra herramienta alrededor de él?**

Si la funcionalidad pertenece principalmente a otro dominio, debería mantenerse fuera del núcleo de AIES o tratarse como una integración independiente.
