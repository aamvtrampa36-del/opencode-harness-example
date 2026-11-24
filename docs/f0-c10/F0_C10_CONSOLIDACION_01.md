# F0-C10/CONSOLIDACION-01 — 23-11-2026

Actor: ChatGPT / GitHub, Cloudflare ADMIN GET only. Scope: f0-c10/consolidacion-01-20261123; no Remote tasks, billing mutation, main/Prod, deploy, merge or live resources.

## Fuentes exactas
- Base #161: cdca028efcef812ede450d445d83f599c365a804; CI histórico #45210054575 (no es CI del nuevo HEAD).
- Hermana #160: d72ffed90e42ef4e7cdde8b847cfbed0d1aa4b36; CI histórico #45209319182. Base común #159: 63706447d36b10ccbbaa87e75cc3e9874808ad54.
- Staging: 0e3b4e040304d4450f1f142e261bc5e76168e619; merge-base b23773c17a188b4c6c50fadc3097d47abc1235f0. Comparación: 6 commits de Staging, 266 del candidato.

## Equivalencias (inspección de fuente, no aceptación runtime)
| Origen | Decisión |
|---|---|
| #160 | Se conservan las cuatro pruebas adicionales reales de ledger: cap exacto, suma de seis servicios, UNKNOWN/reinicio y contraejemplo dos DO. Se adapta solo nombre de constante y error al contrato #161. Snapshot histórico de #160 conservado sin modificar. No se añade su workflow duplicado. |
| #161 | Se mantiene único código ledger, techo 2_000_000 microUSD, quote con overhead y RED históricos. |
| #99 y seis commits Staging | Preview blob idéntico ea7e5269e1dca8a6a98f9c60db81c65e04f2a0c7; las cuatro regresiones de receipts ya están en el candidato, más una de cancelación legacy; server.ts usa reconciliación transaccional y devuelve error reconciliado. No aplicar patch antiguo sobre guardas nuevas. |
| #157/#158/#159 | Ancestros de #161 según cadena de PR; preservar source y checks, no fusionar PR por separado. #149/#146/#145/#144/#143/#126 forman parte de la cadena documentada en #157. Los especialistas #147–#156 tienen integración declarada en #157; no se certifica equivalencia archivo por archivo ni se propone cierre automático. |

## Operación actual
- Spend Policies GET success true, result [], 0 políticas devueltas. El HTTP 403 anterior se conserva como histórico. No hay evidencia de hard cutoff integral. No se cambia ninguna política.
- Worker #375 0255f6c2-2307-479c-9ff0-89986af4a760, #374 3546687b-4cd2-4e22-8ea9-ee5ea8fd02cb. ETag idéntica 6fb589599ab9a0eacca0929a48900b21dd3da54db6d0bc2b1297f1a20ee5032b; bindings iguales; solo cache_options difiere entre campos de script_runtime observados (#375 enabled true, cross_version_cache false). No identidad completa de assets, SHA o estado DO. No deploy ejecutado.
- US$2 TOTAL, no por ruta; no autorización de pago. Diez categorías siguen null. STOP_LIVE, providerDispatchAuthorized=false, sin lease ni hard cutoff real.

## Pruebas y límites
Se verificó el prefijo idéntico de suite #160/#161 y se ejecutó en V8 aislado la función JavaScript real evaluateUsd2ApprovalReceipt extraída sin imports ni CLI: 26 comprobaciones positivas y adversariales PASS. Se añadieron tres tests Node (incluye CLI exit 2) y cuatro casos Bun de #160; su ejecución completa queda pendiente. No hay Bun ni acceso de red al repo en el entorno local. Workflows de #161 inspeccionados: la rama nueva no coincide con push filters, PR contra #161 no coincide con sus filtros salvo Android (sin cambios Android). Commit marcado [skip ci], no se inicia CI facturable ni se modifica workflows. Coste histórico CI/API no conciliado. Verificar posteriormente CI del nuevo HEAD con autorización y runner/coste controlado; no usar CI histórico como prueba del candidato.

RESULTADO: PARTIAL / SOURCE_CONSOLIDATED / FOCAL_JS_PASS / FULL_CI_PENDING / STOP_LIVE / NO_COMPLETE_PASS. Mantener issue #90 abierto. Próxima acción: validar suite completa exact HEAD en entorno offline, después evaluar aislamiento y corte económico antes de cualquier efecto.
