# Respaldo externo (R2) y restauración cruzada verificable — ensayo en Staging

Fecha: 2026-11-13. Rama de trabajo: `opencode/staging-f81d3a5c09e247b6`
(base exacta `feat/staging-supervisor-control-20261111`, commit `3669bd5`).
Estado: **código y pruebas de unidad/E2E local en verde; la ejecución REAL
contra el bucket privado queda PENDIENTE de despliegue autorizado**. Nada de
este documento declara PASS de producción ni certifica recuperación de datos
productivos.

## 1. Problema (pendiente B) y posición en la escalera de recuperación

El sistema tenía tres caminos de recuperación, ninguno externo a la cuenta
salvo el snapshot de Container (30 días) y la copia DO SQLite del mismo DO:

| Mecanismo preexistente | Qué cubre | Hueco |
|---|---|---|
| `snapshotContainer` + `start({containerSnapshot})` | filesystem del Container | TTL 30 días; mismo DO |
| `saveBackup`/`downloadSavedBackup` (`durable-backup.ts`) | tar.gz del proyecto en SQLite del MISMO DO | si el DO se pierde, la copia se pierde con él |
| Ensayo snapshot drill (`container-recovery*.ts`) | pérdida de instancia, mismo/cruce de DO | no ejercita un almacén externo a la plataforma de DO |

Este hito añade el cuarto peldaño: **backup del filesystem de un proyecto de
PRUEBA y de metadatos de tarea/sesión de PRUEBA hacia el bucket privado R2
`opencode-v1-recovery-20261112`, y restauración en un Container/DO NUEVO
verificando SHA-256 y metadatos**, más controles negativos (bytes alterados y
clave ausente). Solo toca proyectos desechables `extbkc-*`: nunca datos de
proyectos ajenos, secretos, tokens, producción ni sesiones personales.

## 2. Qué se implementó (superficie mínima, cambio reversible)

- `src/external-backup.ts` (nuevo): guardas (`assertExternalBackupProject`,
  prefijo `extbkc-`), claves versionadas `opencode-extbk-v1/<runId>/…`
  (`externalBackupKeys`), contrato de manifiesto versionado
  (`ExtBkManifest`, `parseExtBkManifest` fail-closed), metadatos de PRUEBA
  (`buildTestTaskMetadata`, referencia sintética `ses_extbk_*`), JSON
  canónico + digest (`canonicalJson`, `canonicalDigest`), subida con orden
  de confirmación (archivo primero con pin `sha256` en `put`, manifiesto
  ÚLTIMO = punto de commit), descarga verificada
  (`downloadVerifiedBackup`: digest hand-off → contrato → metadatos →
  archivo), sondas negativas (`createTamperedProbe`,
  `assertTamperRejected`, `assertMissingRejected`), limpieza
  (`deleteRunPrefix` borra SOLO claves propias y falla si ve ajenas),
  interfaz estructural `R2LikeBucket` + `assertR2Bucket` (fail-closed sin
  binding; NUNCA simula el bucket), y el programa in-container sin
  dependencias `EXTBK_SOURCE` (create/verify, informe estricto
  `EXTBK_REPORT:`).
- `src/external-backup-do.ts` (nuevo): fases del ensayo sobre el DO:
  `extBackupCreate` (marcador único + metadatos de prueba + archivado por la
  vía `/__archive` probada en `saveBackup`, ancla doble container/DO, subida
  R2), `extBackupDestroyInstance` (destruye SOLO la instancia desechable
  respaldada por el registro persistido; sin registro, no destruye nada),
  `extBackupCrossRestore` (descarga desde R2 — nunca del DO creador—,
  reverifica todo, restaura con el programa preexistente
  `RESTORE_PROJECT_SOURCE` y re-ancla SHA-256 dentro del container
  restaurado), sondas y `extBackupCleanup`.
- `src/dev-container.ts`: seis métodos RPC explícitos `extBackup*`
  (patrón idéntico a los métodos `drill*` existentes; sin mutación de
  prototipo; el ciclo de vida preexistente no se altera).
- `src/supervisor-workflow.ts`: acción privada `external_backup_drill` en el
  Workflow preexistente `opencode-supervisor-stage` (solo
  `wrangler.g1.jsonc`), con pasos `step.do` de reintento 0: crear → destruir
  instancia → restaurar cruzado → sonda de bytes alterados → sonda de clave
  ausente → limpieza (siempre, incluso con error). Sin ruta HTTP nueva y sin
  herramienta de agente nueva.
