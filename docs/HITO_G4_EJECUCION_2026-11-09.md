# OpenCode Cloud — G4: persistencia y recuperación real (9 noviembre 2026)

**DICTAMEN: G4 APROBADO, ALCANCE PERSONAL V1.** Se construyó y probó una restauración auténtica e independiente de las snapshots: se guardó un proyecto Linux en Durable Object SQLite, se destruyó deliberadamente su Container aislado, se confirmó que el Container nuevo no contenía el proyecto y se recuperaron los archivos, la referencia de sesión y los metadatos Git. Los cuatro hashes de archivos coincidieron y Node volvió a pasar las pruebas. La operación se verificó en staging; no se modificó producción.

## 1. Fuentes y punto de partida

Se recuperaron íntegramente el **Informe técnico integral — OpenCode Cloud V1**, PDF de 21 páginas y 1.524 líneas, y los documentos `docs/HITO_G1_EJECUCION_2026-11-09.md`, `docs/HITO_G2_EJECUCION_2026-11-09.md`, `docs/HITO_G3_EJECUCION_2026-11-09.md`, `docs/V1_EXECUTION_PLAN.md` y `docs/ARCHITECTURE_DECISION_2026-11-08.md`. G1 demostró reparación; G2 autodesarrollo con PR #29; G3 conservó Workerd/Harness sin exigir instalación del motor nativo.

**Gate G4:** copia fuera del Container, archivos/restauración comprobables con hashes, detención/reinicio, prueba ante fallos durante escritura, contexto de proyecto y sesión útil, ruta de reversión documentada. Siguiente gate: G5, interfaz sin terminal.

## 2. Funcionalidad realizada

El código anterior ya permitía descargar y almacenar archivos `.tar.gz` en SQLite de Durable Objects (hasta 2 MiB comprimidos), separado de las snapshots beta del Container. **Carecía de restauración ejecutable verificada**. Se implementó lo necesario sin introducir R2, servicios, dependencias ni otro motor:

- `src/restore-project.ts`: restauración dentro de Linux a un destino **nuevo** con descompresión de tamaño acotado, validación de nombres de tar, rechazo de enlaces y rutas fuera del proyecto, escritura en directorio temporal, hashes SHA-256 del contenido realmente escrito y publicación mediante cambio de nombre atómico. Ante errores no se publica el directorio parcial ni se modifica un proyecto existente.
- `src/restore-project.test.ts`: prueba de ida y vuelta con `node --test`, restauración desde filesystem completamente vacío, rechazo de archivos inválidos/symlinks y destino existente, y fallo simulado **después de escribir y antes de publicar**, seguido de recuperación exitosa. Las pruebas fueron ejecutadas por CI, no aceptadas por declaración textual.
- `src/durable-backup.ts`: metadatos opcionales de referencia de sesión, rama y SHA de commit, sin guardar credenciales.
- `src/dev-container.ts`: `restoreSavedBackup(origen,destino)`, que lee los chunks persistentes, valida SHA-256 del archivo y envía los bytes por stdin a un proceso Node aislado. Registra el proyecto restaurado. `saveBackup` conserva metadatos Git cuando están disponibles. La extracción no sobrescribe proyectos.
- `src/server.ts`: ruta autenticada por Cloudflare Access y protegida por Origin/JSON `POST /api/dev/restore/{origen}` con `{ "target": "nombre-nuevo" }`. El respaldo `POST /api/dev/backup/{origen}` acepta `{ "sessionRef": "..." }` opcional. Las consultas y descargas anteriores se conservan.
- **No se tocaron los datos de CDF CLOUD o WorkBench, la rama `main`, PR #29, credenciales, permisos de Cloudflare Access ni producción.** No se realizaron llamadas al modelo; no se consumió presupuesto de inferencia OpenRouter para G4.

## 3. Prueba real en Cloudflare — resultados

Instancia de Durable Object exclusiva: `DEV.getByName("g4-isolated-20261109-v2")`; proyectos de prueba `g4-proof-source` y `g4-proof-recovered`. **No se utilizó el DO `personal` ni se detuvieron proyectos reales.** El runner programado de staging se retiró después.

### Hallazgo y corrección

**22:15:46 UTC**, el primer ensayo devolvió `status=failed, phase=restore`, porque un Container recién creado no tenía todavía `/workspace/projects`. No se ocultó ni se adjudicó éxito. Se añadió la creación del directorio raíz antes de restaurar y una regresión de filesystem vacío. La corrección aprobó **GitHub Actions #169**. La ejecución se repitió en un DO nuevo, preservando el aislamiento.

