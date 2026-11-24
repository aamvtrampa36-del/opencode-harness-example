# F0-C10 — Plan integral de concurrencia estable y depuración paralela

**Proyecto:** OpenCode Cloud — Desarrollo y Autonomía  
**Preparado:** 22 de noviembre de 2026 (America/Sao_Paulo)  
**Actualización R2:** 22 de noviembre de 2026; ver PARTE II, apartados 22–31.
**Actualización R3:** 23 de noviembre de 2026; ver PARTE III, apartados 32–39, que prevalece para el estado posterior a PR #145  
**Estado del documento (histórico R2):** plan operativo actualizado para segunda ronda; **PR #126 candidata con CI verde, sin despliegue; F0-C10 PARTIAL, no autoriza por sí sola acciones**  
**Repositorio:** https://github.com/aamvtrampa36-del/opencode-harness-example  
**Issue de referencia:** https://github.com/aamvtrampa36-del/opencode-harness-example/issues/90

## 1. Misión, alcance y resultado útil

F0-C10 busca demostrar **diez tareas distintas con ejecución verdaderamente solapada y resultados individuales verificables** en `opencode-g1-staging`, bajo control de `opencode-staging-control-mcp`. Incluye memoria, recuperación, idempotencia, aislamiento, Linux, inferencia, GitHub, progreso y entrega de archivos cuando se soliciten. Pertenece a Fase 0; no sustituye G0 histórico de PR/CI ni las fases de orquestación #66/#65. Para decidir cerrar F0-C10 se exige evidencia de runtime + código SHA + prueba repetida, no cantidad de PR.

**No objetivos:** diez usuarios empresariales; garantías de disponibilidad universal; auto-merge; publicar Producción; sustituir Harness/SDK; desplegar nuevos servicios por defecto; crear Codex paralelo; construir un observability stack nuevo; multiplicar tareas pagadas antes de resolver el problema actual.

**Definiciones operativas:** recibido ≠ admitido; admitido ≠ persistido; en cola ≠ ejecutando; `busy=true` aislado ≠ progreso efectivo; `finished` ≠ éxito; PR/CI verde ≠ runtime E2E. Se debe observar una ventana temporal donde **diez tareas distintas tengan actividad efectiva concurrente** (inferencia/herramientas y progreso correlacionado, no solo llamadas HTTP de inicio), y después diez resultados recuperables. Una cola de diez con solo 2–4 activos es una protección intermedia, NO `COMPLETE PASS`.

## 2. Bases y jerarquía de fuentes

Documentación del proyecto consultada (corte **19-11-2026**): `00_ESTADO_Y_FUENTES.md`, `01_PRODUCTO_Y_ARQUITECTURA.md`, `02_PLAN_EJECUTIVO.md`, `03_OPERACION_Y_PERMISOS.md`, `04_PRUEBAS_COSTES_Y_RIESGOS.md`, `05_INICIO_FASE_0.md`. El archivo `CONOCIMIENTO_UNIFICADO.md`, cuando esté presente, es una consolidación, no prueba independiente; evitar cargar duplicados. Esos archivos documentan Linux/Bun y PR históricas, los permisos por lote, CI y el objetivo general de Fase 0. **Se han actualizado las premisas de estabilidad y simultaneidad en este plan; no se editó el canon anterior.**

1. **GitHub** = código, HEAD, branches, commits, issues, PR, CI, artefactos y registro del trabajo. Revalidar exact HEAD antes de integrar.
2. **Cloudflare** = versiones, bindings, DO/Containers y telemetría efectivamente observada, no E2E completo por sí mismo.
3. **OpenCode Remote** = eventos y ejecución realmente delegada al agente Stage, pero `Remote` en ChatGPT no prueba conexión Prod→Stage.
4. **Fuentes públicas externas** = patrones y restricciones; licencias revisadas antes de adaptar código.
5. **Documentos del proyecto** = decisiones y continuidad fechadas, nunca estados volátiles garantizados.

## 3. Estado inicial y evidencia histórica, no aceptación