- `wrangler.g1.jsonc` (SOLO Staging): binding
  `RECOVERY_R2` → bucket `opencode-v1-recovery-20261112`.
  `wrangler.jsonc` (Producción) sigue SIN R2 y `src/r2-bindings.d.ts` declara
  el binding OPCIONAL: si falta, el ensayo falla con error claro y no simula.
- `src/external-backup.test.ts` (nuevo): 20 pruebas, incluido un round-trip
  REAL (programa in-container real + `tar` real + restauración real vía
  `RESTORE_PROJECT_SOURCE` + verificación real in-container) con el transporte
  R2 sustituido por un stub en memoria que replica la superficie usada,
  incluido el pin `sha256` de `put`.

## 3. Matriz de respaldo / recuperación (RPO/RTO realistas)

| Escenario | Mecanismo | RPO | RTO observado / estimado | Estado de la prueba |
|---|---|---|---|---|
| Container suspendido por inactividad | checkpoint `alarm()` + snapshot | 0 (checkpoint cada ≤2 min tras actividad) | arranque desde snapshot: segundos–minutos | preexistente, en producción de Staging |
| Instantánea perdida/vencida (30 días) | `saveBackup` → SQLite del DO (≤2 MiB) | desde el último `saveBackup` manual | restore `restoreSavedBackup`: ~segundos | preexistente, unit tests + E2E #43261446743 |
| Pérdida de instancia (mismo DO) | snapshot drill fase 2 | 0 desde el snapshot | ejecución real: pendiente de nuevo ensayo (doc snapshot-recovery-drill §8) | pendiente, fuera del alcance de esta PR |
| **Pérdida total del DO creador** | **este ensayo: R2 → nuevo DO/Container** | 0 desde la subida (archivo+manifiesto con digest) | sin ejecución real aún; coste objetivo: un `get` R2 + restore (~segundos tras arranque de Container) | **unit/E2E local en verde; R2 real pendiente de despliegue** |
| Bytes alterados en R2 | pin `sha256` en `put` + digest en descarga | rechazo inmediato, sin restauración | milisegundos | probado (stub y helper real) |
| Clave ausente | `get`/`head` null → error fail-closed | n/a (no restaura nada) | milisegundos | probado |
| Limpiado de claves del ensayo | `deleteRunPrefix` (prefijo propio exclusivo) | n/a | milisegundos | probado |

Nota de honestidad: el RTO de la fila R2 no está medido contra el bucket real;
depende de la latencia de `get` y del arranque del Container nuevo. No se
declara ninguna cifra de producción.

## 4. Coste (estimación, sin desplegar)

- R2 clase A/B: por ejecución del ensayo ≈ 2 subidas + 2 lecturas + 2 head +
  2 lecturas (sonda) + 1 list + 1-3 deletes sobre ~1-3 KiB totales: coste
  ínfimo (milesimas de dólar/mes con uso esporádico; el bucket está vacío).
- DO/Containers: dos DOs `basic` nuevos, vivos solo durante el ensayo
  (~minutos), igual que el snapshot drill existente.
- Sin rutas públicas nuevas, sin token nuevo, sin cambios de IAM/ACL.

## 5. Limitaciones de cuenta identificadas (sin crear ningún token)

1. **El binding R2 solo materializa en el Worker desplegado.** Desde este
   Container Linux no hay credencial Cloudflare (y crear una está prohibido),
   así que el bucket real no puede ni debe tocarse desde aquí: la prueba en
   vivo queda `pending-deployment` y se ejecuta con el Workflow privado, como
   el snapshot drill.
2. **`wrangler dev` local simularía R2 con Miniflare**, no con
   `opencode-v1-recovery-20261112`: no cuenta como evidencia del bucket real.
3. La existencia y ACLs reales del bucket privado solo se confirman al
   invocar el ensayo desplegado; cualquier error de binding/permisos se
   captura y se reporta verbatim en el informe del Workflow (reintentos 0),
   sin atribuirlo al código de aplicación.

## 6. Pruebas ejecutadas realmente (evidencia local, proyecto
supervised-f81d3a5c09e247b6, checkout aislado de `3669bd5`)

- `bun install --frozen-lockfile` → exit 0 (672 paquetes).
- `bun test` → **219 pass, 0 fail** (baseline 199 + 20 nuevos), tras commit
  LOCAL de verificación `5b4555c` (nunca enviado; la publicación se hace con
  la herramienta de GitHub sobre la rama precreada). Sin el commit local,
  `scripts/selftest.mjs` falla cerrado por árbol sucio — se verificó que el
  clon prístino de `3669bd5` pasa esos 17 tests (causa ambiental, no
  regresión).