### Evidencia de aprobación

**2026-11-09 22:18:29 UTC**, Cloudflare Workers Observability registró `G4_PROOF_20261109` con `status="passed"`. Resultado confirmado:

| Criterio | Evidencia |
|---|---|
| Fuente y backup fuera del Container | Tar comprimido de **428 bytes** en SQLite de DO; SHA-256 `7eefa6cd7a4a8c3b39fa0c8f1342a789c32aea60e6d17e167cd2b38ad55dfa45` |
| Destrucción real del Container | `container.destroy()` ejecutado sobre instancia aislada |
| Reinicio desde imagen vacía, no snapshot | Se verificó que `g4-proof-source` **no existía** antes de restaurar |
| Restauración independiente | Se creó `g4-proof-recovered`; SHA-256 de contenido `0209d18f2b5f32d25c7d007614343bb920ffc89d47c95e60a932a229c4a25fd4` |
| Integridad de archivos | **4/4 hashes SHA-256 idénticos antes y después**, incluidos `calc.mjs`, `calc.test.mjs`, `session-context.json` y `pending-work.txt` (cambio local aún no confirmado en Git) |
| Tests tras restauración | `node --test calc.test.mjs` **aprobado** |
| Metadata persistente | `sessionRef=g4-proof-do-pointer`, `gitBranch=opencode/g4-pilot`, `gitHead=ffa013e83d2d748de8de7cf5b4a1803301d5dec8` |
| Resistencia a sobrescritura | Intento de restaurar encima del destino existente **rechazado** |
| Escritura interrumpida | Simulación unitaria verificó que el destino parcial no se publica y que el reintento funciona |

El respaldado independiente es persistente en Durable Object SQLite, **no** una snapshot de 30 días ni una copia dentro del Container destruido.

### Historial del agente

Se consultó directamente y en modo lectura la base SQLite del `OpenCodeAgent` de staging. La sesión histórica de G2 `ses_e3e9e8729ffatpooTEb0xeB1yi` continuaba registrada con **20 mensajes**, tanto antes como después del ensayo de G4.

Esto acredita persistencia de historial Workerd en Durable Objects, separado del Container Linux. La referencia `sessionRef` del backup es **un puntero**, no un transcript exportado. **No se ha demostrado la reanudación automática de un agente que estuviera ejecutando herramientas en el momento exacto de una caída**, ni importación de sesiones en otro motor. No se inventa esa capacidad.

## 4. Seguridad, limitaciones y ruta de reversión

**Uso normal del mecanismo protegido** (Cloudflare Access + petición JSON del mismo origen):

1. Respaldar un proyecto existente mediante `POST /api/dev/backup/{proyecto}`. Puede añadirse una referencia de sesión. Anotar el hash SHA-256 devuelto.
2. Consultar metadatos en `GET /api/dev/backups` y descargar una copia en `GET /api/dev/backup/{proyecto}`.
3. Si desaparece el Container, abrir un proyecto con un **nombre nuevo** mediante `POST /api/dev/restore/{proyecto}` con cuerpo `{ "target": "proyecto-recuperado" }`. No se permite restaurar sobre una carpeta ya existente.
4. Comparar archivos y hashes y ejecutar los tests. Si falla, el respaldo anterior sigue en DO; detenerse sin borrar el proyecto original, inspeccionar el motivo y volver a restaurar con otro nombre. GitHub conserva el historial remoto; revisar rama/commit registrados antes de reanudar el trabajo.

**Límites conocidos:**
- Límite actual de almacenamiento interno **2 MiB comprimidos** por backup. Proyectos mayores requieren exportación externa y, si es necesario, un almacenamiento ampliado cuando el costo/beneficio lo justifique.
- El archivo excluye `.git`, `node_modules`, archivos de entorno, llaves y otros secretos. Los hashes de rama/commit se guardan como **metadatos**; el checkout Git, dependencias y autenticación deben reconstruirse cuando correspondan. No interpretar la referencia de sesión como respaldo completo de mensajes.
- Las snapshots beta expiran tras 30 días; no son respaldo independiente definitivo. El contenido recuperado aquí se almacenó fuera del Container, en SQLite DO.
- Las pruebas se hicieron con un proyecto pequeño e inocuo. La confiabilidad estadística, proyectos CDF CLOUD/WorkBench, interfaz Android y recuperación de ejecuciones interrumpidas siguen sujetos a sus gates específicos. No declarar toda la V1 finalizada.
- No se creó cuota interna diaria artificial. El presupuesto externo OpenRouter informado de **US$2/día** permanece sin cambios. El costo exacto de CPU/Container y almacenamiento no estuvo disponible y no se inventa.

