# F0-C10/R2-T11 — Consolidación maestra de la segunda ronda

**Operación:** F0-C10; issue [#90](https://github.com/aamvtrampa36-del/opencode-harness-example/issues/90). **Actor de esta integración:** ChatGPT mediante conector GitHub, NO OpenCode Remote, NO Codex. **Estado:** `PARTIAL / SOURCE_CANDIDATE / NO_DEPLOY / NO_LIVE_10`.

**Corte de fuentes:** 2026-11-23 UTC; verificar HEAD de esta misma rama y PR después del último commit. Base fuente ya integrada: **PR [#138](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/138) HEAD `7baca594fa4ea731faf3e1d1ddd5feda2ece74b1`**, que incluye #135 T03, #130 T08 y #126. #126 original `1268ba22f26330d619b046fcf551ca846cb69d0f` continúa como base histórica. La PR #137 es revisión parcial solo de Linux; se leyó como referencia y **no** se incorporó además del código de #140.

**Autorización:** solo consultas GitHub/Cloudflare/Remote, integración fuente en rama aislada, pruebas offline/CI y documentación. Sin merge, desplegar, reconfigurar Workers, modificar DO/Containers, secretos, Access, main o Producción. No 10 inicios, no inferencia pagada.

## 1. Inventario de entregas R2, selección y estado

| T | PR(s) verificadas | HEAD de entrega | Evaluación de integración |
|---|---|---|---|
| T01 | #129, #134 (fase R3) | `c8afb5302252d7edce18332b602d6d4e72755d58` / `a5b4dc2da1de15a1b14f5c682215719fe16d5696` | **Incluir #129 offline**; #134 instrumenta `src/server.ts` en un flujo de inicio superado por #135, no aplicar hunk obsoleto sin rediseñar la ubicación. La causa root de OOM continúa sin perfil real |
| T02 | #128 | `9bea0a3288561e7e311257a701f197686f5f9ae1` | Benchmarks Node/offline y documento incluidos; no presume 10 Harness vivos ni separación física de isolates |
| T03 | #135 | `b3387593a1300133aa0b15f4b2e07e204313a806` | Incluido por ascendencia de #138: admisión transaccional, capacidad 10 y fencing; solo probado con mocks/CI |
| T04 | #136 | `521257b214632d723a00e1efa9fad83f4c976ab8` | **DEFERIDO / BLOQUEANTE**: los hunks de deterministic-v1 y `continue/cancel` compiten con el inicio y fencing de #135; 6+ hunks sin contexto exacto al aplicar sobre #138. No sustituir la transacción de admisión. Integrar mediante reparación focal separada con pruebas de fallos antes de promover |
| T05 | #139 | `8b980be574a14789415db9468b934c959e1e00b5` | Integrados serializador MCP, progreso, pruebas y guarda fail-closed de export legacy; no garantiza bytes de evento crudo del SDK |
| T06 | #132, #137 revisión, #140 incremental | `77494625d921eeb4e9b3b5670203dddd3a8b9c23` (#140) | Integrada versión acumulada #140, que incorpora #132 y #121; manejo de EPIPE y procesos PGID, no resuelve setsid huérfano o cgroups/Container real |
| T07 | #142 | `be1fc4767e42cdc0e63b4687b6f84975d9860d86` | Solo contrato y pruebas offline; no se conectó ledger a ruta de inferencia ni existe corte efectivo de gasto |
| T08 | #130, #131 alterna, #138 final | `7baca594fa4ea731faf3e1d1ddd5feda2ece74b1` (#138) | Incluido por ascendencia: publicador GitHub durable integrado con T03, scope y guard server-side. No reinsertar #130/#131 sobre #138 ni asumir DO live. |
| T09 | #133 | `50742abdad67d9dc605bbd955693756eae371da5` | Contratos/routes y seguridad incluidos con parches de contexto explícito sobre `src/server.ts`, MCP y `src/dev-container.ts`; bytes solo hasta 32 KiB, sin validación multi-tenant/Android |
| T10 | #141 | `254f047653f717c7943df9d8c1bc21fcc4e4a860` | Integrado harness offline con verificaciones Ed25519 de cuatro procedencias; keys fixture no son recibos live y el colector externo no está implantado |

Las PR #128–#142 relevantes siguen candidatas independientes según última consulta. **CI verde individual no acredita composición.** La base #138 ya integra #135 + #130: al evaluar el diff del candidato no contar ese código como nuevo de T11. La PR #137 tenía alcance solo Linux; tampoco sustituye al trabajo T11 completo.

## 2. Verificaciones y conflictos de composición

- En la rama nueva `f0-c10/r2-t11-master-integration-20261123` se copiaron módulos y tests completos que no colisionan, y se aplicaron hunks exactos contra el código acumulado para #139 (`exportSessionData`) y #133 (`src/server.ts`, `src/dev-container.ts`, MCP y tests); una coincidencia textual sola **no** demuestra compatibilidad funcional.
- T09 `src/server.ts` incorporó import de artefactos por ancla verificable, pues el contexto original de #133 correspondía a otra base. T05/T09 dev-container/MCP conservan tanto protección EPIPE/PGID como bounded RPC.
- #136 T04: la posibilidad del SDK `create({id})` podría resolver creación sin recibo, pero requiere integración de deterministic session ID en transacciones de T03. Mantener **sin activar** esta reparación hasta tests de caso OOM, retry de efecto ambiguo, cancel/continue y permisos. No crear `unknown → passed` automático.
- #134 T01 R3: telemetría de fase `create/fork`/submit en candidate propio, pero depende de un bloque de inicio modificado por T03 y T04. No copiar sin adaptación y revisión de memoria/carga del serializador.
- #133 T09: captura almacenada en el DO existente está ligada a identidad de tarea y lectura de bytes; **NO** prueba alcance multitenant o Android. El upload/GET es una operación con efecto; no invocar Remote a ciegas.
- #140 T06: `setsid` puede eludir grupo PGID y heredar/redirigir pipes; controlar con scope de Container/cgroup o degradar garantía explícitamente. Discrepancia documental sobre `ctx.container.start({instance:"basic"})` sigue siendo STOP hasta pruebas compatibles.
- #142 T07: la contabilidad simulada no es interceptor de todas las llamadas/proveedores ni límite real de presupuesto; Cloudflare AI Gateway spending limit reportó `enabled=false` en la auditoría T07. Mantener `NO_LIVE`.

## 3. CI y comprobación

Al corte de creación del documento, cada PR incluible tiene CI individual éxito en su HEAD reportado/verificado por GitHub; la integración necesita nuevos checks del **HEAD exacto final**. Los workflows en esta rama separan `OpenCode validation` (Bun, typecheck, build ambos Workers/cliente, invariantes), `F0-C10 offline harness` (T10 con fallos negativos + T06 EPIPE/PGID), T01/T02 y T09 artefactos.

**Recibo de CI combinado:** actualizar después de crear PR y verificar los runs de Actions. Si una prueba falla, conservar salida/exit codes y no declarar PASS.

## 4. Runtime y versiones (solo lectura T11)

Cloudflare GET deployments antes de esta integración:
- Principal `opencode-g1-staging` deployment `36ef84b3-0f99-4dd4-ab8e-c11ee450dd23`, versión `3546687b-4cd2-4e22-8ea9-ee5ea8fd02cb`, tráfico 100 %.
- MCP `opencode-staging-control-mcp` deployment `9fdaf22d-beeb-44a0-ab68-77ecd5745fa1`, versión `196240c0-1052-47b3-aaa7-02cf5baa87f0`, tráfico 100 %.
- Remote `status=ok`, supervisor `ready=true`, inventario al menos 96 sesiones **incompleto**. Salud y sesiones indexadas no demuestran sesiones activas. Ninguna de las nuevas correcciones se ha desplegado como parte de T11.

**Histórico #90:** diez solicitudes 22/11, seis OOM, 0/10 resultados verificados. Las tareas antiguas `a642be2611220007`, `a642be2611220009` permanecían `unknown/not_found` en la auditoría T11 anterior; no fueron modificadas por este encargo.

**Costes:** 0 cargas Remote nuevas, 0 inferencias por T11; GitHub Actions/CI tienen coste operativo no medido. No afirmar que el presupuesto global esté aplicado.

## 5. STOP antes de promoción o 1→2→4→10

1. Reconciliar T04 #136 contra T03 + T08 con pruebas de transacción y caos: creación con ID determinista, pérdida de respuesta, turno doble, cancelación y generación obsoleta.
2. Resolver alcance de procesos fuera de PGID y `instance:"basic"` del Container real; fijar memoria del SDK/DO, no inferir desde Node.
3. Instrumentar observador auténtico de inferencia/herramienta y procedencia verificable; conectar T10 a firmas de colector independiente, no solo claves de fixture.
4. Implementar enforcement durable del gasto en TODAS las rutas proveedor/infra, incluyendo Workers AI, OpenRouter, Containers, Workers, CI y reintentos. Sin corte técnico, no live.
5. Auditar multi-tenant ACL y bearer/Access para capturas y descarga Android; no aceptar `/bundle` como bytes.
6. Validar binarios de ambos Workers, bindings/assets, revisiones, rollback por separado de Worker/DO/Container. `CI PASS` no autoriza deploy.
7. Solo con **lote específico** de despliegue y carga, preflight de lease atómico y recursos, ejecutar 1→2→4→10; tres campañas independientes con 10 tareas activas realmente solapadas, diez resultados hash/readback exactos, sin OOM, duplicación, huérfanos ni mezcla de scope.

**Decisión actual:** PARTIAL. Selección razonada, pruebas offline y CI del HEAD integrado (si pasa) son útiles, pero no implican COMPLETE PASS, autonomía OpenCode ni precondiciones de carga real.

## 6. Continuidad y Biblioteca

Repositorio, SHAs, PR y CI son autoridad de código. Biblioteca `/OpenCode-Cloud-F0-C10/` contiene copias T03/T06/T08/T11 y plan R2, consultadas en lectura; las copias no sincronizan con GitHub. Tras CI del candidato, guardar copia reducida de este informe y recibo en Biblioteca con versión/HEAD sin secretos. No cerrar issue #90. No fusionar el conjunto de PR superpuestas individualmente.
