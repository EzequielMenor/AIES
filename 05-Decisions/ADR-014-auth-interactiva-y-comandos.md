# ADR-014 — Auth interactiva y descubrimiento de comandos

Estado: Accepted  
Fecha: 2026-08-25

## Contexto

La CLI standalone de AIES ya usa `ModelRuntime` de `@earendil-works/pi-coding-agent` para catálogo, selección de modelos y credenciales. El REPL tenía comandos escritos a mano, `/login <provider>` y el credential store de pi, pero no tenía selector ni descubrimiento por prefijo.

## Decisión

- El registry de `runtime/src/commands.ts` es la única fuente de nombres y descripciones para `/help` y `/`.
- `/login` y `/logout` usan un selector raw ligero, sin alternate screen ni framework de TUI. El selector sólo se activa cuando stdin y stdout son TTY.
- Las credenciales siguen en el credential store de pi (`~/.pi/agent/auth.json` por defecto, con sus permisos y sincronización). `aies.config.json` no contiene secretos.
- MiniMax se ofrece como Token Plan mediante el provider `minimax` existente y una clave con prefijo `sk-cp-`.
- Alibaba Model Studio se ofrece como Token Plan mediante `qwen-token-plan-cn`, que coincide con la región China (Beijing), el endpoint compatible y la clave `sk-sp-` documentados por Alibaba. No se muestra Qwen OAuth antiguo.
- Coding Plan de Alibaba no se presenta como opción separada: su documentación define endpoints y catálogo específicos que no están expuestos por la versión actual de pi usada por AIES. No se reutiliza el provider Token Plan para fingir que son el mismo producto.
- OpenAI / ChatGPT se delega al provider público `openai-codex` de pi mediante `ModelRuntime.login(..., "oauth", ...)`. AIES no lee `~/.codex`, cookies o browser storage, ni implementa endpoints OAuth propios. La sesión ChatGPT/Codex y el API key de OpenAI son métodos y facturación distintos.

## Evidencia de proveedor

- MiniMax Token Plan: <https://platform.minimax.io/docs/coding-plan/quickstart>
- Alibaba Model Studio Coding Plan: <https://www.alibabacloud.com/help/en/model-studio/coding-plan>
- Alibaba Model Studio Token Plan: <https://help.aliyun.com/en/model-studio/token-plan-overview>
- OpenAI Codex authentication: <https://developers.openai.com/codex/auth>
- API pública de pi usada por AIES: `ModelRuntime.login`, `logout`, `getProviderAuthStatus` y el provider `openai-codex`.

## Consecuencias

La UX es interactiva en TTY y determinista en pipes. El descubrimiento no puede divergir de `/help`. Los secretos no pasan por `TaskState`, logs, prompts de tareas, métricas ni checkpoints de AIES. Una actualización de pi puede cambiar los providers disponibles; las opciones se construyen comprobando el catálogo real en tiempo de ejecución.
