# OpenCode Cloud — Registro de ejecución del hito G1
**Corte:** 2026-11-09 UTC · **Resultado:** PARCIALMENTE COMPLETADO; prueba real del agente BLOQUEADA POR AUSENCIA DE ENTORNO DE EJECUCIÓN DE PR AUTENTICADO. 

## Objetivo de aceptación
Demostrar **modelo real → Linux herramienta del agente → Node test fallido observado → edición efectiva → test superado → verificación del servidor**. Una ejecución de CI o una reparación manual no satisface este criterio.

## Estado comprobado antes de intervenir
- `main` permanecía en `67b44a92177d176d177dc4607f580808102d36ff`; PR #28 abierta como draft con cambios en rama `fix/repeatable-agent-verification-20261108`.
- El Worker activo `opencode-harness-example` desplegaba 100% la versión `1d70eb77-316e-408d-bd14-5f19b171dedf`, de 2026-11-08 23:48:25 UTC.
- Cloudflare Access: existe una aplicación de acceso privado para el dominio **productivo** `opencode-harness-example.cdf-cloud-mvp-20261019.workers.dev`. No se verificó que cubra futuros Preview URLs.
- `wrangler.jsonc` contiene `preview_urls:false` y bindings `AI`, `LOADER`, `OpenCodeAgent`, `DEV`, `SETTINGS`. **No** contiene aún una declaración separada y validada de `previews`.
- El repositorio usa Wrangler 4.158.0 y una acción CI que valida Bun, preview estática, TypeScript, Worker/Vite e invariantes. El flujo CI no ejecuta automáticamente una aplicación de prueba de Cloudflare.
- El Container Linux actual es distinto del motor OpenCode Workerd/Harness. La prueba de autorreparación del agente no se había ejecutado con inferencia real.

## Defecto detectado y corregido en esta intervención
**Falso positivo potencial del ensayo rojo→verde:** la evaluación anterior aceptaba un token devuelto por una herramienta Linux con éxito y el archivo final correcto, pero **no requería que el modelo hubiera observado primero el test fallido**. La prueba fallida preparada por el servidor no es, por sí sola, prueba de observación del agente.

Corrección aplicada a PR #28:
1. `src/agent-check.ts`: ahora rastrea `observedFailingTest` y `verifiedRepairSequence` desde los resultados reales de herramientas Linux, comprobando el orden fallo→éxito para el mismo proyecto.
2. `src/server.ts`: solo inicia la verificación final de reparación cuando existe una secuencia válida; la aprobación requiere además archivo fuente distinto del defectuoso, test original intacto y test Node final con salida 0. El fallo se registra con una explicación separada.
3. `src/agent-check.test.ts`: regresiones para éxito sin observación previa, orden inverso, fallo de otro proyecto y contenido de una herramienta distinta de Linux.
4. `src/agent-check-panel.tsx`: muestra si el agente realmente observó el fallo y distingue el éxito de reparación del de prueba Linux simple.

La ejecución local del comando que prepara los archivos devolvió `exit_code=1` y `not ok 1 - sumar dos numeros`, como se esperaba, con Node 22.16.0. Esa ejecución fue del supervisor, **no de OpenCode Cloud**. Los cambios fueron preparados exclusivamente en la rama de PR; no se modificó producción.

## Evidencia y limitaciones
- CI #89 para commit `9b546e4321f2db22417d421881811bfaef281cc4`: completo y correcto (Bun tests, preview, TypeScript, compilación, invariantes).
- La verificación con inferencia real sigue sin ejecutarse: no hay un entorno Preview de PR accesible mediante sesión autorizada; la conexión Cloudflare API permite administración, pero no proporciona la sesión de navegador Cloudflare Access ni ejecuta directamente la aplicación protegida.
- El plugin de control remoto disponible no tiene ningún dispositivo conectado. No se usaron atajos para saltar Access ni se expusieron tokens.
- **No se desplegó una Preview pública**. La documentación oficial requiere verificar los bindings de Durable Objects/Containers y proteger el URL antes de alojar una terminal o un agente con herramientas. Un Preview puede obtener recursos separados, pero algunos bindings exigen configuración en `previews` y el soporte de Containers es parcial.
- No se probó todavía una sesión real, un modelo operativo, un diff autónomo, persistencia tras reinicio o recuperación de errores del motor. Estos resultados no se deben atribuir al agente.

## Próxima operación necesaria (en orden)
1. Confirmar en el entorno de despliegue si existe un mecanismo autorizado para ejecutar Wrangler con esta rama y los secretos exclusivos de prueba. Antes de desplegar, fijar Access del Preview y bindings separados de `DEV`, `SETTINGS`, `OpenCodeAgent`; nunca compartir datos de producción.
2. Publicar **solo** una Preview temporal aislada (no modificar `main` ni el Worker productivo), comprobar que Linux y AI binding realmente responden, y que la Preview no permite acceso anónimo.
3. Iniciar, desde una sesión Cloudflare Access autorizada, la modalidad `repair` con Cloudflare GPT-OSS (costo limitado, máximo dos autopruebas por día). Registrar ID, herramientas, tiempos, secuencia roja→verde, archivo final, Node exit code, respuesta diagnóstica y gasto cuando esté disponible.
4. Si falla, solucionar la causa (modelo, registro de herramientas, Linux o persistencia) sin añadir una nueva capa de adaptadores. Si se demuestra limitación estructural de Workerd/Harness, adelantar un piloto nativo de OpenCode en Linux.
5. Si G1 pasa, siguiente hito: **G2 autodesarrollo del propio repositorio**; realizar una edición de código en rama por el agente interno, comprobar diff/test y abrir PR borrador.

## Política de finalización
**G1 no se declara completado** hasta contar con la sesión real y la prueba roja→verde observada y auditada. El plan general sigue en `docs/V1_EXECUTION_PLAN.md`; la decisión arquitectónica en `docs/ARCHITECTURE_DECISION_2026-11-08.md`.

## Fuentes
- PR: https://github.com/aamvtrampa36-del/opencode-harness-example/pull/28
- CI #89: https://github.com/aamvtrampa36-del/opencode-harness-example/actions/runs/42554023118
- Previews/resources: https://developers.cloudflare.com/workers/previews/resources/
- Previews/configuration: https://developers.cloudflare.com/workers/previews/configuration/
- Container snapshots: https://developers.cloudflare.com/containers/guides/snapshots/
