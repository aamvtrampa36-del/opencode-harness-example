# Ensayo de recuperación real del filesystem de Container (snapshot drill)

Fecha: 2026-11-12. Rama de trabajo:
`opencode/staging-ad42c8f71e905b63` (base exacta `feat/staging-supervisor-control-20261111`,
commit `3e9010b2e9b9ec5d122dda8f0bfb166ba66451b9`). Estado: **preparado y probado en
unit tests; la ejecución remota REAL queda PENDIENTE de despliegue autorizado**. Nada de
este documento declara PASS de producción ni certifica recuperación de datos productivos.

## 1. Base factual verificada (leída del código, no supuesta)

- `wrangler.jsonc` declara la Container app para `DevContainer` con
  `scheduling_policy: "durable_object"`: cada Durable Object tiene su Container propio.
- `DevContainer.alarm()` ya hace checkpoint con `container.snapshotContainer()` y guarda
  `snapshotId` en DO storage; `startOrRecover()` ya arranca con
  `ctx.container.start({ containerSnapshot: { id } })` (nunca con imagen si hay snapshot).
- Los snapshots de Container: TTL de 30 días (`SNAPSHOT_TTL_MS`), inmutables, ligados a
  la imagen y SIN procesos. `assertRecoverableContainer` falla cerrado si el snapshot
  venció o si hubo actividad sin snapshot (no arranca disco vacío).
- El método preexistente `verifyRestore` prueba tar+gzip **en el MISMO container**:
  NO prueba perder la instancia ni restaurar el snapshot. Este hito cubre ese hueco
  con un ensayo en DOs nuevos y desechables.

## 2. Diseño del ensayo (seguro, desechable, repetible)

Módulo nuevo `src/container-recovery.ts` (guardas, parsers y programa
in-container), módulo de enlace `src/container-recovery-do.ts` (añade los métodos
del ensayo a `DevContainer` por aumentación de prototipo al importarlo;
`src/dev-container.ts` permanece INTACTO) y ruta
`POST /api/dev/snapshot-recovery-drill` que se agrega a `src/server.ts` con el
patch machine-legible `docs/evidence/server-drill.patch` (50 líneas: un import de
efecto, `drillProjectNames`, el cast tipado `DrillDev` y el bloque de ruta). Por cada invocación se crean **dos DOs nuevos**
`projectContainerName("snaprec-a-<nonce12>")` (creador) y
`projectContainerName("snaprec-b-<nonce12>")` (restaurador cruzado), con nonce de
`crypto.randomUUID()`. Nunca se toca `personal`, sesiones ajenas, datos productivos
ni credenciales: `assertDrillProject` rechaza todo slug que no empiece por `snaprec-`
(los tests lo demuestran, incluido el programa in-container que se niega a correr
aunque se le invoque directamente con otro proyecto).

Fase 1 — `drillCreateSnapshot` (DO creador):
1. `DRILL_SOURCE` (programa Node sin dependencias) crea en `/workspace/projects` un
   directorio aislado `__drill-<proyecto>-<runId>` con un marcador único
   (`opencode-snapshot-drill-v1|proyecto|runId|<48 hex aleatorios>`) y un manifiesto.
2. El SHA-256 del marcador se calcula DOS veces: dentro del container y en el Durable
   Object (`hashText` con WebCrypto). Deben coincidir o la fase falla.
3. `container.snapshotContainer({ name: "opencode-drill-" + runId })` y el handle se
   persiste en el DO (claves existentes `snapshotId`/`savedAt` + registro dedicado
   `recovery-drill-record-v1` con hashes, imagen `container.inspect().image` y TTL).
4. **Control negativo**: se muta el disco vivo DESPUÉS del snapshot (append al marcador
   + archivo extra `post-snapshot.txt`). Un restore válido NO debe contener estos cambios.

Fase 2 — `drillRestoreSameDo` (DO creador, pierde su instancia):
1. Lee el registro persistido; `assertSnapshotHandle` aborta sin destruir nada si el
   handle falta o venció (fail-closed, jamás arranca imagen vacía).
2. Comprueba metadata DO ANTES (`recordPresent`, `snapshotId`, `savedAt`, `handleMatchesRecord`).
3. `container.destroy("opencode-drill-recovery")` — SOLO esa instancia desechable — y
   espera `!running`.
4. `container.start({ containerSnapshot: { id } , entrypoint:["sleep","infinity"],
   enableInternet:true, instance:"basic" })` — sin `image` (exclusión mutua tipada,
   igual que `startOrRecover`).
5. Verifica: `assertCompatibleImage` (imagen restaurada == imagen pre-snapshot),
   SHA-256 del marcador restaurado == ancla pre-snapshot, ausencia del archivo de
   mutación posterior (`DRILL_MUTATION_ABSENT=1`) y manifiesto intacto.
6. Comprueba metadata DO DESPUÉS (las mismas claves persisten y siguen casando).
   Guarda el outcome en `recovery-drill-result-v1` (evidencia máquina-legible).

Fase 3 — `drillCrossRestore` (DO restaurador, distinto):
- Arranca su propio DO, destruye su instancia en blanco y llama
  `start({ containerSnapshot: { id } })` con el handle del creador.
- Resultados: `crossDoRestore: "verified"` (recuperación cruzando DO),
  `"start-rejected"` (la plataforma rechazó el arranque: queda **pendiente** como
  limitación observada, NO se atribuye a código de aplicación) o
  `"verification-failed"` (arrancó pero los checks fallaron: hallazgo real).
- Si la recuperación cruzando DO no es posible en este hito, queda documentado aquí
  como pendiente con el error capturado, sin atribución.

