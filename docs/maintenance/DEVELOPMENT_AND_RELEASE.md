# Desarrollo autónomo y publicación Staging

## Iteración rápida

1. Leer AGENTS.md y localizar el componente por ruta/función. Para una sesión OpenCode vinculada, el archivo importado es un archivo fuente sin .git; consulta GitHub para identidad de commit, rama y PR. No simules git push.
2. Crear una rama aislada con base comprobada. Si otra tarea modifica las mismas rutas, revisar el diff y SHA antes de escribir. Nunca usar force push para resolver concurrencia.
3. Reproducir el fallo con el caso mínimo. Ejecutar el test focal con Bun 1.4.4 y lockfile congelado. Solo ampliar a suite completa cuando el cambio esté listo.
4. Registrar exitCode, nombre del caso y SHA. Un resultado textual o finished no equivale a verified; un mock prueba el contrato, no el runtime.

| Superficie | Comando focal desde la raíz |
|---|---|
| GitHub / importación | `bun test src/github.test.ts src/github-import.test.ts src/github-import-source.test.ts src/read-only-supervisor.test.ts` |
| Linux / salida | `bun test src/dev-guard.test.ts src/bounded-process-output.test.ts src/dev-runtime.test.ts` |
| Supervisor | `bun test src/supervisor-control.test.ts src/supervisor-metrics.test.ts src/supervisor-status-reconciliation.test.ts` |
| MCP | `bun test src/staging-control-mcp/server.test.ts src/dynamic-mcp.test.ts` |
| Selección de modelo | `bun test src/model-presets.test.ts src/openrouter-catalog.test.ts` |
| Descargas y preview | `bun test src/download-response.test.ts src/session-export.test.ts src/tool-file-attachment.test.ts`, `bun scripts/test-preview.mjs` |
| Recibo de paquete | `node --test scripts/staging-release-receipt-check.mjs` |
| Selftest | `bun test src/selftest-core.test.ts` |

Antes de integrar: instalación congelada, bun test, pruebas Node, typecheck, build, preview, invariantes. Si la fuente no contiene .git, no inventar SHA; --allow-uncommitted sirve para iteración, no para publicar.

## Staging: fuente, paquete y runtime son estados distintos

Referencia de integración fuente: `staging/reconciled-20261124`, basada en el último build común histórico `74632f75db010223cc90d99ba4a801ce0e6414e5` (CI 45053917747, 438 Bun). No es #163 ni la rama que el supervisor histórico usa para tareas ordinarias. La fuente de la pareja activa no está completamente atestada: principal comparte ETag con el histórico, MCP difiere. Conservar las versiones activas hasta reconciliación y aprobación real de release. No usar esta rama para sustituir las protecciones F0-C10.

El workflow Saneamiento offline empaqueta ambos Workers con dry-run, sin credenciales ni upload. El recibo JSON del job contiene SHA, árbol, run ID, hashes de config y contenidos de ambos paquetes y assets. Comprueba identidad del árbol (si PR merge sintético, padres y árbol) y resultado de CI. El recibo no autoriza publicar, no demuestra que los bytes activos sean iguales y no incluye secretos. Conservar los logs; reconstruir el mismo SHA y comprobar digests o documentar no determinismo.

Publicación: comprobar rama aprobada y SHA, CI, configs, par de Workers, estado del supervisor, presupuesto y rollback. Registrar build ID, versión ID y deployment ID de cada Worker, ETag y hora; volver a leer 100% del tráfico, health y RPC. No publicar desde ramas históricas ni activar pruebas vivas F0-C10. Revertir código a versiones anteriores no revierte DO/Container ni datos. No hacer cambios de bindings, migraciones o secretos como parte de un release documental.

