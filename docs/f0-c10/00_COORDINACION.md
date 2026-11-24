# F0-C10 — Coordinación de segunda ronda (R2)

**Corte:** 2026-11-22, America/Sao_Paulo. **Estado:** plan, no aceptación E2E. **Autoría:** ChatGPT. Documento del maestro; especialistas no deben sobrescribirlo.

## Autoridades y snapshots

- Plan focal: `docs/f0-c10/F0_C10_PLAN_INTEGRAL.md` (versión R2); archivo adjunto del Proyecto/Biblioteca no se sincroniza automáticamente con GitHub.
- Fuente de integración: [PR #126](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/126), base `11161dd6f2c4b5237a2da59d7275ff693e0afdbe`, HEAD candidato `1268ba22f26330d619b046fcf551ca846cb69d0f`, draft/unmerged al corte. CI de dicho HEAD: `45093134023`, `45093134014`, `45093134038`, completed/success.
- Incidente: [issue #90](https://github.com/aamvtrampa36-del/opencode-harness-example/issues/90), sin COMPLETE PASS. Worker activo `3546687b-4cd2-4e22-8ea9-ee5ea8fd02cb`, MCP `196240c0-1052-47b3-aaa7-02cf5baa87f0`. Revalidar antes de usar.
- Source of truth: GitHub para código/CI; Cloudflare para binarios/runtime; OpenCode Remote solo para la ejecución que demuestre; Biblioteca como copia de artefactos, nunca fuente única.

## Mapa de trabajos

| Encargo | PR previa | Bloqueo R2 | Superficie principal | Dependencia |
|---|---|---|---|---|
| T01 | #116 | atribución del OOM, heap por etapa | diagnóstico/telemetría | T02/T05 |
| T02 | #115 | memoria de supervisor único vs aislamiento | benchmark arquitectura/prototipos | T01/T03 |
| T03 | #125 | admisión durable/fencing | scheduler/ledger | T04/T07 |
| T04 | #120 | crear sesión sin recibo y cancel race | journal/recovery | T03 |
| T05 | #114 + #106 | evento gigante/transcript y cursor | RPC, MCP/progreso | T01/T04 |
| T06 | #121 | descendientes/orfandad de procesos | Linux/Container | T02 |
| T07 | #117 | límites upstream y corte real de gasto | proveedor/contabilidad | T03 |
| T08 | #122 + #124 | carrera de escritores GitHub | bridge/repos | T03 (solo interfaz) |
| T09 | #123 | endpoint/lectura autenticada de bytes | archivos/UI | T10 |
| T10 | #118 + #119 | telemetría live autenticada | harness/evaluación | T01/T09 |

## Reglas operativas de las diez continuaciones

1. Cada especialista continúa **en el mismo chat** de su entrega anterior, no asume contexto de otros chats, y revalida todo contra GitHub.
2. Crear rama propia `f0-c10/r2-tXX-<fecha>` desde el SHA correcto; no escribir `main`, Staging, #126 ni ramas ajenas. El PR draft debe declarar actor, head/base, diff, pruebas y coste.
3. Preferir OpenCode para programación solo con lease exclusivo, control técnico de gasto y permisos de herramienta verificables. Si no hay tales condiciones, trabajar con código/CI/fixtures offline y atribuir a ChatGPT su autoría.
4. No efectuar merge, deploy, cambios de Worker, DO/Containers persistentes, Access, secretos o pruebas masivas. No reutilizar IDs `unknown/not_found` para reintentar efectos; nunca inventar tiempos o resultados.
5. Antes de cambiar `src/server.ts`, comparar #126, T03/T04/T05 e identificar hunks. No duplicar el scheduler ni un sistema de colas innecesario. El siguiente T11 integra.
6. Actualizar el informe de TXX **en su propia rama** con sección R2 (o nuevo `XX_CONTINUACION_R2.md` si es más seguro). Guardar informe y evidencia en Biblioteca personal **solo si** existe permiso/conexión y se comprueba el recibo; si no, entregar archivo descargable y marcar no publicado.
7. Cerrar cada T con `RESULTADO | EVIDENCIA | BLOQUEANTE | PRÓXIMA ACCIÓN`, separando PASS de subsistema, CI y runtime. Ninguno declara COMPLETE PASS global.

## Cadena de integración

R2 investigaciones y PR separados → T11 consolida frente a #126 → CI del HEAD integrado y revisión de seguridad → preflight de despliegue/coste/lease si se autoriza expresamente → E2E de 1→2→4→10 → tres rondas 10/10 con telemetría auténtica, descargables y sin OOM → auditoría y aceptación del propietario.

**STOP** ante lease ambiguo, límite de gasto no aplicado, OOM, pérdida de identidad SHA, evento o dato sensible, migración no autorizada o mezcla de proyectos.

# PARTE R3 — Coordinación de tercera ronda (corte 2026-11-23)

**Esta parte reemplaza el mapa de siguiente acción R2, no su historia.** La cadena de código base es #126→#143→#144→#145, todas PR draft/no merge, HEAD histórico de #145 `a49e985909cb56bb42c609c9cd5cb4250a620169`. CI #45106083359 PASS offline, sin DO live. Plan R3 en `F0_C10_PLAN_INTEGRAL.md` §§32–39. Retrospectiva en `15_RETROSPECTIVA_Y_CONTROLES_R3.md` y prompts completos en `16_RONDA_3_PROMPTS.md`. La PR #127 era el documento R2 separado, pero #143 copió plan y coordinación al árbol de código. No asumir que Biblioteca/adjuntos reflejan automáticamente esos commits.

## R3 — Propiedad, entradas y handoff

| T | PR históricas pertinentes | Único problema R3 | Consumidor directo |
|---|---|---|---|
| T01 | #116/#129/#134 | perfil OOM por fases en supervisor #145 | T11, insumo T02/T05 |
| T02 | #115/#128 | memoria/aislamiento, criterio no migración vs coordinador | T11 |
| T03 | #125/#135/#138/#145 | legacy fuera de slots, readmisión y fencing | T11, contrato T04/T07 |
| T04 | #120/#136/#144/#145 | SDK real, recuperación y creadores tardíos | T11, contrato T03 |
| T05 | #106/#114/#139 | SDK event/log limits, MCP states de R2 | T11 |
| T06 | #121/#132/#140 | procesos detached, EPIPE, Container boundary | T11 |
| T07 | #117/#142 | hard stop medido e inferencia integrada T03 | T11 |
| T08 | #122/#124/#130/#138 | escrituras GitHub CAS multiwriter y branch isolation | T11 |
| T09 | #100/#123/#133 | ACL, bytes, caducidad, Android | T11 |
| T10 | #118/#119/#141 | procedencia runtime y 10 intervalos reales medibles | T11 |

## R3 — Contrato único de avance

Cada T lee su chat anterior, revalida #145 y dependencias, implementa lo mínimo útil en rama propia, corre pruebas RED/GREEN + CI HEAD, documenta en GitHub y confirma copia no sensible en Biblioteca. **El cierre es un solo `HANDOFF A F0-C10/R3-T11`; NO genera prompt de seguimiento del mismo especialista.** T11 recolecta las diez PR desde GitHub y copias de Biblioteca sin pedir pegarlas en este chat. Cada reporte incluye autoría, costes y conflictos. T11 elige cambios sin doble merge de ancestros y ejecuta regresión del HEAD final.

## R3 — STOP y autonomía

Solo lecturas GitHub/Cloudflare/Remote, ramas propias de código offline, PR draft, CI, docs y Biblioteca con recibo. Sin merge, deploy, Producción/main, DO/Containers persistentes, secretos/Access, reintentos ciegos, pago de inferencia ni prueba real 1→2→4→10. OpenCode es ejecutor preferente solo con capacidad/lease/exclusión y hard stop efectivos; de otro modo ChatGPT trabaja offline declarando actor. `status=ok` Remote no equivale a autonomía ni diez activos.

**Verificación decisiva:** no cerrar #90 sin tres campañas de diez tareas realmente solapadas y diez outputs por campaña, OOM/control coste/aislamiento/recuperación y readback autenticados.

## R3-T11 — Consolidación ejecutada en candidato aislado

Las diez PR R3 [#147–#156](https://github.com/aamvtrampa36-del/opencode-harness-example/pulls) fueron recuperadas y conciliadas por ChatGPT/GitHub en [PR draft #157](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/157), rama `f0-c10/r3-t11-integration-20261123`, base T01 #149 (incluye #146 y #145). No hubo ejecución de OpenCode Remote con efectos, Codex, merge, deploy, modificación de DO/Containers, secretos ni inferencia pagada. Registro canónico de SHAs, conflictos, pruebas, autoría, costes desconocidos, GO/STOP y evidencias: `11_CONSOLIDACION_R3.md`.

CI fuente corregida en SHA `4e2c7af50616658fb01509196946d300a7ed7f6e`: [OpenCode validation #45115683151](https://github.com/aamvtrampa36-del/opencode-harness-example/actions/runs/45115683151) y [R3 integrated #45115683117](https://github.com/aamvtrampa36-del/opencode-harness-example/actions/runs/45115683117), ambos success, luego de resolver el test T06 contra la nueva negación de hardlink T09. El HEAD de los commits documentales posteriores requiere una última revalidación mediante checks del PR. `PARTIAL / STOP_LIVE`: una prueba workerd local/CI no prueba diez OpenCode simultáneos ni diez resultados reales. El siguiente gate es preflight auténtico de entorno aislado con lease y corte de gasto bajo **lote operacional posterior**, no continuación automática de T01–T10.


## PREFLIGHT-01 — Puerta operativa de solo lectura y continuidad

Desde la integración #157 (HEAD histórico `304145eca71a5ffcf6d9c235e67a8065718c6ae5`) se prepara en rama independiente `f0-c10/preflight-01-operational-stop-20261123` el informe `docs/f0-c10/F0_C10_PREFLIGHT_OPERATIVO.md`. Los controles reales de presupuesto, exclusividad, provenance binaria, memoria/cgroups, ACL y observador **no** están completos. AI Gateway devuelve `enabled=false` en su endpoint legacy de spending limit; no se tocaron límites de cuenta ni servicios. La herramienta de auditoría es offline, retorna siempre `STOP`/exit 2, y no puede ejecutar un GO/live. El siguiente gate no es una ronda R4 ni un deploy: probar el corte efectivo de gasto y un lease aislado verificable, mediante una autorización operativa y techo de USD definidos antes de cualquier efecto real.


## PREFLIGHT-02 — Una sola preparación hacia la puerta operacional

Rama exclusiva `f0-c10/preflight-02-cutoff-lease-20261123` desde PR #158 `2231c385dfb5e3d17d84cedafc997c557e2e990d`. Se crearon fixtures de carrera de diez claims, replay y fencing con TTL sticky, más reserva de coste transaccional **en DO sintético** sin autorización de proveedor. CI del SHA final se registra en la PR draft de este preflight; informe: `docs/f0-c10/F0_C10_PREFLIGHT_02_COST_LEASE.md`.

Los límites de Cloudflare no se modificaron. `GET /billing/spend-policies` retornó HTTP 403; no inferir si hay límites activos. No hay un techo numérico de gasto autorizado, y el SDK/Containers/CI no han probado corte efectivo en un entorno aislado. **Próximo gate único:** validar cuenta/namespaces realmente aislados con límites observables y un presupuesto máximo USD aprobado, sin otro prompt de diez especialistas ni inferencia antes de pruebas de contención auténticas.


## PREFLIGHT-03 — Presupuesto autorizado US$2, preparación offline

Partiendo de PR #159 HEAD `63706447d36b10ccbbaa87e75cc3e9874808ad54`, rama exclusiva `f0-c10/preflight-03-usd2-20261123`. El techo del propietario es **US$2,00 global** incluyendo inferencia e infraestructura; ni por tarea ni por modelo. Cambios de código/contratos y pruebas de fuente: `src/preflight-disposable-cost.ts`, `src/preflight-usd2-quote.ts`, `docs/f0-c10/PREFLIGHT_03_USD2_AUTHORIZATION.json`; fuente documental `F0_C10_PREFLIGHT_03_USD2.md`. CI exacto HEAD se registra en la PR draft. Cloudflare `GET /billing/spend-policies` respondió HTTP 403, sin modificación de facturación. Todos los efectos reales siguen `STOP`. Único siguiente gate: demostrar un interceptor, cuenta/namespace exclusivo y corte de **todos** los costes atribuibles compatible con US$2. Ningún efecto de inferencia ni despliegue autorizado en este lote.


## CONSOLIDACION-01 — revalidación posterior del 23-11-2026

Véase [F0_C10_CONSOLIDACION_01.md](F0_C10_CONSOLIDACION_01.md). Cloudflare ADMIN GET de Spend Policies ya devuelve éxito y lista vacía (0); el 403 previo es histórico. #375 conserva ETag y bindings de #374, con cache_options distinto. No demuestra procedencia binaria GitHub ni corte financiero. El recibo original permanece intacto; el nuevo manifiesto revalidado conserva STOP y todos los costes desconocidos. #160 aporta cuatro regresiones transaccionales al candidato #161, sin duplicar ledger, workflow ni constante de techo. Las tres rutas divergentes de Staging ya contienen la reparación funcional en #161; no se sobrescriben las guardas transaccionales R2/R3. Estado PARTIAL / STOP_LIVE; CI combinado del nuevo HEAD pendiente. Ningún cierre, merge, deploy ni llamada de inferencia.
