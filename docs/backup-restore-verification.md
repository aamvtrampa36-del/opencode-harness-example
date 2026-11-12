# Respaldo y restauración verificables — estado staging

Fecha: 2026-11-12. Rama: `opencode/supervised-a7c05e19d24b638f`. Estado: **borrador de
trabajo, sin desplegar**. Nada de este documento certifica producción.

## Qué se implementó (superficie mínima)

- `src/container-verify.ts` (nuevo): programa Node sin dependencias (`FS_VERIFY_SOURCE`)
  que se ejecuta DENTRO del container Linux del proyecto; es la única fuente de verdad y
  corre igual desde el Worker (`container.exec`) y desde
  `scripts/verify-backup-restore.mjs`. Además: parser estricto del informe
  (`parseVerifyReport`, fail-closed), normalización de identidad de imagen OCI
  (`normalizeImageRef`), preflight fail-closed de snapshots (`preflightSnapshotSupport`),
  evaluación de integridad (`assertRoundTripIntegrity`) y evaluación de rutas de rollback
  (`evaluateRollbackPaths`).
- `src/container-verify.test.ts` (nuevo): round-trip REAL (spawn de node+tar), control
  negativo (corrupción → FAIL), entorno inválido → FAIL, y tests de helpers puros.
- `src/dev-container.ts`: métodos nuevos `verifyRestore(project)` y `snapshotPreflight()`.
  No se modificó el ciclo de vida existente (`ensureRunning`, checkpoints, alarm).
- `src/server.ts`: ruta nueva `POST /api/dev/verify/:project` (mismo Origin + Content-Type JSON; 200 solo si ok y exitCode=0) que devuelve el informe JSON.
- `scripts/verify-backup-restore.mjs` (nuevo): corredor local con control negativo
  (`--expect-fail`). Sin dependencias nuevas; `package.json` y CI sin cambios.

## A. Respaldo/restauración REAL del filesystem — VERIFICADO EN VIVO

Round-trip real ejecutado en el container Linux del proyecto
(`supervised-a7c05e19d24b638f`, Debian 13 trixie, kernel 6.18.56-cloudflare-microvm,
Node v24.22.1, x64), con archivo de prueba aislado y hash SHA-256:

1. Crea payload aleatorio de 64 KiB + manifiesto; ancla `payloadSha256`.
2. `tar -czf` hacia ubicación externa (`/tmp`); verifica magia gzip y ancla `archiveSha256`.
3. Corrompe la copia viva (append + borra manifiesto).
4. Restaura desde el archivo externo y recalcula TODOS los hashes + identidad.
5. Éxito solo si todos los checks pasan; en fallo conserva artefactos y sale ≠ 0.

Evidencia (modo normal, `bun scripts/verify-backup-restore.mjs`, exit 0):
- `payloadSha256=697abdaae4051080716a280e89a130aaa1706bb5dad218d2dd6d97658604f6d1`
- `archiveSha256=2f6d08c791c86641c8263249d4bde6f0f5b22ae580463fb2febbccd73ebacf11` (66069 bytes)
- 9/9 checks pass, artefactos limpiados.

Control negativo (`--expect-fail`, exit 0 del corredor porque el veredicto esperado es FAIL):
- Archivo truncado 64 bytes → `restore-extracted: fail`, informe `ok:false`, exit 1 del script.
- Demuestra que el harness detecta corrupción y NO emite PASS sintético.

## B. Rollback de Worker — independencia entre APIs

El resultado vacío de `GET /containers/applications/{id}/versions` corresponde a la aplicación **Container** con `scheduling_policy=durable_object`. NO es el historial del **Worker**. La API de despliegues `GET /workers/scripts/{name}/deployments` devuelve versiones del Worker y permite la reversión cuando los bindings siguen compatibles.

En una ejecución anterior se comprobó el rollback real del Worker **Staging** desde `17d26f40-d71c-4eaa-869e-da2e1b2a11a4` a `d028f857-2dc9-4593-ac9b-9de6751c8dad` y de vuelta. Esta PR NO repitió esa prueba ni realizó despliegues.

La evaluación `evaluateRollbackPaths` recibe exclusivamente el conteo de versiones de **Worker**, nunca el de Container. La existencia de un historial no confirma por sí sola que un rollback específico sea compatible con migraciones o bindings vigentes.

## C. Rollback de imagen de Container — requiere despliegue (bloqueo documentado)

