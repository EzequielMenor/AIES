# AIES — Principios

Los principios de AIES definen las reglas fundamentales que deben guiar su diseño, evolución e implementación.

No todos los principios tienen que estar completamente implementados desde el principio, pero las decisiones de arquitectura deberían respetarlos salvo que exista una razón explícita para desviarse de ellos.

---

## P-01 — El orquestador no realiza el trabajo

El orquestador es responsable de **coordinar el trabajo**, no de realizarlo directamente.

Su función principal es:

- entender el estado de la tarea;
    
- decidir qué debe hacerse;
    
- seleccionar la capacidad necesaria;
    
- delegar el trabajo;
    
- recibir resultados;
    
- comunicar el progreso y resultado al desarrollador.
    

El orquestador no debería utilizar herramientas de lectura, escritura o modificación del proyecto para realizar el trabajo que puede delegar.

La separación conceptual es:

```text
Desarrollador
      │
      ▼
Orquestador
      │
      ├── Explorer
      ├── Planner
      ├── Implementer
      ├── Verifier
      └── Reviewer
```

El orquestador coordina; los subagentes ejecutan.

---

## P-02 — Separación entre coordinación y ejecución

AIES debe separar explícitamente:

```text
decidir qué hacer
```

de:

```text
hacerlo
```

Un agente responsable de tomar decisiones no debería necesitar también ejecutar todas las operaciones necesarias para llevarlas a cabo.

Esta separación permite:

- mantener el contexto del coordinador reducido;
    
- limitar las capacidades de cada agente;
    
- sustituir trabajadores sin modificar la lógica de coordinación;
    
- controlar mejor qué puede hacer cada componente.
    

---

## P-03 — Los agentes deben estar especializados

Los agentes deberían recibir responsabilidades concretas.

Un agente puede estar especializado en:

- explorar;
    
- planificar;
    
- implementar;
    
- verificar;
    
- revisar;
    
- depurar;
    
- investigar.
    

La especialización tiene como finalidad reducir responsabilidades y contexto, no aumentar artificialmente el número de agentes.

Un nuevo agente solo debería existir cuando su separación aporte una ventaja real.

---

## P-04 — El trabajo debe dividirse en tareas pequeñas

AIES debe favorecer la descomposición de una tarea grande en unidades de trabajo pequeñas y claramente definidas.

Una tarea debería tener, siempre que sea posible:

- un objetivo concreto;
    
- un alcance definido;
    
- información suficiente para realizarla;
    
- un resultado esperado;
    
- un criterio de finalización o verificación.
    

La división debe buscar **unidades de trabajo comprensibles y verificables**, no simplemente una mayor cantidad de tareas.

---

## P-05 — El proceso debe adaptarse a la tarea

AIES no debe asumir que todas las tareas necesitan el mismo proceso.

El trabajo requerido debe depender de factores como:

- complejidad;
    
- alcance;
    
- incertidumbre;
    
- riesgo;
    
- necesidad de información;
    
- impacto del cambio.
    

Por tanto:

```text
tarea pequeña
→ proceso pequeño

tarea compleja
→ proceso más elaborado
```

La complejidad del proceso debe estar justificada por la complejidad de la tarea.

---

## P-06 — El mínimo proceso necesario

AIES debe intentar resolver cada tarea utilizando **el mínimo proceso que permita obtener un resultado suficientemente correcto y confiable**.

Esto implica que:

> más pasos no significa necesariamente mejor resultado.

Un paso debe existir porque aporta una función necesaria.

Por ejemplo, una revisión arquitectónica completa puede ser apropiada para un cambio de arquitectura, pero innecesaria para modificar un texto o corregir un valor aislado.

---

## P-07 — El contexto debe estar aislado y ser intencional

Cada agente debería recibir únicamente el contexto que necesita para realizar su trabajo.

No se debe asumir que compartir toda la conversación entre todos los agentes es beneficioso.

El contexto debe construirse de forma intencional:

```text
Tarea
  +
información relevante
  +
resultado de etapas anteriores
  +
restricciones necesarias
```

y no:

```text
todo lo ocurrido anteriormente
```

El objetivo es reducir contexto innecesario sin perder la información necesaria para tomar buenas decisiones.

---

## P-08 — El conocimiento importante debe persistir

La información relevante para continuar el trabajo no debería depender exclusivamente de la memoria de una sesión.

AIES debe favorecer la persistencia y recuperación de conocimiento importante, especialmente:

- arquitectura;
    
- decisiones;
    
- convenciones;
    
- estado relevante del proyecto;
    
- aprendizajes;
    
- problemas conocidos.
    

La persistencia debe ser selectiva.

No se pretende almacenar todo, sino aquello que tenga valor para futuras tareas.

---

## P-09 — El estado del runtime debe ser explícito

El estado de una tarea debe poder representarse de forma explícita.

AIES no debería depender exclusivamente de información implícita contenida en una conversación.

El estado debe permitir conocer, al menos conceptualmente:

- qué tarea se está resolviendo;
    
- qué información se conoce;
    
- qué se ha hecho;
    
- qué resultados se han obtenido;
    
- cuántas iteraciones se han realizado;
    
- qué debe hacerse a continuación.
    

Esto permite que el runtime pueda observar el resultado de una acción y tomar una nueva decisión.

---

## P-10 — Información y ejecución son operaciones distintas

AIES debe distinguir entre:

```text
necesito información
```

y:

```text
puedo ejecutar una acción
```

Cuando el estado actual no contiene información suficiente para continuar, el runtime debe poder solicitarla antes de ejecutar un cambio.

Conceptualmente:

