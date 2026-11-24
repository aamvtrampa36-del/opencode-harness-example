# F0-C10/PREFLIGHT-03 — Presupuesto global US$2, verificación de límites e aislamiento

**Alcance y estado:** `PARTIAL / OFFLINE_BUDGET_GUARDS / STOP_LIVE / NO COMPLETE PASS`.
**Issue:** [#90](https://github.com/aamvtrampa36-del/opencode-harness-example/issues/90).
**Base verificada:** [PR #159](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/159), HEAD `63706447d36b10ccbbaa87e75cc3e9874808ad54`, CI [#45195447167](https://github.com/aamvtrampa36-del/opencode-harness-example/actions/runs/45195447167) `completed/success`.
**Rama exclusiva:** `f0-c10/preflight-03-usd2-20261123`.
**Actor:** ChatGPT vía GitHub; Cloudflare solo consultas GET, ninguna escritura. No Codex, no OpenCode Remote con efectos.
**Fecha de corte de lectura:** 23-11-2026.

## 1. Decisión explícita del propietario: US$2 TOTAL

El propietario aprobó **US$2,00** como gasto **máximo combinado del ensayo F0-C10**, no como asignación por proveedor, agente, prompt, ejecución o por día. La autorización monetaria está restringida a este ensayo: no eleva privilegios, no despliega nada y **no cambia la prohibición actual de inferencia pagada, despliegues o mutaciones compartidas**.

Valor de contrato: `2_000_000` micro-USD = `2.00 USD`. Una sola exposición agregada debe cubrir Workers AI, OpenRouter, Workers, Durable Objects, Containers, GitHub Actions **y** almacenamiento, transferencia/egress, observabilidad y gastos no clasificados. Un resultado sin precio verificable es **`UNKNOWN`**, nunca coste cero. La cifra es un **techo autorizado**, no una provisión/cargo, compra o política Cloudflare activada.

Artefacto legible por máquina: `docs/f0-c10/PREFLIGHT_03_USD2_AUTHORIZATION.json`. Conserva consentimiento numérico, todos los costes como `null`, condiciones de aislamiento no verificadas, 403 de políticas y `gate=STOP`. No contiene identificadores de cuenta, secrets ni contenidos de sesiones.

## 2. Verificación puntual de políticas modernas de Cloudflare (solo GET)

| Endpoint o característica | Resultado exacto | Inferencia legítima |
|---|---|---|
| `GET /accounts/{account_id}/billing/spend-policies` | **HTTP 403** (Authentication error); el API expone el endpoint moderno `List Spend Policies` con políticas activas/desactivadas | **No se pudo leer** inventario de reglas modernas. No inferir ausencia, importe o estado de políticas |
| `GET /accounts/{account_id}/ai-gateway/gateways` | **OK**; gateway `default`, `rate_limiting_limit=null`, `rate_limiting_interval=null`, logging activo | No se observó límite de tasa en ese objeto. No certifica corte financiero |
| `GET /accounts/{account_id}/ai-gateway/billing/spending-limit` | **OK**, API **deprecated**; `enabled=false` | Solo estado de la política antigua, no refleja necesariamente reglas modernas de gateway |
| Código de Staging / #157 | Binding directo `env.AI`, OpenRouter, SDK y Workers/DO/Containers/CI con entradas independientes | No existe evidencia de interceptor obligatorio a todas las rutas; un gateway opcional no cubre egress que lo omita |

Las reglas comerciales por gateway y las políticas de gasto de Workers/DO pueden actuar por cuenta, cubrir únicamente parte de los productos y depender de contabilidad con retraso; **no son prueba automática de factura máxima US$2**. No se modificó la facturación: una política aplicada en una cuenta compartida podría afectar otros recursos. La verificación de precio real, consumo y enforcement requiere alcance de lectura específico y pruebas posteriores autorizadas **en entorno dedicado**.

**Fuentes de semántica del proveedor**, que deben reconfirmarse en el lote operativo siguiente:
- Cloudflare Billing Spend Management: https://developers.cloudflare.com/billing/manage/spend-management/
- Cloudflare AI Gateway spend limits: https://developers.cloudflare.com/ai-gateway/features/spend-limits/
- Workers spend management: https://developers.cloudflare.com/workers/platform/spend-management/
- Containers pricing: https://developers.cloudflare.com/containers/platform/pricing/

No se comprobó ningún importe de factura actual; el coste real de GitHub Actions, Worker GET y otras lecturas es **desconocido**, no «0 USD».

## 3. Correcciones de fuente candidate **offline**, no en runtime

- `src/preflight-disposable-cost.ts`: el antiguo techo de saneamiento `MAX=1_000_000_000_000` micro-USD pasa a `F0_C10_GLOBAL_APPROVED_MICRO_USD=2_000_000`, con validación transaccional que rechaza `2_000_001`. Esto evita que un llamador del prototipo PREFLIGHT-02 inicialice accidentalmente una reserva superior al máximo del propietario. No se conectó al SDK ni a Staging.
- `src/preflight-usd2-quote.ts`: `buildUsd2DisposableShadowPolicy()` crea **un solo ledger** de US$2 con las seis categorías, no seis presupuestos individuales de US$2. `evaluateUsd2ShadowQuote()` contempla también cuatro tipos de costes indirectos, rechaza números negativos, fraccionarios o desconocidos, múltiples DO de control y suma superior a `2_000_000`. Todos los resultados son `STOP`, incluso si una simulación encaja en el techo; **no** emite token de GO.
- `scripts/f0-c10/preflight-03-usd2.mjs`: verifica manifest de consentimiento estricto, bloqueos actuales y diez costes desconocidos; produce `STOP` con **exit 2**. Un JSON alterado para declarar gastos `0`, cambiar base SHA, alterar importe o falsificar `GO` es rechazado.
- `src/preflight-usd2-quote.test.ts` y `scripts/f0-c10/preflight-03-usd2.test.mjs`: tests positivos/negativos de límite exacto US$2, diez reservas concurrentes, rechazo al centavo/micro-USD extra, presupuestos por proveedor acumulados, costos ocultos y claims falsos.
- `scripts/f0-c10/preflight-03-usd2-known-red.red.mjs`: dos errores de diseño reproducidos como **RED deliberados**: duplicar US$2 en proveedores separados, y reemplazar overhead desconocido por cero. CI debe exigir su fallo previsto, no usarlos como criterio de PASS.
- `.github/workflows/f0-c10-preflight-03-usd2.yml`: pruebas focales, STOP, RED conocido, regresión completa Bun, preview, typecheck, builds principal/MCP/web, invariantes. No secrets, no despliegue, ni gastos de inferencia.

## 4. Gates de capacidad operativa y seguridad

| Gate | Estado demostrado | Necesario para futuro GO |
|---|---|---|
| Consentimiento numérico | **VERIFIED: US$2 total** | Conservar `2_000_000` como máximo, sin defaults por proveedor |
| Ledger de un DO local | **PARTIAL / test offline** | Verificar DO exclusivo **físico**, única ruta de reserva y fencing en servicio |
| Proveedor y control de gasto | **BLOCKED** | Inventario moderno de políticas legible, techo/corte real comprobado de **todas** las rutas o bloqueo seguro de las no cubiertas |
| Presupuesto de infraestructura | **BLOCKED** | Cuenta/entorno sin otros proyectos, coste de Containers/DO/Workers/CI/almacenamiento/egress mensurable con límite duro que no permita rebasar US$2 |
| Respuesta perdida/TTL | **PARTIAL / test offline** | Controlar efecto ambiguo con recibos nativos y guardia de propietario original |
| Identidad staging y rollback | **NOT TESTED en live** | Identidad binaria de Workers, DO/Containers/snapshot, rollback sin tocar producción ni sesiones previas |
| E2E 10 simultáneos | **NOT TESTED en live** | Tres campañas reales posteriores, con trazas firmadas y outputs/ACL probados |

**Decisión:** `STOP` si cualquier coste es desconocido, una ruta de proveedor elude el corte, el namespace/identidad no son aislados o el gasto por otro DO puede evadir el ledger. El escenario de factura estrictamente acotada US$2 exige más que un límite mensual de cuenta configurado con consistencia eventual.

## 5. Receta futura de control efectivo (NO ejecutada)

1. Aislar cuenta/billing/proyecto y DO/Container nuevos de cualquier servicio existente; probar que todos los ejecutores llegan al **mismo** propietario de reservas y nadie puede escribir fuera del scope. Ninguna migración de datos históricos.
2. Conseguir credencial **de solo lectura** que permita consultar los Spend Policies modernos, además de observabilidad de gasto y reglas vigentes; no ajustar límites de una cuenta compartida para conseguir éxito artificial.
3. Encerrar las rutas Workers AI/OpenRouter/SDK bajo un único interceptor server-side, con **denegación por defecto** de rutas no medibles y de egress alternativo. Pre-reservar coste máximo por operación y retener UNKNOWN; corroborar límites externos reales.
4. Reservar techo **menor o igual a US$2** considerando coste residual de infraestructura, creación de recursos, logs y CI, no solo tokens de modelo. Si el producto no proporciona corte exacto, **no se puede garantizar US$2** con ese proveedor: STOP o elegir un entorno que sí lo haga.
5. Solo con observador autenticado, aislamiento y rollback ensayado, documentar una autorización operacional separada para una solicitud mínima. La presente preparación **no** permite esa solicitud, y aún menos 1→2→4→10.

**No se ejecutaron** pruebas reales, despliegues, modificaciones de billing ni operaciones con efectos de OpenCode Remote. Los importes de los fixtures son matemáticos, no precios reales.

## 6. Cierre

**RESULTADO:** `PARTIAL / USD2_OFFLINE_ENFORCED / CLOUD_BILLING_403 / STOP_LIVE`.
**EVIDENCIA:** PR draft de PREFLIGHT-03 y CI del HEAD (añadir recibo verificado al cierre), pruebas RED/GREEN, manifest, Cloudflare GET con 403.
**BLOQUEANTE:** falta permiso para leer políticas modernas y no se ha demostrado una frontera completa y exacta de corte de gasto ni un control DO aislado real.
**COSTE:** no se generaron solicitudes de inferencia, ni despliegues; costes de CI/consultas desconocidos.
**PRÓXIMA ACCIÓN ÚNICA:** obtener visibilidad de políticas actuales y preparar un entorno **realmente aislado** con límite eficaz demostrable antes de solicitar prueba de pago. Si los US$2 no se pueden garantizar, `STOP`.

**Estado #90:** `PARTIAL / NO COMPLETE PASS`.


## CONSOLIDACION-01 — revalidación posterior del 23-11-2026

Véase [F0_C10_CONSOLIDACION_01.md](F0_C10_CONSOLIDACION_01.md). Cloudflare ADMIN GET de Spend Policies ya devuelve éxito y lista vacía (0); el 403 previo es histórico. #375 conserva ETag y bindings de #374, con cache_options distinto. No demuestra procedencia binaria GitHub ni corte financiero. El recibo original permanece intacto; el nuevo manifiesto revalidado conserva STOP y todos los costes desconocidos. #160 aporta cuatro regresiones transaccionales al candidato #161, sin duplicar ledger, workflow ni constante de techo. Las tres rutas divergentes de Staging ya contienen la reparación funcional en #161; no se sobrescriben las guardas transaccionales R2/R3. Estado PARTIAL / STOP_LIVE; CI combinado del nuevo HEAD pendiente. Ningún cierre, merge, deploy ni llamada de inferencia.