Limpieza — `drillCleanup` (ambos DOs, siempre, también en error):
- Destruye el container si sigue vivo y borra `snapshotId`/`savedAt`/registro.
- `lastActivity` se conserva a propósito: `assertRecoverableContainer` rechazará
  cualquier arranque futuro de ese DO desechable (sin re-vínculo silencioso a disco vacío).

## 3. Qué NO cambia

- `src/dev-container.ts` NO se modifica en esta rama: los métodos del ensayo se
  adjuntan a la clase existente por aumentación de prototipo desde
  `container-recovery-do.ts` (side-effect import en `server.ts`), con las mismas
  constantes de ciclo de vida replicadas y documentadas.
- El resto del ciclo de vida preexistente (`ensureRunning`, checkpoints por alarma,
  `run()`, backups DO) no se modificó. Los proyectos `snaprec-*` nunca tocan el
  inventario de proyectos ni el registro del DO `personal`.
- Coste mínimo: dos DOs/containers nuevos de instancia `basic`, vivos solo durante el
  ensayo; el restore solo mueve el filesystem del snapshot ya almacenado.

## 4. Pruebas ejecutadas realmente (evidencia local)

Clone en el proyecto de prueba `supervised-ad42c8f71e905b63`, re-ejecutado con la
estructura final (módulo de enlace + patch; ver commit local en la evidencia JSON,
sobre la base `3e9010b2`):

- `bun install --frozen-lockfile` → exit 0 (672 paquetes).
- `bun test` → **197 pass, 0 fail** (línea base 177 + 20 nuevos de este ensayo;
  incluye round-trip real node+tar preexistente y ejecución REAL de `DRILL_SOURCE`).
- `bun run typecheck` (NODE_OPTIONS=--max-old-space-size=1024) → exit 0, 0 errores.
- `bun scripts/verify-backup-restore.mjs` → exit 0; con `--expect-fail` → exit 0
  (detecta corrupción; sin PASS sintético).
- Tests de rechazo exigidos (todos implementados y en verde):
  1. **Imagen diferente** → `assertCompatibleImage` rechaza digest distinto, falta o
     formato inválido (`rechazo de imagen diferente`).
  2. **Snapshot ausente** → `assertSnapshotHandle` aborta el restore sin destruir nada
     y sin imagen vacía; vencido (TTL 30 días) también (`instantánea ausente o vencida`).
  3. **Marcador alterado** → `assertMarkerIntegrity` rechaza hash distinto y mutación
     superviviente; además la ejecución REAL del programa (create→mutate→verify con
     ancla pre-snapshot) falla con exit≠0 y `ok:false`, demostrando detección sin
     PASS sintético (`marcador alterado`, `control negativo real`).
  4. **Operación fuera del proyecto** → `assertDrillProject("personal")` y cualquier
     slug sin prefijo `snaprec-` se rechaza; `assertDrillRecordProject` rechaza
     registros ajenos; `drillProjectNames` valida nonce de 12 hex
     (`operación fuera del proyecto`).

## 5. Cómo ejecutar el ensayo REMOTO (requiere despliegue autorizado — gates)

Esta tarea NO desplegó nada y NO ejecutó el ensayo contra Workers/Containers reales.
Cuando el propietario autorice el despliegue a Staging:

1. Aplicar el patch `docs/evidence/server-drill.patch` sobre `src/server.ts`
   (`git apply docs/evidence/server-drill.patch`; la base es exactamente
   `3e9010b2`, el resto de los módulos ya está en la rama) y desplegar en Staging
   (`vite build && wrangler deploy` con los permisos del propietario; fuera del
   alcance de esta tarea).
2. Invocación (solo staging, mismo origen autenticado + JSON, como los probes):
   ```
   POST https://opencode-g1-staging.cdf-cloud-mvp-20261019.workers.dev/api/dev/snapshot-recovery-drill
   Origin: https://opencode-g1-staging.cdf-cloud-mvp-20261019.workers.dev
   Content-Type: application/json
   Cookie: <sesión autenticada del propietario>
   ```
   Sin cuerpo. La ruta crea los dos DOs `snaprec-a-<nonce>`/`snaprec-b-<nonce>`,
   ejecuta las 3 fases + limpieza y responde JSON máquina-legible.
3. Gates para aceptar el resultado (todos obligatorios, sin excepciones):
   - `passed: true` con `restoreSameDo.ok: true`, `destroyedInstance: true`,
     `crossDo.ok: true` o `crossDoRestore: "start-rejected"` documentado como pendiente
     con el error de plataforma capturado;
   - `create.doHashVerified: true` (ancla doble container/DO);
   - `restoreSameDo.metadataBefore.handleMatchesRecord && metadataAfter.handleMatchesRecord`;
   - checks `marker-integrity`, `manifest-integrity`, `manifest-hash` y
     `post-snapshot-mutation-absent` en `pass`;
   - `cleanup` con los dos DOs gestionados (container destruido, handle borrado).
4. PASS declarable SOLO con esa ejecución observada y su JSON archivado. Mientras no
   ocurra, `liveProof` de este hito sigue siendo pendiente de despliegue; el método
   `snapshotPreflight()` preexistente continúa reportando `liveProof:
   "pending-deployment"` y no se alteró.

## 6. Pendientes explícitos (sin atribución)

- Ejecución remota real (fase 2 same-DO): requiere despliegue autorizado. PENDIENTE.
- Recuperación cruzando DO (fase 3): puede ser rechazada por la plataforma
  (`start-rejected`); si ocurre, queda documentada como limitación observada del
  runtime y NO como fallo del código de aplicación. PENDIENTE de evidencia.
- El ensayo no sustituye al respaldo DO independiente (`saveBackup`/
  `downloadSavedBackup`), que sigue siendo la vía que sobrevive a la expiración de
  30 días del snapshot.
