# B2 — Backup/restore del SQL privado de sesiones (Staging, 2026-11-13)

Estado: **implementación lista para ensayo real en Staging** (PR borrador; sin despliegue ni fusión).
Base: `feat/staging-supervisor-control-20261111` (7edac108). No toca `src/server.ts` ni `wrangler.jsonc`.

## Qué entrega

Acción privada de Workflow **solo Staging** `{ "action": "session_backup_drill" }` que:

1. Crea un conjunto pequeño de sesiones de prueba **vía métodos normales** del harness
   (`sessions.create()`; una de ellas con un turno real corto en Workers AI
   `@cf/openai/gpt-oss-20b`, prompt fijo sin secretos) dentro de un DO **desechable**
   `opencode-sqlbak-a-<nonce>` del namespace dedicado `SESSION_BK`.
2. Exporta un **snapshot versionado SHA-256** de TODAS las tablas `opencode_*`
   (esquema + filas ordenadas por `rowid`) más las huellas de la lectura normal
   (`sessions.list()` orden/ids + `session(id).history()`), lo sube al bucket privado
   `RECOVERY_R2` bajo `opencode-sqlbk-v1/<runId>/` (snapshot primero con `sha256`
   fijado en `put`, manifiesto AL FINAL como valor de relevo).
3. Restaura en un DO **nuevo y vacío** `opencode-sqlbak-b-<nonce>`: `deleteAll()`
   atómico → apertura del harness (crea el esquema actual) → comprobación de que el
   conjunto de tablas y su CREATE SQL son **idénticos** → aplicación de todas las filas
   dentro de **UNA sola `ctx.storage.transaction()`** con lectura de retorno
   comparada sincrónicamente dentro de la transacción.
4. Verifica tras el commit: digests SHA-256 por tabla re-leídos del SQL objetivo vs
   manifiesto, y **igualdad de contenido/orden/cantidad por método de lectura normal**
   (`sessions.list()` + `history()` por sesión) contra las huellas capturadas en origen.
5. Limpia: borra solo su prefijo propio de R2 y drena (`deleteAll`) ambos DO
   desechables. El resultado del Workflow queda como recibo (conteos, digests, ids).

## Evaluación de la API SQL real (evidencia)

- El estado de sesiones vive en el **SQLite propio del Durable Object**:
  `OpenCodeHarnessContext.storage` documenta que el harness abre OpenCode sobre el
  almacenamiento del objeto «with OpenCode's tables moved under the `opencode_`
  prefix» (agents@0.33.0, dist/harness/opencode/index.d.ts). En `@opencode/core@2.0.24`
  las migraciones confirman las tablas `session_v2` (renombrada desde `session`) y
  `session_message`, con índices `(session_id, time_created, id)` — de ahí
  `opencode_session_v2` / `opencode_session_message` en el DO.
- API de acceso: `ctx.storage.sql.exec(...)` (`SqlStorage`), cursores síncronos
  (`toArray()`), catálogo vía `sqlite_master`. Sin fila de contenido en logs.
- **Atomicidad**: la documentación de Cloudflare (SQLite-backed Durable Objects,
  sep-2026) es explícita: `sql.exec()` **no** ejecuta `BEGIN TRANSACTION`/`SAVEPOINT`;
  las transacciones multi-sentencia se hacen con `ctx.storage.transaction()` (o
  `transactionSync()`), y con backend SQLite **toda** operación de almacenamiento —
  incluidas las consultas `sql.exec()` — ejecutada dentro del closure pertenece a esa
  transacción y revierte si el closure lanza. `deleteAll()` es atómico (todo o nada,
  incluye SQL + KV + alarma). Por tanto la restauración atómica/consistente **es
  garantizable** con la plataforma: DELETE + INSERT + lectura de retorno comparada
  dentro de UNA transacción; cualquier divergencia revierte TODO y el ensayo falla.
- **No usado a propósito**: PITR (`onNextSessionRestoreBookmark`) restaura el propio DO
  a un punto del pasado, no copia estado entre DOs; no sirve para este ensayo cruzado.

## Alcance y limitaciones declaradas

