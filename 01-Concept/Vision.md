**Que problema existe**
Bueno creo que varios la verdad. Primero a ver el contexto el contexto si solo usas un agente para todo, escribir, buscar, leer, pensar ..., pues el contexto se llena y entonces cada cosa que hagas va a costar mas y a la larga el modelo piensa peor y hace las cosas peores. 
Luego tambien la de la rapideza, de forma general me gustaria hacer las cosas "rapido" no tardar demasiado en la spec, el desing, task eh incluso apply que tambien tarda. Aunq si habran tareas que lo requieran tardar mas y se puede llegar a entender. 
Tambien esta el problema de no saber que hace la IA, dejar que la IA escriba escriba y escriba codigo que tu te pierdas y no sepas ni q ha hecho ni como y el codigo sea demasiado como para ponerte a revisarlo. 
El problema del contexto y la memoria, me gustaria que en cada nueva sesion lo primero que sepa el agente es el proyecto q es, lo ultimo que hicimso, arquitecutra, deciisones, etc todo lo importnate y basico del proyecto. 

**AIES**
aies es una configuracion que pretende arreglar eso, el harness


**Que no es AIES**
Para mi aies no deberia ser el que ejecuta o llama el agente o con el que tienes que interactuar para hacer cosas, AIES solo es la configuracion, el harness


**Q intenta conseguir**
Pues princpalmente supongo que arreglar esos problemas, poder programar de forma rapida, eficiente, sin gastar demás, y pudiendo confiar en lo q hace la IA
Y tambien intenta mejorar la calidad de los modelos mas malitos mas baratos, diviendo el trabajo y usando algun modelo mas potente para pensar y mas barato para implementar 

**Principios lo diferencian**
pues yo creo que primero que el agente principal es el unico que no tiene ni puede hacer nada de escribir leer nada, es como si fuera una cuminicacion User <--> orquestador <--> subagentes, asi cada subagente especializado hace su tarea corresponiendten que le manda el orquestador y el orquestador no se llena de contexto y es el que se encarga de decirte a ti lo q se ha hecho y tal
y ademas sobretodo lo diferencia la filosofia de trabajar en tareas pequeñas, algo que tu le pidas al agente lo descompone en tareas mas pequeñas bien definidas y vamos asi poco a pcoo 