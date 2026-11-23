# F0-C10/PREFLIGHT-01 — Diagnóstico operativo y puerta GO/STOP

**Fecha de corte:** 2026-11-23 (America/Sao_Paulo).
**Repositorio:** `aamvtrampa36-del/opencode-harness-example`.
**Issue:** [#90](https://github.com/aamvtrampa36-del/opencode-harness-example/issues/90).
**Fuente:** [PR #157](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/157), HEAD exacto `304145eca71a5ffcf6d9c235e67a8065718c6ae5` (draft, sin merge).
**Rama del preflight:** `f0-c10/preflight-01-operational-stop-20261123`, creada exclusivamente desde dicho SHA. **Actor:** ChatGPT vía GitHub, Cloudflare y lecturas OpenCode Remote. No Codex; OpenCode Remote **sin acciones con efectos**, debido a ausencia de lease exclusivo y hard cutoff demostrado.

## 1. Veredicto

**`STOP_LIVE / PARTIAL / SOURCE_OFFLINE_PASS / NO_REAL_10X3`**.

El preflight verificó que hay código R3 con CI offline verde, pero **no** existe un conjunto completo y probado de controles operativos para ejecutar una tarea real, permitir gasto o publicar la cadena de Workers. «Autorizo todo» concede margen de investigación y escrituras reversibles en rama; no define un límite de gasto monetario y no justifica exceder límites de privacidad/seguridad o modificar el entorno compartido.

**Esta entrega NO despliega Workers, modifica recursos Cloudflare, inicia inferencias, crea sesiones Remote ni ejecuta carga.** El verificador agregado es deliberadamente **de solo lectura y siempre STOP**: un archivo JSON inventado o claims `hardStopProven=true` no habilitan una operación real. No existe todavía un adaptador independiente, autenticado y completo que pueda emitir un GO ejecutable. El código de T07, incluso con `paidPreflight(...).decision === 'GO'` en fixtures, **no intercepta** cada llamada nativa de inferencia ni garantiza todos los gastos.

## 2. Evidencia revalidada, sin secretos ni datos personales

| Elemento | Lectura y alcance | Resultado |
|---|---|---|
| GitHub | PR #157 draft/open, HEAD `304145eca71a5ffcf6d9c235e67a8065718c6ae5`; [CI #45115974272](https://github.com/aamvtrampa36-del/opencode-harness-example/actions/runs/45115974272) y [#45115974218](https://github.com/aamvtrampa36-del/opencode-harness-example/actions/runs/45115974218) completed/success | **VERIFIED** fuente offline, **NO** runtime |
| Worker principal | `opencode-g1-staging`, deployment `36ef84b3-0f99-4dd4-ab8e-c11ee450dd23`, versión **#374** `3546687b-4cd2-4e22-8ea9-ee5ea8fd02cb` al 100% | **BLOCKED** identidad binaria con #157 sin bundle hash |
| Worker MCP | `opencode-staging-control-mcp`, deployment `9fdaf22d-beeb-44a0-ab68-77ecd5745fa1`, versión **#19** `196240c0-1052-47b3-aaa7-02cf5baa87f0` al 100% | **BLOCKED** identidad fuente/assets/bindings |
| Bindings/config | Principal: `OpenCodeAgent`, `DevContainer`, `PersonalSettings`, `SessionBackupDrillAgent`, `AI`, `LOADER`, R2, workflow; MCP: `STAGING_SUPERVISOR` apunta al Worker principal y service binding | **PARTIAL** configuración actual leída, par R3 no publicado |
| Memoria/telemetría | Logs de ambos Workers activados, pero **traces desactivadas**; el issue #90 registra OOM reales y R3 solo mide Node/local; sin perfil isolate real correlacionado | **BLOCKED** |
| Gateway | Gateway `default` existente; `rate_limiting_limit=null`; el endpoint **deprecated** de spending limit devuelve `enabled=false` y configuración mensual no aplicada | **BLOCKED**: no prueba un hard cutoff vigente; **NO** inferir que agota todas las reglas modernas |
| Rutas de inferencia | Catálogo Remote: `economy` DeepSeek Workers AI y otros presets; `src/server.ts` posee `createAI({binding: env.AI})`; OpenRouter también configurado | **BLOCKED**: rutas directas y SDK no verificadas bajo un solo interruptor de coste |
| Containers | API uso instantáneo: 0 instancias/vCPU y siete aplicaciones registradas, incluyendo Staging; una muestra **no demuestra** ausencia de actividad histórica ni coste cero | **NOT_TESTED** presupuesto/cgroup live |
| Remote | `ready=true`, `supervisedCountAtLeast=96`, `supervisedCountComplete=false`, modelos disponibles. No hay lease exclusivo; no son 96 sesiones activas | **BLOCKED** exclusividad |
| Seguridad de salida | T09 bloquea hardlinks y verifica bytes localmente, pero ACL por principal y Android autenticado siguen pendientes | **BLOCKED** para aceptación |
| Rollback | Versiones Worker previas identificadas; no se ejecutó reversión de DO/Containers ni snapshot/PITR/restore comprobado | **NOT_TESTED** |

**Cuidado de facturación:** no se persisten detalles del medio de pago, credenciales, cuenta, request IDs ni contenidos de sesiones. Un saldo/prepago y un límite mensual no equivalen a cota de gasto total de Workers, DO, Containers, CI y proveedores. Los costes monetarios de lecturas/CI de este encargo no fueron medidos.

Fuentes públicas de reglas actuales:
- [Cloudflare Workers AI binding y posibilidad de AI Gateway](https://developers.cloudflare.com/workers-ai/configuration/bindings/).
- [AI Gateway Unified Billing / límites de gasto por gateway](https://developers.cloudflare.com/ai-gateway/features/unified-billing/).
- [Límites de Workers, incluidos CPU/duración](https://developers.cloudflare.com/workers/platform/limits/).
- [Durable Objects y almacenamiento SQLite](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/).
- [Acceso a almacenamiento Durable Objects / estrategia de actualización](https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/).

## 3. Contrato reproducible y pruebas

Archivos nuevos:
- `scripts/f0-c10/operational-preflight.mjs`: evaluador de **snapshot de solo lectura**, con once gates y salida JSON determinista. **Nunca devuelve GO**; `STOP` produce exit code **2**. No tiene llamadas de red ni acceso a secretos.
- `scripts/f0-c10/operational-preflight.test.mjs`: tests positivos de reconocimiento del CI offline y negativos de spend cutoff, CI con SHA incorrecto, snapshot incompleto, procedencia inválida y **GO falso por claims manuales**.
- `docs/f0-c10/preflight-01-observed-20261123.json`: observaciones sanitizadas verificables en lectura y fecha de corte; **no** es un recibo criptográfico ni captura independiente del runtime.
- `.github/workflows/f0-c10-preflight-01.yml`: workflow sin permisos de escritura ni deploy: Node tests/STOP esperado + Bun suite, preview, typecheck, build dos Workers/web e invariantes, fijando SHA del HEAD. El workflow **no** prueba hard stop externo ni diez tareas.

Uso offline:

```bash
node --test scripts/f0-c10/operational-preflight.test.mjs
node scripts/f0-c10/operational-preflight.mjs --snapshot docs/f0-c10/preflight-01-observed-20261123.json
# Exit 2 = STOP esperado; jamás tratar exit 2 como autorización operacional.
```

**Límite intencional del instrumento:** evita falsos GO y organiza blockers, pero no puede certificar un GO real usando solo un JSON declarativo. La futura puerta operacional debe tomar directamente lecturas autenticadas de proveedores, observar el corte efectivo **antes** y **después** de una solicitud controlada y disponer de reserva exclusiva/rollback; no promover este verificador offline como interceptor del SDK.

## 4. Matriz de aceptación

| Gate | Estado actual | Mínimo exigido para posterior GO operativo |
|---|---|---|
| Código y CI | **VERIFIED offline** | HEAD exacto final, CI, build dos Workers, diff y provenance |
| Fuente→binarios→assets | **BLOCKED** | Bytes/digests y binding manifest de ambos Workers verificados con candidate SHA y rollback |
| Exclusividad | **NOT_TESTED** | Lease aislado exclusivo, generación/fence, TTL y rechazo del concurrente sin afectar tareas legacy |
| Capacidad/legacy | **PARTIAL** | Censo completo de todas las rutas nativas no gobernadas y STOP/aislamiento |
| Recuperación | **PARTIAL** | Casos live de DO descartable: pérdida de respuesta, creador viejo, operación `unknown`, cancel y readmisión |
| Memoria/aislamiento | **BLOCKED** | Medición real isolate+Container, margen con OOM y límites de memoria confiables |
| Procesos Linux | **BLOCKED** | `setsid`/cgroup scope y ausencia de huérfanos probados con proyecto descartable |
| Hard cutoff financiero | **BLOCKED** | Presupuesto **explícito en USD**, medición de todas las seis rutas T07 y **corte efectivo probado**; interceptar todas las inferencias o negar rutas sin cobertura |
| ACL/Android | **BLOCKED** | Identidad autenticada de principal, lectura byte-exact por usuario y verificación Android |
| Observador | **BLOCKED** | Telemetría independiente autenticada/firmada de DO, Containers, proveedor, reloj y outputs |
| Rollback | **NOT_TESTED** | Snapshot/restore según naturaleza del almacenamiento, rollback Workers/Container separado con verificación |

No inferir `GO` por ausencia de errores en pruebas sintéticas, por presencia de diez slots o por `ready=true`. El criterio final #90 mantiene tres rondas independientes con diez intervalos de actividad realmente simultáneos, diez resultados con readback/hash y cero OOM/huérfanos/mezclas, todos dentro de coste acotado.

## 5. Plan reversible **propuesto**, no ejecutado

Una vez exista autorización sobre operaciones de facturación con techo numérico definido y se compruebe gasto real, el siguiente lote tendría que:

1. Crear un workspace o cuenta/namespace **aislado** sin importación de sesiones ni DO históricos; registrar propietario, región, TTL, política de acceso, cotas de Container y límite de coste con rollback.
2. Capturar manifests con hashes de fuente/bundle/asset/DO class/migration y las dos versiones de Worker; ensayar rollback **sin** asumir restauración de DB/Container. Para DO SQLite, usar PITR/backup probado según capacidad del namespace (no confundir con revertir Worker).
3. Configurar únicamente un presupuesto efectivo de servicios aplicables sin cambiar límites generales de la cuenta en producción; confirmar bloqueo de ruta alternativa directa de `env.AI` y de SDK/provider sin interceptor.
4. Obtener lease de prueba exclusivo con fence, reportar moneda y máximo combinado verificable; realizar un único efecto mínimo **solamente con preflight GO** y observador independiente; comprobar stops, coste, resultado y limpieza antes de ampliar.
5. Solo en un lote ulterior y autorizado: ejecutar rampa 1→2→4→10 y tres rondas completas, con parada inmediata ante gasto, latencia OOM, recursos huérfanos, mezcla de outputs o recuperaciones ambiguas.

**STOP actual:** no desplegar PR #157, no modificar `main`, Producción, Access, secretos, bindings persistentes ni ejecutar carga/Remote. No establecer límite de gasto sobre toda una cuenta compartida como efecto colateral de un preflight. Costes de pruebas offline/Actions no pueden calificarse como gratuitos sin medición.

## 6. Cierre de este lote

**RESULTADO:** `PARTIAL / PREFLIGHT_READ_ONLY_STOP / NO_LIVE` (si el CI de este HEAD pasa, añadir `CI_PASS` con recibo verificado).
**EVIDENCIA:** PR #157 y CI, Cloudflare GET de versiones, settings, gateway billing legacy, Container usage; Remote status/diagnostics/models; snapshot sanitizada + pruebas.
**BLOQUEANTE PRIORITARIO:** no existe **corte verificable total de gasto** ni lease aislado probado, además de las barreras de memoria, ACL y observabilidad.
**COSTE:** importe en USD **no medido**; no se iniciaron inferencias ni despliegues.
**PRÓXIMA ACCIÓN ÚNICA:** diseñar y verificar primero **control de gasto efectivo + lease exclusivo en entorno descartable**, sin intervención en recursos compartidos, y obtener aprobación explícita del techo numérico si se requieren pruebas con coste.

**Estado global F0-C10:** `PARTIAL / NO COMPLETE PASS`. Mantener #90 abierto.