Las pruebas de staging-control-mcp con InMemoryTransport no llaman DO reales. La validación de selecciones de modelo no demuestra disponibilidad ni coste. Descargas externas son enlaces, rutas internas no lo son. Los límites de salida no prueban aislamiento físico ni concurrencia 10/10. Ver [incidente #90](https://github.com/aamvtrampa36-del/opencode-harness-example/issues/90) y registros de F0-C10.


## Barrera de publicación aplicada el 24-11-2026

Cloudflare ADMIN confirmó que los dos triggers existentes (principal 6389b483-1230-47c0-bb2c-9ac007f930d4 y MCP 0256daec-8698-4c50-a035-0fbb53158045) ahora incluyen exclusivamente `staging/release-approved-20261124`, sin exclusiones; los comandos, rutas y token de build permanecen iguales. Esa rama se reserva a una publicación deliberada y **no existe** al establecer esta barrera. No crearla como paso rutinario de desarrollo: podría activar ambos builds. Integrar código y pruebas en `staging/reconciled-20261124` no activa esos triggers. Los branches históricos RPC-safe y remote-control-hardening dejan de activar publicación automática. Los builds manuales/API siguen siendo una capacidad del operador: esta barrera no es un permiso server-side ni garantiza un bloqueo de todos los despliegues posibles. No cambiar Access, secretos o bindings. Para revertir solo la configuración de triggers, los includes previos exactos eran `staging/opencode-g1-rpc-safe-20261120` (principal) y `feat/remote-control-hardening-20261119` (MCP), ambos con branch_excludes []. No restaurarlos sin verificar la fuente para evitar downgrade.

Dos CI iniciales (45328080895 y 45328086240) acreditaron 470 Bun/0 fail, 12 pruebas Node y paquetes dry-run del mismo árbol 098aa0ce1ebc3623896a7fa1180b662812c3c10f. Los hashes de configs y assets coincidieron, pero los hashes de los bundles no: **no se acredita reproducibilidad byte a byte**. No atribuir el motivo sin comparar manifiestos, ni reutilizar un digest de otro run como prueba de publicación. Se elimina el disparador redundante push de este workflow; el PR comprueba padres/árbol y su CI. Una publicación futura requiere artefacto propio certificado, identidad de origen de ambos Workers, aceptación de seguridad/coste y rollback antes de crear o mover la rama de release.


## SANEAMIENTO-03: reproducibilidad y publicación certificada

Usa [SANEAMIENTO_03.md](SANEAMIENTO_03.md) y el workflow `staging-reproducibility.yml`. Dos jobs independientes del mismo SHA fijan Node 22.22.0, Bun 1.4.4, lockfile, imagen, UTC y SOURCE_DATE_EPOCH. El proceso genera los README de paquete con fecha de fuente, mapas reubicables con contenido íntegro y configs para no-bundle. Compara los módulos de ambos dry-run no-bundle, todos los archivos, y el tar.gz determinista completo. Los ZIP de Actions son contenedores de transporte, no el tar certificado. No uses coincidencia de ETag como prueba de origen.

Descarga `staging-repro-a` y `staging-repro-comparison` del mismo run PASS; comprueba ID, SHA exacto, digest de artefactos y comparación. Extrae payload.tar.gz en directorio aislado conservando receipt.json. Desde el checkout limpio del mismo SHA, usa `node scripts/staging-release-guard.mjs verify ROOT CERTIFICATE COMMIT TREE ARCHIVE_SHA CERTIFICATE_SHA principal` (o mcp). Los hashes aprobados deben obtenerse de evidencia independiente, no recalcularse de un artefacto no confiable para aprobarlo. Sólo una operación autorizada puede cambiar verify a upload: Wrangler versions upload --no-bundle, versión inactiva con tag de fuente. No ejecuta deploy ni modifica Containers. Verifica la nueva versión y configuración antes de promoción controlada mediante Cloudflare; preserva rollback. Cualquier trigger automático debe permanecer fail-closed hasta autorización/certificación. La consulta de assets y RPC del workflow sólo se habilita mediante marca [staging-readback] en merge deliberado, no en todos los cambios.


Los runners Ubuntu24.04 gestionados por GitHub pueden tener revisiones de imagen distintas incluso en la misma matriz. Se registra cada revisión observada y se exige identidad de entradas declaradas (incluye familia de imagen, toolchain y lockfile) y bytes reales; no se exige falsamente identidad de una revisión de imagen que GitHub no deja fijar por etiqueta. La operación R4 mantiene ambos triggers actuales con comandos inertes y SHA propio: no sobrescribirlos ni restaurar auto-deploy. La barrera no sustituye el gate de autorización v2 ni STOP_LIVE.
