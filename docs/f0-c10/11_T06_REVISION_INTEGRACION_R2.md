# F0-C10/R2 — T11: revisión de integración Linux T06 (#132)

**Corte:** 2026-11-22/23 (America/Sao_Paulo). **Actor:** ChatGPT, no OpenCode Remote.  
**Estado de aceptación:** \`PARTIAL / REVIEWED / NO LIVE CONTAINER CLEANUP PROOF / NO DEPLOY\`.  
**Issue central:** https://github.com/aamvtrampa36-del/opencode-harness-example/issues/90  
**Repositorio:** https://github.com/aamvtrampa36-del/opencode-harness-example

## 1. Alcance, autoridad y regla de no duplicación

Esta revisión ejecuta la siguiente acción autorizada tras R2-T06: contrastar, integrar **como candidato de código no fusionado**, revisar #132 frente a la consolidación #126 y determinar si Cloudflare ofrece limpieza de descendientes \`setsid\`. No se realiza merge de #132, #126 o main ni despliegue. No se ejecuta código en Containers vivos ni se altera su filesystem/snapshot.

- **Base consolidada de T11:** PR [#126](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/126), \`f0-c10/t11-integration-20261122\`, SHA \`1268ba22f26330d619b046fcf551ca846cb69d0f\`, draft abierto al corte.
- **Fuente del cambio Linux:** PR [#132](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/132), \`fix/f0-c10-r2-t06-process-lifecycle-20261122\`, SHA \`7f0fe32eeba2f6e8c0b0a967f0b15e06b294db4b\`, draft abierto. Ya se basa directamente en #126, con cinco ficheros modificados.
- **Candidato de revisión T11:** nueva rama \`f0-c10/r2-t11-t06-review-20261122\` creada **desde el SHA exacto de #132**, sin cherry-pick ambiguo ni reimplementación. Esta rama contiene las mismas correcciones y pruebas R2-T06 más ESTE informe. Se propone PR draft dirigida a la rama #126, no a main.
- **No fusionar a la vez #132 y el PR T11:** los diffs de código se superponen. La PR de T11 es candidato documental/de integración; elegir una sola ruta cuando exista autorización. Mantener #132 como fuente y evidencia original.

La revisión evita repetir #105 (captura bounded) y #121 (escalada TERM→KILL) y no toca el código ni los workflows de #126, salvo lo ya contenido en #132.

## 2. Estado comprobado de versiones y CI

- **GitHub #132 HEAD exacto:** \`7f0fe32eeba2f6e8c0b0a967f0b15e06b294db4b\`.
- **CI HEAD #132:** [OpenCode validation #45096881008](https://github.com/aamvtrampa36-del/opencode-harness-example/actions/runs/45096881008) y [F0-C10 offline #45096881049](https://github.com/aamvtrampa36-del/opencode-harness-example/actions/runs/45096881049): \`completed/success\`. Incluyen Bun tests, preview, typecheck, build Worker/web, invariantes, harness offline y fixture nuevo T06. **No prueban** aislamiento físico ni limpieza de \`setsid\` en Cloudflare.
- **Cloudflare GET (lectura de despliegues, sin cambiar nada):** \`opencode-g1-staging\` deployment \`36ef84b3-0f99-4dd4-ab8e-c11ee450dd23\`, versión \`3546687b-4cd2-4e22-8ea9-ee5ea8fd02cb\` al 100 %; \`opencode-staging-control-mcp\` deployment \`9fdaf22d-beeb-44a0-ab68-77ecd5745fa1\`, versión \`196240c0-1052-47b3-aaa7-02cf5baa87f0\` al 100 %. **Ninguno de los cambios #126/#132 está acreditado como desplegado.** La igualdad de bytes Worker↔GitHub no se deduce de un SHA de fuente.
- **OpenCode Remote:** \`NO START\`, ningún requestId/turnId nuevo, sin inferencia o acciones con coste.
- **Issue #90:** seguía abierto. El caso RED histórico 22/11 obtuvo 0/10 flujos completos y verificados; ninguna de las dos PR corrige por sí sola la aceptación global.

## 3. Auditoría de diff / contrato Linux

Se revisó [diff de #132](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/132/files) contra #126:
1. \`src/dev-container.ts\`: sustituye la ruta de \`runExclusive\` que invocaba directamente \`bash -lc\` + GNU timeout por un supervisor Node dentro del Container; \`LINUX_RUNNER_SOURCE\` se transporta como argv independiente del comando. El hijo \`timeout\` arranca en **PGID privado** (\`detached:true\`) y recibe TERM→KILL por señales negativas al PID del grupo creado, NO por selección global de nombres. Cuando el proceso raíz sale, se intenta terminar su grupo; se concede tiempo a los pipes heredados y se devuelve 125 si siguen abiertos tras límite.
2. \`captureBoundedOutput\` de #105 se conserva: drena stdout/stderr a la vez; máximo 32.000 B de contenido por canal, más marcador de truncamiento. La API de devolución es texto; binarios no UTF-8 no recuperables byte-exact.
3. \`scripts/f0-c10/t06-r2-process-fixtures.mjs\`: caso de 10 procesos **locales** con marcadores, exit codes 0–9; streams simultáneos de 16 MiB por canal; señales, timeout, cancelación explícita, errores, datos binarios; **dos casos RED deliberados** de escape \`setsid\`.
4. \`.github/workflows/f0-c10-offline.yml\` y \`.github/workflows/ci.yml\`: añaden ejecución de fixture y disparadores de PR hacia rama de integración; no contiene \`deploy\`, no introduce secretos ni permisos de escritura.
5. \`docs/f0-c10/06_LINUX_CONTAINERS.md\`: añade resultados R2 y deja expresos los fallos no resueltos.

**Contrato de entrada:** \`DevContainer.run()\` no abre stdin interactivo. Las rutas auxiliares que sí usan stdin están fuera de esta PR.  
**Contrato de salida:** exitCode refiere a proceso raíz/supervisor, **no al árbol completo**. Código 125 identifica error de supervisión o pipes abiertos, pero no es exclusivo de esa causa.  
**Cancelación RPC:** abortar la llamada remota NO implica que se entregue SIGTERM al supervisor Node; faltan registro durable y protocolo explícito de cancelación/rehidratación.  
**Grupo:** \`process.kill(-pgid)\` alcanza miembros del grupo propio; \`setsid\` separa PGID/SID. No garantiza limpieza de procesos reparentados/daemon double-fork que escapen; tampoco garantiza reaping completo de zombis.  
**Cambio de comportamiento:** comandos que dejaran intencionalmente servidores en background bajo el mismo grupo ahora pierden dichos procesos al salir el root. Es coherente con una herramienta one-shot, pero debe documentarse y probarse en los flujos del agente.

**Riesgos de revisión adicionales** (no demostrados como defectos en Staging):
- Temporización TERM→KILL y reutilización teórica de PID/PGID: la implementación conoce solo el PID inicial. No debe evolucionar a recorridos globales o señales a otros grupos. El ownership real debe probarse con handle/rango gestionado y tareas sintéticas controladas.
- Si \`node\`/GNU \`timeout\` no está disponible, o un signo de señal se traduce distinto en la imagen real, fallará la llamada. Node 24 se documenta en cloudflare/debian-trixie, pero no se confirmó con \`container.exec\` en Staging.
- Los límites de memoria son de la captura del DO, **no** del supervisor Node ni del árbol Linux.
- Un resultado exitoso con \`setsid\` redirigido es un falso negativo de la condición «cero huérfanos».

## 4. Reproducción local INDEPENDIENTE de esta revisión

Fixture original, sin cambio y sin credenciales, ejecutado otra vez en el runtime local disponible:
\`node --experimental-strip-types scripts/f0-c10/t06-r2-process-fixtures.mjs\`, Node v22.16.0, Linux. **Exit code 0** del fixture con estado \`PASS_WITH_KNOWN_GAPS\` (las condiciones RED son contraejemplos intencionales, no capacidad aprobada).
- Nueve casos comprobados; positivos: códigos 7, 23, 19, 0–9, 31, 137, 143; 16.777.216 bytes stdout y stderr de forma simultánea, retención de 32.000 bytes por canal; diez cwd independientes sin cruces observados.
- RED \`setsid\` heredando pipes: \`exitCode=125\`, proceso separado continúa vivo; RED \`setsid\` con pipes redirigidos: \`exitCode=0\`, proceso separado continúa vivo.
- Muestreo del proceso Node del **fixture local**: RSS inicial **54.071.296 bytes**, pico RSS **93.716.480 bytes**, heap inicial/no registrado, no es medición de memoria del Durable Object ni suma de RSS hijos. Se limpian únicamente PIDs del fixture, sin \`killall\` ni pruebas de Containers Cloudflare.
- Resultado local guardado como \`t11_r2_t06_rerun_evidence.json\` en artefactos de esta revisión (no confundir con entrega de una herramienta remota).

## 5. ¿Garantiza Cloudflare la limpieza de \`setsid\` por comando?

**NO** según el contrato público de \`ctx.container.exec()\`. La propia documentación afirma que \`kill()\` señala solo el proceso que \`exec()\` inició; \`exitCode\` puede resolver con hijos vivos; cancelar request no los detiene; \`output()\` aguarda pipes y acumula bytes si se usa indiscriminadamente. El GNU \`timeout\` limpia un grupo pero excluye descendientes que cambian de grupo con \`setsid\`.

Documentos públicos comprobados:
- https://developers.cloudflare.com/containers/guides/execute-commands/ — sección "Stop the processes a command starts": grupo de GNU timeout y excepción \`setsid\`.
- https://developers.cloudflare.com/containers/api/durable-object-container/ — "Process lifetime": kill sólo raíz, abort de RPC no automática; opción \`enable_request_signal\` para llamadas fetch, no para RPC actual.
- https://developers.cloudflare.com/containers/concepts/architecture/ — cada instancia corre en microVM Firecracker con kernel propio, pero apagar VM afecta filesystem/snapshots del proyecto; shutdown envía TERM a proceso principal y SIGKILL si sigue tras 15 min.
- https://developers.cloudflare.com/containers/configuration/scheduling-policy/ — imagen managed Debian Trixie incluye Node 24.20.0; \`instance\` para política \`durable_object\` acepta \`lite\` o \`standard-1\` a \`standard-4\`; documentación advierte expresamente que **\`basic\` no se acepta por runtime**.
- https://developers.cloudflare.com/containers/platform/limits/ — tabla general TODAVÍA enumera \`basic\` 1/4 vCPU, 1 GiB RAM, 4 GB disco, contradiciendo la interfaz anterior. **Conflicto documental efectivo**, no prueba automática de que el deployment existente falla.
- https://developers.cloudflare.com/containers/guides/local-dev/ — el Container desplegado difiere de Docker local, incluso capacidades Unix; no inferir compatibilidad cgroup a partir de pruebas en host.
- https://developers.cloudflare.com/sandbox/sdk/guides/docker-in-docker/ — Docker en sandbox personalizado puede usar cgroupfs y no systemd; ejemplo de **otra imagen/SDK**, no garantía de cgroups escribibles en la imagen managed \`cloudflare/debian-trixie\` de OpenCode.
- https://developers.cloudflare.com/sandbox/commands/run-background-processes/ — patrón explícito de sesiones con \`setsid\`/PGID, no garantía de proceso que se escapa mediante otro \`setsid\`.

**Decisión técnica:** conservar por ahora la supervisión por PGID como mitigación acotada; **no implementar \`cgroup.kill\`, \`unshare\`, \`systemd-run\`, pid scans globales ni \`destroy()\`** en el proyecto compartido. Necesitamos una comprobación de capacidades en un **Container desechable, aislado y autorizado**. La CLI/API de \`DevContainer\` actual no expone ownership de cgroups por comando. En ausencia de cgroup v2 delegado con acceso de escritura, el PGID por sí solo no satisface el criterio de cero huérfanos.

### Preflight propuesto (no ejecutado)

En un Container completamente nuevo y desechable, tras autorización explícita para iniciar esa instancia, bloqueo exclusivo, control de gasto y sin credenciales de producción: ejecutar sólo lecturas con límite temporal:
- \`cat /proc/self/cgroup\` y \`stat -fc %T /sys/fs/cgroup\` para identificar versión y montaje;
- \`cat /proc/self/mountinfo\` filtrando exclusivamente cgroup; \`test -w /sys/fs/cgroup\` (sin escribir) para evaluar el acceso, sin asumir delegación;
- \`id\`, \`node --version\`, \`timeout --version\`, \`cat /proc/1/comm\` y disponibilidad de \`unshare\` (no ejecutar unshare), sin exponer datos privados;
- correlacionar estos resultados con método de arranque \`ctx.container.start\`, tamaño de instancia y versión real; no diagnosticar "cgroup habilitado" solo por un mount.

Solo si se demuestra una jerarquía cgroup v2 **delegada por tarea**, definir contrato de ownership y limpieza que no alcance a servicios ajenos, primero en fixture aislado y luego con verificación externa. Si no es posible, comparar Container desechable **por tarea**, con backup/rollback y coste aprobados; no cambiar por sorpresa las instancias persistentes. En todos los casos mantener journal de cancel/restart (T04) y readback independiente (T10).

## 6. Hallazgo adicional: instancia \`basic\` y compatibilidad

\`src/dev-container.ts\` en #132 contiene \`container.start({ ... instance: "basic" })\` (imagen \`cloudflare/debian-trixie\`). La documentación específica de \`durable_object\` actual dice que \`basic\` NO está aceptada, aunque la tabla de tipos aún lo enumera. **Estado: discrepancia por confirmar con Cloudflare o prueba controlada.** No cambiar de forma especulativa a \`lite\` (menos memoria) ni a \`standard-1\` (más coste) sin preflight, compatibilidad de snapshot y control monetario. Este hallazgo es un **STOP de despliegue** de T11 hasta aclaración formal o evidencia reproducible.

## 7. Gate, coste y decisión

| Gate | Resultado |
| --- | --- |
| Fuente base #126 y delta #132 | **VERIFIED** por SHA, diff y estado draft |
| CI de #132 | **PASS, sólo CI offline** en dos workflows |
| Fixture de esta revisión | **PASS_WITH_KNOWN_GAPS**, 9 casos, sin Staging |
| Cero huérfanos con \`setsid\` | **RED / BLOCKED** |
| Compatibilidad del \`instance:"basic"\` con runtime actual | **UNRESOLVED / STOP despliegue** |
| Binario nuevo en Staging y E2E Linux | **NOT EXECUTED** |
| Diez tareas activas y verificadas | **NOT VERIFIED** |

**Coste:** 0 comandos sobre Containers Staging; 0 operaciones de Remote, 0 inferencias; solo lecturas Cloudflare/GitHub, pruebas locales y CI de PR. Los minutos de CI y coste de plataformas no fueron contabilizados monetariamente. **No se promete presupuesto técnico aplicado.**

**Próxima acción:** revisar diff y CI del HEAD de la PR T11 con la incorporación de este informe. Mantener #132 y PR T11 como candidatos NO MERGED. Con otro lote y autorización específica, verificar tamaño de instancia y capacidades cgroup de Cloudflare en un Container **nuevo aislado**, con costo efectivo y rollback; medir corte real y limpieza de procesos. Una vez validado, T11 decidirá entre (a) ownership OS por tarea probado o (b) aislamiento por Container desechable; no cerrar #90 hasta 3 campañas de diez tareas auténticas con 10/10 salidas comprobadas.
