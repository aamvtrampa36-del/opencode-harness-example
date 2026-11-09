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
- La API de Workers Builds respondió que no existe configuración de build asociada al Worker y devolvió listas vacías de triggers y Previews; no hay una ruta de despliegue remoto lista para usar mediante esa integración.
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
- CI #91 del commit `5d07953d37626ec18317b7c6948911bad5e450ee` (run 42554295714): completo y correcto.
- **Preflight real del proveedor**: Cloudflare Workers AI devolvió `success:true` para una llamada directa a `@cf/openai/gpt-oss-20b` (106 tokens totales, 2,2181796 neuronas reportadas). Esto confirma acceso del administrador al modelo por la API directa; **NO** demuestra OpenCode, sesión Harness, registro de herramientas ni ejecución de Linux por IA. El costo monetario de esa llamada no fue calculado.
- La verificación con inferencia **dentro de OpenCode Cloud** sigue sin ejecutarse: no hay un entorno Preview de PR accesible mediante sesión autorizada; la conexión Cloudflare API permite administración, pero no proporciona la sesión de navegador Cloudflare Access ni ejecuta directamente la aplicación protegida.
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


## Continuación — normalización de staging y prueba interna (9 de noviembre de 2026)

### Estado técnico verificado
- PR #28 sigue abierta en borrador. El Worker productivo `opencode-harness-example` permanece en versión `1d70eb77-316e-408d-bd14-5f19b171dedf` (despliegue 8/11/2026 23:48:25 UTC).
- Worker de staging `opencode-g1-staging` existe; su dominio `opencode-g1-staging.cdf-cloud-mvp-20261019.workers.dev` exige la pantalla `Sign in · Cloudflare Access` a clientes no autenticados.
- La aplicación Container `opencode-g1-staging-devcontainer` usa política `durable_object` con namespace `bb8b042de894489f82b9efeb486da157`, distinto del namespace productivo. Los namespaces `OpenCodeAgent` y `SETTINGS` de staging también son independientes.
- La conexión Workers Builds se limita a la rama `fix/repeatable-agent-verification-20261108`. La API de Workers Builds ejecuta un build con configuración de staging específica. No hubo actualización de CDF CLOUD ni WorkBench.
- **Incidencia de Container en el despliegue**: el error recurrente `Durable Object-managed Container application settings were not fully applied` desapareció después de alinear el nombre usado por Vite y Wrangler. La causa probable es la mezcla de config de producción con la opción `wrangler deploy --name opencode-g1-staging`; el experimento demuestra que al usar una configuración completa e idéntica para build/deploy el resultado cambia a éxito, pero no establece de manera concluyente la causa interna de Wrangler.
- Se añadió `wrangler.g1.jsonc`, copia aislada de `wrangler.jsonc` con nombre `opencode-g1-staging`; la compilación de staging ahora utiliza `cp wrangler.g1.jsonc wrangler.jsonc && bun install --frozen-lockfile && bun run build` y despliega con `bunx wrangler deploy`. La configuración principal permanece intacta.
- Workers Builds ejecución `b2d1ce0b-0122-4234-95f0-10acccdfea3e`: `success`; versión staging `657ead04-7e3e-48cb-a499-1fbcead59511`.
- GitHub Actions #101 del cambio de staging concluyó `success`.
- Para evitar pedir credenciales y no exponer una ruta de administración, se creó **solo para staging** `src/g1-probe-worker.ts` y se configuró temporalmente un Cron `* * * * *`. El wrapper llama a los métodos reales `OpenCodeAgent.startAgentCheck("cloudflare","repair")` y `agentCheckStatus()` sin sustituir el modelo ni simular herramientas. Usa un workspace único y no repite la prueba después de iniciarla. El mecanismo debe **retirarse antes de cerrar la intervención**; no es parte de la V1.
- Workers Builds `a9349655-1560-4346-ba2a-5ba607785828` terminó satisfactoriamente y desplegó la versión staging `ac1a0716-6864-45fe-9bdd-206449e816d4` con disparador temporal. GitHub Actions #102 concluyó `success`.
- La comprobación externa no autenticada posterior a ese despliegue vuelve a recibir `Sign in · Cloudflare Access`, sin contenido de la API interna.
- El resultado de la modalidad `repair` **no queda aprobado por la mera existencia del Cron**. Exige logs y verificación efectiva de modelo/herramientas/Node; si la invocación no aparece, debe señalarse explícitamente como bloqueo de disparo/acceso en lugar de inferir que el agente falló.

### Cierre y siguiente hito (pendiente de verificación)
1. Confirmar en Workers Observability el evento real `G1_EVIDENCE` y las ejecuciones del agente.
2. Si la prueba se inició, recoger su dictamen y repetibilidad; si no, registrar el motivo real. Ninguna simulación cuenta.
3. Retirar el cron de staging y verificar `schedules: []` antes de concluir.
4. Conservar esta evidencia y actualizar esta sección con el estado final. `G2` (autodesarrollo) solo puede iniciarse después de aprobar genuinamente `G1`; de lo contrario, la prioridad única es el bloqueo observado.

### Referencias de esta intervención
- [GitHub PR #28](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/28)
- [GitHub Actions #101](https://github.com/aamvtrampa36-del/opencode-harness-example/actions/runs/42564251255)
- [GitHub Actions #102](https://github.com/aamvtrampa36-del/opencode-harness-example/actions/runs/42564565910)
- [Cloudflare Workers Environments](https://developers.cloudflare.com/workers/wrangler/environments/)
- [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
