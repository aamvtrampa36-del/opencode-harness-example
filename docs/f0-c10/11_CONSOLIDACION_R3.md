# F0-C10/R3-T11 — Consolidación de diez especialidades y decisión de gate

**Estado R3-T11 (candidato integrado):** fuente y regresiones offline aprobadas hasta `4e2c7af50616658fb01509196946d300a7ed7f6e`; los commits documentales posteriores requieren verificar CI otra vez sobre el nuevo HEAD exacto. Compatibilidad con Staging **NO PROBADA**. **Decisión global:** `PARTIAL / STOP_LIVE / NO COMPLETE PASS`.
**Issue:** [#90](https://github.com/aamvtrampa36-del/opencode-harness-example/issues/90).
**Actor de integración:** ChatGPT mediante GitHub, no OpenCode Remote con efectos, no Codex.
**Rama:** `f0-c10/r3-t11-integration-20261123`.
**Base:** [#149](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/149) HEAD `8c6a6d61aa5bfd9bfd6b162df3c7d6d1f4ff730e`, que ya incorpora la documentación R3 [#146](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/146) `05da68fd1644f92578588c62a4586d561c418c49` y el código [#145](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/145) `a49e985909cb56bb42c609c9cd5cb4250a620169` por ascendencia. #145 incluye #144/#143/#126. No reaplicar esos ancestros.

## 1. Matriz de entregas R3 recuperadas (PR/HEAD, autoría y alcance)

| Área | PR draft HEAD de especialista | Selección en T11 | Evidencia técnica y límites |
|---|---|---|---|
| T01 memoria/OOM | [#149](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/149) `8c6a6d61` | **Base**: tracer opt-in OFF, MCP/Worker y tests RED/GREEN | Node N=1/2/4/10; no perfil workerd ni raíz OOM |
| T02 arquitectura/DO | [#148](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/148) `b0f3673c` | Informes, benchmark y fixture workerd descartable | Modelo de residencia, no prueba DO aislado con diez agentes |
| T03 slots/legacy | [#147](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/147) `4417b85b` | Ledger T03, inventario legado acotado, fail-closed rutas auxiliares y tests | Legado/DO externos sin reconciliar fuerzan STOP |
| T04 SDK/recuperación | [#150](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/150) `ae1e7512` | Fence ante catch tardío, tags SDK, tests de workerd local/RED | No demuestra efectos internos del SDK completamente finalizados |
| T05 MCP/Remote | [#151](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/151) `f92d1a40` | Snapshot MCP sin side effect, errores fail-closed y rechazar serialización bytes | La ruta nativa `supervisedTaskStatus` sigue materializando eventos SDK antes de byte-bound |
| T06 Linux/Container | [#154](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/154) `39f0e94a` | Bootstrap acotado, árbol procesos/setsid/artefactos RED y tests | Escape setsid/cgroup Cloudflare no certificado |
| T07 inferencia/costes | [#153](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/153) `17ee4933` | Contrato durable de reserva, simulación y preflight STOP | NO interceptor en todas las llamadas ni hard stop proveedor/infra |
| T08 GitHub | [#152](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/152) `189e2add` | Proof `baseSha+headSha` antes de POST, reconciliación y tests de diez writers | GitHub POST con HEAD movido puede tener efecto externo que exige cuarentena; no live |
| T09 artefactos/Android | [#155](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/155) `f8990e25` | Bloqueo hardlinks, artifactId inmutable, tests byte-exact y preflight Android | Bearer global sin ACL por principal; sin Android autenticado ni GET Stage |
| T10 E2E | [#156](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/156) `901a3e79` | Verificador observed journal y fallos negativos con fuente independiente **simulada** | Sin colector runtime autenticado ni diez solapamientos reales |

**Handoffs:** los diez informes están en `docs/f0-c10/01_DIAGNOSTICO.md` a `10_PRUEBAS_E2E.md` en HEAD de cada especialista; sus PR y varias copias de Biblioteca incluyen recibos. Los apartados R3 de cada informe no siempre usan exactamente el mismo encabezado de handoff, pero contienen un cierre único a T11, autor, límites y recomendación. Biblioteca no sincroniza automáticamente GitHub.

**Autoría:** según las diez PR, implementación ChatGPT vía GitHub, pruebas GitHub Actions/local; no atribuirla a OpenCode Remote. Coste real de Actions, CI, API, CPU local y Cloudflare GET no reconciliado. No nuevas cargas de inferencia ni operaciones Remote con efectos de T11.

## 2. Secuencia y conciliación semántica

1. **T01 = tronco de partida**, por heredar #146/#145 y mantener el trace opt-in apagado. El parche viejo #134 no se aplicó.
2. **T03** se incorporó primero con su ledger y pruebas de legado, adaptando los retornos de capacidad a las llamadas trazadas por T01. Es la única autoridad de slots, fencing y readmisión; el STOP en rutas legacy G8/G9 y `agent_check` no sustituye un censo total del entorno.
3. **T04** se aplicó después por parches de contexto verificados sobre admisión, journal, pruebas y catch del supervisor. La escritura tardía del creador comprueba token+generation antes de degradar la tarea. La consulta exact-ID no habilita reenvío ciego de `create`.
4. **T05** se integró conservando instrumentación T01: MCP usa el snapshot durable sin `wait/busy/log`, progresa con `pageAvailable:false` cuando el SDK no ofrece límites previos a materialización. La vía nativa de reconciliación permanece distinta de la vía de lectura externa; requiere publicar ambos Workers juntos en un lote posterior.
5. **T08** reusa el puente GitHub duradero del ancestro, agrega proof inmutable `baseSha/headSha`, verificación POST y pruebas stateful, sin scheduler nuevo. **T07** mantiene un módulo de presupuesto offline, no se conectó a llamadas pagadas en esta PR.
6. **T06** aporta bootstrap/fixtures Linux, incluido RED detached, sin afirmar limpieza de todos los descendientes. **T09** mitiga hardlink e identidad de bytes pero no habilita acceso multitenant con bearer global. **T10** aporta instrumento observed journal offline que rechaza firmas/orígenes falsos.
7. Se evitaron workflows individuales atados a ramas que no son la de integración. Una sola suite integrada `.github/workflows/f0-c10-r3-t11-integrated.yml` ejecuta los tests y build de los dos Workers/cliente contra el SHA exacto. No activa workerd de Staging ni despliega.

**Conflictos que T11 no debe enmascarar:** hay archivos compartidos `src/server.ts` (T01/T03/T04/T05), `supervisor-admission.ts` (T03/T04), `supervisor-t03-t04-integration.test.ts` (T03/T04), MCP server (T01/T05). La conciliación conserva ambos conjuntos de guardas y exige tests del HEAD final. Que una hunk aplique no equivale a prueba de semántica: inspeccionar diffs y casos interleaving del resultado combinado.

## 3. Auditoría de retrospectiva R3

Referencia: `docs/f0-c10/15_RETROSPECTIVA_Y_CONTROLES_R3.md`.
- **SHA y DAG:** las diez PR tienen base explícita #145 o #146, sin merge en `main`. Una rama R3 fue elegida como base; cambios R3 se importaron solo una vez por área.
- **RED/GREEN:** T01 memoria, T03 legacy, T04 stale creator, T06 procesos, T07 reservas, T08 GitHub SHA, T09 hardlink y T10 falsos live tienen negativos. La validez de esos negativos es offline salvo workerd local T04.
- **Evidencia:** la mayoría declara CI del HEAD, pero workflows `push` no siempre aparecen en la consulta limitada a `pull_request`; citar recibos de PR y ejecutar CI integrado independiente. Registrar `completed/success` solo tras leer resultado del HEAD final.
- **Autoría/autonomía:** ChatGPT y no OpenCode; no se demostró trabajo autónomo por un agente live.
- **Costes y STOP:** todas mantienen no-deploy/no-load; hard stop real no instalado, por tanto resultado global STOP.
- **Biblioteca:** copias con recibos de especialistas y documentos de preparación R3; no suponer igualdad de bytes de resúmenes.
- **Mejora procesal:** la herramienta de contenidos GitHub escribe archivos individualmente, generando varios commits técnicos aun cuando el cambio de concepto es único. La futura integración debe usar transacción Git tree si puede probar SHA y la semántica; no retocar la historia con fuerza ni ocultar autoría.

## 4. Gate de pruebas offline e identidad

**Evidencia del código compuesto tras reparar una regresión real:** la primera ejecución del SHA `060f05e756ba0e92a2831ac2b45b02f5d6bc4dec` falló en [OpenCode validation #45115537741](https://github.com/aamvtrampa36-del/opencode-harness-example/actions/runs/45115537741) y en los dos jobs dependientes del fixture T06 en [workflow #45115537743](https://github.com/aamvtrampa36-del/opencode-harness-example/actions/runs/45115537743). Resultado Bun: **757 PASS, 1 FAIL**. El test antiguo T06 esperaba una fuga por hardlink, pero la corrección T09 ya bloqueaba la lectura. No se relajó la protección: se convirtió la expectativa vieja en negativa de lectura. El SHA corregido `4e2c7af50616658fb01509196946d300a7ed7f6e` obtuvo [OpenCode validation #45115683151](https://github.com/aamvtrampa36-del/opencode-harness-example/actions/runs/45115683151) y [R3-T11 integrated #45115683117](https://github.com/aamvtrampa36-del/opencode-harness-example/actions/runs/45115683117) **completed/success**; tres jobs integrados `source-regression`, `fault-injection` (incluye DO workerd descartable) y `e2e-offline` pasaron. Los resultados siguen siendo solo OFFLINE/local. **El HEAD definitivo de esta PR después de editar documentos se verifica en los checks y comentario de PR #157; no reutilizar un green de SHA anterior.** Suites requeridas: `bun test`, preview, `bun run typecheck`, `bun run build`, invariantes, Node/DO local, Linux negativos, budget, E2E mock y prueba de firmas incorrectas. Los fixtures con firma efímera NO son recibos de runtime.

Si cualquier job falla, identificar prueba exacta, causa y corrección mínima; actualizar el informe y repetir CI solo en HEAD cambiado. **No afirmar PASS anticipadamente.**

## 5. Operaciones y preflight para futuro despliegue: STOP

- **Fuente/binario:** #145 y R3 son candidatos no publicados. Cloudflare GET al inicio de R3 seguía principal `3546687b-4cd2-4e22-8ea9-ee5ea8fd02cb` y MCP `196240c0-1052-47b3-aaa7-02cf5baa87f0`, al 100%; revalidar al cierre. No hay digest exacto fuente/artefacto/despliegue de R3.
- **Capacidad:** demostrar ausencia o contabilización de legacy fuera del ledger T03, lease exclusivo atómico con fencing, rutas auxiliares, readmisión y corte de operación `effect_unknown` sin reintentos ciegos.
- **Memoria/aislamiento:** obtener perfil de isolate y memoria Container de SDK real con margen de seguridad; `setsid` y cgroups no probados. Mocks de 10 no sustituyen concurrencia.
- **Coste:** probar hard stop de Workers AI, OpenRouter, Workers, DO, Containers y CI, incluidas respuestas ambiguas, presupuesto total y recibos upstream. T07 solo contract/offline. Sin autorización de gasto **no iniciar una sola inferencia de campaña**.
- **Outputs/ACL:** identidad autenticada por principal (no bearer global expuesto), readback byte exact y diez archivos separados, expiración/retención y aceptación Android real.
- **Telemetría:** colector runtime externo, provenance de DO/Container/proveedor, firma y sincronización temporal; sin eso, un intervalo firmado de fixture no es inferencia real.
- **Compatibilidad y rollback:** build byte-identical con SHA de ambos Workers, bindings, assets, DO/Container separados y plan de reversión que no confunda Worker rollback con restauración DO persistente.

La futura campaña necesitará **autorización operativa explícita diferente**, primero 1→2→4→10, después tres rondas independientes con diez intervalos solapados auténticos, diez outputs leídos y verificados y cero OOM, mezcla, huérfanos o gasto no controlado. Este lote **NO** permite ejecutarla.

## 6. Entrega

- **RESULTADO:** `PARTIAL / SOURCE_CANDIDATE_OFFLINE_CI_PASS / NO_LIVE`; comprobar que los checks finales corresponden al HEAD más reciente y mantienen verde el código. El área T10 puede pasar su oráculo offline sin que F0-C10 alcance COMPLETE PASS.
- **EVIDENCIA:** PR R3 #147–#156 y sus commits, diez informes y Biblioteca, CI combinado #45115683151/#45115683117 **verde para SHA `4e2c7af5…`**; confirmar checks posteriores en PR #157, atribuir actores reales.
- **BLOQUEANTE:** alcance real de legacy, efecto SDK todavía en vuelo, memoria isolate, proceso detached, gasto sin corte, principal ACL y observador live.
- **PRÓXIMA ACCIÓN ÚNICA:** resolver primero las condiciones STOP operativas de un **preflight DO/Container aislado, auténtico, medido y reversiblemente autorizado**, sin pedir todavía despliegue ni campaña 1→2→4→10. En el estado actual, **STOP**.

## 7. Estado del runtime y veredicto posterior a R3-T11

Lectura Cloudflare revalidada: principal `opencode-g1-staging` deployment `36ef84b3-0f99-4dd4-ab8e-c11ee450dd23`, version `3546687b-4cd2-4e22-8ea9-ee5ea8fd02cb` al 100 %; MCP deployment `9fdaf22d-beeb-44a0-ab68-77ecd5745fa1`, version `196240c0-1052-47b3-aaa7-02cf5baa87f0` al 100 %. Esas versiones **no** prueban correspondencia binaria con #157; no se inspeccionaron bytes completos/asset digests y no se despliega. Remote solo devolvió `ready=true`, `supervisedCountAtLeast=96`, `supervisedCountComplete=false`; no equivale a actividad de diez tareas.

El panel de salida Android aún requiere ACL ligada a principal; el presupuesto T07 no tiene interceptor/corte real de proveedores+infra; el legacy y procesos fuera de PGID/cgroup exigen preflight; el diario observado T10 usa claves de test sin colector live. **Decisión de despliegue: STOP. COMPLETE PASS: NO.** No cerrar issue #90, no atribuir autonomía a OpenCode y no pedir nueva ronda R4 automática.


## 8. Recibos exactos de los diez especialistas R3

**Regla de evidencia:** todos los workflows enumerados aquí se leyeron en GitHub Actions y sus jobs terminaron `completed/success` en el HEAD que acompaña cada fila; eso certifica pruebas CI de **esa rama**, nunca el código combinado hasta que CI de #157 esté verde. Actor de código en estas diez PR: **ChatGPT vía GitHub**; OpenCode Remote no ejecutó los cambios; coste monetario acumulado de CI/API no conciliado. Los experimentos con Node/Miniflare/workerd local no son pruebas de Cloudflare Staging.

| T | PR / HEAD fuente completo | CI individual y prueba principal | Resultado/limitación |
|---|---|---|---|
| T01 | [#149](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/149) `8c6a6d61aa5bfd9bfd6b162df3c7d6d1f4ff730e` | [#45109901200](https://github.com/aamvtrampa36-del/opencode-harness-example/actions/runs/45109901200) éxito; medidor Node RED/GREEN 1/2/4/10, Bun/TypeScript/build | `PARTIAL`: causa OOM real no medida; flag OFF |
| T02 | [#148](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/148) `b0f3673ced29db85c2ed3162f9115109e44dcc1f` | [#45109824551](https://github.com/aamvtrampa36-del/opencode-harness-example/actions/runs/45109824551) éxito; lifecycle sintético y fixture workerd no ejecutado | `PARTIAL`: separación física no verificada |
| T03 | [#147](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/147) `4417b85bc6abf6652776597f19641380c3a65e7b` | [#45110032404](https://github.com/aamvtrampa36-del/opencode-harness-example/actions/runs/45110032404) éxito; RED→GREEN legacy, capacidad, Bun | `PARTIAL`: legado fuera de censo obliga STOP |
| T04 | [#150](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/150) `ae1e7512e6186f50b81cf0db629f9a6c78943efa` | [#45110366653](https://github.com/aamvtrampa36-del/opencode-harness-example/actions/runs/45110366653) éxito; workerd local descartable, creator tardío | `PARTIAL`: efectos internos SDK aún no certificados |
| T05 | [#151](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/151) `f92d1a407c952c1ac68a06d51b3d9d11ad26a5ba` | [#45110056837](https://github.com/aamvtrampa36-del/opencode-harness-example/actions/runs/45110056837) éxito; MCP limitadores, errores y snapshot | `PARTIAL`: ruta SDK native aún potencialmente ilimitada |
| T06 | [#154](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/154) `39f0e94aeff0731b80e81c382c6e6a754b9c104e` | [#45110143261](https://github.com/aamvtrampa36-del/opencode-harness-example/actions/runs/45110143261) éxito en dos jobs; Linux+setsid/EPIPE/local | `PARTIAL`: detached y cgroup real siguen STOP; su test de hardlink histórico fue actualizado en T11 por T09 |
| T07 | [#153](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/153) `17ee4933fdbce3e9a958444b5e19aa59395f97b1` | [#45110167632](https://github.com/aamvtrampa36-del/opencode-harness-example/actions/runs/45110167632) éxito; gasto transaccional sintético y rechazo de pago | `PARTIAL`: no control efectivo upstream/infra |
| T08 | [#152](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/152) `189e2add5880ca213562cbc5ee1bd0ab08223960` | [#45110051885](https://github.com/aamvtrampa36-del/opencode-harness-example/actions/runs/45110051885) éxito; writer mock 10×, SHA swap/503 | `PARTIAL`: diez escritores OpenCode reales no probados |
| T09 | [#155](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/155) `f8990e25ee77b473aa9f8ae2308591788d20d127` | [#45111110721](https://github.com/aamvtrampa36-del/opencode-harness-example/actions/runs/45111110721) éxito; hash/bytes, hardlink negativos, móvil emulado | `PARTIAL`: ACL por principal y Android real pendientes |
| T10 | [#156](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/156) `901a3e79e0d9ca9fffe5f74832805499a137b8f6` | [#45111097353](https://github.com/aamvtrampa36-del/opencode-harness-example/actions/runs/45111097353) éxito en dos jobs; trazas firmadas y negativos | `PASS` solo oráculo offline; sin diez activos reales |

Las ramas T01/T04/T07/T09/T10 partieron de [#146](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/146) `05da68fd1644f92578588c62a4586d561c418c49`, las demás de [#145](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/145) `a49e985909cb56bb42c609c9cd5cb4250a620169`; ambas bases comparten la misma fuente productiva. T11 eligió #149 como base que ya tenía #146, y reconcilió las otras sin duplicar #145. **Esto no es una afirmación de diez especialistas autónomos en ejecución.**

**Coste y permisos:** los diez lotes declaran ausencia de inferencia iniciada en Staging y de despliegues, pero el coste real combinado de CI, API de lectura, CPU local y productos Cloudflare no está certificado; **desconocido ≠ cero**. Resultado de #157: `PARTIAL / NO LIVE`; cualquier acción operativa adicional exige permiso nuevo.
