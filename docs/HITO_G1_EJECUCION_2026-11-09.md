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


## Cierre de la intervención — G1 sigue pendiente de ejecución auténtica

**Corte:** 2026-11-09 05:11 UTC · **Dictamen:** G1 **parcialmente completado**, con bloqueo operativo en la ejecución autenticada del agente.

### Trabajo efectivamente terminado
1. El despliegue separado `opencode-g1-staging` dejó de fallar en la configuración del Container después de usar `wrangler.g1.jsonc` como configuración de compilación y despliegue. Se conserva la configuración productiva original.
2. Los namespaces `DEV`, `OpenCodeAgent` y `SETTINGS` están separados de producción. La aplicación `opencode-g1-staging-devcontainer` tiene política `durable_object` y cero instancias activas tras la comprobación.
3. La URL de staging exige inicio de sesión de Cloudflare Access. Una solicitud no autenticada a `/api/health` devuelve la página de login, no información interna.
4. Los builds `b2d1ce0b-0122-4234-95f0-10acccdfea3e` y `a9349655-1560-4346-ba2a-5ba607785828` acabaron correctamente. GitHub Actions #101 y #102 también aprobaron.
5. Se desplegó temporalmente una envoltura `src/g1-probe-worker.ts` con un disparador programado interno para intentar `startAgentCheck("cloudflare","repair")` y consultar `agentCheckStatus()`. No se creó ruta HTTP pública ni se relajó Cloudflare Access.
6. **No apareció ningún evento de ejecución `G1_EVIDENCE` ni invocación del Worker atribuible al disparador en los registros consultados durante la intervención.** Por tanto, no existe evidencia de que el modelo hubiera realizado llamadas a Linux, editado código o superado el test; no se atribuye éxito a OpenCode. La ausencia de eventos no demuestra por sí sola un defecto de la IA: los cambios de Cron pueden tardar en propagarse.
7. Para no dejar una tarea recurrente en ejecución sin supervisión, se eliminaron los disparadores por API (`schedules: []`), se retiró `src/g1-probe-worker.ts` y se restauró `wrangler.g1.jsonc` a `main: src/server.ts` y `triggers.crons: []`. Los builds de limpieza `f64a31b7-d2ca-4356-9bc3-eaaf0624493b` y `2d902d91-edfe-41bb-ab77-9418e0d066f1` terminaron en `success`; GitHub Actions #104 también terminó en `success`.
8. El Worker de staging quedó en versión `2e1026dd-b34d-4220-b30a-9072672f2c4d`, sin Cron y con el Container sin instancias activas. Producción conserva la versión `1d70eb77-316e-408d-bd14-5f19b171dedf`; CDF CLOUD y WorkBench no fueron modificados.

### Distinción de evidencias
- **Implementado:** ensayo repetible de reparación, corrección de falsos positivos, configuración aislada de staging.
- **CI:** pruebas automatizadas aprobadas en #104.
- **Cloudflare:** despliegue completo de staging aprobado; aislamiento y protección de acceso comprobados.
- **Modelo real dentro de OpenCode Cloud:** **sin ejecución verificable**.
- **Linux iniciado por OpenCode:** **sin ejecución verificable**.
- **Secuencia rojo→verde y repetibilidad:** **sin demostrar**.
- **Costo:** no se obtuvo la facturación desglosada por operación. No se observó ninguna instancia Container activa en el corte final. Los builds y Worker pueden registrar consumo; no se declara gasto cero.
- **Recursos de prueba no productivos restantes:** staging Worker protegido y su aplicación Container; existe además un Preview creado anteriormente sin despliegue y una aplicación Access para él, sin intervenir en esta limpieza.

### Única siguiente prioridad según el plan V1
**Ejecutar `repair` mediante la sesión del propietario en la aplicación staging protegida**, sin crear nuevos adaptadores ni Cron. El usuario autorizado deberá abrir `https://opencode-g1-staging.cdf-cloud-mvp-20261019.workers.dev`, autenticarse por Access, iniciar la autoprueba con `Cloudflare GPT-OSS 20B` y conservar el resultado y la traza de herramienta. Si G1 supera el test auténtico y su repetición, se pasa a **G2 — autodesarrollo del propio repositorio**; si falla, investigar el primer error verificable del modelo/Harness/Linux y aplicar la reparación mínima.

**No se puede declarar G1 completado** con las evidencias disponibles, pero el bloqueo administrativo de despliegue identificado en la intervención anterior sí quedó resuelto.