```text
THINK
  │
  ├── información insuficiente
  │        ↓
  │   obtener información
  │
  └── información suficiente
           ↓
        ejecutar
```

Esto evita que un agente actúe basándose en suposiciones cuando puede obtener información adicional.

---

## P-11 — Las decisiones deben poder observarse

Las decisiones relevantes tomadas durante una ejecución deberían ser comprensibles y observables.

El desarrollador debería poder responder preguntas como:

- ¿qué entendió AIES?
    
- ¿por qué decidió explorar?
    
- ¿por qué utilizó ese agente?
    
- ¿por qué consideró necesaria una revisión?
    
- ¿por qué terminó la tarea?
    
- ¿por qué decidió continuar después de un fallo?
    

El objetivo no es exponer cada token del razonamiento del modelo, sino proporcionar suficiente información estructurada para entender el comportamiento del sistema.

---

## P-12 — La verificación forma parte del trabajo

Una tarea no debería considerarse terminada simplemente porque un agente ha producido una respuesta o ha modificado código.

Cuando sea aplicable, el resultado debe poder verificarse mediante mecanismos adecuados:

- tests;
    
- typecheck;
    
- build;
    
- análisis;
    
- revisión;
    
- comprobaciones específicas de la tarea.
    

La verificación debe ser proporcional al riesgo y complejidad del cambio.

---

## P-13 — Los fallos deben conducir a nuevas decisiones

Un fallo no debería implicar necesariamente reiniciar toda la tarea desde cero.

Cuando una ejecución falla, AIES debería poder:

```text
resultado
   ↓
observar
   ↓
analizar
   ↓
decidir
   ↓
corregir / obtener información / cambiar estrategia
```

El runtime debe tratar los resultados intermedios como información para la siguiente decisión.

---

## P-14 — Las capacidades se separan de los agentes

AIES debe distinguir conceptualmente entre:

```text
qué debe hacerse
```

y:

```text
quién lo hace
```

Una capacidad puede ser:

```text
explorar
planificar
implementar
verificar
revisar
```

y diferentes agentes pueden ser capaces de realizar una misma capacidad.

Esto permite cambiar:

- modelo;
    
- proveedor;
    
- configuración;
    
- agente concreto;
    

sin cambiar necesariamente el proceso de resolución de la tarea.

---

## P-15 — El modelo utilizado debe depender del trabajo

No existe un único modelo óptimo para todas las tareas.

AIES debería poder utilizar modelos diferentes según:

- complejidad;
    
- necesidad de razonamiento;
    
- velocidad requerida;
    
- coste;
    
- fiabilidad esperada;
    
- tipo de capacidad.
    

Los modelos más capaces pueden utilizarse donde su capacidad aporte mayor valor y los modelos económicos donde sean suficientes.

---

## P-16 — La coordinación debe poder reemplazar trabajadores

Un trabajador concreto no debe convertirse en una dependencia fundamental del runtime.

La arquitectura debe permitir sustituir un agente por otro siempre que ambos puedan proporcionar la capacidad necesaria.

Por ejemplo:

```text
            IMPLEMENT
                │
        ┌───────┴───────┐
        ▼               ▼
    Modelo A         Modelo B
```

La capacidad que necesita AIES permanece estable aunque cambie el trabajador.

---

## P-17 — La complejidad debe poder crecer progresivamente

AIES debe poder empezar con un conjunto pequeño de capacidades y agentes.

No se debe introducir complejidad arquitectónica antes de que exista una necesidad demostrada.

La evolución deseada es:

```text
runtime simple
      ↓
más capacidades
      ↓
más estrategias
      ↓
más especialización
      ↓
más coordinación
```

y no:

```text
arquitectura compleja
      ↓
buscar para qué sirve
```

---

## P-18 — Las decisiones importantes deben quedar justificadas

Cuando una decisión arquitectónica tenga consecuencias relevantes, debe existir una explicación de:

- qué problema resuelve;
    
- qué alternativas se consideraron;
    
- qué ventajas aporta;
    
- qué inconvenientes introduce;
    
- por qué se eligió.
    

Estas decisiones deberán documentarse mediante ADRs cuando corresponda.

---

## P-19 — AIES debe priorizar evidencia frente a intuición

Las decisiones sobre el diseño de AIES deberían poder validarse mediante experimentos siempre que sea posible.

Especialmente deberán medirse hipótesis relacionadas con:

- consumo de contexto;
    
- coste;
    
- tiempo;
    
- calidad;
    
- tasa de errores;
    
- número de pasos;
    
- eficacia de la especialización;
    
- utilidad de la memoria;
    
- beneficio de utilizar diferentes modelos.
    

Una arquitectura no debe considerarse mejor únicamente porque parezca más sofisticada.

---

## P-20 — El desarrollador mantiene el control

AIES debe aumentar la capacidad del desarrollador para delegar trabajo sin eliminar su capacidad para comprenderlo y controlarlo.

El desarrollador debe poder conocer:

```text
qué se pidió
   ↓
qué entendió el sistema
   ↓
qué trabajo realizó
   ↓
qué resultado obtuvo
   ↓
qué se verificó
```

La autonomía de los agentes debe estar limitada por el diseño del harness y por las capacidades que se les conceden.

---

## 4. Resumen de los principios

Los principios de AIES pueden resumirse en cinco ideas fundamentales:

```text
1. Coordinar, no hacer.
2. Dividir el trabajo, no acumularlo.
3. Usar el mínimo proceso necesario.
4. Mantener el contexto y el estado bajo control.
5. Delegar sin perder visibilidad ni control.
```

Estos principios constituyen la base para definir posteriormente los requisitos, casos de uso y arquitectura de AIES.
