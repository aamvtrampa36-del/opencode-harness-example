# Ensayo real de recuperación por snapshot (Staging, 2026-11-12)

## Propósito

`src/restore-proof.ts` añade un ensayo REAL y aislado del ciclo de
recuperación del Container: `snapshotContainer()` → `destroy()` →
`start({containerSnapshot})`, sobre una instancia de DevContainer creada
exclusivamente para la prueba. El ensayo escribe en el filesystem un
conjunto de marcadores (payload de 64 KiB + nonce + manifiesto, cada uno
anclado por SHA-256) y un dato duradero en el storage del Durable Object;
ambos se consultan y re-verifican después del reinicio.

`DevContainer.proveRestoreFixture()` (en `src/dev-container.ts`) es el
adaptador que ejecuta la máquina de estados sobre el DO propio.

## Aislamiento garantizado

- Solo acepta un DO **recién creado** cuyo nombre sea exclusivo de prueba:
  `restore-proof-v1:<16 hex>`. Ese prefijo nunca colisiona con el DO
  `personal` ni con los contenedores de proyecto (`project-v1:*`).
- Rechaza cualquier DO con estado previo: si el storage tiene una sola
  clave, el ensayo aborta antes de tocar ningún Container.
- Nunca destruye ni reinicia el Container personal, canónico, ni instancias
  previas. Solo destruye y reinicia el Container del DO de prueba, y solo
  desde la imagen base o desde el snapshot tomado dentro del mismo ensayo.
- No escribe ninguna clave de producción (`snapshotId`, `savedAt`,
  `lastActivity`, inventarios): usa únicamente `restore-proof-state` y
  `restore-proof-datum`.

## Reglas fail-closed

El resultado es `ok:false` (nunca un PASS sintético) si:

1. No hay snapshot compatible: `snapshotContainer()` ausente, llamada
   fallida, o identificador devuelto inutilizable.
2. El image digest es desconocido: `container.inspect()` no devuelve una
   referencia normalizable (`normalizeImageRef`) o cambia entre el
   priming y la verificación.
3. El marker/sha256 no es verificable tras el reinicio: archivos
   ausentes, hash distinto del ancla, o manifiesto inconsistente.
4. El dato de DO storage falta o pertenece a otro ensayo.
5. El programa de verificación no produce un informe analizable.

La API de Cloudflare Containers exige `scheduling_policy: durable_object`,
mantiene los snapshots 30 días, NO restaura procesos y NO permite cambiar
la imagen al reiniciar: el arranque con `containerSnapshot` no lleva clave
`image` (hay una prueba de contrato que lo fija).

## Ruta privada por Workflow (sin HTTP público)

La acción `restore-proof` se añadió al Workflow privado existente
`OpenCodeSupervisorWorkflow` (`src/supervisor-workflow.ts`), que solo es
invocable por la API de Workflows de la propia cuenta Cloudflare y exige
la variable de cuenta `OPENCODE_SUPERVISOR_ENABLED=true` (solo definida en
el despliegue de Staging `wrangler.g1.jsonc`). No se añadieron rutas HTTP,
tokens ni ACL nuevas.

Paso de supervisión por cuenta existente (ejemplo, desde la cuenta del
propietario, NO ejecutado en esta sesión):

```bash
# 1. Generar un id de prueba de 16 hex y crear el DO de prueba invocando el Workflow
FIXTURE_ID=$(openssl rand -hex 8)
curl -X POST "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/workflows/opencode-supervisor-stage/instances" \
  -H "Authorization: Bearer $CF_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"action\":\"restore-proof\",\"fixtureId\":\"$FIXTURE_ID\"}"
# 2. Reinvocar con el mismo fixtureId reanuda la máquina de estados si el
#    DO fue desalojado a mitad del ensayo (fases persistidas en DO storage).
```

El Workflow puede fallar terminalmente en una invocación (retries: 0);
reinvocar con el mismo `fixtureId` continúa desde la última fase
persistida. Un DO con estado ya existente es rechazado en cualquier caso.

## Integración puntual y prueba en vivo

- No hizo falta tocar `wrangler.g1.jsonc` (archivo protegido): la clase
  `OpenCodeSupervisorWorkflow` ya está registrada allí con el binding
  `SUPERVISOR_WORKFLOW`. Si en el futuro se desea un Workflow dedicado
  solo para el ensayo, esa edición corresponde al propietario.
- NO se ejecutó ninguna prueba en vivo contra Cloudflare Containers:
  el ensayo requiere el Worker desplegado en Staging (g1). Esta sesión
  no despliega. Las pruebas reales ejecutadas aquí son unitarias e
  integrales locales (bun test), typecheck e invariantes estáticas.
- Este ensayo NO constituye recuperación de otros proyectos ni un
  respaldo R2 a largo plazo; el respaldo independiente sigue siendo el
  archivo tar+gzip en DO SQLite (`saveBackup`/`restoreSavedBackup`).

## Evidencia local (rama de trabajo, 2026-11-12)

- `bun test`: 205 pass / 0 fail (39 archivos; 28 pruebas nuevas).
- `tsc --noEmit`: exit 0.
- `scripts/check-invariants.mjs`: exit 0.
- Nota de entorno: en el Container de desarrollo `tsc` necesita
  `NODE_OPTIONS=--max-old-space-size=2048` por el límite de memoria y
  `vite build` (fase de bundling del worker) supera el límite duro de
  1 GiB del Container (OOM-kill documentado en dmesg); son restricciones
  del entorno de desarrollo, no del código. El selftest E2E del repo
  debe ejecutarse en la infraestructura del propietario.
