# Ensayo de ROLLBACK CONJUNTO Worker + Container + Durable Object (solo Staging)

Fecha: 2026-11-13. Rama de trabajo: `opencode/staging-c21b48a7e5f039d6`
(base exacta `feat/staging-supervisor-control-20261111`, commit
`3669bd50266cc4f184e1e65317de3638c644424e`). Estado: **implementado y probado
en tests locales (bun + tsc + node real); la ejecución conjunta REMOTA queda
PENDIENTE de: (a) despliegue autorizado del Worker de staging
(`wrangler.g1.jsonc`), (b) invocación de las acciones por la API de Workflow
de Cloudflare con permisos del SUPERVISOR EXTERNO, y (c) rollback reversible
de versión de Worker ejecutado por el supervisor externo. Este documento NO
declara PASS de la ejecución remota y no certifica recuperación de datos
productivos.**

## 1. Propósito y alcance

Retener una prueba sintética y metadata del Durable Object DURANTE un rollback
de Worker controlado a otra versión Stage, y verificar después que:

1. la metadata del DO (registro, nonce, handle del snapshot) sobrevivió al
   cambio de versión del Worker;
2. el Container desechable de prueba puede destruirse y restaurarse desde el
   snapshot tomado ANTES del rollback (nunca desde una imagen vacía);
3. los hashes SHA-256 del marcador coinciden con el ancla previa al snapshot;
4. NO sobrevive ninguna mutación posterior al snapshot (control negativo);
5. queda un recibo de auditoría aunque todo lo demás falle.

El ensayo opera EXCLUSIVAMENTE sobre el scope desechable fijo
`snaprec-a-<nonce>` (creador, dueño del estado y del Container de prueba) y
`snaprec-b-<nonce>` (reservado por simetría de scope; NO se instancia en el
ensayo joint), con `nonce` de 12 caracteres hexadecimales. Nunca toca
`personal`, proyectos importados, datos reales ni credenciales.

## 2. Acciones privadas añadidas (Cloudflare Workflow, nunca endpoints públicos)

En `src/supervisor-workflow.ts` (desplegado SOLO por `wrangler.g1.jsonc`,
binding `SUPERVISOR_WORKFLOW`, var `OPENCODE_SUPERVISOR_ENABLED=true`):

| Acción | Payload exacto | Efecto |
|---|---|---|
| `joint_prepare` | `{"action":"joint_prepare"}` | Genera nonce, crea prueba sintética aislada + `snapshotContainer()` real, persiste registro + handle en el DO creador y deja el Container de prueba corriendo y PRISTINO. Devuelve `{schema, nonce, scope, handle, prepare, nextStep}`. |
| `joint_verify_cleanup` | `{"action":"joint_verify_cleanup","nonce":"<12hex>"}` | Tras el rollback externo: valida supervivencia/correlación de metadata, aplica control negativo al disco vivo, destruye SOLO la instancia desechable, restaura desde el handle, valida anclas y ausencia de mutación, imprime recibo y limpia SIEMPRE (incluso con fallos). |
| `joint_cleanup` | `{"action":"joint_cleanup","nonce":"<12hex>","reason?":"<texto>"}` | Limpieza de emergencia break-glass: destruye el Container del scope, borra SOLO `snapshotId`/`savedAt`/`joint-rollback-record-v1`, escribe recibo `emergency`. Idempotente. |

Validación estricta por acción: campos desconocidos → `UNKNOWN_JOINT_FIELD`;
nonce inválido → error de nonce; `SUPERVISOR_DISABLED` si la var no está en
`true`. Cualquier otra acción sigue el camino preexistente.

## 3. Estado persistido en el DO creador (claves)

- `snapshotId`, `savedAt`: handle vivo (mismas claves del ciclo de vida existente).
- `joint-rollback-record-v1`: registro del ensayo (nonce, scope, runId, hashes
  del marcador/manifiesto, snapshotId, imagen, estado `prepared`/`verifying`).
- `joint-rollback-receipt-v1`: LÁPIDA de auditoría; se escribe en cada final
  (verified/failed/emergency) y NUNCA se borra. No mantiene nada vivo.

La limpieza borra EXACTAMENTE `["snapshotId","savedAt","joint-rollback-record-v1"]`
(`JOINT_LIVE_KEYS`): jamás `lastActivity` ni claves de otros subsistemas
(test lo demuestra con claves extranjeras sembradas).