### Enlaces de verificación
- [GitHub Actions #104](https://github.com/aamvtrampa36-del/opencode-harness-example/actions/runs/42565660807)
- [Rama y cambios de PR #28](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/28)
- [Plan maestro de V1](https://github.com/aamvtrampa36-del/opencode-harness-example/blob/fix/repeatable-agent-verification-20261108/docs/V1_EXECUTION_PLAN.md)


## Corrección posterior a la primera comprobación de cierre (05:11 UTC)

**Esta sección corrige el carácter provisional del cierre anterior.** Los eventos de Cron llegaron a Workers Observability después de la comprobación inicial y mostraron un fallo técnico **real**, que no estaba incluido en el diagnóstico previo.

- 2026-11-09 05:10 UTC: evento `scheduled` del staging, llamadas RPC reales a `OpenCodeAgent`, `PersonalSettings` y `DevContainer`. El primer resultado `G1_EVIDENCE` fue `{phase:"start",status:"failed",kind:"repair",model:"cloudflare",message:"No se pudo preparar la prueba de reparación con un test fallido verificable."}`.
- No había evidencia de un modelo trabajando todavía: el fallo ocurrió durante la **preparación de los archivos de prueba** en Linux. No se debe atribuir la reparación a OpenCode.
- **Hipótesis técnica sustentada:** el Container ejecuta Node.js 24; el verificador esperaba el texto TAP `not ok`, pero Node.js 24 puede usar por defecto un reporter distinto. La prueba anterior del supervisor había usado Node.js 22 y no detectó esta diferencia. La documentación pública de Node confirma que `--test-reporter=tap` permite fijar el formato.
- Se corrigieron `src/agent-check.ts`, `src/server.ts` y `src/agent-check.test.ts` para usar explícitamente `node --test --test-reporter=tap calc.test.mjs` en preparación, solicitud al agente, verificación y regresiones. Ahora el servidor también informa `exitCode` y si observó salida TAP cuando la preparación falla.
- La corrección quedó en la PR #28; GitHub Actions #107 terminó satisfactoriamente. Una nueva prueba interna de staging usa el workspace aislado `d46c73a9-7e9d-4280-a0a9-1a7bf5cb3405`. El desplegue asociado a Workers Builds `37860877-8812-450f-96eb-539813937feb` terminó con `success` y versión `b2aa474c-10bb-4533-b1a0-8cadc375e2b2`.
- La segunda prueba todavía exige **su propia evidencia real de ejecución** y no debe declararse aprobada por el éxito del despliegue. El mecanismo temporal `scheduled` permanece solo en staging mientras se observa ese intento, y se retirará antes del cierre final.

**Estado revisado:** infraestructura y Linux realmente invocados en una primera prueba; el modelo todavía no inició una reparación observable. El cierre del hito G1 sigue abierto y sujeto al resultado del reintento con TAP explícito.


## Dictamen definitivo de esta intervención — 05:21 UTC

**G1 = PARCIALMENTE COMPLETADO; no aprobado.** Se resolvió el despliegue completo de `opencode-g1-staging` y se obtuvo una primera invocación real de Linux desde el control de prueba del agente. Sin embargo, no existe aún evidencia de inferencia dentro de OpenCode y reparación autónoma rojo→verde.

**Primera ejecución auténtica, observada posteriormente:** Cloudflare Workers Observability registró `OpenCodeAgent.jsrpc`, `PersonalSettings.jsrpc`, `DevContainer.jsrpc` y `G1_EVIDENCE phase=start status=failed` alrededor de 05:10 UTC. El fallo ocurrió en la preparación: el test Node no devolvió la representación que el verificador esperaba. La hipótesis de incompatibilidad del reporter Node.js 24 se corrigió fijando `--test-reporter=tap` en todos los comandos y añadiendo regresiones.

**Reintento TAP:** GitHub Actions #107 aprobó; Workers Builds `37860877-8812-450f-96eb-539813937feb` también terminó en `success` y subió staging versión `b2aa474c-10bb-4533-b1a0-8cadc375e2b2`. Se preparó un segundo proyecto y un disparador interno temporal, pero hasta 2026-11-09 05:20:54 UTC **no apareció ningún evento `G1_TAP_RETRY` atribuible al segundo intento**. No puede afirmarse que la corrección ya haya pasado el ensayo remoto o que el modelo haya ejecutado herramientas.

**Limpieza de seguridad:** se eliminó el Cron del Worker de staging con Cloudflare API, que confirmó `schedules: []`; se restauró `wrangler.g1.jsonc` a `main: src/server.ts`, `triggers.crons: []` y se eliminó `src/g1-probe-worker.ts`. Producción seguía en `1d70eb77-316e-408d-bd14-5f19b171dedf`. El build de limpieza `55915885-1b67-483c-892b-2356265698d4` concluyó en `success`. Staging quedó en la versión `5d2c6c5a-fb43-4baa-96e0-44658ca28fb6`, con `schedules: []`; no quedó el disparador temporal. No queda programada una nueva ejecución ni se promete trabajo en segundo plano.

**Siguiente acción única conforme a `docs/V1_EXECUTION_PLAN.md`:** abrir desde un navegador autorizado `https://opencode-g1-staging.cdf-cloud-mvp-20261019.workers.dev`, iniciar sesión mediante Cloudflare Access y ejecutar una vez la opción `repair` con `@cf/openai/gpt-oss-20b`. Recopilar la traza real del modelo y herramientas y solo entonces cerrar G1 si supera el ciclo fallido→edición→test verde→verificación independiente. Si falla, corregir la primera causa reproducible antes de agregar funciones. G2 sigue bloqueado hasta aprobar G1.

**Enlaces:** [CI #107](https://github.com/aamvtrampa36-del/opencode-harness-example/actions/runs/42566073996), [PR #28](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/28), [Plan V1](https://github.com/aamvtrampa36-del/opencode-harness-example/blob/fix/repeatable-agent-verification-20261108/docs/V1_EXECUTION_PLAN.md).