- Round-trip REAL en `src/external-backup.test.ts`: `EXTBK_SOURCE create`
  (exit 0, checks preflight/marker-created/container-manifest-written) →
  `tar -czf` real → subida con pin sha256 → **destrucción del origen**
  (rm del árbol y del tar) → `downloadVerifiedBackup` → restauración REAL
  con `RESTORE_PROJECT_SOURCE` (recibo source/target/files/sha256) →
  `EXTBK_SOURCE verify` in-container (exit 0, marker-integrity +
  manifest-integrity) → hash del marcador restaurado == ancla.
- Rechazos probados: manifiesto inválido (7 variantes), metadatos alterados,
  archivo alterado (digest y gzip), tamaño/techo de bytes, archivo sin
  manifiesto (atomicidad: no se restaura), digest hand-off falso, clave
  ausente, sonda alterada rechazada con original intacto, limpieza que
  conserva claves ajenas, guardas `personal`/`repo-*`/`snaprec-*`,
  destrucción sin registro (fail-closed), binding R2 ausente (sin simulación).
- `bun run typecheck` (NODE_OPTIONS=--max-old-space-size=1024) → exit 0.
- `bun scripts/check-invariants.mjs` → pass; `wrangler.g1.jsonc` parsea
  (jsonc→json) y conserva sin cambios `wrangler.jsonc`.
- **`bun run build` NO verificable hoy**: OOM del kernel (SIGKILL, exit 137)
  en la fase de render tras transformar 3997/3997 módulos. **Comparación de
  atribución**: el build del baseline prístino `3669bd5` (3995 módulos)
  muere de forma idéntica en la misma fase → bloqueo ambiental de memoria
  del Container (1 vCPU / 1.1 GiB), no regresión de esta PR. La docs
  preexistente registra un build correcto el 2026-11-12.

## 7. Defectos encontrados durante el desarrollo y su corrección

1. **Layout de verificación tras restaurar**: la fase `verify` leía el
   marcador bajo `<creator>/…` cuando el árbol restaurado vive en
   `<restorer>/__extbk-<creator>-<runId>/`. Corregido; detectado por el
   round-trip real (fallo rojo antes del fix).
2. **Campo de informe mal alineado**: el programa emitía `markerSha256Out`
   y el parser estricto exige `markerSha256`. Corregido en el programa.
3. **Test con subida inconsistente**: un test construyó un manifiesto con un
   digest que no correspondía a los bytes y el pin `sha256` de `put` (que
   replica R2) lo rechazó correctamente; el test se corrigió para subir
   bytes consistentes y usar el digest falso SOLO en el hand-off.

## 8. Cómo ejecutar el ensayo REMOTO (requiere despliegue autorizado)

Esta tarea NO desplegó nada y NO ejecutó nada contra el bucket real.
Cuando el propietario autorice el despliegue en Staging, la invocación es
por el Workflow privado preexistente (la API de Workflows de la cuenta, sin
ruta HTTP nueva):

```json
{"action": "external_backup_drill"}
```

Pasos del Workflow (reintentos 0; la limpieza corre siempre):
`allocate-disposable-extbk-scope` → `create-extbk-backup-upload-r2` →
`destroy-creator-instance` → `restore-cross-do-from-r2` →
`probe-tampered-backup` → `probe-missing-backup` → `cleanup-extbk-drill`.

Gates para declarar PASS (todos obligatorios, sin excepciones):
- `passed: true` con `createPassed`, `destroyPassed`, `crossRestorePassed`,
  `tamperRejected`, `missingRejected` y `cleanupOk` en `true`;
- `create.record.manifestSha256` con formato hex64 y `restore.ok: true`
  con `restoredReceipt.source/target` correctos;
- `cleanup.r2Cleanup.deleted >= 2` y sin `error`; los dos DOs limpiados;
- el JSON del informe archivado como evidencia en la PR.

## 9. Qué NO cubre esta PR (sin inventar cobertura)

- No lee, guarda ni restaura datos de proyectos reales, sesiones personales
  ni DOs existentes: los metadatos de tarea/sesión son sintéticos
  (`ses_extbk_*`) y lo dicen en su propio campo `note`.
- No sustituye al respaldo DO existente ni al snapshot drill; es un peldaño
  adicional para sobrevivir a la pérdida total del DO.
- El transcript real de OpenCode (DO del agente) y un export/import completo
  de sesiones NO se implementaron: no se puede probar en este entorno sin
  tocar DOs personales, y el encargo prohíbe inventar cobertura.
- La ejecución en vivo contra `opencode-v1-recovery-20261112` queda
  pendiente de despliegue autorizado; hasta entonces este hito no declara
  PASS de recuperación externa real.