- Issue [#90](https://github.com/aamvtrampa36-del/opencode-harness-example/issues/90) **abierto** en consulta de GitHub del 22-11-2026. El ensayo de diez solicitudes del mismo día ([registro](https://github.com/aamvtrampa36-del/opencode-harness-example/issues/90#issuecomment-7083567558)) produjo **0/10 tareas completadas y verificadas**, seis respuestas de inicio con OOM, dos operaciones `not_found`, cuatro solicitudes `preparing` canceladas y otras ejecuciones fallidas. La simultaneidad de diez tareas activas **no quedó demostrada**: fueron concurrentes las solicitudes de inicio.
- [PR #91](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/91) y [PR #94](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/94): mitigaciones históricas integradas de lecturas y enumeración no acotadas; no certifican el cierre del OOM.
- [PR #100](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/100): visualización de partes `file` seguras integrada en Staging. Rutas textuales `/bundle/...` **no** equivalen a descargas.
- [PR #102](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/102): proyección diagnóstica acotada con `taskId`; [#103](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/103): corrección REST de commit tree; [#105](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/105): drenar stdout/stderr con memoria acotada, integrado en Staging según su registro aunque PR a main permanezca draft. Revalidar versión en cada caso.
- [PR #106](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/106): contención de lecturas peligrosas del transcript, candidata **no desplegada**, con rutas restantes fuera de alcance.
- [PR #107](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/107) y [#109](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/109): build y transferencia de binarios originales verificables, dry-run sin carga real.
- Auditorías [#108](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/108), [#110](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/110), [#111](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/111), [#112](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/112) y [#113](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/113): procedencia, compatibilidad, binarios y preflight; **no reemplazan validación real de diez tareas**.
- Último snapshot **documentado** en #113 (no revalidado directamente contra Cloudflare para este archivo): Worker principal #374 `3546687b-4cd2-4e22-8ea9-ee5ea8fd02cb`, MCP #19 `196240c0-1052-47b3-aaa7-02cf5baa87f0`, ambos de fuente `74632f75db010223cc90d99ba4a801ce0e6414e5`; candidato #106 de fuente `19bba24d81be5b0673acbf2a56b500aed4fa0b66`. **No asumir que el candidato está activo.**
- #113 declara **bloqueada una carga real**: credencial CI y alcance no comprobados, presupuesto/corte no garantizado y side effects de assets/Workflows/Containers/DO sin certificar. Artefactos candidatos históricos expiran alrededor del 29-11-2026; verificar antes de usarlos.

**Conclusión:** `F0-C10 = NOT VERIFIED`; `F0-OOM-02 = BLOCKED / NO COMPLETE PASS` para promoción. Preparar investigación/PR no implica autorización para fusionar o desplegar.

## 4. Topología y límites físicos relevantes

Camino lógico actualmente descrito: ChatGPT/cliente → MCP Remote autenticado → Worker principal `opencode-g1-staging` → Durable Object `OpenCodeAgent`/supervisor → Harness/SDK, sesiones y tareas → `DevContainer`/Containers, GitHub bridge e inferencia (Workers AI u otros proveedores autorizados). Workers auxiliares, DO adicionales, R2, Workflows y bindings deben conservarse según la configuración real. Las clases relevantes de auditoría: `OpenCodeAgent`, `DevContainer`, `PersonalSettings`, `SessionBackupDrillAgent`; migraciones hasta tag `v4` en el corte #110.

Cloudflare documenta **128 MB por isolate**, con memoria compartida entre los DO albergados por el mismo isolate; un DO individual es single-threaded con intercalado `async` y puertas de I/O. **Distribuir sesiones entre varios DO no garantiza aislar físicamente los 128 MB**; se debe medir la distribución real, carga y reinicios. Referencias:

- https://developers.cloudflare.com/workers/platform/limits/
- https://developers.cloudflare.com/durable-objects/platform/limits/
- https://developers.cloudflare.com/durable-objects/observability/metrics-and-analytics/
- https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/

**Medir antes de diseñar:** tamaño de objetos en heap, carga al inicializar Harness, `history()`/`sessions.list()`/transcripts, unbounded arrays/maps, estado duradero vs en memoria, payload MCP, sesiones residuales, fases `start`/`continue`/alarms, shell output, concurrencia de inferencia y límites proveedor. No inferir causa raíz de un solo evento `exceededMemory`.

## 5. Hipótesis trazables

H1: la memoria crece por historial completo, enumeración de sesiones o serialización. H2: carga de sesiones e inicialización del SDK saturan un único objeto/isolate. H3: reinicios durante `start`/`continue` dejan el estado task↔operation↔session parcialmente persistido. H4: el scheduler admite más trabajo del que puede mantener activo, sin backpressure durable. H5: salida de Linux o respuestas gigantes presionan memoria. H6: límites de proveedor, rate-limit o timeouts provocan recuperaciones y duplicaciones costosas. H7: la interfaz no entrega referencias de archivos producidos. H8: fuente desplegada difiere del SHA evaluado. **Ninguna de estas hipótesis es diagnóstico definitivo.** Cada una requiere reproducción RED, cambio, GREEN y correlación.

## 6. Reutilización de código abierto: política de ingeniería

Reusar Harness/SDK antes de crear mecanismos paralelos. Investigar DeepSeek Harness (`https://github.com/deepseek-ai/deepseek-harness`), OpenHands SDK (`https://github.com/OpenHands/software-agent-sdk`), SWE-agent (`https://github.com/SWE-agent/SWE-agent`), Aider (`https://github.com/Aider-AI/aider`) y otros proyectos específicos al subsistema.

**Advertencia fundamentada:** `dsh-bash-local` de DeepSeek Harness **no es por sí mismo un sandbox**; su documentación indica que ejecuta bajo la autoridad del proceso y requiere composición con mecanismos de sandbox. Leer `https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/shell/bash-local/README.md` antes de adaptar. Examinar también las capas subprocess/collected output en `https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/subprocess.md`.

Ficha obligatoria por referencia: URL, commit exacto, ruta de archivo, mecanismo, licencia observada, límites, compatibilidad Workers/DO/Bun/Containers, cambios mínimos, prueba comparativa con baseline, atribución, mantenimiento y razón de adoptar o descartar. **No copiar por analogía ni instalar dependencias sin compatibilidad probada.** La investigación de fuentes públicas puede avanzar sin desplegar ni usar inferencia.

## 7. Estrategia sin Codex y atribución

**OpenCode Staging** programa, ejecuta Linux/pruebas, escribe sobre ramas autorizadas y prepara PR draft cuando la capacidad de Remote esté comprobada y exista reserva segura. **ChatGPT en diez chats** investiga, descompone el problema, prepara instrucciones, verifica evidencias y documenta; no se atribuye código de ChatGPT a OpenCode. **Chat maestro** integra informes y, en el futuro lote 11, prepara decisiones de integración y verificación. **Work**, si está disponible y autorizado, es opcional. No depender de cuota Codex ni simularla.

Si `staging_start_task` no puede usarse por OOM/permiso/coste, el especialista sigue con lectura, pruebas offline en su entorno disponible y una PR draft de documentación si autorizada. No finge autonomía ni intenta repetidos arranques de un supervisor roto. En un caso excepcional ChatGPT puede preparar un diff en rama autorizada y etiquetarlo como autoría externa; exige posteriormente revalidar la ejecución del agente.

## 8. Diez responsabilidades y entregables no solapados

| ID | Área y principal pregunta | Archivo de informe propio | Dueño primario del código (sujeto a revisión) |
|---|---|---|---|
| T01 | Telemetría/OOM: ¿qué método y fase consumen memoria? | `docs/f0-c10/01_DIAGNOSTICO.md` | Observabilidad/tests de diagnóstico, sin alterar supervisor base |
| T02 | DO/sesiones: ¿qué debe residir en un isolate? | `docs/f0-c10/02_DURABLE_OBJECTS.md` | Prototipos de partición/carga, sin nuevas migraciones activas |
| T03 | Admisión y capacidad: ¿cómo demostrar diez activos? | `docs/f0-c10/03_CONCURRENCIA.md` | Máquina de estados de admisión y tests offline |
| T04 | Recuperación/idempotencia: ¿cómo reparar `not_found`? | `docs/f0-c10/04_RECUPERACION.md` | Reconciliación y tests de interrupción |
| T05 | Remote/MCP: ¿cómo obtener status sin historiales gigantes? | `docs/f0-c10/05_REMOTE_MCP.md` | Contratos RPC/progreso y tests, no despliegue |
| T06 | Linux/Containers: ¿qué procesos/salidas presionan memoria? | `docs/f0-c10/06_LINUX_CONTAINERS.md` | Ejecutor bounded y aislamiento, revisando #105 |
| T07 | Inferencia/proveedores/costes: ¿cuál es el límite real? | `docs/f0-c10/07_INFERENCIA_COSTES.md` | Simuladores de límites/medición, sin llamadas pagadas no acotadas |
| T08 | GitHub/PR: ¿son seguros diez branches y respuestas ambiguas? | `docs/f0-c10/08_GITHUB_INTEGRIDAD.md` | GitHub bridge/fixtures, no main/merge |
| T09 | Outputs/móvil: ¿qué es efectivamente descargable? | `docs/f0-c10/09_OUTPUTS_ARCHIVOS.md` | Contrato de artifacts y UI, sin rutas `file:` inseguras |
| T10 | Prueba final: ¿qué demostración vale para COMPLETE PASS? | `docs/f0-c10/10_PRUEBAS_E2E.md` | Harness de carga sintético offline y métricas |

Cada chat escribe **solo su archivo** y código en **su rama**. `00_COORDINACION.md` y `11_CONSOLIDACION.md` serán propiedad de la coordinación maestra o un lote de integración posterior; los especialistas podrán proponer contenido en su propio informe sin modificar el registro común. Si dos ámbitos requieren `src/server.ts`, se preparan PR separadas desde una base declarada, con los hunks documentados y sin merges cruzados.

## 9. Dependencias y camino crítico

**Ola A (segura paralela):** T01, T02, T05, T07 y T10: lecturas, perfiles históricos, fuentes externas, instrumentación/prototipos offline, contratos, matriz de carga. T03/T04 investigan antes de alterar admisión/estado. T06/T08/T09 pueden contrastar correcciones existentes y preparar pruebas sintéticas. Ningún encargo intensivo empieza sin reserva.

**Ola B (PR por componente):** una vez conocidas las causas y el SHA base, producir cambios focales y tests en ramas independientes. Las PR pueden coexistir, pero no se fusionan ni despliegan individualmente desde estos diez chats.

**Ola C (encargo 11, posterior):** reconciliar PR, resolver conflictos, integrar sobre Staging con permiso nuevo, comprobar CI y ejecutar 1→2→4→10 con observabilidad. Los diez chats no pueden probar diez activos en el runtime actual sin ponerlo en riesgo.

**Precondición compartida:** no confundir `T02` de F0-C10 con `T02` de F0-OOM-02; todas las ramas, PR e informes deben llevar prefijo `f0-c10/` y un ID inequívoco.

## 10. Protocolo de coordinación entre chats

**Fuente de sincronización:** GitHub con ramas/PR + issue #90. Nada depende de que ChatGPT comparta automáticamente estado entre sesiones. Usar nombres `f0-c10/t01-<fecha>` ... `f0-c10/t10-<fecha>`, cada una creada desde el HEAD de Staging verificado. Si esa nomenclatura no está permitida por el supervisor, usar la rama `opencode/staging-<requestId>` que este provea, documentando el mapeo, sin force push.

Antes de editar: consultar PR/branches T01–T10, SHA base, documentos existentes e issues relacionados; si el trabajo ya existe, validar y documentar, no repetir. Cada PR: actor, ambiente, base SHA, head SHA, ficheros, test RED/GREEN, CI del HEAD, coste y conflicto potencial. No cerrar #90 ni PR de otro ámbito. Los informes de cada chat pueden entregarse al maestro sin exigir que otro chat esté conectado.

**Registro compartido propuesto:** `docs/f0-c10/00_COORDINACION.md` (solo dueño maestro), `01`–`10` especialistas, `11_CONSOLIDACION.md` posterior. Para descubrimientos transversales, incluir sección `Handoff para Txx` en informe propio y enlace verificable; no crear diez comentarios idénticos en #90.

## 11. Exclusión de operaciones de Remote / control de carga

**Riesgo principal:** diez chats paralelos sobre Staging inestable pueden provocar el mismo incidente que intentan corregir. **Nunca usar solo `status=ok` o `busy:false` como lock.** Una conversación no es un mutex.

Diseñar o verificar un **lease exclusivo y atómico** para las operaciones con inferencia/CPU/estado compartido. Opción candidata: branch de control en GitHub con actualización condicionada al SHA anterior (compare-and-swap/lease + owner + expiry + fencing token), verificación de HEAD/TTL, y liberación comprobable. La existencia de un branch o comentario no crea por sí misma exclusión; el protocolo debe ser probado contra dos aspirantes simultáneos antes de usarse. Si no hay soporte seguro, **cero arranques Remote simultáneos de los especialistas** y trabajar offline hasta que el maestro pueda establecer un carril controlado.

**No se instala ni activa dicho mecanismo por este documento.** Durante esta primera ola, cada chat solo tiene permiso de lectura Remote y un inicio supervisado como máximo *si* la reserva está realmente implementada, el estado no indica tareas activas ambiguas, hay límites de coste efectivos y el lote lo permite. Nunca repetir `staging_start_task` con otro requestId tras timeout/OOM; leer el mismo ID. No lanzar diez checks pagados «por prudencia».

Para cancelar/revisar/cambiar modelo/llamar MCP dinámico, verificar alcance específico y efectos; no equiparar consultas de estado a acciones sin efectos si el backend ejecuta trabajo adicional. Documentar que `staging_task_transcript` históricamente podía materializar todo el historial. Ante OOM detener uso de esa ruta hasta contención comprobada.

## 12. Permisos predeterminados de los diez lotes

**Cuando el propietario copie individualmente un prompt**, el lote autoriza exclusivamente: lecturas GitHub/Cloudflare/Remote de Staging y fuentes públicas, pruebas sintéticas locales/offline, creación de una rama propia de este repo, modificaciones dentro de archivos declarados del ámbito, una PR **draft** a rama Stage correcta y documentación propia. Puede usar GitHub para esas escrituras dentro del lote, sin confirmaciones repetitivas.

**Operación condicional:** hasta **un** `staging_start_task` y su seguimiento/reconciliación únicamente tras reserva atómica verificada, compatibilidad de modelo y herramienta, permiso de escritura dentro de la rama propia, control de gastos verificable y preflight sin OOM abierto. No autorizar `staging_agent_check`/`staging_openrouter_check` como sustitutos automáticos: también pueden generar gasto. No modificar Prod, `main`, secretos, Access, bindings, migraciones, DO/R2 persistentes, objetos externos, deployment, traffic, merge, branch de otro chat o eliminación. Tampoco cualquier acción de `staging_mcp_call` sin leer el tipo de herramienta y confirmar que es efectivamente de solo lectura.

**Sin presupuesto efectivo o sin reserva:** el chat no solicita microaprobación: completa todo el trabajo offline y deja solo esa operación `BLOCKED`. El documento por sí solo **no** transfiere autorizaciones futuras a otras sesiones: el prompt pegado será el alcance concreto de cada encargo. Limitaciones del conector o requerimientos de autenticación de plataforma siguen vigentes.

## 13. Coste, medición, límites y parada

Cada ejecución debe registrar proveedor, modelo, tokens/inferencia si disponible, CPU wall time, memoria, invocaciones, Containers y CI, total medido y fecha. No afirmar costo cero porque el modelo se llame `economy`. **No fijar un USD arbitrario como corte efectivo.** La acción pagada requiere cuota/corte técnico verificable según `04_PRUEBAS_COSTES_Y_RIESGOS.md`; si no existe, no iniciar nueva carga pagada en este lote. Un cupo de tool calls solo es protección si el backend lo aplica.

STOP inmediato ante: OOM activo, task/session incierta que no puede reconciliarse, SHA fuente ambiguo, nueva migración/side effect, lectura de secrets, scope GitHub excedido, CI de rama equivocada, salida sin límite, lease inválido, costo no acotable. No hacer reintentos ciegos; conservar evidencia de fallos. Reversión normal: no fusionar PR draft. La reversión de Workers NO restaura datos DO, Containers ni R2.

## 14. Método de ingeniería y evaluación de alternativas

Para cada hipótesis: a) confirmar estado/refs; b) aislar test RED; c) comparar parche mínimo con máximo 1–2 alternativas de código abierto; d) decidir con coste/fiabilidad; e) delegar código a OpenCode con reserva verificada, o preparar cambio local/PR si no es posible con autoría explícita; f) test GREEN+regresión+CI; g) verificar comportamiento real solo cuando haya entorno candidato autorizado; h) documento de aceptación por componente. No trasplantar una solución solo porque aparece en DeepSeek Harness.

