# AIES — Objetivos

## 1. Objetivo general

AIES tiene como objetivo proporcionar un harness para el desarrollo asistido por agentes de IA que permita trabajar de forma **rápida, eficiente, controlada y confiable**, adaptando la cantidad y el tipo de trabajo realizado a las necesidades reales de cada tarea.

AIES debe evitar tanto dos extremos:

- utilizar un único agente para realizar todo el trabajo, acumulando contexto innecesario;
    
- imponer procesos complejos y rígidos a tareas que no los necesitan.
    

El objetivo es que el trabajo realizado por la IA sea **proporcional a la tarea**.

---

## 2. Objetivos principales

### OBJ-01 — Mantener el contexto controlado

AIES debe reducir la cantidad de contexto innecesario que necesita manejar cada agente.

El trabajo debe poder dividirse entre agentes especializados de forma que cada uno reciba únicamente la información necesaria para realizar su función.

El objetivo es:

- reducir el contexto innecesario;
    
- evitar que un único agente acumule toda la investigación y ejecución;
    
- reducir el consumo de tokens;
    
- mantener la calidad del razonamiento a medida que aumenta la complejidad de una tarea.
    

---

### OBJ-02 — Adaptar el proceso a la complejidad de la tarea

AIES no debe utilizar un proceso fijo para todas las tareas.

Debe ser posible resolver una tarea pequeña con un proceso pequeño y utilizar procesos más elaborados cuando una tarea realmente lo requiera.

Por ejemplo:

```text
Tarea trivial
→ implementar
→ verificar

Tarea normal
→ explorar
→ implementar
→ verificar

Tarea compleja
→ explorar
→ planificar
→ revisar
→ implementar
→ verificar
```

La cantidad de trabajo debe depender de las características de la tarea y no únicamente de un workflow predeterminado.

---

### OBJ-03 — Reducir el tiempo necesario para completar tareas

AIES debe permitir completar tareas de desarrollo de forma rápida cuando su complejidad no justifique un proceso largo.

La velocidad es un objetivo importante, pero no debe conseguirse eliminando pasos necesarios para tareas de mayor riesgo.

Por tanto, AIES debe buscar un equilibrio entre:

- velocidad;
    
- calidad;
    
- coste;
    
- seguridad del cambio.
    

---

### OBJ-04 — Mantener al desarrollador informado y en control

El desarrollador debe poder entender qué está haciendo la IA sin tener que seguir cada operación individual.

AIES debe proporcionar una visión clara de:

- qué se ha entendido de la tarea;
    
- qué se está haciendo;
    
- qué agentes han intervenido;
    
- qué decisiones importantes se han tomado;
    
- qué cambios se han realizado;
    
- qué resultado se ha obtenido;
    
- qué problemas siguen pendientes.
    

El objetivo no es que el desarrollador supervise cada acción, sino que pueda mantener una **visión suficiente del trabajo para confiar en el resultado y revisarlo correctamente**.

---

### OBJ-05 — Trabajar mediante tareas pequeñas y bien definidas

AIES debe favorecer la descomposición de trabajos grandes en unidades de trabajo más pequeñas.

Cada tarea debería tener:

- un objetivo claro;
    
- un alcance limitado;
    
- un resultado esperado;
    
- unas condiciones para considerar el trabajo terminado.
    

Esto debe facilitar:

- la comprensión del trabajo;
    
- la revisión de cambios;
    
- la detección de errores;
    
- la asignación de trabajo a agentes especializados;
    
- la recuperación ante fallos.
    

---

### OBJ-06 — Mantener continuidad entre sesiones

AIES debe permitir que una nueva sesión pueda recuperar rápidamente el conocimiento esencial del proyecto.

El agente debe poder conocer, sin que el desarrollador tenga que reconstruir manualmente todo el contexto:

- qué proyecto está trabajando;
    
- qué arquitectura utiliza;
    
- qué decisiones importantes se han tomado;
    
- qué se hizo anteriormente;
    
- qué trabajo está pendiente;
    
- qué restricciones o convenciones son relevantes.
    

La información persistente debe centrarse en conocimiento útil para continuar el trabajo, evitando conservar información innecesaria.

---

### OBJ-07 — Utilizar los modelos de forma eficiente

AIES debe permitir asignar diferentes tipos de trabajo a diferentes modelos.

Los modelos más capaces pueden utilizarse cuando el razonamiento tenga mayor importancia, mientras que modelos más rápidos o económicos pueden utilizarse para tareas más mecánicas y bien definidas.

El objetivo es mejorar la relación entre:

```text
calidad
   +
velocidad
   +
coste
```

sin asumir que un único modelo es óptimo para todas las fases del trabajo.

---

### OBJ-08 — Mejorar el aprovechamiento de modelos económicos

AIES debe explorar si la división adecuada del trabajo permite obtener mejores resultados de modelos menos capaces o menos costosos.

La idea es que un modelo no tenga necesariamente que resolver por sí solo:

```text
investigación
+
razonamiento
+
planificación
+
implementación
+
verificación
```

sino que diferentes agentes puedan realizar partes concretas del trabajo.

AIES debe utilizar esta separación como una estrategia para mejorar la eficiencia, no como una obligación de utilizar múltiples agentes siempre.

---

### OBJ-09 — Mantener la especialización de los agentes

Cada agente utilizado por AIES debería tener un propósito claro y unas responsabilidades limitadas.

La especialización debe permitir que un agente se centre en una tarea concreta, reduciendo el contexto y las responsabilidades que debe manejar simultáneamente.

La arquitectura debe evitar crear agentes especializados únicamente por añadir más componentes. Un agente debería existir cuando su separación aporte una ventaja real.

---

### OBJ-10 — Permitir procesos adaptativos

AIES debe poder cambiar de estrategia durante la resolución de una tarea.

El resultado de una operación puede revelar que:

- falta información;
    
- la tarea es más compleja de lo esperado;
    
- el plan inicial no es adecuado;
    
- es necesario revisar un cambio;
    
- la tarea puede darse por terminada.
    

Por tanto, AIES no debe asumir necesariamente que el proceso correcto puede conocerse completamente antes de empezar.

---

## 3. Objetivos de calidad

Además de los objetivos funcionales, AIES debería perseguir las siguientes propiedades.

### Claridad

Las decisiones importantes del sistema deben poder entenderse y explicarse.

### Control

El sistema debe mantener límites claros sobre qué puede hacer cada agente.

### Eficiencia

El trabajo realizado debe ser proporcional al valor que aporta a la resolución de la tarea.

### Robustez

Un fallo de un agente o de una operación no debería obligar necesariamente a reiniciar todo el proceso.

### Observabilidad

Debe ser posible reconstruir qué ocurrió durante la resolución de una tarea.

### Extensibilidad

Debe ser posible añadir nuevos agentes, modelos o capacidades sin rediseñar todo el runtime.

---

## 4. Criterio general de éxito

AIES debería considerarse exitoso si permite resolver tareas de desarrollo de forma que, frente a un enfoque basado en un único agente o en workflows rígidos:

- se utilice menos contexto innecesario;
    
- se reduzca el trabajo innecesario;
    
- se mantenga o mejore la calidad del resultado;
    
- el coste y el tiempo sean proporcionales a la complejidad de la tarea;
    
- el desarrollador mantenga una visión clara de lo realizado;
    
- el conocimiento importante del proyecto pueda mantenerse entre sesiones.
    

Estos objetivos deberán convertirse posteriormente en **criterios y experimentos medibles**, de manera que las decisiones de arquitectura de AIES puedan validarse mediante resultados y no únicamente mediante intuiciones.
