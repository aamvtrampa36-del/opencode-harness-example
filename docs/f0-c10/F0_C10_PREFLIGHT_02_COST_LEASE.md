# F0-C10/PREFLIGHT-02 — Lease aislado y contención de gasto antes de cualquier operación real

**Estado de fuente (pendiente CI del HEAD final):** `PARTIAL / ISOLATED_OFFLINE_CONTRACT / HARD_CUTOFF_EXTERNAL_BLOCKED / NO_RUNTIME_PASS`.
**Issue:** [#90](https://github.com/aamvtrampa36-del/opencode-harness-example/issues/90).
**Punto de partida exacto:** PR [#158](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/158), HEAD `2231c385dfb5e3d17d84cedafc997c557e2e990d`, CI [#45191140043](https://github.com/aamvtrampa36-del/opencode-harness-example/actions/runs/45191140043) completed/success.
**Rama aislada:** `f0-c10/preflight-02-cutoff-lease-20261123`.
**Actor real:** ChatGPT mediante GitHub. No Codex; no OpenCode Remote con efectos. Cloudflare únicamente consulta GET de facturación/configuración, sin cambios.

## 1. Problema decisivo y contrato

La [PR #157](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/157) está validada como código offline, pero no tiene lease operativo exclusivo de una campaña ni proveedor/infraestructura bajo corte total de gasto. T03 controla hasta diez tareas dentro del **DO actual**; eso no equivale a tener un entorno de prueba exclusivo frente a sesiones heredadas o otros DO. T07 mantiene un ledger de inferencia por proveedor **sin interceptor SDK** y sin hard cutoff efectivo de Workers, DO, Containers y CI. El preflight #158 es intencionadamente un verificador `STOP`, no autorización operativa.

Este lote crea **un contrato transaccional reutilizable y probado offline**, no un nuevo scheduler ni una cuenta/namespace o DO real. La implementación no está conectada a `src/server.ts` ni al SDK: **NO DISPONIBLE EN STAGING**.

## 2. Fuente nueva, aislada y reversible

| Archivo | Qué implementa | Qué no prueba |
|---|---|---|
| `src/preflight-exclusive-lease.ts` | Ledger único por DO dedicado; bootstrap rechaza DO con filas preexistentes; claim/renovación con token aleatorio, generación, plazo y transacciones; concurrencia: solo un titular; estado `effect_unknown` write-ahead sticky; vencimiento **no transfiere lease**; no se elimina ningún dato | Que el DO esté realmente aislado, que un propietario antiguo haya terminado, exclusión entre **varios** DO/Workers o proveedores |
| `src/preflight-disposable-cost.ts` | Techo global y por servicio en **micro-USD**, para exactamente seis categorías: Workers AI, OpenRouter, Workers, DO, Containers y GitHub Actions; política inmutable en el scope; reservas de máxima obligación en la **misma transacción** que comprueba fencing; journal pre-envío de efecto ambiguo; cancelación solo antes del envío | Un límite de facturación real, cobertura de SDK y rutas alternativas, coste de reposo/almacenamiento, cumplimiento de cuota en toda la cuenta |
| `src/preflight-exclusive-lease.test.ts` | Carrera de diez propietarios, deduplicación de claim, rechazo después de TTL, reboot/replay, vieja generación, fallo transaccional, inspección sin token | DO Cloudflare auténtico, WAN, invocador antiguo en movimiento |
| `src/preflight-disposable-cost.test.ts` | Carreras con diez reservas, límites y reconciliación de 100 replays, tentativas desconocidas, cancelación antes del envío, cambio de política y owner stale, rechazo de GO financiero | Interceptor/corte del proveedor |
| `scripts/f0-c10/preflight-02-known-red.red.mjs` | Dos fixtures **RED deliberados**: takeover solo por TTL, diez ledgers individuales gastando un techo supuestamente global | Solo describe diseño inseguro; **no** requiere fallar CI principal |
| `.github/workflows/f0-c10-preflight-02.yml` | GREEN Bun focal, RED separado con código de salida esperado, `STOP` del #158, Bun completo, preview, typecheck, build principal/MCP/web, invariantes del SHA de ejecución | Prueba de carga real, despliegue, coste físico |

**Reglas de seguridad importantes:**
- Un permiso de escribir `effect_unknown` localmente **no** es una autorización al SDK o al proveedor. `armReservedDisposableExpense()` devuelve **`providerDispatchAuthorized:false` siempre**, incluso en el primer arm.
- El primer actor que arma un intento conserva la responsabilidad de resolución. Un segundo con el mismo `operationId` ve duplicado; un efecto distinto, un token antiguo o un propietario nuevo se rechaza. No hay `force_unlock`, TTL reclaim, ni `release` para efectos ambiguos.
- Las cotas en micro-USD se fijan **antes** de reservar y no pueden aumentarse bajo la misma política. `unknown` retiene su máxima exposición tras perder un recibo. Un `cancel` solo libera la reserva **nunca enviada**, dentro del mismo DO.
- El contrato exige que TODAS las llamadas de ese test dispongan del mismo propietario transaccional; **no** suma costos entre DO distintos, cuentas diferentes, Workers que evadan el adaptador ni SDK native subcalls invisibles.
- Un DO vacío con `isolationProven:false` NO es garantía de namespace/cliente separado. Todavía hace falta provisionamiento autorizado y observador.
- Estos métodos no están expuestos por RPC/HTTP de Staging ni producen cambios en DO históricos.

## 3. Evidencia nueva sobre hard cutoff real

La documentación actual de Cloudflare distingue:

1. **AI Gateway Spend limits** (actualizado 17-11-2026): aplica a solicitudes que **atraviesan el gateway**, pero se calcula después de completar llamadas y es **eventualmente consistente**; ráfagas concurrentes pueden rebasar el límite. No da techo exacto a diez inferencias simultáneas sin reservar exposición en un owner durable y restringir rutas bypass. Fuente: https://developers.cloudflare.com/ai-gateway/features/spend-limits/
2. **Workers spending limits** (13-11-2026): cuenta global; cobertura solicitudes/CPU de Workers, **no** Durable Objects, Containers, Workers AI ni otros productos; reporte y bloqueo no instantáneos. Activarlo en la cuenta compartida puede interrumpir otros servicios. Fuente: https://developers.cloudflare.com/workers/platform/spend-management/
3. **Billing Spend Policies para Workers y DO** (13-11-2026): políticas de producto **a nivel cuenta, no por Worker/namespace**; cargos de almacenamiento y otros servicios quedan fuera y aún puede existir overrun durante el retraso de medición. Fuente: https://developers.cloudflare.com/billing/manage/spend-management/
4. **Containers**: tiempo activo y recursos pueden facturarse; que la API muestre cero instancias en un momento no equivale a techo financiero ni limpieza certificada. Fuente: https://developers.cloudflare.com/containers/platform/pricing/

**Cloudflare API autentificada, lectura de 23-11-2026:**
- `GET /accounts/{account_id}/billing/spend-policies` respondió **HTTP 403** (permisos insuficientes para comprobar políticas modernas). **No** se conoce la configuración efectiva de Workers/DO y **no** se intentó mutarla.
- Gateway `default` existe; consulta anterior: `rate_limiting_limit:null`; endpoint **legacy/deprecated** `/ai-gateway/billing/spending-limit` reportó `enabled:false`. No extrapolar esto como ausencia de reglas nuevas de gateway.
- Staging principal mantiene binding directo `AI` y OpenRouter configurado. Ningún control de gateway alcanzará rutas que no lo utilizan.
- No se ha establecido presupuesto numérico **del propietario** para esta campaña, ni se ha hecho reserva global de los recursos que comparten la cuenta.

**Conclusión técnica del coste:** el prototipo ya hace una reserva **local, atómica, de exposición máxima**, pero **no** demuestra el control externo efectivo. El hard cutoff requerido de facturación y proveedores sigue `BLOCKED`. No se presupone un límite, una recarga, un cargo aceptable ni una configuración de cuenta por el hecho de disponer de métodos de API.

## 4. Evidencia y pruebas reproducibles

GREEN:
```bash
bun test src/preflight-exclusive-lease.test.ts src/preflight-disposable-cost.test.ts
bun test
bun scripts/test-preview.mjs
bun run typecheck
bun run build
bun scripts/check-invariants.mjs
```

RED deliberado, aislado del pipeline general:
```bash
node --test scripts/f0-c10/preflight-02-known-red.red.mjs
# exit 1, dos fallos de inseguridad esperados
```

Regresión #158:
```bash
node --test scripts/f0-c10/operational-preflight.test.mjs
node scripts/f0-c10/operational-preflight.mjs --snapshot docs/f0-c10/preflight-01-observed-20261123.json
# STOP esperado, exit 2; nunca significa GO
```

Los resultados CI deben atribuirse **al HEAD final** de este PR, con job, exit code y enlace GitHub. El fake DO serializado prueba invariantes de código, **no** latencia, memoria workerd ni fencing ante un viejo proceso vivo.

## 5. Gate operativo y límites de autorización

| Control | Estado después de esta preparación de fuente | Demostración todavía necesaria |
|---|---|---|
| Lease en **un DO simulado** | `PARTIAL` (RED/GREEN offline) | Namespace dedicado, un solo owner alcanzable desde todos los ejecutores, lease físico exclusivo, identificador de cuenta/worker version verificados |
| Fencing, TTL y pérdida de respuesta | `PARTIAL` (invariantes offline) | Demostrar original antiguo inhabilitado por guarda server-side y recibo de quiescencia del SDK real; no liberación automática |
| Reserva y cancelación de coste **en un solo DO** | `PARTIAL` (transacciones/fixtures) | Interceptor real de **cada** inferencia/modelo y efecto infra, coste medible y cumplimiento upstream |
| Hard cutoff proveedor/infra | **`BLOCKED`** | Permiso para leer políticas modernas, gateway obligatorio o bloqueo de ruta directa, guardas de Workers/DO/Containers/CI, proveedor sin bypass, medición/stop bajo techo USD |
| Autorización live | **`STOP`** | Gasto máximo numérico explícito, entorno realmente aislado y checks anteriores, más observabilidad/rollback |
| COMPLETE PASS C10 | **`PARTIAL`** | Aún faltan tres rondas con diez ejecuciones verdaderamente simultáneas, correctas y verificadas |

**No ejecutar sin nuevo preflight verificado:** cambios en límites de cuenta, activación de billing, deploy, migraciones DO, cargas Stage, OpenCode Remote con efectos, inferencia pagada, ni operaciones en sesiones o datos de terceros.

## 6. Recibo y continuidad

**RESULTADO:** código de prototipo `PARTIAL`, lease/cap offline validable; `STOP` operacional mientras falta corte efectivo y presupuesto en USD.
**EVIDENCIA:** PR draft de PREFLIGHT-02, HEAD/CI por verificar; scripts/tests/documentos anteriores; Cloudflare GET 403 de Spend Policies.
**BLOQUEANTE:** controles actuales de facturación inaccesibles, coste máximo numérico no definido y ninguna prueba de egress real sin bypass/infra bajo corte.
**COSTE:** no hubo inferencia, deploy o Container activado en este lote; coste monetario de CI/lecturas **desconocido**.
**PRÓXIMA ACCIÓN:** definir un techo de gasto en USD y verificar capacidad de aislamiento real y controles para una sola operación mínima. Si se trabaja en la misma cuenta sin separación y se interrumpen otros servicios, **STOP**. No iniciar una cuarta ronda T01–T10.

**Autoría:** ChatGPT en rama propia vía GitHub; GitHub Actions para pruebas. No OpenCode Remote ejecutor ni Codex. Biblioteca personal solo tras upload y recibo confirmado; no sincronizar automáticamente con GitHub.