**Criterio de arquitectura:** preferir parche de lecturas/retención y concurrencia acotada si llega a diez verdaderamente activos; considerar shard de sesiones, supervisor control-plane ligero, pools de Containers o ejecución fuera del DO únicamente si un benchmark demuestra un límite estructural. Cualquier cambio de DO schema/migrations o deployment es lote posterior con rollback propio.

## 15. Observabilidad, métricas y correlación

Cada evento de prueba debe tener `experiment_id`, `requestId`, `sessionId`, `operationId`, worker/deployment/version, branch/base SHA, inicio/fin, transiciones, modelo, tool calls, exit codes, bytes emitidos, error_code y retries. Para diez activos exigir una línea temporal por tarea y evidencia de **actividad de ejecución dentro de una ventana de intersección**; `busy` sin progreso no basta. Usar trazas y métricas de Cloudflare sin volcar secrets ni historiales completos.

Métricas: peak/isolate memory, OOM count, CPU, p50/p95 de start/status/resultados, throughput, fairness, número de sesiones activas/queued, fallos por clase, reconciliaciones exitosas, abort confirmados, orphan count, bytes de respuesta retenidos vs omitidos, costo por tarea verificada. Publicar umbrales **antes** de la prueba y ajustar con evidencia de baseline y limits, no a posteriori para declarar PASS.

## 16. Diseño de pruebas escalonadas

**Offline primero:** tests de secuencia y estado; 1→2→4→10 solicitudes con sistema falso reproducible, payloads acotados, fallos inyectados, snapshots/restores, saltos de cursor, respuesta perdida, tool errors. Repetición de paso 1 y 2 en Staging **solo con acceso, lease, presupuesto y despliegue aprobado**. Paso 4 y 10 se ejecutan tras estabilizar la base; registrar `requestId` único, evidencia de diez activos, consulta status en carga y 10 outputs.

Casos funcionales distintos y descartables: hash local; JS+tests Unicode; CSV agregado; JSON válido/inválido; logs sintéticos; HTML accesible; TDD; combinación de configuración; DAG con ciclo; generación de reporte desde pipeline. No escribir en Prod, GitHub real ni canon si el caso no lo necesita. Separar prueba «solo local» de otra con GitHub write autorizado. Incluir controles negativos: denegación de ruta no permitida, error 403/429, cancelaciones, restart con operación ambigua y diffs para detectar cruces entre tareas.

**Definición de simultaneidad:** diez `requestId` únicos con diez sesiones/ejecutores realizando trabajo, progresos o eventos de herramientas dentro de una ventana de solapamiento medida; las pruebas no deben rellenar artificialmente `busy=true`. La cronología debe probar diez realmente activos, no diez task records. Se acepta tiempo de cola previo, pero no se acepta nivel 4 si nunca hay diez activos.

## 17. Outputs y experiencia móvil

El mecanismo de entrega debe distinguir texto, JSON estructurado, artefacto real, parte `file` segura y URL autenticada. No convertir `/tmp`, `/bundle`, `file:`, HTML/SVG activos o URL no verificada en enlaces descargables. Debe permitir informe claro y artefacto/descarga para tipos compatibles (por ejemplo `.txt`, `.md`, `.json`), con nombre, tamaño y checksum o verificación de bytes cuando proceda. Para respuestas largas, streaming/paginación o truncamiento explícito, nunca lectura total seguida de `slice`. Probar desde Android cuando haya cliente autenticado autorizado; Playwright solo no prueba descarga móvil real.

## 18. Criterios `COMPLETE PASS` y gates

