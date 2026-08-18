# AIES — Problem

## 1. Context

Programar con agentes de IA permite delegar una parte importante del trabajo de desarrollo, pero cuando un único agente se encarga de investigar, leer el proyecto, razonar, planificar, escribir código, ejecutar herramientas y verificar el resultado, aparecen varios problemas.

Estos problemas no son necesariamente consecuencia de que el modelo sea malo. En muchos casos aparecen por la forma en la que se organiza el trabajo alrededor del modelo.

AIES nace a partir de estos problemas.

---

## 2. Context overload

Cuando un único agente realiza todo el trabajo de una tarea, su contexto acaba acumulando gran cantidad de información:

- conversaciones anteriores;
    
- código leído;
    
- resultados de búsquedas;
    
- archivos relevantes;
    
- decisiones tomadas;
    
- planes;
    
- código generado;
    
- resultados de herramientas;
    
- errores y correcciones.
    

A medida que aumenta la cantidad de información, resulta más difícil mantener el contexto relevante para la siguiente decisión.

Esto puede provocar:

- mayor consumo de tokens;
    
- mayor coste;
    
- mayor latencia;
    
- dificultad para identificar qué información es realmente importante;
    
- pérdida de contexto relevante entre diferentes partes de la tarea;
    
- una posible degradación de la calidad del razonamiento.
    

El problema no es únicamente cuánto contexto puede soportar un modelo, sino cuánto contexto innecesario debe manejar para realizar correctamente una tarea concreta.

---

## 3. Excessive process overhead

Los procesos de desarrollo asistidos por IA pueden introducir una cantidad significativa de pasos incluso para tareas relativamente pequeñas.

Una tarea puede acabar pasando por diferentes fases de:

- exploración;
    
- especificación;
    
- diseño;
    
- planificación;
    
- implementación;
    
- revisión;
    
- verificación;
    
- archivado.
    

Este nivel de proceso puede ser útil para tareas complejas o de alto riesgo, pero resulta innecesario para cambios pequeños.

Por tanto, existe un problema de desproporción entre la complejidad de una tarea y la cantidad de trabajo necesaria para resolverla.

Una tarea sencilla debería poder resolverse rápidamente, mientras que una tarea compleja debería poder utilizar un proceso más elaborado cuando realmente lo necesite.

---

## 4. Lack of visibility and control

Delegar una tarea completa a un agente puede hacer que el desarrollador pierda visibilidad sobre lo que está ocurriendo.

El agente puede:

1. investigar;
    
2. tomar decisiones;
    
3. modificar múltiples archivos;
    
4. corregir sus propios errores;
    
5. continuar iterando;
    

sin que el desarrollador tenga una visión clara de todo el proceso.

Esto genera varios problemas:

- el desarrollador puede no saber exactamente qué se ha hecho;
    
- revisar el resultado puede resultar demasiado costoso;
    
- puede ser difícil entender por qué se tomó una decisión;
    
- los cambios pueden crecer demasiado antes de ser revisados;
    
- aumenta el riesgo de aceptar código que el desarrollador no comprende suficientemente.
    

La automatización no debería implicar una pérdida completa de control.

---

## 5. Context and project memory

Cada sesión de trabajo con IA comienza con la necesidad de reconstruir parte del contexto del proyecto.

Un agente debería conocer de forma consistente, al comenzar una nueva sesión, información esencial como:

- qué proyecto está trabajando;
    
- cuál es su arquitectura;
    
- qué decisiones importantes se han tomado;
    
- qué se hizo anteriormente;
    
- qué problemas siguen pendientes;
    
- qué restricciones existen;
    
- qué información es relevante para continuar.
    

Sin un mecanismo adecuado para conservar y recuperar este conocimiento, el agente puede:

- repetir investigaciones;
    
- volver a tomar decisiones ya tomadas;
    
- contradecir decisiones anteriores;
    
- perder contexto arquitectónico;
    
- necesitar que el usuario vuelva a explicar información conocida.
    

El problema no consiste en conservar absolutamente toda la información de sesiones anteriores, sino en conservar y recuperar aquello que sea realmente importante para continuar el trabajo correctamente.

---

## 6. Uneven model capabilities

Los modelos disponibles tienen diferentes niveles de capacidad, coste y velocidad.

Los modelos más capaces pueden ser mejores para tareas como:

- razonamiento;
    
- planificación;
    
- arquitectura;
    
- análisis de problemas complejos;
    
- revisión.
    

Sin embargo, utilizarlos para absolutamente todas las tareas puede resultar innecesariamente caro o lento.

Por otro lado, los modelos más rápidos y económicos pueden ser suficientes para tareas más mecánicas o bien definidas.

Existe por tanto una oportunidad para mejorar la relación entre calidad, coste y velocidad distribuyendo el trabajo entre diferentes modelos y agentes según la naturaleza de cada tarea.

---

## 7. Large tasks are difficult to control

Una tarea aparentemente sencilla puede terminar convirtiéndose en una cantidad considerable de trabajo.

Cuando el agente intenta resolver demasiadas cosas simultáneamente, aumenta la dificultad de:

- entender qué está haciendo;
    
- revisar sus cambios;
    
- detectar errores;
    
- mantener un objetivo claro;
    
- controlar el tamaño del cambio.
    

Trabajar con tareas más pequeñas y claramente definidas puede reducir este problema.

La descomposición de una tarea no debería consistir únicamente en dividirla arbitrariamente, sino en convertirla en unidades de trabajo que tengan un objetivo concreto y un resultado verificable.

---

## 8. Motivation

Estos problemas justifican la existencia de AIES.

AIES pretende proporcionar una forma de organizar el trabajo de agentes de IA que permita mantener:

- contexto controlado;
    
- procesos proporcionales a la complejidad de la tarea;
    
- visibilidad sobre el trabajo realizado;
    
- continuidad entre sesiones;
    
- uso adecuado de distintos modelos;
    
- tareas pequeñas y controlables.
    

El objetivo no es añadir más pasos al desarrollo asistido por IA, sino **organizar el trabajo de forma que cada paso exista porque es necesario**.

---

## 9. Problem statement

En conjunto, el problema puede resumirse así:

> Los agentes de IA pueden realizar una gran parte del trabajo de desarrollo, pero cuando el trabajo se concentra en un único agente o se fuerza a través de procesos rígidos, el contexto crece demasiado, el trabajo puede volverse lento y costoso, la visibilidad del desarrollador disminuye y se pierde continuidad entre sesiones.

> AIES pretende abordar estos problemas mediante un harness que organiza el trabajo entre agentes especializados, mantiene el contexto de cada tarea controlado, adapta el proceso a la complejidad del trabajo y mantiene al desarrollador informado sobre lo que está ocurriendo.