- Se copia y verifica el estado SQL `opencode_*` completo del DO desechable. El KV del
  DO (ámbitos `ProjectScope`, tareas del supervisor) **no** forma parte del backup:
  es estado de la aplicación, no del harness, y la verificación exigida (lecturas
  normales de sesiones) no lo necesita. Queda como trabajo futuro explícito.
- Las filas de `session_message` se ejercitan con un **turno real** (una inferencia
  barata en Workers AI). Si el modelo falla, el ensayo exige reposo (`busy()==false`)
  y al menos un mensaje persistido; si no, falla (fail-closed), no simula.
- Tablas `WITHOUT ROWID` o valores no JSON-fieles (BLOB, bigint > 2^53, NaN/Infinity)
  abortan la exportación en vez de perder datos.
- Los DO desechables no se «destruyen» (no existe API de borrado de DO): quedan drenados
  con `deleteAll()`; igual que los drills existentes dejan contenedores destruidos.
- Tras `deleteAll()` el harness reabre y ejecuta migraciones; si workerd dejara estado
  semilla o sintoma de caché, el ensayo falla con evidencia (`SQLBK_SCHEMA_MISSING_AFTER_WIPE`
  / digests) y **B2 queda bloqueado** hasta entenderlo — contrato solicitado.

## Secretos y seguridad

- Nunca se leen sesiones de usuario: origen y destino son DO nuevos con nombres
  `opencode-sqlbak-*` en el namespace `SESSION_BK`; el workspace del supervisor
  (`opencode-supervisor-v1`) y los workspaces UUID no participan.
- Tablas cuyo nombre parece credencial (`credential|secret|token|api_key|...`) con
  filas **abortan la exportación** (`SQLBK_SECRET_TABLE_NOT_EXPORTED`).
- Resultados solo con conteos, digests e ids; el `snapshotJson` nunca va al resultado
  del Workflow ni a stdout.
- Sin rutas HTTP nuevas (`assets.run_worker_first` sin cambios), sin tokens, sin
  permisos nuevos; los métodos del DO re-verifican `OPENCODE_SUPERVISOR_ENABLED`.
- `wrangler.jsonc` (Producción) intacto. Cambios de infraestructura SOLO en
  `wrangler.g1.jsonc`: binding `SESSION_BK`, migración `v4` y `main: src/entrypoint.ts`
  (entrypoint nuevo que reexporta el Worker de producción sin cambios + la clase de drill).

## Cómo ejecutar el ensayo (tras desplegar Staging con esta rama)

1. Desplegar Staging desde esta rama (crea la migración v4 y el binding `SESSION_BK`).
2. Crear una instancia del Workflow `opencode-supervisor-stage` con parámetros
   `{"action":"session_backup_drill"}` mediante la API de Workflows de la cuenta
   (mismo canal autenticado que los drills existentes; nunca desde el chat ni del agente).
3. Leer el estado de la instancia: `passed:true` exige fixture+export+upload+wipe+
   prepare+commit+verify+cleanup, con `verified.normalReadsMatch == true`.

## Bloqueo informado: CI en el PR

`.github/workflows/ci.yml` es una ruta oficial protegida y la herramienta GitHub
rechazó su edición (`Protected official/production path cannot be edited from
OpenCode`). Consecuencia: el disparador `pull_request` sigue limitado a `main`, así que
el PR borrador contra la base de Staging **no dispara CI por sí solo**. Para activarlo,
el propietario puede añadir `feat/staging-supervisor-control-20261111` a
`pull_request.branches` (una línea). Las pruebas unitarias nuevas
(`src/session-sql-backup.test.ts`) corren con `bun test` y no requieren el runtime de
Worker ni instalación local fuera de CI.

## Pruebas incluidas (unitarias, sin runtime de Worker)

- Ciclo completo con SQL simulado: snapshot estable, parseo estricto, plan, aplicación,
  lectura de retorno y digests idénticos.
- Rechazos: tipo de valor no soportado, número no finito, esquema ausente, tabla tipo
  credencial con filas, tampering byte/nivel-tabla/nivel-conjunto, esquema objetivo
  distinto (falta/CREATE/columnas/extra), conteo/orden/historial/contenido de lecturas
  normales, manifiesto alterado (8 mutaciones), runId/nonce/claves ajenas de R2,
  `SUPERVISOR_DISABLED`, wipe sin `deleteAll`, binding R2 ausente.