**G-C10-A:** identidad/versión de ambos Workers, base SHA, permisos, snapshot y correcciones mínimas candidatas auditadas. **G-C10-B:** pruebas locales reproducibles RED→GREEN, unit/typecheck/build/invariantes/CI del HEAD. **G-C10-C:** candidato integrado/desplegado en Stage por lote aparte; métricas reales 1→2→4→10. **G-C10-D:** tres rondas independientes satisfactorias en el candidato con 10 trabajos verdaderamente solapados y 10 terminaciones verificadas, observabilidad sin OOM ni reset atribuible, sin huérfanos, idempotencia correcta, aislamiento, outputs verificables, recuperación y cancelación, costos medidos y guardas negativas. **G-C10-E:** auditoría final independiente de código↔deploy y reporte aceptado por propietario.

No exigir cero errores transitorios del mundo exterior: distinguir fallos esperados reproducibles del proveedor y errores del propio sistema. La aceptación de diez tareas completas exige que las diez tareas de cada ronda seleccionada finalicen con resultado esperado y real. No ocultar fallos con reintento ilimitado. Un FAIL invalida esa ronda; diagnosticar antes de repetir.

Estados: `PASS` para subgate demostrado, `PARTIAL` para avance sin E2E completo, `BLOCKED` para permiso/costo/infra, `FAIL` para defecto reproducible. **Solo G-C10-D/E cerrados equivalen a COMPLETE PASS**; ni diez PR verdes ni una cola funcional bastan.

## 19. Plan de recuperación y reversión

Ramas/PR: drafts sin merge; conservar evidencias hasta auditar, no borrar automáticamente. Runtime: verificar versiones, tráfico y 30 invariantes de #110; rollback Worker es cambio separado que **no recupera** SQLite DO/Containers/R2. Estado persistente: snapshots y fixtures descartables con manifest hash y prueba de restauración independiente si se autoriza. Recuperación de task: requestId igual + payload igual debe devolver exactamente la misma tarea o una reconciliación de efecto ya realizado, nunca duplicar side effects. `unknown/not_found` no se maquilla como cancelado. Evitar restaurar un sistema vivo desde un snapshot de prueba.

## 20. Continuidad, entrega y encargo 11

Cada especialista entrega informe `docs/f0-c10/0X...` en una **rama propia**, PR draft con diff exacto si escribió, y un recibo compacto:

```
F0-C10/Txx | PASS/PARTIAL/BLOCKED/FAIL
Actor real; entorno; rama; BASE_SHA; HEAD_SHA; PR; CI run/HEAD
OpenCode requestId/sessionId/operationId (si existen); tool calls/exit codes
Hallazgo reproducible; referencia open source y licencia
Cambio implementado; test RED→GREEN; E2E (si se autorizó)
Costo medido; riesgos; conflictos; bloqueos; siguiente integración
No desplegado / desplegado: versión, deployment y evidencia (si aplica)
```

El **encargo 11**, solicitado posteriormente desde el chat maestro, hará lectura y reconciliación de las diez PR, selección de cambios, merge/integración **solo con nuevo lote autorizado**, despliegue Stage **solo con permiso separado**, pruebas E2E por escalones, informe de aceptación y actualización de `11_CONSOLIDACION.md` y del mapa de estado. No atribuir al encargo 11 autoría de los cambios del agente. No asumir que todos los diez chats terminan o que sus PR pueden mezclarse sin conflictos.

## 21. Instrucciones para iniciar los diez chats

1. Incorporar **este archivo** como plan focal de F0-C10 al proyecto; conservar los seis documentos originales como mapa general y evitar duplicar `CONOCIMIENTO_UNIFICADO.md`.
2. Crear diez chats, pegar un prompt específico T01–T10 en cada uno. **No implica que diez trabajos Remote deban ejecutarse a la vez**.
3. Investigar en paralelo en modo lectura, fuentes públicas, GitHub y pruebas offline; las escrituras normales se restringen a ramas, archivos e informes individuales, previa comprobación de conflictos.
4. No iniciar operaciones de Remote con inferencia mientras no exista reserva atómica verificada y control real de coste. Si fallan, seguir produciendo PR/tests offline y reportar BLOCKED de la operación, sin pedir microaprobaciones.
5. Al concluir la primera ola, volver al chat maestro y solicitar: **«Encargo 11: consolida F0-C10 utilizando las PR e informes T01–T10; verifica estado y propone lote de integración segura, sin merge/despliegue no autorizado»**. Ningún proceso se mantiene trabajando en segundo plano por haber creado los chats.

---

### Fuentes externas de referencia (verificar commit y licencia antes de adaptar)

- Cloudflare Workers limits: https://developers.cloudflare.com/workers/platform/limits/
- Cloudflare Durable Objects: https://developers.cloudflare.com/durable-objects/platform/limits/
- Cloudflare DO memory metrics: https://developers.cloudflare.com/durable-objects/observability/metrics-and-analytics/
- Cloudflare DO rules: https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/
- DeepSeek Harness (shell local + subprocess): https://github.com/deepseek-ai/deepseek-harness
- OpenHands Software Agent SDK: https://github.com/OpenHands/software-agent-sdk
- SWE-agent: https://github.com/SWE-agent/SWE-agent
- Aider: https://github.com/Aider-AI/aider

**Última advertencia:** este archivo es un **plan creado**, no un cambio en el repositorio, en los Workers ni en OpenCode; la evidencia de 22-11-2026 debe revalidarse cuando los encargos comiencen.

---

# PARTE II — Segunda ronda, posterior a T11: consolidación del candidato y resolución focalizada

**Corte de revalidación:** 22 de noviembre de 2026, America/Sao_Paulo (las respuestas de GitHub pueden fecharse el 23 de noviembre UTC).  
**Naturaleza:** plan actualizado y evidencia de lectura; ninguna prueba de carga, despliegue, merge ni ejecución de OpenCode fue causada por esta actualización documental.  
**Autor de esta consolidación documental:** ChatGPT; no atribuir este texto al agente OpenCode.  
**Prioridad:** esta Parte II actualiza los *snapshots* de los apartados 3, 8–12 y 18–21 anteriores, conservados como historial. Los requisitos de seguridad, objetivo y gates siguen vigentes.

## 22. Dictamen ejecutivo después de T11

La primera ronda produjo doce PR especializadas y una consolidación de código. **El progreso es real en código candidato y tests**, pero **F0-C10 sigue `PARTIAL / NOT VERIFIED`**. CI verde certifica la rama candidata, no el runtime en Cloudflare; el hecho de que Remote responda `status=ok` no certifica diez activos. No cerrar issue #90 ni saltar directamente a campaña de carga.