## 4. Idempotencia, lease y caducidad (sin instancias vivas huérfanas)

- **Idempotencia de `joint_prepare`**: un registro fresco en estado `prepared`
  del MISMO nonce se devuelve sin cambios (`replayed:true`) sin crear un
  segundo snapshot. Registro de OTRO nonce en el scope → rechazo
  (`JOINT_METADATA_MISMATCH`); vencido → `JOINT_EXPIRED`; en `verifying` →
  `JOINT_STATE_INVALID`.
- **Caducidad**: la ventana para verificar es `JOINT_PREPARE_TTL_MS = 6 h`
  desde `snapshotSavedAt`. Vencida, `joint_verify_cleanup` se rehúsa y solo
  cabe `joint_cleanup` (que es idempotente), de modo que no quedan instancias
  vivas indefinidamente.
- **Lease de verificación**: al entrar, el registro pasa a `verifying` con
  `stateSince`. Durante `JOINT_VERIFY_LEASE_MS = 15 min`, `joint_cleanup` de
  emergencia se niega a destruir (`JOINT_VERIFY_IN_FLIGHT`) porque el verify
  tiene su propia limpieza terminal. Un lease atascado se puede romper al
  vencer la ventana.
- **Firma/correlación por nonce**: el nonce es un token de CORRELACIÓN, no un
  secreto (queda incrustado en el propio nombre del DO). La validación exige
  coincidencia exacta de nonce/scope/handle entre el payload de Workflow y el
  registro persistido. No hay credenciales públicas en juego: estas acciones
  solo son alcanzables por la API de Workflow autenticada de la cuenta.

## 5. RUNBOOK para el verificador externo autorizado (nadie más)

Requisitos de permisos (separación de permisos; si falta alguno, reportar el
bloqueo y NO certificar PASS):
  (a) permiso para desplegar/actualizar el Worker de staging con
      `wrangler.g1.jsonc` (la clase del Workflow y la var
      `OPENCODE_SUPERVISOR_ENABLED` viven solo ahí);
  (b) credencial de la CUENTA con permiso de invocar la API de Cloudflare
      Workflows (crear/leer instancias del Workflow `opencode-supervisor-stage`);
  (c) credencial con permiso sobre versiones/despliegues del Worker de staging
      para el rollback reversible (operación de PROPIETARIO, nunca del agente).

Pasos:
1. **Desplegar staging** (si no está ya) con el código de esta rama. Verificar
   que la versión desplegada contiene las acciones joint (revisar que el
   bundle incluye `joint-rollback`).
2. **joint_prepare**: crear instancia del Workflow con payload
   `{"action":"joint_prepare"}`. Anotar del resultado: `nonce`, `scope.creator`,
   `handle` y `passed:true`. Si `passed:false`, leer `error`/`emergency` y
   detener (no se avanza con scope sucio).
3. **Línea base del Worker**: registrar el IDENTIFICADOR de versión/despliegue
   actual del Worker de staging (consola o API de versiones de Workers; el
   verificador confirma el endpoint vigente en la documentación de su cuenta).
4. **Rollback reversible a OTRA versión Stage**: desplegar/rollback a una
   versión Stage previa distinta (que NO contenga las acciones joint es
   esperable y no rompe nada: el ensayo usa SOLO recursos del DO/Container,
   que sobreviven al cambio de versión). Verificar que la versión activa cambió
   (identificador distinto). OJO: mientras la versión alternativa está activa,
   NO se puede invocar `joint_verify_cleanup` (esa versión no la conoce);
   el ensayo está diseñado para que la metadata del DO sobreviva ese periodo.
5. **Restaurar el Worker candidato original**: volver al identificador de
   versión del paso 3 y verificar que vuelve a estar activo.
6. **joint_verify_cleanup**: crear instancia con
   `{"action":"joint_verify_cleanup","nonce":"<nonce del paso 2>"}` (dentro de
   6 h). Leer el recibo.
7. **Evidencia**: guardar JSON completo del retorno (paso 6) y los
   identificadores de versión de los pasos 3-5.

