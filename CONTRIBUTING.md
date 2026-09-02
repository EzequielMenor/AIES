# 🤝 Guía de Contribución a AIES

¡Gracias por tu interés en contribuir a **AIES**! Este proyecto busca construir un harness y runtime autónomo riguroso, eficiente en tokens y basado en evidencia empírica.

---

## 🧭 1. Principios y Arquitectura Primero

Antes de proponer cambios grandes o nuevas funcionalidades, es fundamental entender las bases arquitecturales del proyecto:

1. **Lee los Principios:** Revisa [`01-Concept/Principles.md`](01-Concept/Principles.md). Todo cambio debe respetar los principios centrales (como **P-01: El orquestador no realiza el trabajo**, aislamiento estricto de contexto y verificación objetiva).
2. **Consulta los ADRs:** Revisa [`05-Decisions/`](05-Decisions/) para comprender las decisiones de diseño tomadas hasta la fecha.
3. **Límites de confianza (Zod):** Todo intercambio de datos entre modelos y el runtime debe estar tipado y validado mediante esquemas Zod estrictos.

---

## 🌟 2. Formas de Contribuir

No todas las contribuciones son código. Puedes apoyar al proyecto en múltiples frentes:

### A. Reporte de Errores e Ideas
* Si encuentras un fallo o comportamiento inesperado, [abre un Issue](https://github.com/EzequielMenor/AIES/issues) describiendo:
  * Entorno (versión de Node.js, SO, modelo LLM utilizado).
  * Pasos exactos para reproducir.
  * Comportamiento esperado vs. obtenido.
* Si tienes una propuesta de funcionalidad que afecte a la arquitectura, abre primero un Issue de discusión antes de implementar código.

### B. Investigación Empírica y Benchmarks
* AIES se guía por el principio **P-19 (Evidencia frente a intuición)**.
* Puedes contribuir diseñando, ejecutando y documentando experimentos comparativos en [`06-research/`](06-research/) (por ejemplo, midiendo el consumo de tokens y tasa de éxito frente a baselines de agente único).

### C. Desarrollo de Código
* Corrección de bugs en el runtime central (`runtime/src/`).
* Mejoras en los subagentes efímeros (*Explorer*, *Implementer*, *Verifier*).
* Nuevas integraciones de modelos o proveedores.
* Optimizaciones en la interfaz de terminal (UI / telemetría).

### D. Documentación y Wiki
* Mejoras en [`openwiki/`](openwiki/) o en la documentación de conceptos y especificaciones.
* Corrección de erratas, ejemplos prácticos o guías de configuración.

### E. Apoyo y Patrocinio
Si no tienes tiempo para programar pero encuentras valor en AIES y quieres asegurar su continuidad:
* ⭐ **Estrella el repositorio** en GitHub para darle visibilidad.
* ☕ **Patrocina el proyecto:** Puedes invitarme a un café en [Buy Me a Coffee](https://buymeacoffee.com/wm2jv22vfmx) o en [Ko-fi](https://ko-fi.com/ezequiel_33).

---

## 🛠️ 3. Entorno de Desarrollo Local

### Prerrequisitos
* **Node.js**: `>= 22.19.0` (o Node 20+)
* **Gestor de paquetes**: `pnpm` (recomendado)

### Instalación y Compilación
```bash
# 1. Clonar el repositorio
git clone https://github.com/EzequielMenor/AIES.git
cd AIES/runtime

# 2. Instalar dependencias
pnpm install

# 3. Compilar el runtime
pnpm run build
```

### Ejecutar Tests y Verificación
Antes de enviar cualquier cambio, asegúrate de que todos los chequeos pasen satisfactoriamente:

```bash
# Comprobación de tipos TypeScript
pnpm run typecheck

# Suite de tests completa
pnpm test
```

---

## 📋 4. Convenciones de Código y Commits

* **Commits Semánticos:** Usa la convención de [Conventional Commits](https://www.conventionalcommits.org/):
  * `feat: ...` para nuevas funcionalidades.
  * `fix: ...` para corrección de errores.
  * `docs: ...` para cambios exclusivamente en documentación.
  * `refactor: ...` para cambios estructurales de código sin modificar funcionalidad externa.
  * `test: ...` para añadir o corregir pruebas.
* **Sin Atribuciones Automáticas de IA:** No incluyas trailers como `Co-Authored-By` de herramientas generativas en los mensajes de commit.
* **Zero-Bloat:** No agregues librerías o dependencias externas pesadas a menos que exista una justificación técnica sólida y consensuada.

---

## 🚀 5. Flujo de Trabajo para Pull Requests (PRs)

1. Haz un fork del repositorio y crea una rama descriptiva a partir de `main`:
   ```bash
   git checkout -b feat/mi-mejora
   ```
2. Realiza tus cambios asegurando que el código sea limpio y cumpla los estándares.
3. Asegúrate de que `pnpm run typecheck` y `pnpm test` pasen en local.
4. Haz push a tu fork y abre un **Pull Request** hacia la rama `main` del repositorio oficial.
5. Explica claramente en el PR:
   - ¿Qué problema resuelve o qué añade?
   - ¿Por qué se ha implementado de esta manera?
   - Pruebas realizadas para verificar el cambio.