- **Autoridad de código y CI:** [PR #126](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/126), rama `f0-c10/t11-integration-20261122`, HEAD **`1268ba22f26330d619b046fcf551ca846cb69d0f`**, base **`11161dd6f2c4b5237a2da59d7275ff693e0afdbe`**, **open/draft/unmerged**, 40 archivos; verificado en la consulta de esta ronda. La rama de Stage de referencia es `staging/opencode-g1-rpc-safe-20261120`.
- **CI exacto del HEAD #126:** [OpenCode validation #45093134023](https://github.com/aamvtrampa36-del/opencode-harness-example/actions/runs/45093134023), [F0-C10 offline #45093134014](https://github.com/aamvtrampa36-del/opencode-harness-example/actions/runs/45093134014), [T09 output integrity #45093134038](https://github.com/aamvtrampa36-del/opencode-harness-example/actions/runs/45093134038): los tres `completed/success`. Unit, preview, typecheck, build de ambos Workers/web, invariantes y fixtures offline superaron sus pasos; **ninguno ejecutó diez tareas reales en Staging**.
- **Runtime activo, leído en Cloudflare:** Worker `opencode-g1-staging` deployment `36ef84b3-0f99-4dd4-ab8e-c11ee450dd23`, versión `3546687b-4cd2-4e22-8ea9-ee5ea8fd02cb` al 100%; Worker `opencode-staging-control-mcp` deployment `9fdaf22d-beeb-44a0-ab68-77ecd5745fa1`, versión `196240c0-1052-47b3-aaa7-02cf5baa87f0` al 100%. **No se promovió #126**; el origen binario activo se auditó previamente en [#111–#113](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/113), no se reatribuye por inferencia.
- **Remote consultado en lectura:** `status=ok`, `ready=true`, `supervisedSessions=96`, `supervisedCountComplete=false`, `supervisedCountAtLeast=96`, `defaultModel=economy`, `schema=opencode.staging-control.v2`. El recuento es **incompleto**, no 96 ejecuciones activas.
- **Histórico de fallo:** [issue #90](https://github.com/aamvtrampa36-del/opencode-harness-example/issues/90), abierto. El ensayo del 22/11 envió diez inicios y dejó **0/10 verificados**. Las operaciones `a642be2611220007` y `a642be2611220009` permanecían `unknown/not_found` en la verificación directa de T11. Esto es evidencia contra reclamar recuperación integral.
- **Atribución:** la construcción de #126 se hizo en ChatGPT mediante GitHub; las PR especializadas de la primera ronda también registraron autoría directa de ChatGPT, con pruebas offline/CI. La capacidad de programación y corrección **por OpenCode Remote** no queda demostrada por esas PR.

## 23. Inventario verificable de T01–T10: selección y huecos restantes

| Área | PR primera ronda (draft, no fusionadas) | Evidencia reutilizada por #126 | Deficiencia que debe resolver R2 |
|---|---|---|---|
| T01 memoria | [#116](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/116) | Cronología de trazas OOM, historial completo previo a recorte, RED/GREEN sintético | Perfil/atribución real por fase de `startSupervisedTask` y SDK, sin confundir último RPC con allocador |
| T02 DO/isolation | [#115](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/115) | Topología: supervisor lógico único con Harness; prototipo offline; límite isolate compartido | Medir residencia real, comparar aislamiento existente frente a ejecutor distribuido con pruebas |
| T03 admisión | [#125](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/125) | 13 tests de modelo de admisión/idempotencia, dos RED deliberados | Máquina durable integrada con fencing y política de admisión que permita diez activos |
| T04 recuperación | [#120](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/120) | Journal conservador `sessionCreationAttempted`, `unknown` fail-closed, CI | Reconciliación de creación de sesión con recibo perdido; carrera continue/cancel, fault injection real |
| T05 Remote/MCP | [#114](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/114) + [#106](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/106) | Progreso acotado, 128 eventos crudos/64 proyectados/8192 bytes, bloqueos tempranos de transcript | Evento individual gigante, SDK `next()` bloqueante, transcript histórico paginado y contrato de ambos Workers |
| T06 Linux | [#121](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/121) | `timeout --kill-after=5s`, fixtures de diez procesos locales, CI | Subprocesos detached/grupos, cancelación, recursos reales y aislamiento Container, no simulación local |
| T07 inferencia | [#117](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/117) | Simulador de rate-limit y coste; documenta límites de proveedor, sin dinero real | Control real y auditable de RPM/concurrencia, recuperación de 429, presupuesto y corte efectivo |
| T08 GitHub | [#122](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/122), [#124](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/124) | Reconciliación de PR tras respuesta perdida y contraprueba de carreras | Arbitraje atómico / fencing para publicación concurrente; no confundir CAS de branch con operación completa |
| T09 outputs | [#123](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/123) | Contrato `opencode.task-output.v1` **propuesto**, fixtures GET byte-exact, CI | Endpoint/servicio autenticado real, ownership, Android, caducidad y recuperación, sin URLs ficticias |
| T10 evaluador | [#118](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/118), [#119](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/119) | Versión #119 integra validación independiente de bytes y negativos, 26 casos; tests CI | Colección confiable de telemetría runtime de inicio/fin de herramienta/inferencia, sincronía y campañas live |

**Solapamientos ya seleccionados en #126:** para T10 prevalece #119 sobre #118 en sus siete rutas idénticas; para T08 código e informe de #122 más prueba negativa de #124; los hunks de `src/server.ts` de #106/#114/#120 se aplicaron desde base fija. Su aplicación textual y CI verde no prueban carreras, serialización ni comportamiento de memoria real. **No fusionar individualmente estas PR encima de #126** ni repetir sus cambios. T07 tiene base distinta de la mayoría; se incorporaron solo sus archivos aislados. Revalidar continuamente nuevos HEAD/PR antes de apilar cambios.

## 24. Dependencias y propietario de cada superficie para segunda ronda

**Mapa funcional y orden de integración:**

1. **Identidad y memoria (T01 + T02):** perfilar sin leer transcript completo. La residencia del Harness en un supervisor único y la cuota por isolate forman una hipótesis de límite estructural, **no un veredicto de migración**. T01 aporta medición, T02 compara alternativas.
2. **Admisión y recuperación (T03 + T04):** establecer un único contrato `requestId → sessionId → operationId`, un journal idempotente y arbitraje de capacidades. T03 es dueño de la admisión/leases, T04 de journal/cancel/reconcile. Acordar interfaces mediante informe y commits; no crear máquinas de estados rivales.
3. **Progreso (T05):** proteger todos los caminos de lectura y MCP; no revivir `history()` ni truncar después de materializar. Su `src/server.ts` puede solaparse con T03/T04: proponer hunks sobre base #126 sin escribir la rama integrada.
4. **Ejecutor (T06):** `src/dev-container.ts` y tests de procesos; distinguir memoria isolate de memoria Container. No modificar código de status que pertenece a T05.
5. **Inferencia (T07):** capa por proveedor/modelo acoplada a una única reserva durable T03; sin segundo scheduler en paralelo. Control económico verificable por separado de la admisión técnica.
6. **Publicación GitHub (T08):** `src/github.ts` y tests; no intervenir con el lease de Remote sin coordinación. Un merge de ramas de GitHub no significa un lock de efecto externo.
7. **Resultados (T09):** contrato completo hasta bytes recuperados con autorización, compatible con cliente Android y el evaluador T10. Un path `file:` no prueba accesibilidad.
8. **Evidencia (T10):** fixture y evaluador de referencia #119; agregar recolector runtime e identidad autenticada, sin fabricar `source=runtime` ni tratar `busy` como intervalo real.

**Ramas y escrituras:** base de comparación = #126 HEAD fijado, salvo que cambie en una verificación posterior. Cada chat R2 crea/usa rama nueva con nombre `f0-c10/r2-tXX-<fecha>`; nunca escribe en la rama #126 ni en las ramas de otras T. Si un archivo compartido exige cambios, crear PR aislada desde el SHA base comprobado, documentar hunks y dependencias; la siguiente T11 integra. GitHub es fuente canónica, no la memoria entre chats. Evitar editar `11_CONSOLIDACION.md` fuera del maestro.

## 25. Contrato de autorización y seguridad en segunda ronda

Al pegar cada prompt R2 se permite **exclusivamente el alcance que declara ese prompt**: lecturas de GitHub/Cloudflare/Remote, investigación pública, tests sintéticos locales, escrituras de código/documentación **solo en rama R2 propia**, y PR draft con CI. No autorizar cambiar `main`, Stage desplegado, Workers, rutas de tráfico, DO persistente, Containers compartidos, claves, Access, costos pagados sin corte o merges. Las acciones Remote con efectos (`staging_start_task`, `staging_agent_check`, `staging_openrouter_check`, `staging_task_continue`, `staging_task_select_model`, `staging_cancel_task`, `staging_review_task`, `staging_mcp_call`) requieren reserva y permiso específico, análisis de gasto, ámbito y riesgo; su descubrimiento o `status=ok` no otorgan seguridad operativa.

**Pruebas offline pueden avanzar sin microaprobaciones.** Si el lease global o el corte de coste no está demostrablemente aplicado, no iniciar nuevas tareas pagadas ni pruebas multiusuario. No maquillar `unknown/not_found` como `cancelled` o `passed`. No se transfiere acceso a secretos ni credenciales por pegar un prompt. Documentar costos efectivos o `no medido`; precio nominal cero no equivale a presupuesto aplicado. En las PR, mantener cero modificaciones a deploy/CI secrets, rutas de Producción, bases compartidas y datos históricos.

## 26. Estrategia de ingeniería focalizada R2

**Objetivo práctico de cada especialista:** convertir un bloqueo probado en un cambio mínimo verificable con RED→GREEN y CI sobre la rama propuesta. Si corresponde una transformación arquitectónica, crear primero prueba de comparación con baseline, costo/complexidad y reversibilidad; no migrar DO por intuición. Los cambios de SDK/Harness requieren evaluar sus APIs reales en la versión fijada. Open source: documentar URL/commit/licencia/ruta; preferir patrones comprobados de DeepSeek Harness (streams/timeout, sin asumir aislamiento), OpenHands (eventos), SWE-agent (trajectories/evaluator) y Aider (GitHub), sin importar código por analogía.

**Rondas de trabajo:**
- R2-A: T01/T02/T05/T10 instrumentación y validación de contrato; T03/T04 coordinación de state machine; T06–T09 fixtures y correcciones por módulo. Toda investigación segura en paralelo, efectos sobre Remote no.
- R2-B: PR drafts y CI individual; cada especialista conserva informe con `PARTIAL` cuando no existe E2E real; evita duplicar #126.
- R2-C: T11 revalida permisos, SHA, conflictos y CI combinado en nueva rama. No hace merge/deploy sin lote separado y rollback.
- R2-D: **solo tras autorización específica y controles efectivos**: pilotaje 1→2→4→10, tres rondas de diez realmente solapados, diez archivos/resultados, recuperación, costes y trazas.

## 27. Gates de aceptación actualizados

**G-C10-A:** fuente, versión y configuración del candidato/preflight identificados; **PARTIAL**, porque #126 no está desplegada.  
**G-C10-B:** código candidato integrado y CI específico completo en HEAD #126: **PASS limitado a CI** (tres workflows verdes); no cumple la semántica runtime.  
**G-C10-C:** versión integrada autorizada en Staging y 1→2→4→10 medidos: **NO EJECUTADO**.  
**G-C10-D:** tres campañas 10/10 con simultaneidad genuina, recuperación, archivos byte-exact, aislamiento, cero OOM y medición de coste: **NO EJECUTADO**.  
**G-C10-E:** auditoría independiente de código↔binarios activos, permisos y aceptación del propietario: **PENDIENTE**.  
**Estado global:** `PARTIAL / NO COMPLETE PASS`.

Para un PASS live se requiere fuente/telemetría confiables, no strings inventadas en JSON de test. Harness #119 exige lectura independiente de artefacto, identidad y ventanas reales. Los umbrales de su informe se predeclaran y no se aflojan a posteriori para declarar éxito. La memoria de un isolate no se atribuye automáticamente a un DO individual. Un E2E sin referencias SHA de ambos Workers, gasto controlado y recuperación no constituye éxito integral.

## 28. Biblioteca, archivos y documentación: política R2

**GitHub conserva autoridad** de código, PR/CI y el archivo técnico canónico. En cada chat especialista, actualizar `docs/f0-c10/0X_*.md` **en su rama propia** (o añadir sección R2). La Biblioteca personal de ChatGPT se usa solo para copias útiles de informes, trazas sintéticas y manifiestos de pruebas, si el usuario autoriza expresamente y el conector lo permite. No confundir Biblioteca personal con archivos adjuntos al Proyecto. Nunca guardar secretos, tokens, transcripts privados, datos reales no anonimizados o ZIP redundantes. Usar nombre `F0-C10_R2_TXX_<HEADshort>_<tipo>.md/json`. Verificar recibo de subida antes de afirmar que se guardó; en caso de fallo, adjuntar fichero descargable y decir `biblioteca no actualizada`.

**Handoff mínimo por encargo:** `actor, ambiente, base/head SHA, rama/PR, cambios, tests/exit codes, CI del HEAD, fallos RED, métricas, costo, OpenCode IDs reales o NO START, conflicto, propuesta de integración, bloqueo de live`. Un paso no disponible debe conservar estado PARTIAL. El maestro puede recuperar todo desde GitHub sin abrir los diez chats manualmente.

## 29. Próximo T11: integración y aceptación posterior

Después de la segunda ronda, el próximo T11 tendrá un **lote distinto** de consolidación: recuperar PR/HEAD/CI/documentos R2, comparar diffs contra #126 y contrapruebas, escoger módulos, crear rama integrada desde base exacta, verificar CI y un informe nuevo `docs/f0-c10/11_CONSOLIDACION_R2.md`. No instalar, desplegar ni ejecutar carga sin autorización específica. Priorizar admitir y recuperar tareas antes de elevar la simultaneidad real; no sacrificar diez activos convirtiéndolos permanentemente en una cola de dos. Si subsiste bloqueo, registrar la única siguiente acción técnica útil y continuar el trabajo autorizado, sin atribuir PASS.

**Checklist decisiva:** ¿se probó el journal de sesión sin respuesta? ¿Existe lease atómico con fencing para trabajo compartido? ¿Se midió memoria real del Harness? ¿Hay trazas auténticas de 10 inferences/tools en ventana común? ¿Descarga Android recupera bytes ligados a la tarea? ¿El gasto tiene corte técnico? ¿El binario activo corresponde al commit probado? Si alguna respuesta es NO/desconocida, mantener `NO COMPLETE PASS`.

## 30. Regla de alcance

Este plan actualiza solamente **F0-C10**. No autoriza iniciar fases #66/#65, cambiar defaults de agente, lanzar procesos masivos, arreglar todos los issues sin relación ni publicar Producción. La meta no es un número de PR: es una evidencia reproducible de diez tareas simultáneas, estables, aisladas, recuperables y verificables bajo control económico.

## 31. Segunda consolidación R2 — candidato acumulado (pendiente de CI)

Se recuperaron PR R2 #128–#142. La nueva rama `f0-c10/r2-t11-master-integration-20261123` parte de la PR #138, que ya incorpora T03 #135 y el publicador durable T08 a partir de #130. Se integraron de forma aislada los instrumentos T01 #129 y T02 #128, T07 #142 y T10 #141, mejoras MCP T05 #139, Linux T06 #140, y endpoints artefactos T09 #133 reconciliando el código del supervisor y MCP. Los detalles, SHAs y el resultado del CI del conjunto están en `docs/f0-c10/11_CONSOLIDACION_R2.md` y la PR draft de esta rama.

**Bloqueos conservados:** T04 #136 modifica el mismo flujo de inicio que T03 #135; no confundir su CI individual con compatibilidad combinada. Instrumentación T01 R3 #134 no se activó en runtime. La capacidad live, aislamiento cloud, corte de gasto y despliegue permanecen sin demostrar. La rama es un candidato fuente NO desplegado, y no autoriza carga de diez sesiones. Cualquier veredicto posterior deberá basarse en el HEAD exacto, CI y pruebas reales autorizadas.

# PARTE III — Estado posterior a PR #145 y preparación de la tercera ronda (R3; 23-11-2026)

**Regla de precedencia:** esta Parte III actualiza el estado de PR/código/gates de las Partes I–II. No modifica su historia, sus pruebas ni sus límites. La documentación de los apartados 1–31 no constituye un despliegue. Ver `docs/f0-c10/00_COORDINACION.md` (sección R3), `15_RETROSPECTIVA_Y_CONTROLES_R3.md` y `16_RONDA_3_PROMPTS.md`.

## 32. Fotografías revalidadas y fuentes

- Issue #90 abierto; ensayo del 22 de noviembre: diez starts, seis errores OOM, **0/10 resultados auténticamente verificados**; no se atribuye una causa única al isolate.
- Cadena de código candidata y no fusionada: PR #126 (`1268ba22f26330d619b046fcf551ca846cb69d0f`) → #143 (`160eafbb0e4842063e37c71425f1a5c2e08b18b2`) → #144 (`baebc30a71dbaa8abca722c0780d4d658e2192c8`) → #145 (`a49e985909cb56bb42c609c9cd5cb4250a620169`). Sus bases son apiladas; no fusionar cada PR como si fuese independiente. Todas verificadas draft/open/no merge en el corte.
- HEAD #145: GitHub Actions #45106083359 `completed/success` (focal T03/T04, inyección de fallos local, Bun, preview, typecheck, Workers/web build, invariantes). Las pruebas de SDK/DO real y E2E **no se efectuaron**.
- Cloudflare: `opencode-g1-staging` versión `3546687b-4cd2-4e22-8ea9-ee5ea8fd02cb` deployment `36ef84b3-0f99-4dd4-ab8e-c11ee450dd23`; `opencode-staging-control-mcp` versión `196240c0-1052-47b3-aaa7-02cf5baa87f0` deployment `9fdaf22d-beeb-44a0-ab68-77ecd5745fa1`, ambos 100%. No hay evidencia de estos candidatos publicados.
- Remote de lectura: `ready=true`, mínimo 96 sesiones registradas, inventario `supervisedCountComplete=false`. **96 registradas no equivale a 96 activas**.
- GitHub aloja el plan actualizado candidato en el árbol de #145 (copiado desde PR #127 por #143); la PR documental #127 permanece abierta por separado. El archivo de prompts R2 `12_RONDA_2_PROMPTS.md` sigue fuera del árbol #145. Los adjuntos del Proyecto y Biblioteca no se sincronizan solos con GitHub.

## 33. Contratos candidatos de memoria, arquitectura, Linux, Remote/MCP y resultados

**Memoria/aislamiento:** T01 #129 correlaciona fases sintéticas; T02 #128 hace bench offline 1/2/4/10; la instrumentación #134 no se incorporó por conflicto de estructura. No hay perfil de heap workerd/DO bajo diez agentes. Varios DO pueden compartir isolate. Criterio R3: T01 observa, T02 decide contención/aislamiento según mediciones, sin migraciones especulativas.

**Linux/Container:** #140 acumula PGID/TERM/KILL y guardas EPIPE; `setsid`/procesos detached, cgroups, aislamiento real y `ctx.container.start` no están cerrados. T06 debe probar negativos de descendientes en entorno descartable, no matar procesos ajenos.

**Remote/MCP:** #139 introduce límites/cursos y export legacy fail-closed. El SDK aún puede materializar eventos grandes antes de que el usuario reciba una página. T05 debe medir límite previo a serialización y representar `unknown/not_found/cancel_requested` sin `passed=true` inventado, manteniendo compatibilidad entre Workers.

**GitHub:** #138 usa publicador durable y exclusión T03; faltan efectos reales de diez escritores, conflictos de un mismo archivo, 503 después de POST y seguridad de CAS/fencing tras reinicio. T08 conserva el puente GitHub propio; el conector ChatGPT solo investiga/verifica.

**Outputs/Android:** #133 propuso captura/descarga autenticada limitada a 32 KiB y readback; falta prueba ACL multitenant, expiración, accesibilidad Android, archivo grande y diez resultados reales. Un path como `/bundle/file.txt` nunca es descarga suficiente. T09 colabora con T10 en hashes y procedencia.

## 34. Única autoridad de admisión, recuperación y nueva readmisión

- T03 `supervisor-admission.ts` posee el ledger `supervisor:admission:v1`, máximo **diez slots** de tareas nuevas, token+generation y estados `reserved/effect_unknown/running`; un TTL nunca resuelve un efecto desconocido. `capacity=10` no prueba diez ejecuciones realmente en paralelo.
- #144 incorporó T04: política `deterministic-v1` para tareas nuevas normales, `r2SessionId(requestId)`, journal `turnId+hash`, cancelar/continuar/status mediante transacción y negativa a repetir `fork` sin ID idempotente. Las tareas legacy no se migran automáticamente.
- #145 comprueba `opencode.sessions.get({sessionID: 'ses_r2_'+requestId})` por ID exacto al reconciliar `session_create/effect_unknown`. **GET positivo** transfiere generación/fencing y vincula session/owner de forma transaccional; GET negativo/error deja `unknown` y no ejecuta otra creación. No prueba que todos los side effects del creador anterior hayan cesado.
- #145 readmite una tarea `finished` bajo el mismo ledger de diez en la transacción que crea el nuevo journal de turno; registra `turn_submit/effect_unknown` antes del RPC. Un resultado de admisión no es finalización; `not_found` nunca libera el efecto; recibo nativo terminal verificable es necesario.
- STOP abierto: sesiones legacy sin slot pueden ejecutar fuera de la capacidad; recuperación del creador tardío sin pruebas reales DO; seguridad de `create({id})` bajo caída real; readmisión/cancelación y fork bajo garantías nativas; coste y memoria no medidos. R3-T03 y T04 tienen propiedad separada (capacidad vs. reconstrucción SDK).

## 35. Coste, inferencia y prueba final auténtica

T07 #142 conserva un contrato offline de presupuesto, **no** un interceptor de todas las llamadas ni un hard stop aplicado a Workers AI/OpenRouter/Workers/DO/Containers/CI; tarifa visible y AI Gateway no prueban corte efectivo. T10 #141 dispone de validador de firmas/trazas sintéticas, no de colector live independiente. La campaña real exige dos Workers versionados y con rollback, autorización separada, lease atómico exclusivo, corte de gasto medido, telemetría externa, fuente/binario, negativa ante OOM/unknown, tareas aisladas y diez readbacks.

**Aceptación F0-C10:** tres campañas independientes 1→2→4→10 que terminan con **diez intervalos realmente solapados** de herramienta/inferencia por campaña, **diez salidas verificadas** con hash/readback y aislamiento, cero OOM/duplicados/huérfanos, recuperación y gastos auditables. CI, mock, `busy`, número de sesiones o prompts no sustituyen estos hechos.

## 36. Retrospectiva de T11 — evidencias y cambios aplicables

Retrospectiva detallada en `docs/f0-c10/15_RETROSPECTIVA_Y_CONTROLES_R3.md`. Decisiones verificadas: PR #143 acumuló 78 commits de comparación desde #126 y 56 archivos cambiados (incluye ancestros y trabajo de especialistas, **no** 78 commits adjudicados al integrador); se aplicaron hunks por coincidencia de contexto textual antes de pruebas semánticas; PR #144 requirió conciliación especial y un segundo ajuste de readmisión tras el primer CI; #145 precisó otra ronda de journaling/fencing. La evidencia indica **integración evolutiva y controles tardíos**, no demuestra que todas las reparaciones anteriores fuesen incorrectas. Las dos propuestas iniciales de panel copiador no cumplieron el contrato de equivalencia con el archivo canónico: HTML separado y UI acortada.

**Reglas R3:** (a) fijar árbol base+dependencias; (b) comprobar SDK/contratos antes de codificar; (c) definir RED/STOP antes de escribir; (d) un solo dueño por ledger/fuente; (e) probar carreras y falsos PASS; (f) integrar por comportamiento, no solo por hunk aplicable; (g) minimizar commits/workflows redundantes, validar CI HEAD final y costes desconocidos; (h) exigir atribución real OpenCode vs ChatGPT; (i) verificar recibos de Biblioteca; (j) **QA exacta de los once botones** frente al prompt Markdown, sin HTML simulado ni resúmenes.

## 37. Mandatos de tercera ronda y handoff único

Los diez especialistas vuelven a sus mismos chats, no crean seguimientos independientes. Propietarios: T01 OOM/medición; T02 aislamiento DO/Container; T03 capacidad + legacy; T04 recuperación SDK/DO y fencing; T05 Remote/MCP; T06 Linux; T07 inferencia/coste; T08 GitHub escrituras; T09 artefactos/Android; T10 E2E y trazas. R3-T11 consolidará solo después de recibir handoffs.

Cada T tiene lote de lecturas, pruebas offline, rama propia, commits/PR draft, CI HEAD y publicación documental GitHub; Biblioteca solo tras pruebas y con recibo. Los diez entregan una sección `HANDOFF A F0-C10/R3-T11`: PASS/PARTIAL/BLOCKED/FAIL, SHAs, rama, PR, archivos, actor, pruebas/exit code/CI, métricas, costes, riesgos, solapes, copia confirmada y recomendación de integración. **Ninguno genera un prompt de seguimiento propio**, ni inicia Staging, despliega o hace merges.

## 38. Integración R3-T11 y precedencia de PR

R3-T11 recupera las diez PR, evidencia y archivos, revalida base/HEAD, rechaza duplicados de PR apiladas y elige el mínimo conjunto compatible con T03/T04/T08 y contratos de outputs. Implementa en su propia rama aislada; exige suite Bun, build de dos Workers y cliente, typecheck, invariantes, negativos y CI final HEAD. Documenta en `11_CONSOLIDACION_R3.md`. Aunque todas las PR tengan CI, **no** está autorizado un deploy o carga sin lote operativo específico. No abrir otra ronda automática de diez encargos.

## 39. Reglas de autorización y parada (R3)

En este lote de **planificación/documentación**: lecturas GitHub/Cloudflare/Remote, nueva rama documental, archivos Markdown, PR draft, CI de documentos y copias personales de Biblioteca con recibo; no ejecutar anticipadamente T01–T10 ni T11. Los futuros prompts autorizan únicamente sus respectivos lotes offline. Prohibidos `main`, Producción, merges, despliegues, mutaciones DO/Containers, secretos, Access, cambios de bindings, cancelaciones ajenas y gasto de inferencia sin gate técnico. READ de Remote no debe confundirse con una operación que muta storage.

**Resultado actual:** `PARTIAL / NO COMPLETE PASS`. El siguiente movimiento del propietario es pegar diez prompts R3 en sus chats originales. Cuando terminen sus PR/handoffs, pegar R3-T11 aquí; la coordinación mecánica entre GitHub, documentación y Biblioteca corresponde al ejecutor, no al propietario.

## 40. Consolidación de resultados de la tercera ronda (R3-T11)

Se recibieron e integraron **diez entregas** de los especialistas [#147](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/147) a [#156](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/156) en rama exclusiva `f0-c10/r3-t11-integration-20261123` y [PR draft #157](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/157). La base incluye #149→#146→#145→#144→#143→#126, no replicar esos ancestros. Informe técnico y matriz de aceptaciones: `docs/f0-c10/11_CONSOLIDACION_R3.md`.

**Lección de integración aplicada:** el primer CI detectó que el test T06 seguía esperando una **fuga** por hardlink, ya corregida por T09; su fallo 757/758 era un contrato de prueba antiguo. Se actualizó la expectativa hacia rechazo de hardlinks, sin relajar seguridad. Los workflows posteriores de integración fuente sobre SHA `4e2c7af50616658fb01509196946d300a7ed7f6e` pasaron [#45115683151](https://github.com/aamvtrampa36-del/opencode-harness-example/actions/runs/45115683151) y [#45115683117](https://github.com/aamvtrampa36-del/opencode-harness-example/actions/runs/45115683117). Los documentos posteriores cambian el HEAD: revalidar siempre **el último SHA** en PR #157 y registrar recibo definitivo en su conversación.

La solución sigue **candidata no publicada**: T01 no explica aún root cause OOM runtime, T02 no acredita aislamiento físico, T03 conserva STOP legacy, T04 no demuestra ausencia de efectos SDK tardíos, T05 aún usa SDK nativo potencialmente costoso al conciliar, T06 no demuestra cierre de detached en Cloudflare, T07 presupuesto sin hard stop total, T08 sin diez PR reales de OpenCode, T09 sin ACL por principal y Android autenticado, T10 sin observer externo real. Nada de esto autoriza deploy, carga masiva, gastos o declarar tres rondas 10/10. **F0-C10 = PARTIAL / STOP**; no abrir automáticamente otra ronda de diez especialidades.


## 41. PREFLIGHT-01 — Veredicto operativo después de R3-T11 (2026-11-23)

El preflight documentado en `docs/f0-c10/F0_C10_PREFLIGHT_OPERATIVO.md` comprobó por lecturas GitHub, Cloudflare y Remote el estado posterior a la [PR #157](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/157). El candidato tiene dos workflows CI offline verdes en SHA `304145eca71a5ffcf6d9c235e67a8065718c6ae5`, pero las versiones activas de ambos Workers son las anteriores y NO tienen manifiestos de proveniencia binaria R3. Cloudflare confirma que el límite de gasto **legacy/deprecated** de AI Gateway está desactivado y el gateway no informa rate limit; la ruta `env.AI` está configurada, sin interceptor upstream/corte global demostrado. No confundir una configuración legacy con un inventario exhaustivo de reglas modernas.

**STOP de operación y despliegue:** sin lease aislado, gasto máximo expresado en USD y corte efectivo de todas las rutas, memoria/cgroup, ACL por principal, observador firmado ni rollback de almacenamiento verificado, no se inician tareas con inferencia ni pruebas de carga. El script `scripts/f0-c10/operational-preflight.mjs` y su snapshot de solo lectura documentan el STOP con exit 2; **jamás autorizan GO basándose en JSON declarativo**. Las pruebas y CI de esta rama establecen la seguridad del verificador, no la seguridad de un despliegue. F0-C10 permanece `PARTIAL / NO_COMPLETE_PASS`.


## 42. PREFLIGHT-02 — Prototipo de contención de gasto y lease exclusivo (sin despliegue)

Continuación directa de [PR #158](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/158), partiendo de HEAD `2231c385dfb5e3d17d84cedafc997c557e2e990d`. El único encargo técnico es cerrar, con evidencia, los dos primeros bloqueos del preflight: **lease exclusivo con fencing** y **control efectivo del gasto**, sin iniciar cargas.

Se añadieron `src/preflight-exclusive-lease.ts` y `src/preflight-disposable-cost.ts`, con pruebas RED/GREEN offline, transacciones de un solo DO descartable y un límite sintético de exposición máxima en micro-USD para seis categorías. El lease no se recupera por TTL ni por string terminal; una invocación externa desconocida conserva la cuarentena. El registro de gastos no permite aumentar su techo in situ, ni liberar cargos ambiguos o conceder `providerDispatchAuthorized` verdadero. **No se conectaron a `src/server.ts` ni interceptan el SDK real**.

La consulta de los **Spend Policies modernos** de Cloudflare devolvió HTTP 403: no existe prueba de cortes activos. La documentación de Cloudflare confirma que los spend limits por cuenta para Workers/DO y por gateway tienen demoras o consistencia eventual, no cubren todas las categorías ni constituyen garantía de factura máxima; un límite aplicado a esta cuenta compartida podría interrumpir otros proyectos. Es condición de GO futuro **cuenta y namespace realmente aislados**, egress del SDK efectivamente supervisado y presupuesto máximo explícito en USD. Véase `docs/f0-c10/F0_C10_PREFLIGHT_02_COST_LEASE.md`. **Estado** `PARTIAL / STOP_LIVE / NO_COMPLETE_PASS`.


## 43. PREFLIGHT-03 — Techo global US$2, sin habilitar gasto

El propietario aprobó un **techo monetario combinado de US$2,00** para el futuro ensayo F0-C10, **no por tarea ni proveedor**. Se fijó como `2_000_000` micro-USD en el prototipo offline `src/preflight-disposable-cost.ts`; `src/preflight-usd2-quote.ts` rechaza sumas sintéticas que lo rebasen, DO independientes y costes indirectos desconocidos como `storage`, `egress`, `observability` y `unclassified`. El manifiesto `docs/f0-c10/PREFLIGHT_03_USD2_AUTHORIZATION.json` conserva exclusivamente la autorización numérica, **no** una autorización de pago.

El endpoint moderno de Cloudflare `GET /billing/spend-policies` devolvió **HTTP 403** en la revalidación; gateway `default` no mostró rate limit, y el límite **legacy** de AI Gateway está desactivado, sin demostrar el estado de políticas modernas. No existen recibos de aislamiento real, gasto medido ni hard cutoff total de las seis rutas/overhead. La nueva etapa mantiene `STOP_LIVE / PARTIAL / NO_COMPLETE_PASS`. La documentación completa y criterio de aceptación están en `docs/f0-c10/F0_C10_PREFLIGHT_03_USD2.md`. No se fusionó ni desplegó código.


## CONSOLIDACION-01 — revalidación posterior del 23-11-2026

Véase [F0_C10_CONSOLIDACION_01.md](F0_C10_CONSOLIDACION_01.md). Cloudflare ADMIN GET de Spend Policies ya devuelve éxito y lista vacía (0); el 403 previo es histórico. #375 conserva ETag y bindings de #374, con cache_options distinto. No demuestra procedencia binaria GitHub ni corte financiero. El recibo original permanece intacto; el nuevo manifiesto revalidado conserva STOP y todos los costes desconocidos. #160 aporta cuatro regresiones transaccionales al candidato #161, sin duplicar ledger, workflow ni constante de techo. Las tres rutas divergentes de Staging ya contienen la reparación funcional en #161; no se sobrescriben las guardas transaccionales R2/R3. Estado PARTIAL / STOP_LIVE; CI combinado del nuevo HEAD pendiente. Ningún cierre, merge, deploy ni llamada de inferencia.
