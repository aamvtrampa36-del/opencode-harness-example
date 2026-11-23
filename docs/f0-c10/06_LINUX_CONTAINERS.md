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


---

## R2-T06 — Ciclo de procesos, escape de PGID y pruebas negativas

**Corte:** 2026-11-22/23 UTC. **Actor:** ChatGPT; GitHub lectura/escritura en rama y pruebas Node/Linux offline. OpenCode Remote no utilizado. **Estado:** PARTIAL / SAME_PGID_POSITIVE / DETACHED_RED_CONFIRMED / NO STAGING E2E.

**Integración de referencia:** [PR #126](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/126), draft, HEAD inicial observado 1268ba22f26330d619b046fcf551ca846cb69d0f. Incorpora #121 y conserva #105. **PR R2:** [#132](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/132), rama fix/f0-c10-r2-t06-process-lifecycle-20261122, base exacta del candidato #126. Ninguna rama se integró ni desplegó.

### R2.1 Reconstrucción y corrección

El supervisor OpenCodeAgent valida scope, registra proyecto y enruta a un DevContainer lógico mediante projectContainerName; DevContainer.run valida proyecto y longitud del comando, adquiere commandQueue, verifica import/restore, inicia o restaura Container, prepara Git/Bun si corresponde, y llama a runExclusive; finalmente actualiza busy, lastActivity y alarm. Un Container lógico por proyecto no prueba diez Containers activos ni separación física de isolates.

La primera ronda envolvió el comando con GNU timeout, TERM tras 180 s y KILL después de 5 s, pero no limpió los descendientes del grupo si el Bash principal salió normalmente; tampoco los descendientes que abandonan el grupo mediante setsid. Drenar stdout/stderr en paralelo como hace #105 elimina la acumulación completa de salida, pero aún puede esperar eternamente por un descriptor heredado.

**Cambio R2 limitado a la ruta de runExclusive en src/dev-container.ts:** el shell prepara el directorio propio y reemplaza su proceso por un supervisor Node (Node 24 suministrado por la imagen managed). El código y la instrucción de usuario se transportan como argumentos POSICIONALES distintos; no se concatenan dentro de código ejecutable. El supervisor lanza GNU timeout con detached:true y stdio separado; el PID del proceso que crea corresponde a un grupo de procesos privado. A la salida normal o por error de ese proceso raíz, envía TERM y después KILL exclusivamente a su PGID, con 250 ms entre señales. Frente a TERM/INT/HUP explícito sobre el supervisor, lo transmite al grupo y escala tras 5 s, cancelando timer al terminar. Nunca utiliza killall, pkill, recorrido global de PIDs ni destroy() de Container.

La salida pasa por pipes binarios con backpressure, que sigue drenando captureBoundedOutput de #105 con contenido máximo de 32.000 bytes POR canal; el marcador de truncamiento va aparte. Si los pipes continúan abiertos 1,5 s después de limpieza, el supervisor los cierra, emite diagnóstico y devuelve 125: no se interpreta una captura incompleta como éxito. Códigos normales no cero se conservan. El código 125 no es prueba de origen único (podría proceder de una app).

**stdin:** en run() sigue cerrado (EOF), no hay PTY persistente. Las rutas con stdin explícito fuera de run() no se modificaron. Salida binaria no UTF-8 pasa con byte counts correctos, pero TextDecoder convierte secuencias inválidas a caracteres de sustitución; no prometer recuperación byte-exacta de archivos desde stdout textual.

### R2.2 Fixtures Linux y mediciones locales

**Nuevo test:** scripts/f0-c10/t06-r2-process-fixtures.mjs. Lee el mismo LINUX_RUNNER_SOURCE del código productivo, lo ejecuta mediante el mismo transporte posicional de Bash y crea exclusivamente directorios temporales. PIDs de procesos creados por el test se recopilan y se terminan en finally; nunca se mata un PID ajeno deliberadamente. Ejecutado con Node v22.16.0 y GNU timeout 9.7, sin acceso a Cloudflare ni inferencia.

**Última muestra de ejecución local:** PASS_WITH_KNOWN_GAPS. Nueve casos:

| Prueba | Resultado local |
| --- | --- |
| stdout/stderr corto, exit code 7 | PASS, código 7 |
| 5 bytes de datos binarios en cada pipe, exit code 23 | PASS, recuento 5 por canal; texto contiene U+FFFD |
| 16.777.216 bytes simultáneos POR canal, exit code 19 | PASS; 32.000 bytes conservados y 16.745.216 omitidos por canal |
| 10 procesos sintéticos en 10 cwd independientes, marcadores y códigos 0–9 | PASS, sin mezcla observada |
| descendiente en mismo PGID ignora TERM, raíz exit code 31 | PASS; descendiente no activo al finalizar (gone/Z) |
| timeout sintético acortado a 1 s; escalada a KILL | PASS; salida observada 137 |
| SIGTERM explícito al supervisor, escalada reducida solo en test | PASS; código 143 |
| descendiente setsid hereda stdout/stderr | RED CONFIRMADO; 125 y diagnóstico de pipes abiertos, hijo sigue vivo S |
| descendiente setsid redirige los tres stdio a /dev/null | RED CONFIRMADO; raíz devuelve 0 pero hijo sigue vivo S |

**Memoria de la última prueba local, muestreo cada 10 ms:** RSS inicial 56.426.496 bytes, máximo RSS muestreado 97.452.032 bytes, heapUsed máximo 12.289.200 bytes; duración total 8.967 ms. Se midió SOLO el proceso Node del fixture, sin agregación del RSS de sus hijos ni Workers/DO/Containers. No se atribuye causalmente ahorro de memoria ni capacidad para diez Containers; el límite de 32.000 bytes es de contenido retenido, no de RSS.

Los dos casos setsid son **pruebas negativas deliberadas**: no se han corregido. El test limpia sus propios PIDs, pero el ejecutor de producción no puede asegurar limpieza de un proceso setsid con stdio redirigido; ni un exitCode 0 significa que el árbol está vacío. Estado Z significa zombie inactivo, no reaping garantizado. La cancelación de una RPC no envía automáticamente SIGTERM a este supervisor; perder la respuesta todavía puede dejar trabajo vivo.

### R2.3 Comparación externa y compatibilidad

**DeepSeek Harness** fijado a commit [4b399c39a6d1479cd84ca591b4d7c88e24d38a96](https://github.com/deepseek-ai/deepseek-harness/tree/4b399c39a6d1479cd84ca591b4d7c88e24d38a96), licencia MIT, LICENSE con copyright 2026 DeepSeek.

- packages/shell/bash-local/src/index.ts: Bash por comando y timeouts, no proporciona sandboxing.
- packages/subprocess/subprocess-local/src/index.ts y README.md: grupo/rango de proceso, finalización/join y captura acotada con spill opcional a archivo privado (permisos 0700/0600); soporta scopes systemd Linux cuando existen, fallback sin visibilidad completa de escapes.
- packages/shell/bash-sandbox/README.md: confinamiento explícito de archivos, no de red/procesos; falla cerrado si no puede confinar.
- packages/shell/tool-bash-persistent/README.md: PTY por agente y reset en estado incierto; no trasplantar a herramienta Linux one-shot.

No se copió código DeepSeek ni se instalaron dependencias. Node 24 pertenece al Container manejado del proyecto; Bun 1.4.4 continúa como dependencia condicional para comandos, no como runtime del Durable Object. El comportamiento real del Runner Node en la imagen de Cloudflare no fue medido.

**Cloudflare:** https://developers.cloudflare.com/containers/guides/execute-commands/ (actualizado 2026-11-09), https://developers.cloudflare.com/containers/api/durable-object-container/ y https://developers.cloudflare.com/containers/platform/limits/. La documentación confirma que exitCode no implica cierre de descendientes, kill() afecta solo al proceso directo, timeout trabaja por grupo excepto setsid y process.output() retiene memoria completa. El tamaño basic por instancia es 0,25 vCPU, 1 GiB RAM y 4 GB de disco; no garantiza diez instancias concedidas ni coste nulo. Véase también https://github.com/cloudflare/sandbox-sdk/blob/main/docs/SESSION_EXECUTION_DEEP_DIVE.md sobre los límites de limpieza de descendientes escapados.

### R2.4 Gates y restricciones

**Evidencia de integridad:** fuente base 1268ba22f26330d619b046fcf551ca846cb69d0f; PR #132 draft, cuyo HEAD y checks deben contrastarse después del último commit. El estado de Staging principal #374 y MCP #19 citado en la primera ronda es HISTÓRICO, no revalidado aquí; el parche R2 no está desplegado.

**Costes/acciones:** 0 llamadas Remote que inicien o modifiquen tareas; 0 comandos sobre Containers vivos; 0 pruebas de carga en Staging; 0 cambios de infraestructura, secretos, Producción o main, sin merge. GitHub CI autorizado puede consumir tiempo de runners; ningún importe real de facturación se midió. No afirmar coste total de cuenta cero.

**G-C10-B:** pruebas offline locales positivas y negativas ejecutadas. En HEAD 3d8c10fdda1be6b6017cc68c0b14eeb8d612a6a2, GitHub Actions OpenCode validation [#45096789695](https://github.com/aamvtrampa36-del/opencode-harness-example/actions/runs/45096789695) y F0-C10 offline [#45096789671](https://github.com/aamvtrampa36-del/opencode-harness-example/actions/runs/45096789671) finalizaron completed/success. Incluyeron Bun unit, preview, typecheck, build Worker/web, invariantes y fixture R2 de Linux. Este documento genera un HEAD posterior, que debe revalidarse por CI independiente antes de aceptación. **G-C10-C/D/E:** BLOCKED/NO VERIFIED: falta entorno de ejecución aislado, reserva/corte de gasto, E2E con recuperación e instrumentación de procesos y memoria.

**Para cumplir cero huérfanos de setsid se requiere ownership del sistema operativo** (cgroup v2/servicio gestionado o PID namespace con supervisor reaper), con capacidad comprobada dentro de Containers Cloudflare. No probarlo sobre Containers compartidos ni introducir comandos globales. También falta recuperación durable de operaciones ante OOM y cancelación RPC, auditoría de process.output() en rutas auxiliares y medición real de overhead de Node por proceso. Un CI verde no cierra esas brechas.

**Conclusión:** R2 mejora el tratamiento de grupos, señales, pipes y códigos de salida, pero **NO GARANTIZA limpieza de procesos detached ni demuestra diez tareas Linux ejecutándose en Staging**. Mantener #90 abierto. Estado PARTIAL.


---

## R2-T06.2 — Cierre prematuro de stdout/stderr y huérfanos por EPIPE

**Corte:** 2026-11-22 America/Sao_Paulo / 2026-11-23 UTC. **Autor:** ChatGPT en entorno local; OpenCode Remote NO START. **Resultado:** mitigación positiva para cierre de pipes en Linux local; riesgo de detached setsid todavía RED. F0-C10 continúa PARTIAL.

### Continuidad exacta y cambio mínimo

La PR #121 (GNU timeout TERM/KILL) se incorporó a #126. La PR #132 (supervisor Node con grupo privado, bounded capture heredada de #105) y su copia revisada #137 siguen DRAFT, no fusionadas. El HEAD de #132 recuperado es 7f0fe32eeba2f6e8c0b0a967f0b15e06b294db4b, desde el que se creó exclusivamente la rama **f0-c10/r2-t06-epipe-20261122**. Esta segunda corrección es una PR incremental hacia la rama de #132; no se escribe #126 ni #132 directamente, no se duplican sus parches contra main.

**RED nuevo reproducido:** si el lector del stream stdout (o stderr) destruye prematuramente su extremo mientras el comando aún emite datos, el Node supervisor de #132 puede sufrir error EPIPE no escuchado en process.stdout o process.stderr. El proceso Node sale con código 1 en lugar de error de supervisión controlado y un hijo puede continuar vivo; en una prueba dirigida sobre stdout se observó estado S del PID propio después del crash. Una RPC que pierda el canal de salida puede reproducir una condición análoga, pero **no se ha probado el disparador real en Cloudflare**.

**Corrección propuesta acotada, solamente src/dev-container.ts:** registrar manejadores de error de los streams stdout y stderr del supervisor. Al fallar un canal, marcar fallo, dejar de reenviar ambas salidas hacia destinos fallidos, continuar drenando los pipes del hijo a descarte para no bloquearlo, enviar TERM exclusivamente al PGID propio del proceso creado y programar SIGKILL a ese mismo PGID tras 5 segundos si no salió. Conservar el flujo de salida normal y exit codes de #132. Si falla la salida, retornar exitCode 125 en lugar de afirmar éxito; en las pruebas se devuelve 125. Si se rompe el mismo stderr, no escribir en él para intentar diagnosticarlo.

El cambio no añade dependencias, no cambia imágenes, cgroups, red, snapshots, Do, Workers, modelos ni esquema de permisos. No usa pkill, killall, ps con acciones globales, búsqueda de PID ajenos o destrucción del Container. La misma limitación previa se mantiene: los hijos que ejecutan setsid pueden escapar del PGID y no se garantiza su limpieza, incluso si redirigen stdio y el comando devuelve cero. Tampoco la cancelación de RPC se traduce automáticamente en señal.

### Prueba de regresión dirigida RED → GREEN

Fixture **scripts/f0-c10/t06-r2-output-disconnect.test.mjs** (Node 22/Linux, descartable, dos casos con node:test): ejecuta la misma constante LINUX_RUNNER_SOURCE embebida en src/dev-container.ts mediante argumentos posicionales, hace que un comando local emita 4096 bytes por intervalo y cierre a propósito el pipe de su consumidor después de 8192 bytes. Lee /proc solamente para el PID registrado por el fixture, comprueba estado gone/Z/X y termina solo PIDs propios en finally.

| Caso | Antes (#132) | Después (candidato EPIPE) |
| --- | --- | --- |
| Cierre anticipado stdout | FAIL: test exit 1; runner exit 1; hijo vivo S observado en reproducción dirigida | PASS: test exit 0; runner exit 125; hijo inactivo |
| Cierre anticipado stderr | FAIL: test exit 1; runner exit 1 | PASS: test exit 0; runner exit 125; hijo inactivo |

El test sin modificación del contrato de salida falla dos subcasos contra el supervisor previo (0/2) y pasa sobre el nuevo (2/2). La prueba independiente original **scripts/f0-c10/t06-r2-process-fixtures.mjs** continúa PASS_WITH_KNOWN_GAPS: nueve escenarios, incluidos diez procesos Linux locales en CWD distintos con marcadores propios y exit codes 0–9, 16 MiB simultáneos por canal con retención de 32000 bytes por canal, truncamiento y no cero, timeout y SIGTERM. Los dos casos negativos setsid continúan detectando supervivencia del descendiente.

**Métricas de la última ejecución local de la suite anterior:** Node v22.16.0 y coreutils timeout 9.7, RSS inicial del fixture 57.647.104 bytes, RSS máximo muestreado 93.855.744 bytes, heap máximo muestreado 11.944.120 bytes, duración 22.364 ms. Son valores exclusivamente del proceso de prueba local, no agregan los hijos ni miden Durable Objects, Container RAM, costes de inference o Cloudflare. El tiempo incluye variación de la máquina compartida; no inferir ahorro de recursos.

**Evidencia canónica:** docs/f0-c10/fixtures/06_epipe_redgreen_evidence.json, junto a scripts/f0-c10/t06-r2-output-disconnect.test.mjs. CI que incluya explícitamente este fixture, Bun unit, typecheck, build, invariantes y el conjunto Linux original se deberá comprobar por HEAD de la PR draft. No llamar a un PASS offline aceptación E2E.

### Comparación con DeepSeek y Cloudflare (fuentes comprobadas)

**DeepSeek Harness** repositorio https://github.com/deepseek-ai/deepseek-harness, commit fijo **4b399c39a6d1479cd84ca591b4d7c88e24d38a96**, archivo LICENSE: **MIT**, copyright 2026 DeepSeek. Leídos packages/shell/bash-local/README.md y packages/subprocess/subprocess-local/README.md a ese commit; las implementaciones se organizan en packages/shell/bash-local/src/index.ts y packages/subprocess/subprocess-local/src/index.ts. El executor Bash local no confina archivos ni procesos: corre con autoridad del host. Subprocess-local usa ownership de rangos gestionados por el OS en Linux compatible con user-systemd y explicitamente reconoce límites de fallback, incluso setsid/reparent. Tiene collector bounded/spill, terminación y espera de rango vacío; esas APIs específicas de Node host no están demostradas como compatibles con Cloudflare workerd. No se copió código ni se instalaron paquetes de DeepSeek.

**Cloudflare:** https://developers.cloudflare.com/containers/guides/execute-commands/ y https://developers.cloudflare.com/containers/api/durable-object-container/ distinguen exitCode del proceso inicial y supervivencia de descendientes, advierten de pipes mantenidos y de que cancelar RPC no termina procesos; timeout de GNU no cubre setsid. En https://developers.cloudflare.com/containers/configuration/scheduling-policy/ la política durable_object indica que runtime no acepta basic, mientras https://developers.cloudflare.com/containers/platform/limits/ aún lista basic; no cambiar instance: "basic" por intuición, sin preflight ni autorización. Esto es conflicto documental, no fallo runtime demostrado. Cloudflare GET revalidó versiones anteriores: Worker principal 3546687b-4cd2-4e22-8ea9-ee5ea8fd02cb (100 %) y MCP 196240c0-1052-47b3-aaa7-02cf5baa87f0 (100 %); ninguno porta estos parches candidatos.

### Riesgos, permisos y gate

0 tareas iniciadas por OpenCode Remote, 0 inferencias nuevas, 0 comandos en Containers Staging, 0 deploy/merge, 0 cambios a main, Production, secretos, Access o recursos persistentes. Las pruebas locales se ejecutaron en directorios temporales y limpiaron solo procesos que crearon. Gastos monetarios de CI, de Cloudflare y del entorno local: **no medidos**, no declarar coste cero. GitHub Actions es el medio para certificar Bun/compilación; no confirma el runtime.

**Resultado de subsistema:** mitigación EPIPE local PASS (2/2), suite anterior PASS_WITH_KNOWN_GAPS (9/9 con dos casos RED deliberados). **No garantiza** ausencia de huérfanos por setsid, aislamiento físico de diez Containers, control de cancelación RPC, autenticidad de código desplegado ni gasto controlado. Sigue bloqueado el gate de procesos detached/cgroups y compatibilidad de instancia. La próxima consolidación T11 deberá seleccionar una sola ruta entre #132, #137 y este incremento; nunca fusionar parches completos superpuestos por duplicado. F0-C10 = PARTIAL / NOT COMPLETE PASS.


---

## R3-T06 — Cierre especializado Linux, cgroups y rutas de artefactos

**Corte:** 2026-11-23 UTC (America/Sao_Paulo). **Autoría:** ChatGPT mediante GitHub y pruebas Node/Linux locales; NO OpenCode Remote ni Codex. **Estado:** PARTIAL / BOUNDED_BOOTSTRAP_CANDIDATE / LOCAL_POSITIVES / DETACHED_AND_HARDLINK_RED / CLOUD_CONTAINER_NOT_PROVEN.

### 1. Autoridad de fuente y dependencia exacta

- Fuente de partida R3: [PR #145](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/145), commit **a49e985909cb56bb42c609c9cd5cb4250a620169**; hereda #144 (baebc30a71dbaa8abca722c0780d4d658e2192c8), #143 (160eafbb0e4842063e37c71425f1a5c2e08b18b2) y #126 (1268ba22f26330d619b046fcf551ca846cb69d0f). Se comprobó que siguen abiertos/draft sin merge. La rama R3 propia es **f0-c10/r3-t06-linux-scope-20261123**, creada desde ese SHA exacto; no modifica ninguna rama ajena.
- #145 contiene los parches Linux previos: #121 (timeout con KILL diferido), #132 (Node supervisor por PGID), #140 (manejo de EPIPE) y el informe #137. No se copió ni aplicó nuevamente ninguna de esas PR.
- Fuente operativa al corte, verificada por Cloudflare **GET-only**: principal deployment **36ef84b3-0f99-4dd4-ab8e-c11ee450dd23**, versión **3546687b-4cd2-4e22-8ea9-ee5ea8fd02cb** al 100 %; MCP deployment **9fdaf22d-beeb-44a0-ab68-77ecd5745fa1**, versión **196240c0-1052-47b3-aaa7-02cf5baa87f0** al 100 %. No se inspeccionó una instancia Container mediante exec ni se atribuye igualdad byte-a-byte entre estos binarios y #145.
- Los documentos docs/f0-c10/F0_C10_PLAN_INTEGRAL.md, docs/f0-c10/00_COORDINACION.md, docs/f0-c10/14_SESSION_RECOVERY_READMISSION.md y la retrospectiva R3 se leyeron; el plan R3 de Biblioteca es posterior a los cortes R2 incluidos en la rama. GitHub es autoridad de código; Biblioteca no se sincroniza automáticamente.

### 2. Contrato verificado de DevContainer.run y corrección mínima de memoria

**Routing y aislamiento lógico:** src/project-container.ts construye el nombre de DO project-v1:<slug>. DevContainer.run valida proyecto/comando, serializa los comandos del MISMO DO mediante commandQueue, comprueba import/restore pendientes y llama runExclusive. ensureRunning/startOrRecover inicia o recupera un Container managed cloudflare/debian-trixie, con enableInternet=true, instance: "basic" y snapshots. CWD por proyecto es /workspace/projects/<project>. Distintos DO son nombres lógicos distintos; no son prueba de aislamiento físico de diez Containers ni permisos dentro del filesystem.

**Ciclo de comando:** runExclusive mantiene busy, lastActivity y alarm; prepara Git/Bun si falta; pasa texto de comando y fuente Node separados como argumentos posicionales a bash, no interpolados en el código del wrapper. El Node supervisor crea GNU timeout sobre bash con detached:true y un PGID privado; timeout aplica TERM a 180 s y KILL tras 5 s. El supervisor recibe TERM/INT/HUP explícitos, señala solo ese PGID y termina descendientes que continúen dentro del grupo al salir la raíz. Si stdout/stderr del consumidor se cierra con EPIPE, desengancha el forwarding, drena y termina el grupo, devolviendo código 125; si hay pipes heredados abiertos después de la ventana de 1.5 s, también devuelve 125. Los exit codes de comando ordinario no cero se conservan. La cancelación del RPC externo NO envía necesariamente señal al Node supervisor. El código 125 no identifica una causa exclusiva.

**stdin:** la ruta ordinaria no solicita stdin interactivo ni PTY persistente. Otros comandos auxiliares que pasan stdin explícito quedan fuera de la corrección. **stdout/stderr:** src/bounded-process-output.ts, heredado de #105, drena ambos flujos concurrentemente; conserva máximo 32.000 bytes de contenido por canal (prefijo y sufijo más marcador), sin recuperar binarios desde texto de forma byte-exacta. **exitCode** corresponde al proceso controlado, NO a la totalidad del árbol, y una respuesta cero no prueba que todos sus descendientes estén muertos.

**Nuevo defecto acotado (fuente RED):** aunque runExclusive ya evita output(), ensureGitAvailable utilizaba handle.output() para apt-get y ensureBunAvailable utilizaba process.output() para npm install. Esos métodos pueden materializar streams completos **antes** de aplicar un recorte; Git/Bun bootstrap podían seguir elevando memoria del isolate aunque el comando Linux general fuera bounded. Se confirmó por lectura de la fuente en #145; no se ha reproducido la OOM histórica #90 en esa llamada.

**Parche R3 pequeño, src/dev-container.ts solamente:** sustituir esas dos lecturas por Promise.all de captureBoundedOutput(stdout, MAX_SHELL_OUTPUT), captureBoundedOutput(stderr, MAX_SHELL_OUTPUT) y exitCode. En Git se conserva el sufijo de error de hasta 350 caracteres y la salida de fallo; en Bun se mantiene el código de salida no cero y el mismo mensaje de error. En ambos, se drenan los dos pipes antes de esperar finalización, sin nuevas dependencias, cambios de imagen o permisos. No se toca ninguna ruta que pertenezca a T03/T04/T05/T08/T09 ni se proclama acotación total del resto de process.output() (por ejemplo inspect/import/recovery).

**RED/GREEN de contrato:** el baseline #145 muestra explícitamente los dos output() no acotados, y el nuevo test source-contract falla si vuelve a aparecer output() en cualquiera de los dos bootstrap. Las pruebas locales de flujos grandes confirman la retención del helper, pero **no miden una reducción real de memoria Cloudflare** ni ejecutan apt-get/npm como efecto de prueba.

### 3. Suite descartable Linux (reproducida fuera de Cloudflare)

Archivos nuevos:
- scripts/f0-c10/t06-r3-tree-child.cjs: raíz/intermedio/nieto, IGNORE_TERM, setsid, doble fork (setsid con stdio redirigido), barrera de proyectos, salida binaria y 16 MiB por canal.
- scripts/f0-c10/t06-r3-linux.test.mjs: extrae LINUX_RUNNER_SOURCE del código candidato para utilizar EL MISMO source en CI, llama procesos locales con bash posicional, monitorea únicamente /proc/<PID> de los procesos propios, registra inicio (starttime) para evitar matar PID reutilizados, los termina en finally y retira los directorios temporales. No usa pkill, killall ni un scan global de /proc. Ejecuta también el lector real de src/task-artifact-source.ts.
- scripts/f0-c10/t06-r3-source-contract.test.mjs: impide regresar a output() en los dos bootstrap y conserva el PGID y pipes bounded.
- docs/f0-c10/fixtures/06_r3_local_evidence.json: JSON con 12 subpruebas, exit codes, valores de memoria y RED explícitos.

**Ejecución local Linux/Node v22.16.0**, mirror textual local de LINUX_RUNNER_SOURCE y del lector de artefactos creado desde la fuente; se exige CI de la rama para repetir contra **archivos exactos del repositorio**. Comando de prueba: node --experimental-strip-types --test scripts/f0-c10/t06-r3-linux.test.mjs. **12/12 PASS en el significado propio de las aserciones; dos pruebas demuestran fallos de seguridad persistentes**, no equivalen a cero defectos.

| Escenario | Resultado local / exit code |
| --- | --- |
| Raíz→intermedio→nieto que ignora TERM, mismo PGID | 31; nieto gone/Z (inactivo) después de cleanup |
| setsid con pipes heredados | 125 y diagnóstico; descendiente S todavía vivo: **RED** |
| Doble fork + setsid + stdio redirigido | 0 pese a descendiente S todavía vivo: **RED, falso positivo si se infiere limpieza por exit 0** |
| Timeout corto sintético 1 s, TERM→KILL | 137; descendiente inactivo |
| Binario no UTF-8, stdout+stderr, código no cero | 23; conteo exacto de 5 bytes por canal, texto con reemplazos |
| 16 MiB simultáneos en stdout y stderr | 19; 16.777.216 B por canal; contenido retenido 32.000 B por canal |
| Barrera local de 1, 2, 4 y 10 procesos | salidas 0..N-1, marcadores de cwd correctos, sin cruce detectable en la prueba |
| O_NOFOLLOW y rutas dist | symlink final/intermedio, traversal y /bundle rechazados, lectura autorizada exacta |
| Hardlink entre dist de dos proyectos en UN filesystem local | lectura ajena permitida por hardlink: **RED de supuesto aislamiento same-FS** |
| Lectura no destructiva de cgroup local | cgroup2 detectado, /sys/fs/cgroup no writable en este entorno |

**Tiempo y memoria del fixture local:** RSS inicial 56.422.400 B, máximo RSS muestreado 86.306.816 B, heapUsed pico 13.941.232 B, duración 7.708 ms; muestreo cada 15 ms del **test Node padre**, no agrega procesos hijos y no mide workerd/DO/Cloudflare. Ninguna cifra demuestra memoria del Container ni el coste de diez ejecuciones reales. Barreras 1/2/4/10 prueban procesos Linux que esperaron antes de liberar una marca local, NO agentes OpenCode ni inferencias simultáneas.

**Pruebas R2 reutilizadas, no copiadas:** scripts/f0-c10/t06-r2-process-fixtures.mjs (PGID, setsid, 16MiB, 10 directorios) y scripts/f0-c10/t06-r2-output-disconnect.test.mjs (stdout/stderr EPIPE) se conservan. El nuevo workflow ejecuta esos tests y los R3, además de regresión Bun/typecheck/build.

### 4. O_NOFOLLOW, paths, archivos compartidos y límites de confianza

El lector REAL de src/task-artifact-source.ts (superficie T09, sin cambios R3) valida proyecto y ruta relativa bajo dist, realpath de root/proyecto/dist, abre con O_RDONLY | O_NOFOLLOW | O_NONBLOCK y comprueba /proc/self/fd/N después de abrir, fstat de archivo regular y máximo 32 KiB, retornando base64 con SHA-256. Son controles positivos verificados en fixture.

**Límite importante:** O_NOFOLLOW detiene symlinks del componente final, NO hardlinks. Cuando DOS proyectos artificiales comparten el mismo filesystem POSIX local, puede crearse un hardlink dentro de dist al inode de otro proyecto y el lector lo acepta: su fd realpath presenta el dentry bajo el directorio permitido. Esto es un **contraejemplo de aislamiento por path en un mismo filesystem**, NO evidencia de que los Containers aislados por DO de Cloudflare compartan inodes o de que el acceso real sea explotable entre ellos. El shell del proyecto sigue sin sandbox filesystem adicional dentro de su propio Container. Mitigación propuesta para dueño T09/T11: revisar si el contrato permite hardlinks (st_nlink>1), readback de identidad y propiedad por tarea, y demostrar separación efectiva por Container antes de cambiar lector. No cambiar automáticamente código de T09 desde T06.

El test actual NO certifica que un comando Bash no pueda salir de su cwd. CWD diferente ≠ filesystem privado; la garantía depende del mapeo real project-v1 a distintas instancias y del runtime.

### 5. Cgroup y alcance de procesos: STOP real

**Solo Linux local:** /proc/self/cgroup contiene 0::/ y /sys/fs/cgroup usa cgroup2fs; el mount observado es de solo lectura y test -w del root del cgroup es false. El test NO escribió cgroup.procs, cgroup.kill, cgroup.subtree_control ni ejecutó systemd-run/unshare. Por tanto **este entorno no demuestra una jerarquía cgroup delegada utilizable**, ni un kill de setsid fuera del PGID.

**Cloudflare Containers managed:** la API pública ctx.container.exec documenta kill() del proceso raíz, no de un árbol/scope del usuario; wait/exitCode no garantiza desaparición de descendientes; cancelar RPC no mata los procesos. La documentación no acredita que la imagen managed cloudflare/debian-trixie con scheduling_policy: durable_object exponga cgroup v2 writable/delegado por comando. **No se ejecutó ningún probe en Container Staging ni desechable; resultado Container = UNKNOWN / STOP.** No asumir cgroups por la existencia de Linux o Firecracker, ni añadir cgroup.kill, systemd-run, killall, pkill, scans globales de PIDs o destroy() de una instancia compartida.

Además, src/dev-container.ts solicita instance: "basic" mediante ctx.container.start(). En la documentación específica de política durable_object, basic NO se acepta actualmente, pero el documento de migración todavía enumera basic como opción. **Conflicto de documentación, no fallo de Staging demostrado**: revalidar en preflight aislado antes de desplegar; no cambiar el tamaño sin precio/capacidad y rollback revisados.

Fuentes públicas: https://developers.cloudflare.com/containers/guides/execute-commands/ ; https://developers.cloudflare.com/containers/api/durable-object-container/ ; https://developers.cloudflare.com/containers/configuration/scheduling-policy/ ; https://developers.cloudflare.com/containers/guides/migrate-to-durable-object-scheduling-policy/ .

**Lista exacta para T11 en un lote posterior autorizado:**
1. Reservar Container NUEVO, desechable y no compartido, identidad/version SHA, llave de aislamiento, gasto con corte real y rollback; nunca usar Container de proyecto existente.
2. Verificar image Node/GNU timeout, instance basic u opción aceptada, política e imagen efectiva, sin ajustes implícitos del precio.
3. Realizar lecturas solamente de /proc/self/cgroup, mountinfo de cgroup, statfs, test -w, identidad de PID 1 y puertos; comprobar si existe jerarquía **delegada por tarea** antes de cualquier escritura.
4. Solo si la delegación se demuestra, crear scope privado a partir de ownership comprobable en ese Container descartable; insertar hijo setsid con stdio redirigido, probar TERM/KILL/cgroup.kill limitado al scope y leer proc/cgroup.events hasta quedar vacío. No ejecutar esta fase en la imagen actual sin su preflight.
5. Probar cancelación, timeout, SIGKILL de supervisor, reinicio del DO, aislamiento por diez Container IDs (escalando únicamente con autorización y política de gasto), recuperación de 10 archivos/hash y memoria efectiva del DO+Container. Medir huérfanos, RSS, cuotas y coste; establecer STOP en OOM o efecto ambiguo.

### 6. Comparación DeepSeek Harness fijada y compatibilidad

Repo https://github.com/deepseek-ai/deepseek-harness, commit INMUTABLE **4b399c39a6d1479cd84ca591b4d7c88e24d38a96**; licencia **MIT** en LICENSE (copyright 2026 DeepSeek) y packages/subprocess/subprocess-local/package.json. Código y docs leídos en ese commit: packages/subprocess/subprocess-local/src/index.ts, src/linux-scope.ts y README.md, packages/shell/bash-local/src/index.ts y README.md. DeepSeek usa rangos de proceso gestionados, user-systemd scopes en Linux compatible, join y limpieza al disponer recursos, collectors bounded con spill opcional y un fallback que NO garantiza detectar todos los setsid/reparent. Su Bash local ejecuta con la autoridad del host y **no es sandbox**. Las APIs usan Node/host y no son importables automáticamente en workerd/DO; Node dentro del Container no demuestra que systemd user-scope esté disponible. No se copió código, no se añadieron dependencias.

### 7. Registro de permisos, CI, costes y entrega

**Acciones:** lectura GitHub, Cloudflare GET y docs públicas; pruebas descartables Linux LOCAL; código y docs en rama R3; PR draft y GitHub Actions autorizadas. **No OpenCode Remote start/cancel/continue**, inferencia, cambios Cloudflare, merge, despliegue, Producción, main, secretos, DO, Containers compartidos, Access o migraciones. El total monetario de GitHub Actions, costes de cuenta, Cloudflare y almacenamiento **NO MEDIDO**; cero operaciones de inferencia iniciadas por este encargo, no costo cero global.

**G-C10-B:** la suite local R3 contiene 12/12 aserciones pasadas, donde dos casos setsid y uno hardlink siguen RED en seguridad. Bun/typecheck/build/invariantes requieren CI sobre HEAD exacto de esta PR. **G-C10-C/D/E NO VERIFICADOS**: no hay ejecución Cloudflare E2E ni auditoría binaria autenticada. Issue #90 sigue abierto con 0/10 en el fallo histórico.

**Handoff único a T11:** integrar exclusivamente este diff incremental de bootstrap + tests + informe desde la base exacta #145, no agregar #121/#132/#140/#137 otra vez. STOP para prometer cero huérfanos: resolver ownership de processes con Container descartable y test real. Coordinar hardlink como descubrimiento de T09. No iniciar nueva ronda T06 ni declarar COMPLETE PASS.
