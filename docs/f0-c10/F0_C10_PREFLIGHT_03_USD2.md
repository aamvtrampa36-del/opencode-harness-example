# F0-C10/PREFLIGHT-03 — Límite total US$2 y verificación de controles (sin ejecución real)

**Fecha de la decisión:** 2026-11-23.
**Autorización del propietario:** **US$2,00 como techo máximo agregado** del futuro ensayo F0-C10. No es US$2 por sesión, proveedor, intento, Worker o modelo. Incluye todos los gastos atribuibles, incluidos GitHub Actions, Workers AI/OpenRouter, Workers, Durable Objects, Containers y partidas adicionales como almacenamiento/telemetría cuando sean facturables.
**No supone autorización de gastar ahora:** el lote actual es solo consultas, código/CI offline en rama exclusiva y documentación; no modificar facturación ni despliegues.
**Repositorio:** `aamvtrampa36-del/opencode-harness-example`.
**Issue maestro:** [#90](https://github.com/aamvtrampa36-del/opencode-harness-example/issues/90).
**Base exacta comprobada:** PR draft [#159](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/159), HEAD `63706447d36b10ccbbaa87e75cc3e9874808ad54`, CI [#45195447167](https://github.com/aamvtrampa36-del/opencode-harness-example/actions/runs/45195447167) completed/success.
**Rama de trabajo:** `f0-c10/preflight-03-usd2-cap-20261123`.
**Actor real:** ChatGPT mediante GitHub. No OpenCode Remote con efectos; no Codex; Cloudflare **solo GET**, sin cambios de cuenta.

## 1. El límite y su alcance

Se expresa sin redondeo como:

- `USD 2.00` = **200 centavos de USD** = **2.000.000 microUSD**.
- Es un **máximo acumulado**, no un objetivo ni la suma de seis cuotas adicionales.
- **No hay reparto por servicio autorizado**: no inventar importes por modelo/servicio. Las seis categorías son dimensiones para registrar exposición, no seis presupuestos independientes de US$2.
- No existe saldo inicial, consumo histórico conciliado ni coste por ejecución certificado. Para una reserva real, el gasto acumulado atribuido al experimento tendría que poder leerse y conciliarse **antes** de permitir una solicitud.
- No incluye tácitamente margen adicional por reintentos, fees, latencia de facturación ni cargos de infraestructura. Ninguna operación nueva debe iniciarse si la exposición máxima incluyendo incertidumbre no cabe en lo restante.
- Una aprobación del techo no es un consentimiento de modificar restricciones de **toda una cuenta compartida** o perjudicar otros servicios.

El artefacto sanitizado `preflight-03-usd2-observed-20261123.json` registra esta decisión y observaciones de lectura, **no** credenciales, IDs de cuenta, respuestas del usuario, claves ni un recibo de facturación.

## 2. Código creado o ajustado

La función `cleanPolicy()` en `src/preflight-disposable-cost.ts` ahora rechaza cualquier política con `totalMicroUsd > F0_C10_APPROVED_MAX_MICRO_USD = 2_000_000`, antes de escribir en el ledger. Los registros persistidos por el contrato candidato se decodifican también con ese límite y cada reserva individual se acota.

El contrato de PREFLIGHT-02 conserva los seis tipos `workers_ai`, `openrouter`, `workers`, `durable_objects`, `containers`, `github_actions`; su suma está limitada **solo dentro del mismo DO**. Los tests de PREFLIGHT-03 cubren US$2 exactos, US$2.000001 rechazados, seis reservas concurrentes bajo una cota global, intento de sobrepasar en US$0,01, receipts ambiguos/restarts, política immutable, y dos DO distintos sumando US$4 para demostrar la **debilidad arquitectónica**.

**No se ha introducido un `maxUsd: 2` como configuración activa de Staging, no se han fijado límites nuevos en la cuenta, ni se ha conectado el módulo al SDK.** `providerDispatchAuthorized: false` permanece invariable; por diseño el guard actual **no es capaz de conceder un GO live**.

### Verificaciones

```bash
bun test src/preflight-exclusive-lease.test.ts src/preflight-disposable-cost.test.ts
node --test scripts/f0-c10/preflight-02-known-red.red.mjs # RED deliberado; exit 1 esperado
node --test scripts/f0-c10/operational-preflight.test.mjs
node scripts/f0-c10/operational-preflight.mjs --snapshot docs/f0-c10/preflight-01-observed-20261123.json # STOP / exit 2
bun test
bun scripts/test-preview.mjs
bun run typecheck
bun run build
bun scripts/check-invariants.mjs
```

El workflow `.github/workflows/f0-c10-preflight-03.yml` ejecuta estas pruebas y comprueba el SHA de checkout **del HEAD final**, sin token de despliegue, ni secreto externo, ni calls pagadas. **Importante:** GitHub Actions consume recursos; su coste facturado total todavía no se ha reconciliado y no puede asumirse igual a cero. El resultado del workflow debe anotarse como CI offline, nunca como ensayo con límite de factura verificado.

## 3. Lecturas actuales de Cloudflare y decisión de facturación

Se repitieron GET autorizados el 23 de noviembre de 2026, sin exponer identificadores de cuenta:

| Fuente leída | Hecho verificable | Implicación |
|---|---|---|
| `/billing/spend-policies` (API de Spend Policies moderna) | **HTTP 403**; autenticación/permisos insuficientes | **BLOCKED**: imposible inventariar reglas modernas efectivamente vigentes |
| AI Gateway `default` | `rate_limiting_limit=null`, `rate_limiting_interval=null` | La respuesta no demuestra un límite de tasa activo; tampoco prueba otros límites modernos |
| `/ai-gateway/billing/spending-limit` (API obsoleta) | `enabled=false` | Solo representa el endpoint legacy; **no** significa que todos los límites modernos estén ausentes |
| Worker `opencode-g1-staging` | Deployment `36ef84b3-0f99-4dd4-ab8e-c11ee450dd23`, version `3546687b-4cd2-4e22-8ea9-ee5ea8fd02cb`, 100% | Sigue sin acreditarse identidad binaria del candidato #159 |
| MCP `opencode-staging-control-mcp` | Deployment `9fdaf22d-beeb-44a0-ab68-77ecd5745fa1`, version `196240c0-1052-47b3-aaa7-02cf5baa87f0`, 100% | No se ha publicado candidato nuevo |

Un spend limit de proveedor o gateway puede ser asíncrono/eventualmente consistente; no constituye por sí solo una factura máxima exacta durante ráfagas concurrentes. Además, una ruta directa `env.AI` o salida SDK/OpenRouter fuera del gateway puede eludir una política de gateway. Las reglas Workers/DO pueden estar ligadas a la cuenta compartida y no cubrir Containers, almacenamiento o CI.

**Hallazgo prioritario:** ni leer las políticas modernas existentes es posible con el acceso actual, mucho menos certificar un corte duro de las seis categorías con el techo US$2. La respuesta 403 se conserva como evidencia de un bloqueo, no como prueba de ausencia de límites.

## 4. Condiciones mínimas para un futuro GO auténtico

El siguiente gate no deberá basarse en el JSON offline ni en la presencia de un saldo/prepago. Exigir:

1. **Autoridad aislada:** un único lease/fencing comprobado desde los ejecutores reales sobre un DO/namespace descartable, sin tocar legados ni permitir tomarlo por TTL cuando persiste un efecto ambiguo.
2. **Control de pagos externo:** acceso autorizado de lectura para inventariar Spend Policies actuales; comprobar límites reales del proveedor y/o una cuenta separada con contención efectiva, sin crear reglas compartidas ni sobreescribir políticas existentes.
3. **Intercepción obligatoria:** todas las rutas de inferencia (Workers AI/OpenRouter/SDK/fallback), y los costes de Workers, DO, Containers, CI y almacenamiento/observabilidad, están contabilizados o prohibidos inequívocamente; **ninguna ruta directa** sin control.
4. **Coste máximo conservador:** coste de peor caso y obligaciones pendientes cuantificadas por operación; suma de gasto liquidado + exposición desconocida + costes fijos/inerciales no supera US$2, incluyendo cualquier run de CI. Si alguna tarifa o cola de facturación no es verificable → **STOP**.
5. **Observador y reversión:** identidad de binarios/despliegues, trazas independientes, guardas de salida, backup/recuperación DO y Container separados de rollback de Workers.
6. **Prueba mínima aparte:** solo después de un preflight técnico `GO`, y tras el lote operativo autorizado, una operación real con límites, tiempos, limpieza y recibo medidos antes de intentar 1→2→4→10.

**No existe hoy una manera comprobada en el proyecto de garantizar de forma estricta la factura total US$2 en esa cuenta; por tanto, NO ejecutar tráfico de prueba.** Una futura solución podría requerir cuenta separada/prepago y deshabilitar toda vía que no acepte tope previo verificable. No prometer que comprar crédito de US$2 garantiza corte de facturación.

## 5. Resultado y continuidad

**RESULTADO:** `PARTIAL / USD2_CEILING_SOURCE_PASS_PENDING_FINAL_CI / BILLING_HARD_CUTOFF_BLOCKED / STOP_LIVE`. Comprobar jobs y HEAD exacto en PR nueva.
**EVIDENCIA:** PR draft de PREFLIGHT-03, comparaciones GitHub/Cloudflare de lectura, JSON sanitizado, tests RED/GREEN de US$2, informe y CI del SHA final (a enlazar en el comentario de PR).
**BLOQUEANTE:** lectura de políticas modernas Cloudflare (403), ausencia de hard cutoff completo y lease cloud real, gastos CI/infra desconocidos, sin aprobación de reparto por servicio (no es necesario inventarlo).
**COSTE:** inferencias y despliegues realizados por este lote = ninguno; coste facturado de CI/otras consultas = **NO MEDIDO**, no confundir con US$0.
**PRÓXIMA ACCIÓN:** obtener capacidad de **lectura** de límites modernos y demostrar una contención económica real sobre cuenta/entorno separado antes de solicitar un gasto experimental. No iniciar campañas ni nuevos proveedores para aparentar GO.

**F0-C10:** `PARTIAL / NO COMPLETE PASS`; issue #90 abierto.