- La API real instalada (`@cloudflare/workers-types` 5.20261108.1 + `@cloudflare/computer`
  0.10.0) expone `container.inspect(): Promise<ContainerInfo|null>` con `{labels, image}`
  (referencia concreta, normalmente digest OCI), `snapshotContainer()` y
  `start({containerSnapshot:{id}})` exclusivo con `{image}` (exclusión mutua en tipos).
  `snapshotDirectory()` está declarado solo en los tipados `experimental`, NO en el
  `index.d.ts` que resuelve este tsconfig: el preflight la sondea estructuralmente y, si
  falta, reporta `supported:false` (fail-closed).
- El repo ya restaura desde snapshot (`ensureRunning`) y hace checkpoint con
  `snapshotContainer` (alarm). Ese código es preexistente; esta tarea no lo alteró.
- **Bloqueo**: probar snapshot/restore en vivo exige el Worker desplegado. Esta tarea
  prohíbe desplegar y destruir Containers, por lo que ese round-trip NO se ejecutó.
  `snapshotPreflight()` queda listo para el propietario y siempre reporta
  `liveProof: "pending-deployment"` hasta existir prueba real post-despliegue.
- La identidad de imagen la captura `container.inspect().image` (digest OCI) en el DO;
  el script local captura os/kernel/node/arch como identidad consistente del anfitrión.

## D. Datos persistentes (independientes del snapshot de 30 días)

- Camino preexistente verificado por unit tests: `saveBackup` archiva el proyecto
  (tar.gz vía `/__archive`), lo trocea en DO SQLite con escritura versionada
  (`backup-data:<project>:<version>:<i>`) y `downloadSavedBackup` verifica SHA-256 antes
  de entregar; sobrevive a la expiración de 30 días del snapshot.
- Los helpers (`chunkBackup`/`joinBackup`/`sha256Hex`) tienen tests (31 preexistentes +
  11 nuevos, 42 pass en total). La prueba EN VIVO de saveBackup→downloadSavedBackup
  contra un DO real requiere despliegue: pendiente (mismo bloqueo que C).

## R2 — NO autorizado, NO implementado

`wrangler.jsonc` no declara `r2_buckets`. El encargo exige respaldo por R2 solo con
bindings ya autorizados: no hay ninguno, así que no se implementó y no se simuló.

## Cómo reproducir

```sh
bun install --frozen-lockfile
bun test                                   # 42 pass (incluye round-trip real)
bun scripts/verify-backup-restore.mjs      # exit 0 exige ok:true
bun scripts/verify-backup-restore.mjs --expect-fail   # exit 0 exige ok:false detectado
NODE_OPTIONS=--max-old-space-size=1024 bun run typecheck   # heap por OOM en 1 vCPU/1.1 GiB
bun run build                              # ~2 min en este container
bun scripts/check-invariants.mjs
```

## Bloqueos y restricciones observados

- `tsc --noEmit` y `vite build` mueren por OOM de Node con el heap por defecto en este
  container de 1 vCPU / 1.1 GiB; con `--max-old-space-size=1024` ambos pasan.
- Sin despliegue: B, C y la prueba viva de D quedan pendientes de un entorno autorizado.
- Sin destrucción de Containers: no se probó destroy + `start({containerSnapshot})`.
- La herramienta genérica de escritura de workspace está desactivada en sesiones de
  proyecto; los cambios se escribieron dentro del container Linux del proyecto y se
  publican vía la herramienta de GitHub solo en la rama precreada.

## Corrección de revisión independiente

Una revisión detectó dos falsas equivalencias y las corrigió: (1) `snapshotDirectory` NO es necesario para la instantánea completa `snapshotContainer`; la ausencia de esa API opcional no desactiva el soporte completo; (2) versiones de Containers != versiones de Workers. El resultado de la prueba `tar+gzip` utiliza `/tmp` del **mismo Container** y **no** prueba restauración tras pérdida de instancia. Los respaldos de DO están cubiertos por código y unit tests, no por un ensayo completo de restauración del estado productivo. Las puertas de producción permanecen pendientes.


**Seguridad de la API:** la ruta de verificación crea y altera un fixture temporal y, por ello, **no puede activarse con GET**. Requiere POST con Origin de la aplicación autenticada y Content-Type JSON. Los informes fallidos responden HTTP 422, no HTTP 200. Esta ruta no da permisos adicionales al supervisor ni transforma pruebas locales de tar en respaldo durable.
