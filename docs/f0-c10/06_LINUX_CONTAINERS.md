# F0-C10/T06 — Linux, Containers y aislamiento de procesos

**Corte:** 2026-11-22 (America/Sao_Paulo)  
**Autor de la investigación, fixture y parche:** ChatGPT, pruebas offline en Node/Linux. OpenCode no ejecutó este encargo.  
**Estado:** PARTIAL — corrección acotada propuesta en rama; NO COMPLETE PASS de concurrencia.  
**Repositorio:** https://github.com/aamvtrampa36-del/opencode-harness-example  
**Base de esta rama:** staging/opencode-g1-rpc-safe-20261120 @ 11161dd6f2c4b5237a2da59d7275ff693e0afdbe  
**Issue central:** https://github.com/aamvtrampa36-del/opencode-harness-example/issues/90  
**PR previas:** #104 documental; #105 implementada en Staging, draft frente a main.

## 1. Alcance y trazabilidad

Fuentes leídas: F0_C10_PLAN_INTEGRAL.md del proyecto, issue #90 y ensayo de diez solicitudes del 22-11-2026, PR #104 y #105, y archivos src/dev-container.ts, src/bounded-process-output.ts, src/bounded-process-output.test.ts, src/server.ts, src/project-container.ts, src/dev-guard.ts, src/dev-runtime.ts, package.json y wrangler.g1.jsonc. Se contrastaron lecturas del conector GitHub, consultas GET de Cloudflare y estado de Remote. No se iniciaron tareas Remote, no se ejecutaron comandos en Containers Staging, no se desplegó ni fusionó código.

**Staging observado por GET Cloudflare:** Worker principal versión #374, ID 3546687b-4cd2-4e22-8ea9-ee5ea8fd02cb, deployment 36ef84b3-0f99-4dd4-ab8e-c11ee450dd23, tráfico 100%; Worker MCP versión #19, ID 196240c0-1052-47b3-aaa7-02cf5baa87f0, tráfico 100%. Remote devolvió health/status ok y linuxShell=true, pero eso NO prueba diez ejecuciones. El informe de la PR #113 atribuye el build de ambos Workers al commit 74632f75db010223cc90d99ba4a801ce0e6414e5. La API GET de la versión no expone el SHA fuente: **atribución del código desplegado según #113, no verificación independiente de igualdad byte-a-byte**. Se leyó directamente src/dev-container.ts en ese SHA y en el HEAD de Staging 11161dd6; ambos tienen el colector de #105. El nuevo parche de esta rama NO está desplegado.

El ensayo de 10 solicitudes descrito en issue #90 (comentario 7083567558) produjo 0/10 flujos completos y verificados, 6 respuestas de inicio con OOM, 4 fallos, 2 operaciones not_found y 4 solicitudes preparing canceladas. No probó diez procesos Linux realmente activos.

## 2. Ciclo real de una llamada Linux

1. El supervisor/SDK accede a OpenCodeAgent. En src/server.ts (aprox. líneas 1375–1426 del SHA 74632f7), isolatedProject comprueba el scope de sesión cuando se suministra, consulta/crea registro en DEV.getByName("personal") y utiliza DEV.getByName(projectContainerName(project)). La función src/project-container.ts construye el nombre project-v1:<slug>. El registro personal no es el ejecutor de las tareas aisladas.
2. Cada DevContainer es un Durable Object con Container administrado, imagen cloudflare/debian-trixie, instancia basic y enableInternet=true (src/dev-container.ts). startOrRecover recupera snapshotId si existe o inicia imagen; no es una prueba de filesystem hermético ni sandbox adicional dentro de la VM.
3. DevContainer.run valida proyecto y longitud/comando (src/dev-guard.ts: 1–40 caracteres para slug y como máximo 12.000 caracteres de comando), encola los comandos DEL MISMO DO mediante commandQueue y espera los bloqueos de importación/restauración.
4. runExclusive arranca el Container, actualiza lastActivity y busy, asegura git y Bun 1.4.4 bajo demanda, prepara /workspace/projects/<project> y llama container.exec con bash -lc. El comando de usuario entra como argumento posicional $1, no se concatena directamente al texto de Bash del wrapper.
5. El wrapper ejecuta GNU timeout + bash -lc. La versión inicial de esta rama hacía TERM a los 180 s sin SIGKILL posterior. El parche T06 agrega --kill-after=5s: TERM tras 180 s y KILL tras 5 s adicionales para el grupo gestionado. No abarca procesos que hayan escapado del grupo mediante setsid/detach.
6. La PR #105 sustituyó process.output() en esta ruta por Promise.all de captureBoundedOutput(stdout,32000), captureBoundedOutput(stderr,32000) y process.exitCode. Los dos pipes se drenan durante la ejecución. Se retiene como máximo 32.000 bytes de contenido POR CANAL (prefijo/sufijo) y un marcador de omisión; las salidas pequeñas se conservan completas.
7. Se devuelve project, exitCode real (number o null), stdout, stderr, truncated y persistence="checkpoint-scheduled". Un resultado no cero se representa como código, no como excepción automática. Finalmente se ajusta busy, lastActivity y alarm. La persistencia real depende de checkpoint/snapshot y de recuperación posterior.

