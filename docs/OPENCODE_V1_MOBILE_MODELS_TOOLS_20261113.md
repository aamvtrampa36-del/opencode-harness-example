# OpenCode Cloud V1 — Móvil, modelos y herramientas (14-11-2026)

**Estado:** cambios de aceptación en PR #54, rama `feat/mobile-chat-openrouter-tools-20261113`. G9 permanece cerrado. No hay merge ni cambios en Producción.

## Correcciones

- El chat solo sigue los fragmentos nuevos mientras el lector permanezca al final. Abrir conversaciones pausa el seguimiento; el scroll queda dentro del panel para mantener visibles la cabecera y la entrada.
- Los perfiles simples siguen intactos. Los modelos OpenRouter concretos, `openrouter/auto` y `openrouter/auto-code` llegan a `handle.setModel` por sesión.
- El hook de contexto ofrece `read/ls/find` en conversaciones sin proyecto; las sesiones con proyecto reciben Linux aislado y GitHub solo cuando hay un repositorio vinculado. La validación de ámbito también se mantiene en la ejecución.

## Verificación

- Suite completa: **285 pruebas aprobadas**; también pasaron `typecheck`, `vite build`, preview HTTP e invariantes.
- Playwright, 393 × 852: menú lateral y nueva conversación funcionan; no hay scroll horizontal; la cabecera permanece fija; nuevos fragmentos no fuerzan el scroll si se está leyendo arriba. Esta prueba local usa una respuesta WebSocket simulada.
- Las pruebas del harness verifican el envío del perfil económico, un modelo concreto con herramientas, Auto Router y Auto Code; las pruebas de herramientas cubren sesión sin proyecto, Linux y repositorio GitHub.

## Límites

- El navegador de prueba de Codex no comparte la sesión Access abierta en el navegador del propietario. Staging sigue mostrando el inicio de sesión cuando se abre desde este entorno; por ello no se verificaron conversaciones ni herramientas reales en el Worker desplegado.
- No se hicieron llamadas pagadas a OpenRouter. Cloudflare no muestra una clave `OPENROUTER_API_KEY` como secreto ligado al Worker; la configuración privada de la aplicación no se pudo consultar desde esta sesión.
- Lectura real de `package.json` mediante el agente y listado real de un proyecto Linux siguen pendientes de una sesión Staging controlable.

## Cloudflare

- Antes de este despliegue candidato, Staging servía `2200edc9-e94d-4846-86de-ff2e7cafdfa7` en `opencode-g1-staging`.
- Producción continúa en `ded98d4d-7bd9-45d5-8176-8ace6431ec5b`.
- El disparador de Cloudflare existente construye desde la rama de esta PR con `wrangler.g1.jsonc` y despliega al Worker exclusivo de Staging.

## Publicación

Mantener la candidata sin merge ni despliegue productivo. Solicitar aprobación explícita del propietario solo cuando concluyan las pruebas de Staging que dependen de su sesión autenticada.