## 5. Validación, cambios y estado final

- GitHub Actions **#163**: prueba de recuperación e invariantes aprobadas después del ajuste de ejecución ES module.
- GitHub Actions **#169**, `42710534163`: `success` para el ensayo corregido en filesystem vacío, TypeScript, build e invariantes.
- Se corrigió únicamente el fallo reproducido del directorio raíz ausente; no se refactorizó el sistema ni se introdujo otro motor.
- Se canceló el Cron temporal mediante Cloudflare API: respuesta `success:true, schedules:[]`.
- Se restauró `wrangler.g1.jsonc` a `main: src/server.ts`, `crons:[]` y observabilidad habitual, se retiró el método temporal `g4IsolatedPilot()` y se eliminó `src/g4-proof-runner.ts`. **La restauración definitiva y sus pruebas permanecen.**
- Conservadas PR #28 y #29 como borradores sin fusionar. Versión productiva al comienzo: `1d70eb77-316e-408d-bd14-5f19b171dedf`; no se desplegó producción.
- **Validación final de último commit documental y versión de staging**: se añade después de confirmar build/CI. No usar la versión transitoria de la prueba como versión final de staging.

## 6. Dictamen y siguiente paso

**G4 APROBADO para el gate personal V1:** respaldo independiente del Container, destrucción y recuperación real desde entorno vacío, cuatro archivos y metadatos verificados, pruebas verdes, protección contra sobrescritura, fallo de escritura reversible e historial de sesión separado persistente.

**Única siguiente prioridad: G5 — Interfaz para vibe coding.** Simplificar el flujo para que el usuario seleccione proyecto y tarea, vea progreso real, pruebas, archivos cambiados y costo; y pueda acceder a respaldo/restauración y reanudar desde Android sin usar terminal. Basarse en interfaces y APIs existentes; no duplicar OpenCode Web ni crear otra plataforma.

Referencias:
- [Plan maestro V1](https://github.com/aamvtrampa36-del/opencode-harness-example/blob/fix/repeatable-agent-verification-20261108/docs/V1_EXECUTION_PLAN.md)
- [Informe G3](https://github.com/aamvtrampa36-del/opencode-harness-example/blob/fix/repeatable-agent-verification-20261108/docs/HITO_G3_EJECUCION_2026-11-09.md)
- [PR #28 — staging](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/28)
- [PR #29 — autodesarrollo](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/29)
- [CI #169](https://github.com/aamvtrampa36-del/opencode-harness-example/actions/runs/42710534163)


## 7. Cierre operativo verificado (2026-11-09 22:24 UTC)

Se comprobaron directamente los siguientes resultados después de retirar la infraestructura temporal:

- **GitHub Actions #173**, run `42711351621`: job `validate` completado con `success` y cero etapas fallidas para el commit `34a5dfd7632c56cb8ee3501f4f8219d6afab10ce`.
- **Cloudflare Workers Builds:** build `fa99056d-d7c2-4cae-bb28-2672f20b3741` completado con `success` para ese mismo commit.
- **Staging:** versión activa `be5a8304-003a-4706-b2b7-0d339fc300fb` en la comprobación previa a este apéndice. El código publicado **sí** conserva `restoreSavedBackup`, **no** contiene `g4IsolatedPilot` ni `G4_PROOF_20261109` y mantiene `G1_DEV_UNLIMITED_CHECKS`.
- **Cron:** `schedules=[]`. **Containers activos:** `active=0, starting=0` comprobados a las **22:24:30 UTC**. Se dejó de facturar tiempo activo de esos Containers.
- **Cloudflare Access:** la aplicación de staging continúa protegida con política `allow`; no se cambió autenticación.
- **Producción:** `opencode-harness-example` sigue en `1d70eb77-316e-408d-bd14-5f19b171dedf`, sin despliegue ni alteración.
- Las PR #28 y #29 siguen sin fusionar, y no se cambió la configuración privada de GitHub/OpenRouter.

Este apéndice es documental y puede originar una nueva versión de staging por el pipeline existente. **El dictamen G4 no depende de esa numeración**, sino de la evidencia real registrada y de CI. El siguiente y único trabajo autorizado por el plan es **G5 — Interfaz para vibe coding**.