**stdin:** run() no abre un stdin interactivo; no es una shell PTY persistente. Otras rutas (p. ej. runTokenEconomizerHook) pasan stdin:pipe y escriben JSON; no confundirlas con la tool Linux genérica.

**Cola:** un proyecto/DevContainer ejecuta comandos serializados; diez proyectos distintos tienen nombres DO distintos y podrían solaparse. La asignación de instancias físicas, memoria, CPU, coste, cola supervisor y contención de arranque no están certificados. Separación lógica por DO no implica aislamiento físico del isolate ni de todos los recursos de infraestructura.

## 3. Riesgos restantes (no atribuidos automáticamente al OOM)

- **R1 — Limpieza:** sin escalada, un proceso que ignore TERM puede impedir completar; se aplica --kill-after=5s a la ruta run(). Aun así GNU timeout solo gestiona su grupo; procesos detached/setsid, hijos huérfanos y procesos auxiliares requieren política de lifecycle y verificación.
- **R2 — Rutas aún no acotadas:** se identificaron llamadas process.output() fuera de run(), por ejemplo bootstrap de Git/Bun, instalación/ejecución del conector TokenEconomizer, restauración y verificaciones. Su producción de salida y límites de entrada deben auditarse individualmente; **no** repetir ni deshacer #105.
- **R3 — Reinicios:** busy y commandQueue están en memoria del DO; una caída/reinicio puede perder ese contador/cola aunque un proceso del Container siga vivo. Coordinar con T04: registro durable de operaciones, reconciliación y no reejecución ciega.
- **R4 — Aislamiento:** el directorio cwd por sí solo no es sandbox. Los comandos Bash dentro de un Container pueden explorar rutas accesibles de su propio filesystem; enableInternet=true no equivale a confinamiento de red. El aislamiento entre diez proyectos depende del enrutado efectivo DO→Container, permisos y controles infra.
- **R5 — Resultados:** los 32.000 bytes por canal no son un límite de memoria de TODO el proceso, del tamaño de chunks de origen, del runtime del Container, ni de consumidores posteriores. El marcador hace visible el truncamiento, pero no reemplaza la entrega de artefactos completos.
- **R6 — Timeout/cancel:** abortar una llamada RPC o perder la respuesta no demuestra terminación ni limpieza de procesos. Aún falta prueba recuperable de cancelación, timeout, señales y estado ambiguo. Salida 124/137, exitCode null o SIGKILL deben preservarse sin presentar éxito.

## 4. Comparación técnica y licencia de DeepSeek Harness

**Referencia inmutable:** deepseek-ai/deepseek-harness, commit 4b399c39a6d1479cd84ca591b4d7c88e24d38a96 (consultado el 22-11-2026). LICENCIA MIT verificada en LICENSE y packages/shell/bash-local/package.json; copyright 2026 DeepSeek. El proyecto advierte que está en developer preview y puede introducir cambios incompatibles.

Archivos analizados en ese commit:
- packages/shell/bash-local/src/index.ts y packages/shell/bash-local/README.md: defaults/cap de timeout, control de expiración, shell Bash fresca, clasificación de timeout, cancel y auto-señal, collectors acotados en el servicio subprocess.
- packages/subprocess/subprocess-local/src/index.ts y README.md: control de proceso/rango, stream con cola de bytes acotada y spill opcional a archivos privados, lectura por offsets, scrub de credenciales ambiente y dispose que espera limpieza.
- docs/subsystems/subprocess.md: contratos para spawn, done, terminate, waitForExit, output collect frente a pipe; procesos y terminales persistentes con propiedad de ciclo de vida.
- packages/shell/tool-bash-persistent/README.md: PTY por agente, ejecución secuencial, reseteo en timeout/cancel; no equivale a ejecutar comandos one-shot.
- packages/shell/bash-sandbox/README.md: file confinement explícito, falla con SANDBOX_UNAVAILABLE si no puede aplicarse; no promete aislamiento de red o procesos.

**Transferibles a OpenCode:** límites aplicados ANTES de materializar, lectura streaming de ambos pipes, hechos separados sobre exit/timeout/cancel, proceso registrado hasta su terminación, limpieza confirmada, y pruebas de salidas grandes con exit no cero.

**No adoptar directamente:** el ejecutor dsh-bash-local NO es un sandbox (ejecuta con autoridad del proceso anfitrión), usa APIs Node/OS y un proveedor de subprocess distinto de Cloudflare Containers. subprocess-local usa Node, procesos host y opcionalmente node-pty; no hay compatibilidad demostrada con workerd/DO. La app usa Bun 1.4.4 bajo demanda DENTRO del Container, no como motor del DO. No se instaló DeepSeek, no se copió código upstream ni se añadieron dependencias.