Criterios de PASS (todos obligatorios):
  - `passed:true` en joint_prepare y en joint_verify_cleanup;
  - `outcome.metadataSurvived`: `recordPresent:true`, `handleMatchesRecord:true`,
    `nonceMatches:true` (la metadata DO sobrevivió al ciclo de rollback);
  - `outcome.destroyedInstance:true` y restauración desde el handle
    (`imageIdentityProof` presente, `imageAfter` compatible);
  - checks del programa in-container 7/7 en `pass` y `mutationApplied:true`
    con `mutatedSha256` DISTINTO del ancla (control negativo aplicado);
  - `receipt.outcome:"verified"` y claves vivas borradas (`handleDeleted:3`);
  - identificadores de versión: hubo cambio (paso 4) y retorno al original
    (paso 5), con evidencia guardada.

Criterios de ABORTO/FAIL (cualquiera):
  - `JOINT_METADATA_MISSING` / `JOINT_METADATA_MISMATCH` / `JOINT_HANDLE_MISMATCH`
    / `JOINT_EXPIRED` / `JOINT_STATE_INVALID` en el paso 6: la metadata NO
    sobrevivió o el scope está corrupto; ejecutar `joint_cleanup` con el nonce,
    guardar el recibo y reportar FAIL (no reintentar sobre scope sucio).
  - `passed:false` con `error` en cualquier paso; `cleanup` con
    `cleanupError`; receipt `outcome:"failed"`.
  - Si el rollback de Worker no es reversible o no se puede verificar el cambio
    de versión: ABORTAR y reportar bloqueo de permisos (no improvisar).

## 6. Cobertura de tests locales (evidencia ejecutada 2026-11-13)

Comandos reales ejecutados en el contenedor Linux aislado (checkout del commit
exacto de staging `3669bd5`):
- `bun test` → **225 pass / 0 fail** (199 preexistentes + 26 nuevos), incluidos
  los 22 del ensayo de recuperación previo (CI E2E #43261446743 sigue aprobada;
  no se repite aquí).
- `tsc --noEmit` → exit 0 (con `NODE_OPTIONS=--max-old-space-size=1536`; el
  contenedor tiene ~1.1 GB y tsc necesita heap explícito).
- Nota ambiental: con el árbol de trabajo SUCIO, el test
  `selftest-core > cannot claim reused artifacts...` falla por diseño
  (fail-closed del selftest ante worktree ≠ HEAD). Se resolvió con un commit
  LOCAL de prueba en el checkout aislado; el árbol queda 225/0.

Mapa requisito → test (`src/joint-rollback.test.ts`):
  - nonce inválido → "nonce inválido es rechazado (firma de correlación falla)".
  - handle ausente → "handle ausente: sin registro, verify rechaza y NO toca nada".
  - handle vencido → "registro vencido: verify es rehusado" y "registro vencido:
    verify rechaza y exige joint_cleanup".
  - metadata mismatch → "metadata mismatch: registro de otro nonce/scope...",
    "nonce incorrecto en la invocación...", "scope ocupado por OTRO nonce...".
  - borrado indebido → "borrado indebido: registro vivo pero claves del handle
    eliminadas", "divergencia de savedAt...", y el test de emergencia que
    demuestra que se borran SOLO las 3 claves vivas (claves extranjeras
    sembradas sobreviven).
  - sesión/Container no aislado → "slugs no desechables son rechazados por la
    guardia" (personal, supervised-*, repo-*) + programa in-container real que
    se niega fuera de snaprec-*.
  - control negativo real → test de integración con node: create → ancla real →
    registro parsea → pristine pasa → mutate → verify exigente FALLA.

## 7. Márgenes de protección (lo que este ensayo NO hace)

- No crea endpoints públicos ni herramientas de agente: las 3 acciones viven
  solo en el Workflow privado de staging.
- No ejecuta rollback de Worker por sí mismo: el rollback y la restauración de
  versión son del supervisor externo con sus credenciales.
- No cambia IAM/ACL, secretos, bindings de producción ni configuración de
  acceso; no toca datos de terceros ni proyectos personales/importados.
- No mezcla datos: todo queda en `snaprec-a/b-<nonce>`, DOs nuevos por corrida,
  con recibo-lápida como única huella persistente tras la limpieza.
- Si la API de Cloudflare no permite alguno de los pasos al verificador por
  separación de permisos, el verificador debe REPORTAR qué falta (permiso de
  despliegue, de invocación de Workflow o de versiones de Worker) y NO
  certificar un PASS sintético.
