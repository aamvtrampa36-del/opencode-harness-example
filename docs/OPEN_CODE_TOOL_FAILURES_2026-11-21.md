# OpenCode Cloud: incidentes del runner, errores observados y mitigaciones locales

> **Nota de recuperación, 2026-11-24 — SANEAMIENTO-01.** El informe original de la PR [#104](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/104) (SHA `600d928b99e85dbfac43f34ebfd6756ed22453a1`) se conserva debajo como evidencia histórica, incluidas sus afirmaciones sobre el checkout local del día 21. No describe automáticamente el estado del runtime actual. Véase [reconciliación de mantenimiento](maintenance/SANEAMIENTO_01.md) y la actualización al final.

**Fecha del informe:** 2026-11-21  
**Repositorio documentado:** aamvtrampa36-del/opencode-harness-example  
**Propósito:** conservar los errores observados en tareas recientes de OpenCode Cloud, separar evidencia de hipótesis y registrar las mitigaciones hechas en el checkout local.  
**Estado:** informe documental; los cambios de código descritos todavía no están integrados ni desplegados.

## Resumen

En tareas recientes se observó un runtime asumido que no estaba instalado, comandos de inspección demasiado amplios, interrupciones del runner y un reinicio del Durable Object por límite de memoria. Además, varias tareas remotas de código terminaron sin archivos ni commits revisables. El diagnóstico de agente Linux sí pasó en una ejecución aislada.

La causa de memoria más concreta en el código del runner era que Linux ejecutaba process.output(), que acumula stdout y stderr antes de que el código aplicara el límite de tamaño. La documentación de Cloudflare indica que output() almacena ambos streams y recomienda consumirlos concurrentemente cuando la salida puede ser grande: https://developers.cloudflare.com/containers/guides/execute-commands/.

Se hicieron mitigaciones locales: drenar los streams durante la ejecución con memoria acotada, conservar el inicio y el final de la salida, reportar los bytes omitidos, limitar cada stream a 16 KiB, imponer un cierre forzado cinco segundos después de TERM y mejorar las instrucciones de uso de herramientas. La prueba local de la función de captura pasó. No se desplegó ni se validó contra el Durable Object remoto; por tanto, la mitigación de memoria no equivale a una reparación E2E confirmada.

## 1. Hallazgos observados

| ID | Hallazgo | Evidencia disponible | Clasificación |
|---|---|---|---|
| OC-RUN-01 | Una tarea ejecutó python3 y recibió command not found, con código 127. | Transcript de la tarea OpenCode/Linux. | Observado; error de selección de runtime. |
| OC-RUN-02 | Se usaron listados recursivos, búsquedas globales y lecturas grandes cuando bastaban búsquedas por símbolo y rangos pequeños. | Transcripts revisados en la campaña. | Observado; causa de volumen, latencia y consumo de contexto. |
| OC-RUN-03 | Hubo Tool execution interrupted y reinicios de sesión durante tareas. | Eventos y estados de tareas remotas. | Observado; causa raíz no determinada. |
| OC-RUN-04 | Un Durable Object informó que su isolate excedió el límite de memoria y se reinició. | Diagnóstico remoto de una continuación. | Observado; causa específica de ese reinicio no demostrada. |
| OC-RUN-05 | Las tareas remotas de código acabaron fallidas o canceladas; las revisiones de sus ramas mostraron totalCommits=0 y files=[]. | Revisiones de ramas asociadas a esas tareas. | Observado; no hubo cambio remoto revisable. |
| OC-RUN-06 | Un agent_check Linux pasó en una ejecución aislada, con una llamada a herramienta y archivo verificado. | Resultado de staging recogido en el informe de pruebas anterior. | Observado; acredita esa prueba, no todas las tareas o entornos. |
| OC-RUN-07 | Se sospechó que un ID de tarea no coincidía con su rama. | La comprobación posterior mostró que los campos branch y project sí coincidían. | Sospecha descartada; no registrar como defecto confirmado. |

La imagen base documentada por este proyecto ofrece Debian, Bash y Node.js 24. Python y Bun no están garantizados. El código 127 no prueba que el contenedor esté defectuoso; prueba que la tarea asumió una herramienta no disponible.

## 2. Causa de memoria: qué está demostrado y qué no

### Hecho del código inspeccionado

El runner Linux llamaba a process.output(), decodificaba stdout y stderr completos y solo después aplicaba MAX_SHELL_OUTPUT. Ese orden no limita la memoria ocupada durante la lectura.

### Inferencia respaldada

Una salida de comando grande puede elevar el uso de memoria del isolate porque ambas salidas quedan acumuladas allí. Esto concuerda con el reinicio observado y es una causa de riesgo real que el código permitía.

### Pendiente de probar

No hay una reproducción remota que demuestre que la salida de una tarea concreta provocó el reinicio observado. También pueden intervenir el historial de sesión, continuaciones extensas, concurrencia o límites internos de la infraestructura. La corrección local reduce esa ruta de consumo, pero su efecto sobre el incidente remoto sigue sin medirse.

## 3. Cambios locales preparados

En el checkout local de opencode-harness-example se modificaron estos puntos:

- Se añadió src/bounded-process-output.ts. Consume un ReadableStream por vez y conserva un búfer pequeño con el inicio y el final, contando los bytes descartados.
- En src/dev-container.ts, la ejecución Linux ahora drena stdout y stderr concurrentemente y espera el código de salida del proceso. El recorte sucede durante la lectura, no después de acumular toda la salida.
- Si una salida supera el límite, su texto incluye un marcador con los bytes omitidos y señala que se conservaron inicio y final.
- src/dev-guard.ts reduce MAX_SHELL_OUTPUT de 32.000 a 16.384 bytes por stream.
- Se añadió --kill-after=5s al timeout de comandos Linux y al bootstrap de Git. GNU timeout enviará TERM al alcanzar el límite y KILL cinco segundos después si el proceso sigue vivo.
- src/workspace.ts incluye pautas para consultas acotadas, recuperación tras interrupciones, verificación de runtimes y rechazo de reintentos ciegos.
- Se añadieron pruebas de la captura acotada, del texto de instrucciones y del nuevo límite.

El checkout en que se aplicaron estos hunks estaba en la rama local fix/project-container-isolation-20261111, HEAD f716041. El árbol ya contenía cambios locales ajenos a esta corrección; se conservaron. No se mezclaron ni se atribuyeron esos otros cambios a este informe. Los cambios de código descritos no se enviaron a GitHub ni se desplegaron.

## 4. Verificación local

Comprobaciones realizadas en el entorno local disponible:

- Siete comprobaciones focalizadas de captura: salida menor al límite, truncamiento, conservación de inicio y final, marcador de bytes omitidos, stream nulo, límite cero y drenaje de una salida de 16 MiB conservando solo 128 bytes.
- La prueba local del timeout aceptó la opción --kill-after y cerró con código 137 un proceso de prueba que ignoraba TERM.
- node --experimental-strip-types --check pasó para los archivos TypeScript modificados y añadidos.
- git diff --check pasó.

Límites de estas pruebas:

- Bun no estaba instalado y el checkout no tenía node_modules.
- No se ejecutó la suite completa, el typecheck ni Wrangler.
- No se probó el código dentro de un Worker/DO desplegado.
- No se midieron memoria real, latencia, tokens ni ahorro. La reducción del buffer retenido se conoce por el límite implementado; el ahorro global no se ha medido.

## 5. Reglas de operación incorporadas

1. Leer primero estado, ruta pertinente y contrato; evitar ls recursivo, grep global y lectura completa de archivos grandes sin una razón concreta.
2. Comprobar una vez los runtimes disponibles. Usar Node.js y las dependencias del proyecto cuando estén disponibles; no asumir Python/Bun ni instalarlos por reflejo.
3. Dividir comandos largos en pasos pequeños y reanudables. Preferir consultas por símbolo y rangos de líneas.
4. Cuando una respuesta indique truncamiento, pedir un rango o una búsqueda más estrechos; no repetir la misma consulta.
5. Tras una interrupción, revisar transcript, estado durable y trabajo ya completado antes de reintentar una operación.
6. Mantener una sola ejecución pesada por proyecto cuando el isolate y el contenedor compartan recursos.
7. Tratar un código de salida real, un archivo revisable y un readback como evidencia. El texto del agente no reemplaza el resultado de la herramienta.

## 6. Separación de atribución

Los errores de voz, focalización y causalidad del borrador narrativo de C34 pertenecen a la producción narrativa del asistente en ese flujo; no hay evidencia para atribuirlos al código de OpenCode. El acceso previo a Drive en otra etapa tampoco se atribuye a OpenCode por defecto. Este documento registra el incidente del runner y las mitigaciones de su código, no el canon ni la prosa de CDF.

No se incluye contenido argumental ni prosa inédita de CDF en este informe.

## 7. Pendientes para cerrar la incidencia

- Ejecutar la suite y el typecheck en un entorno con dependencias bloqueadas y compatibles.
- Revisar el diff de código aislado antes de incorporarlo; el árbol local contiene cambios preexistentes y este informe no los aprueba.
- Reproducir stdout/stderr grandes, concurrentes y sostenidos en el entorno Worker/DO que se pretende usar, y confirmar que el proceso se drena, el código de salida se conserva y la memoria permanece dentro del límite.
- Correlacionar los próximos eventos de interrupción y memoria con task ID, session ID, versión del Worker, código de comando, duración, bytes emitidos y estado de continuación. No registrar secretos.
- Verificar si los eventos Tool execution interrupted proceden del proveedor, del Durable Object, del proceso Linux o del cliente antes de cambiar reintentos.
- Revisar la issue #90 mencionada por la guía operativa actual del repositorio cuando se continúe el diagnóstico de reinicios. No asumir que este informe cierra esa incidencia.
- No declarar mejora de latencia o reducción de tokens sin una comparación antes/después con la misma carga.

## Estado documental

Este archivo documenta observaciones, una inferencia causal respaldada por el código y cambios locales verificados de forma limitada. La corrección está preparada localmente; no está integrada, desplegada ni validada en vivo.

## Actualización del 24 de noviembre de 2026 — fuente y límites

En la rama Staging configurada `staging/opencode-g1-rpc-safe-20261120`, SHA `11161dd6f2c4b5237a2da59d7275ff693e0afdbe`, se verificaron directamente `src/bounded-process-output.ts` y `src/dev-container.ts`: stdout/stderr se drenan concurrentemente mediante búfer acotado y se conserva exitCode. El límite del código de esa fuente es 32.000 bytes por stream (`src/dev-guard.ts`), no 16 KiB; el wrapper usa TERM a los 180 s, sin que se observe allí el --kill-after=5s descrito en el informe local original. No extrapolar la configuración local. La [CI histórica 44983062854](https://github.com/aamvtrampa36-del/opencode-harness-example/actions/runs/44983062854) concluyó success para ese SHA con Bun, preview, typecheck, build e invariantes. El historial de Builds registra también un build exitoso de esa rama y SHA. Esto acredita la fuente histórica, no la versión activa del 24.

La consulta `supervisedTaskStatus` de esa base usa un cursor incremental de métricas durable, con límite de 256 eventos por lectura y conteos desconocidos explícitos; la salida del estado incluye el error reconciliado. Esto reduce una ruta de retención de historial, pero no prueba la causalidad del OOM. Las guardas de MCP para workspace y sourceSession se encuentran antes de resolver el supervisor; hay evidencia original recuperada de [#80](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/80). En F0-C10 hay candidatos de recuperación y límites adicionales, incluyendo [#105](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/105), [#106](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/106), [#121](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/121), [#140](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/140) y [#163](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/163). Son referencias históricas y candidatas; no se importan ni se certifica su publicación por este mantenimiento.

El issue [#90](https://github.com/aamvtrampa36-del/opencode-harness-example/issues/90) continúa abierto. No se declara causa raíz confirmada, reparación integral, ahorro de memoria/tokens medido ni PASS en vivo. STOP_LIVE permanece vigente. Los dos últimos Builds registrados corresponden al SHA histórico `74632f75db010223cc90d99ba4a801ce0e6414e5`, mientras las versiones activas del 24 fueron cargadas por API; no se ha probado su vínculo con Git. No se desplegará desde una base más antigua por este documento.