**Otra referencia:** https://developers.cloudflare.com/containers/guides/execute-commands/ — advierte que output() acumula memoria, recomienda drenar ambos pipes a la vez, que exec() no tiene timeout integrado, que kill() se limita al proceso iniciado y que GNU timeout --kill-after puede escalar frente a hijos del grupo. En Cloudflare, process.exitCode resuelve para salidas no cero.

## 5. Fixtures y pruebas offline

**Archivo añadido:** scripts/f0-c10/t06-linux-fixtures.mjs. Diseñado para Node 22+ con --experimental-strip-types; importa el helper de captura existente, genera stdout/stderr simultáneos, salida 0, 1 KiB/512 B, 32 KiB exactos y 16 MiB por canal, errores deliberados 7/23, y diez procesos locales en directorios temporales separados con marcadores, códigos 0–9 y comprobaciones de contenido. También comprueba que GNU timeout termina un proceso que ignora SIGTERM, con escalada corta.

**Ejecución offline efectivamente realizada:** prototipo equivalente del fixture en Linux local con Node v22.16.0; PASS:
- 0 bytes: exit 0, sin truncado;
- stdout 1024 B / stderr 512 B: exit 7, sin truncado;
- 32.000 B en cada canal: exit 0, sin truncado;
- stdout 16.777.216 B / stderr 16.777.216 B: exit 23, ambas salidas truncadas;
- diez procesos simultáneos LOCALMENTE: diez cwd distintos, marcadores propios correctos, exit codes independientes 0–9 y sin cruces detectados;
- timeout corto con hijo que ignora TERM: terminación tras aproximadamente 2002 ms, reportada localmente como signal SIGKILL y exitCode null (no asumir siempre 137).

**Muestra de memoria en el prototipo:** RSS inicial 54.243.328 B; RSS pico 98.152.448 B; heapUsed pico 12.512.112 B; external pico 38.596.251 B; duración total 2411 ms. Lectura por muestreo cada 5 ms, del proceso de prueba y sus buffers; no es el pico de Workers/DO ni de los procesos hijos. La retención de contenido del colector es 32.000 bytes por canal más un marcador; RSS global puede crecer por buffering, runtime y GC. No hay comparación RED cuantitativa de memoria contra process.output() en Cloudflare. No usar este dato como evidencia de reducción real del consumo del Worker.

**Limitación de reproductibilidad:** el script publicado en GitHub corresponde al mismo diseño del prototipo offline, pero su SHA final y ejecución CI deben comprobarse después de crear la PR. No se ejecutó Bun en este entorno (Bun ausente) ni la suite/typecheck/build completos del repositorio. Ningún ensayo de diez procesos se hizo en Staging.

## 6. Cambio propuesto

**Solo src/dev-container.ts:** opción --kill-after=5s añadida al GNU timeout de runExclusive y comentario sobre el alcance de grupos de procesos. No modifica stdout/stderr bounded, scheduler, DO schema, bindings, versiones, credenciales, imagen, proyectos, snapshots ni Producción. Regresión conceptual: duración normal y salida no cero no cambian; si ignora TERM, el comando puede finalizar con código/señal de muerte en lugar de quedar atascado. Riesgo residual: tareas con procesos detached y salida heredada pueden seguir abiertas; el cambio no promete terminación integral.

**Reversión:** no fusionar PR draft. Eliminar el commit de esta rama o revertir la línea en una rama autorizada; no supone restauración de datos DO/Containers ni autoriza rollback de Staging.

## 7. Gate, costes y pasos

- G-C10-A: PARTIAL. Cloudflare GET de versiones y fuente de GitHub verificados por separado; vínculo exacto de binarios con código se apoya en PR #113.
- G-C10-B: PARTIAL. Pruebas locales de fixture equivalentes PASS; falta CI del HEAD en la rama propuesta y prueba integrada Bun/Cloudflare.
- G-C10-C/D/E: BLOCKED/NOT VERIFIED. Sin permiso de desplegar o ejecutar 10 procesos vivos; además reserva exclusiva y corte real de costes no demostrados.
- Uso de Remote para iniciar tareas: **cero**, sin requestId/taskId nuevos. Ejecuciones Linux cobrables en Cloudflare: **ninguna iniciada en este trabajo**. Coste de recursos en plataformas no cuantificado, no afirmar coste total cero.

**Siguiente acción:** revisar CI y diff de esta PR draft; integrar solo con autorización específica, después medir en runtime aislado con reserva efectiva (primero una tarea, luego 2/4/10 en otro lote), instrumentar bytes de ambas salidas/exitCode/timeout/estado del proceso, medir RSS y OOM del DO, y probar cancelación y restart. Resolver rutas auxiliares process.output() y fugas de procesos en un lote independiente antes de declarar diez herramientas Linux simultáneas confiables.

**Conclusión T06:** el colector principal de Linux está mejorado y probado parcialmente, pero el ejecutor todavía NO está certificado para contribuir con diez procesos realmente simultáneos y recuperables en Staging.
