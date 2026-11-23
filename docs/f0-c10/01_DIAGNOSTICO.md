# F0-C10/T01 — Diagnóstico causal de reinicios por memoria

**Corte:** 2026-11-22 (America/Sao_Paulo); consultas de evidencia realizadas entre 2026-11-22 y 2026-11-23 UTC.  
**Dictamen T01:** **PARTIAL**. Hay reinicios OOM reales, rutas de materialización no acotada demostradas por lectura de código y reproducción sintética RED/GREEN; **no** se identificó el único allocador del lote de 10 ni se ejecutó un GREEN del runtime. **F0-C10 NO COMPLETE PASS**.  
**Actor:** ChatGPT (lecturas GitHub, Cloudflare API/Observability, Remote de solo lectura y pruebas locales Node). **OpenCode Staging no ejecutó ninguna tarea para T01**: no se demostró un lease exclusivo/atómico ni un corte de gasto efectivo. No hubo nueva inferencia, deploy, merge, cambios DO, Access, secretos, Prod ni main.  
**Base código Staging:** rama \`staging/opencode-g1-rpc-safe-20261120\` @ \`11161dd6f2c4b5237a2da59d7275ff693e0afdbe\` (ref GitHub comprobada). La fuente de los binarios activos fue identificada en auditorías previas como \`74632f75db010223cc90d99ba4a801ce0e6414e5\`; **un hash de fuente no demuestra por sí mismo igualdad binaria**.

## 1. Evidencia verificable y versiones

- [Issue #90](https://github.com/aamvtrampa36-del/opencode-harness-example/issues/90), especialmente [incidente del 20/11](https://github.com/aamvtrampa36-del/opencode-harness-example/issues/90#issuecomment-7051733325), [mitigación #94](https://github.com/aamvtrampa36-del/opencode-harness-example/issues/90#issuecomment-7051919668) y [experimento de diez solicitudes, 22/11](https://github.com/aamvtrampa36-del/opencode-harness-example/issues/90#issuecomment-7083567558).
- Cloudflare API **GET** de despliegues/versiones, 2026-11-23 ~00:37 UTC: \`opencode-g1-staging\` versión **#374**, ID \`3546687b-4cd2-4e22-8ea9-ee5ea8fd02cb\`, deployment \`36ef84b3-0f99-4dd4-ab8e-c11ee450dd23\`, tráfico 100%; \`opencode-staging-control-mcp\` versión **#19**, ID \`196240c0-1052-47b3-aaa7-02cf5baa87f0\`, deployment \`9fdaf22d-beeb-44a0-ab68-77ecd5745fa1\`, tráfico 100%. No se atribuye una equivalencia byte a byte con el código del repositorio.
- Cloudflare Observability: consulta **POST de solo lectura** \`/accounts/{account_id}/workers/observability/telemetry/query\` filtrada por \`$metadata.service=opencode-g1-staging\`, ventanas 2026-11-20 20:58–22:15 UTC y 2026-11-22 18:12–18:40 UTC, \`needle=memory\`. Correlación por \`timestamp + traceId + rpcMethod\` para no contar líneas duplicadas como resets distintos. No se publicaron cuerpos de requests, transcripts ni claves.
- Remote de solo lectura: \`staging_status=ok\`, \`ready=true\`, \`schema=opencode.staging-control.v2\`, \`supervisedSessions=96\`, \`supervisedCountComplete=false\` y \`supervisedCountAtLeast=96\`. **No** es inventario total, prueba de 96 activos ni medición de memoria. Diagnósticos remotos reportan incidentes Linux, no atribuyen OOM causal.

## 2. Cronología consolidada

| Hora UTC | Evidencia | Método / alcance | Resultado |
|---|---|---|---|
| 2026-11-20 21:03:40.732 | CF trace \`e85a02859cfc44a288c075d20641c66a\` | \`remoteSupervisorMcpCall\`; versión \`f361f16b\` | \`exceededMemory\` en \`OpenCodeAgent\` |
| 2026-11-20, PR #91 | [PR #91](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/91), merged | \`supervisedTaskStatus\`: sustituye \`history()\` por \`log({after,follow:false})\` y cursor acotado | Mitigación de allocación no acotada; **no** prueba de raíz única |
| 2026-11-20 22:00:54.868 | CF trace \`8d9146c1da5fb05fc03d16fce58468e3\` | \`remoteSupervisorSessions\`; versión \`bb2dc56e\`; alarmas previas ~22:00:50 | Nuevo \`exceededMemory\` en **el mismo DO**; #91 insuficiente |
| 2026-11-20, PR #94 | [PR #94](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/94), merged | \`remoteSupervisorSessions/Status\` usan índice de tareas con límite 101 y lectura de 100 | Probada brevemente con 2 sesiones, no memoria sostenida |
| 2026-11-22 18:18:28.906 | CF trace \`fd73701f5765e82eb3eee882daefd489\` | \`startSupervisedTask\`, versión #374 | \`exceededMemory\` |
| 2026-11-22 18:18:40.222 | CF trace \`4a9a911d62b96e94777a77498279baf0\` | \`startSupervisedTask\` | \`exceededMemory\` |
| 2026-11-22 18:18:52.101 | CF trace \`0a08257bc2819ce974fde9f05a343be9\` | \`startSupervisedTask\` | \`exceededMemory\` |
| 2026-11-22 18:19:04.674 | CF trace \`bf3a7810d08531f9d840ea3ad5d3132c\` | \`startSupervisedTask\` | \`exceededMemory\` |
| 2026-11-22 18:19:15.744 | CF trace \`8fa13a7ad993abee69562d58c99b961d\` | \`startSupervisedTask\` | \`exceededMemory\` |
| 2026-11-22 18:19:29.377 | CF trace \`ecded62eb76d2e50a14689779643dc93\` | \`startSupervisedTask\` | \`exceededMemory\` |
| 2026-11-22 ~18:20–18:23 | CF eventos \`alarm\`, \`supervisedTaskStatus\` y \`remoteSupervisorSessions\`, mismo DO | Muchas invocaciones posteriores con \`outcome=ok\` | Se recuperaron respuestas parciales, **no** las diez tareas |
| 2026-11-22 ~18:20 | [matriz de diez IDs](https://github.com/aamvtrampa36-del/opencode-harness-example/issues/90#issuecomment-7083567558) | \`a642be2611220001\`…\`000a\` | **0/10 verificadas**, 4 \`failed\`, 2 \`unknown/not_found\`, 4 \`cancelled\`; seis errores de inicio OOM |

**DO ID común de los eventos:** \`4ed9d1d2f6d3b9c0da23b0b4986af0cb42b9638797470e49466fdef3ba34243c\`, clase \`OpenCodeAgent\`. Las seis trazas del 22/11 son independientes; las líneas \`cf-worker\` y \`cf-worker-event\` duplicadas por timestamp/trace **no** son resets adicionales. Las llamadas de inicio se solaparon en el cliente; no hay evidencia de diez motores de inferencia simultáneos. La matriz posterior señala \`Continuing after restart\`, pero no se leyeron transcripts completos.

La traza agregada de cada reset del 22/11 contiene \`startSupervisedTask\` junto con algunos de: \`remoteSupervisorSessions\`, \`getAllowedRepositories\`, \`getGitHubKey\`, \`getOpenRouterKey\`, \`getRemoteMcps\`, \`connectorSettings\` y hooks. **El RPC que recibe la excepción es el lugar de manifestación, no necesariamente el allocador previo.** \`alarm\` y lecturas de status coexistían en el mismo DO en la ventana consultada; no se ha demostrado qué parte de la memoria mantenían.

## 3. Inspección del código y mecanismos

1. **Historial completo antes del recorte — defecto concreto.** En fuente base \`src/server.ts\`, \`remoteSupervisorInspectSession\` ~líneas 311–326 invoca \`this.harness.sessions.list()\`, \`this.harness.session(id).history()\`, \`renderConversationMarkdown(...)\` y **solo después** \`markdown.slice(-12_000)\`. \`supervisedTaskTranscript\` ~579–583 llama a \`exportSessionData\`, que usa \`sessions.list()\`, \`history()\` y \`JSON.stringify\` (~652–662). El MCP activo tiene \`jsonText\` que primero ejecuta \`safeValue(value)\` y \`JSON.stringify(safe)\` **antes** de limitar a \`maxChars\` (\`src/staging-control-mcp/server.ts\` ~96–148). Esta combinación puede multiplicar retención/serialización y anula el valor de una salida pequeña como control del heap. No prueba que esos métodos hayan sido invocados durante los seis starts.
2. **Rutas de status/listado ya mitigadas.** \`supervisedTaskStatus\` usa \`foldSupervisorToolLog(...,256)\` con cursor guardado; \`remoteSupervisorSessions\` lee hasta 101 registros y \`collectSupervisorDirectory(...,100,4)\`. Por tanto, no es válido seguir atribuyendo las seis OOM de #374 directamente a la enumeración antigua de #94. Estas rutas todavía pueden provocar inicialización o cargar estados internos del SDK al consultar \`busy()\`, cuestión sin perfil.
3. **Inicio sin un límite global de memoria/diez ejecutores.** \`startSupervisedTask\` usa una reserva transaccional y \`withSupervisorStartLock\` **por requestId**; \`advanceSupervisedTask\` crea/forkea una sesión, establece agente/modelo y llama a \`submit(...,whenBusy:"followUp")\`. Un lock **por ID** evita duplicación del mismo ID, pero no constituye límite global de memoria/residencia para diez IDs distintos. Hay un límite de respuesta para consultas de sesiones, no un gate demostrado de memoria para \`sessions.create()\`, \`setModel()\`, \`submit()\` y recuperación. El efecto cuantitativo por sesión sigue desconocido; **T03** es dueño de la admisión, **T02** de la residencia/partición.
4. **Referencias perdidas tras reinicio.** El código persiste \`job.operationId\` antes de \`submit()\` y conserva \`unknown\` al fallar el RPC; en el lote dos IDs terminaron \`not_found\`. Es un problema observable de reconciliación, pero no prueba corrupción de SQLite ni pérdida de datos GitHub. **T04** tiene la reparación principal.
5. **Rutas adicionales de historia.** En \`src/server.ts\` aparecen \`history()\` en exportación, subagentes, autotests y G9. Algunas son rutas internas de prueba, no atribuidas al lote. No ejecutar tests que accedan a sesiones históricas ni copiar su contenido. La salida shell fue acotada históricamente en #105, pero no se descarta presión de Container o RPC sin métrica de bytes.
6. **Diferencias del candidato.** La [PR #106](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/106) (\`19bba24d81be5b0673acbf2a56b500aed4fa0b66\`) devuelve \`SUPERVISOR_TRANSCRIPT_UNAVAILABLE_UNBOUNDED\` **antes** de cargar \`history()\` en inspect/transcript, con cobertura mock. Está **draft, no merge, no deploy**. Las [PR #108](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/108), [#109](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/109), [#110](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/110), [#111](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/111), [#112](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/112), [#113](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/113) están **draft**, con auditorías/artefactos/preflight. Ninguna certifica este cambio en runtime. **No duplicar el hunk de #106**.

## 4. Hipótesis: aceptadas, descartadas y abiertas

| ID | Dictamen | Evidencia/limitación |
|---|---|---|
| H1 — materialización y serialización no acotadas | **ACEPTADA como vulnerabilidad de código**, no como causa exclusiva del lote | \`history()\`, \`sessions.list()\`, \`JSON.stringify()\` antes de \`slice\`; RED sintético y PR #106 |
| H2 — incremento de residencia de SDK/Harness por sesión, hot isolate compartido | **ABIERTA, prioritaria** | Mismo DO y seis starts OOM; sin muestras por etapa/objeto ni baseline V8 real |
| H3 — reinicios y estado operación↔sesión parcial | **ACEPTADA como fallo funcional observado**, causalidad de memoria no demostrada | Dos \`unknown/not_found\` y otras respuestas de inicio ambiguas |
| H4 — falta de presupuesto global de memoria/admisión | **ABIERTA, respaldada por inspección estructural** | Lock por requestId ≠ límite global; no hay benchmark de activos reales |
| H5 — stdout/stderr/transcript de tools | **PARCIAL** | #105 acotó salida shell; aún quedan rutas de historia y respuestas grandes |
| H6 — límites/rate limits del proveedor como causa primaria | **NO DEMOSTRADA** | La causa del reset sí es \`exceededMemory\`; proveedor/timeout podrían contribuir al churn, sin medición |
| H8 — candidato #106 activo en Staging | **DESCARTADA** | Deployments activos #374/#19, auditorías de diferencia binaria; candidato no desplegado |

**Regla:** ningún método señalado como último RPC se declara allocador responsable sin correlación de memoria antes/después de su fase. El límite oficial es **128 MB por isolate**, no una cuota de 128 MB por cada DO; varios DO/clases pueden compartir isolate. El filtro por DO ID en las métricas **sigue midiendo el isolate completo**.

## 5. Reproducción local RED/GREEN (sin DO ni secrets)

Fixture **sintético**, no histórico. Entorno real de ejecución: **Node v22.16.0**, \`--expose-gc --max-old-space-size=256\`, contenedor local de la investigación. Se generaron 20.000 eventos ficticios de 2.048 caracteres de payload más identificador. Salida visible limitada a 12.000 caracteres en ambos modos. RED modela \`history()→JSON.stringify()→slice()\`; GREEN modela log incremental desde un cursor reciente, máximo 128 eventos y tail acotada. No exige reproducir 20.000 eventos en la plataforma ni alojar secretos.

Reproducir con un archivo temporal \`memory-fixture.mjs\` (no añadirlo a otras carpetas del repo):

\`\`\`js
import assert from "node:assert/strict";
const N=20000, CHARS=2048, CAP=128, OUT=12000;
const payload="A".repeat(CHARS);
const record=i=>({seq:i+1,role:"tool",response:i.toString(36).padStart(8,"0")+":"+payload});
global.gc?.();
const before=process.memoryUsage().heapUsed;
if(process.argv[2]==="old"){
  const history=Array.from({length:N},(_,i)=>record(i));
  const full=JSON.stringify(history);
  const delta=process.memoryUsage().heapUsed-before;
  assert.equal(full.slice(-OUT).length,OUT);
  console.log(JSON.stringify({mode:"old",deltaBytes:delta,processed:N,fullChars:full.length}));
  console.error("RED: materialización completa antes de recortar");
  process.exitCode=1;
}else{
  let tail="",processed=0;
  async function* log(after){for(let i=after;i<N;i++)yield record(i);}
  for await(const e of log(N-CAP)){
    if(processed>=CAP)break;
    processed++;tail=(tail+JSON.stringify(e)).slice(-OUT);
  }
  const delta=process.memoryUsage().heapUsed-before;
  assert.equal(processed,CAP);
  assert.equal(tail.length,OUT);
  console.log(JSON.stringify({mode:"safe",deltaBytes:delta,processed,outputChars:tail.length}));
  console.error("GREEN: cursor + iteración/tail acotados");
}
\`\`\`

Comandos de prueba:

\`\`\`sh
node --expose-gc --max-old-space-size=256 memory-fixture.mjs old   # RED: exitCode 1 esperado
node --expose-gc --max-old-space-size=256 memory-fixture.mjs safe  # GREEN: exitCode 0
\`\`\`

Resultados **observados**, una corrida, no benchmark estadístico:

| Modalidad | Heap inicial | Heap pico/observado | Delta heap | Salida | Exit |
|---|---:|---:|---:|---:|---:|
| RED, materializa+serializa 20k | 4.006.184 B | 89.452.016 B | **85.445.832 B** | 12.000 chars | **1** intencional |
| GREEN, log+cursor 128 | 4.006.632 B | 4.448.328 B | **441.696 B** | 12.000 chars | **0** |

Son mediciones del **heap V8 de Node en fixture**, NO memoria de Cloudflare, RSS del Worker ni equivalencia semántica completa de Markdown. RED sale 1 deliberadamente para registrar el incumplimiento del invariante. El fixture demuestra que **recortar la respuesta después de materializarla no acota el pico de heap**. No demuestra cuántas sesiones reales provocan 128 MB, ni autoriza convertir el fixture en E2E.

## 6. Corrección focalizada y diff propuesto

**Cambio implementado por este encargo:** **solo este informe Markdown**; no se modifica código de producción ni se duplica #106. La corrección de seguridad **ya propuesta y probada de forma mock** en #106 es devolver un error temprano para endpoints transcript/inspect mientras no exista API byte-bounded. En vez de \`const history=await handle.history(); return render(...).slice(-12000)\`, usar **en el límite DO** una denegación prelectura \`throw Error("SUPERVISOR_TRANSCRIPT_UNAVAILABLE_UNBOUNDED")\`. Su despliegue exige reconciliar los dos Workers, consentimiento posterior y prueba de funcionalidad; se sacrifica el extracto, explícitamente, para no agotar memoria. El camino futuro seguro es una API propia de eventos paginados/cursor con presupuesto de **bytes y número de eventos**, redacción antes de emitir y garantía de no cargar \`history()\` completo. **T05** posee el contrato Remote/MCP; no introducir una reconstrucción parcial como equivalente al transcript completo.

**Instrumentación mínima propuesta para futuro lote (no implementada):** capturar sin contenido sensible, por invocación/etapa, \`traceId\`, DO ID, versionId, \`requestId\` del supervisor si está disponible de forma segura, fase (\`preflight\`, \`branch\`, \`session.create/fork\`, \`setAgent\`, \`setModel\`, \`submit\`, \`wait\`, \`alarm\`, \`recovery\`, \`status\`), duración, conteo de sesiones residentes, contador de eventos/bytes procesados, excepciones y cuantiles de memoria de isolate vía GraphQL. Nunca emitir secretos, history, prompts ni herramientas. Si no hay medición de heap accesible en el runtime, declararlo y no inventarlo.

**Diff neto de la rama T01:** \`+ docs/f0-c10/01_DIAGNOSTICO.md\` solamente. No tocar informes T02–T10 ni \`00_COORDINACION.md\`. Combinación futura con #106 o PR de T05 requiere revisar HEAD y cambios superpuestos antes de integrar.

## 7. Cloudflare, métricas y límites de atribución

Fuentes oficiales:

- [Workers limits — memory](https://developers.cloudflare.com/workers/platform/limits/#memory): 128 MB por isolate; solicitudes concurrentes comparten memoria.
- [Durable Objects — metrics](https://developers.cloudflare.com/durable-objects/observability/metrics-and-analytics/#memory-usage): memoria **del isolate**, no del DO solo; cuantiles P50/P90/P99/P999. Dataset GraphQL \`durableObjectsPeriodicGroups\`, \`quantiles.memoryUsageBytesP50…P999\`.
- [Cloudflare memory usage release 2026-06-30](https://developers.cloudflare.com/changelog/post/2026-06-30-memory-usage-metrics/): baseline, tendencia y deployment markers.
- [Durable Object lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/): estado de heap efímero frente a storage durable.

**Muestras cuantitativas de V8 de Staging antes/después: NO OBTENIDAS.** La conexión permitió leer eventos \`exceededMemory\`, métodos, trazas, versiones y deploys; no se obtuvo una serie GraphQL de memoria de isolate con muestras per-etapa ni un deploy corregido. No usar las cifras Node anteriores como benchmark de Staging. No se hicieron heap dumps (riesgo de secretos), ni lecturas de transcripts completos. Un filtro de métricas por DO no aísla los otros DO que cohabitan su isolate.

## 8. Comparación con implementaciones abiertas (sin copiar código)

Referencias **pinneadas por commit** y licencia verificada directamente en \`LICENSE\` de cada repo:

- [cloudflare/agents @ f070719721ec25d95bf46ba1884699b3f151db55](https://github.com/cloudflare/agents/tree/f070719721ec25d95bf46ba1884699b3f151db55), [fuente \`packages/agents/src/index.ts\`](https://github.com/cloudflare/agents/blob/f070719721ec25d95bf46ba1884699b3f151db55/packages/agents/src/index.ts), **MIT**. Patrón útil: estado durable separado de memoria efímera y runtime DO; no ofrece garantía automática de diez agentes en 128 MB.
- [OpenHands/software-agent-sdk @ ebec01b3893696c2f5454762eb44796c71bb391a](https://github.com/OpenHands/software-agent-sdk/tree/ebec01b3893696c2f5454762eb44796c71bb391a), [\`conversation/state.py\`](https://github.com/OpenHands/software-agent-sdk/blob/ebec01b3893696c2f5454762eb44796c71bb391a/openhands-sdk/openhands/sdk/conversation/state.py), **MIT**. \`EventLog\` con vista reconstruida/caché incremental muestra beneficio de separar eventos persistentes de proyecciones; también advierte sobre costes al reconstruir estado histórico. No es código trasplantable sin adaptar SDK.
- [SWE-agent @ 3ea751c087f32b16e039a2233dd6eefecef325d5](https://github.com/SWE-agent/SWE-agent/tree/3ea751c087f32b16e039a2233dd6eefecef325d5), [\`history_processors.py\`](https://github.com/SWE-agent/SWE-agent/blob/3ea751c087f32b16e039a2233dd6eefecef325d5/sweagent/agent/history_processors.py), **MIT**. \`LastNObservations\` elimina observaciones antiguas **del contexto que se envía**; la truncación lógica de contexto **no es**, sin evidencia, una cota del heap de un export previo.
  
**No se incorporó ni copió código de estos proyectos.** Son patrones comparables, no soluciones probadas para el isolate de OpenCode.

## 9. Coste, pruebas, riesgos y continuación

- **Reales:** tres consultas acotadas de Observability más lecturas adicionales correlacionadas (sin exportar cuerpos), lecturas GET de Cloudflare/GitHub/Remote, dos ejecuciones Node. Sin llamadas nuevas de inferencia ni Containers de Staging. CPU/bytes de consulta Observability y facturación granular **no verificadas**; no afirmar coste monetario cero. No hubo heap profiling de producción ni carga masiva. Benchmark Node local: salida de proceso RED \`1\`, GREEN \`0\`.
- **Pruebas de aplicación/CI:** no hubo modificación de código de aplicación en esta rama ni \`bun test\`/typecheck/build de la app. La PR #106 incluye sus propias pruebas y CI históricos; **no** se transfieren al HEAD de este informe. No se solicitó una operación de OpenCode, pues no hay reserva atómica, control real de gasto ni preflight seguro verificados. Esto es un bloqueo operativo, no permiso para ejecutar \`staging_agent_check\` como sustituto.
- **Riesgos:** 128 MB por isolate compartido, materialización accidental antes de truncar, serialización con copias transitorias, warm state no acotado, reintentos tras respuesta ambigua, lecturas status que ejecutan trabajo adicional, backlog de logs de progreso, falsos 10/10 por busy sin progreso. **No exponer** estado persistente ni bajar permisos para lograr PASS.
- **Handoff a T02:** medir en entornos sintéticos residencia por SDK/session y composición de DO del isolate; no asumir que cada shard obtiene 128 MB. **A T03:** admisión global y control de presión; preservar diez activos como meta final, no confundir cola con simultaneidad. **A T04:** reconstruir requestId→operationId y \`not_found\` en tests de reset. **A T05:** denegar history/export sin límite y diseñar cursor/byte-budget seguro; revisar #106. **A T10:** no repetir prueba real 1→2→4→10 hasta lease, presupuesto, cambios autorizados y métricas por versión.
- **Próxima acción útil sin nuevo despliegue:** auditar PR #106 con pruebas de paths de historial y habilitar un perfil/replay *offline* con objetos SDK sintéticos que mida picos por \`session.create()\`/start/recovery, antes de plantear la integración Stage. Para validar la causa exclusiva faltan percentiles de isolate y spans de fase en un candidato desplegado por **otro lote**.

**Resultado final T01: PARTIAL** — mecanismo de materialización no acotada demostrado y mitigación candidata identificada; causalidad exclusiva del OOM de diez solicitudes, efectividad del fix en Cloudflare y simultaneidad diez activos **NO VERIFICADAS**.
