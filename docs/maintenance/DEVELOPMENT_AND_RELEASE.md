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

Referencia de integración fuente propuesta: `staging/reconciled-20261124`, basada en el último build común histórico `74632f75db010223cc90d99ba4a801ce0e6414e5` (CI 45053917747, 438 Bun). No es #163 ni la rama que el supervisor histórico usa para tareas ordinarias. La fuente de la pareja activa no está completamente atestada: principal comparte ETag con el histórico, MCP difiere. Conservar las versiones activas hasta reconciliación y aprobación real de release. No usar esta rama para sustituir las protecciones F0-C10.

El workflow Saneamiento offline empaqueta ambos Workers con dry-run, sin credenciales ni upload. El recibo JSON del job contiene SHA, árbol, run ID, hashes de config y contenidos de ambos paquetes y assets. Comprueba identidad del árbol (si PR merge sintético, padres y árbol) y resultado de CI. El recibo no autoriza publicar, no demuestra que los bytes activos sean iguales y no incluye secretos. Conservar los logs; reconstruir el mismo SHA y comprobar digests o documentar no determinismo.

Publicación: comprobar rama aprobada y SHA, CI, configs, par de Workers, estado del supervisor, presupuesto y rollback. Registrar build ID, versión ID y deployment ID de cada Worker, ETag y hora; volver a leer 100% del tráfico, health y RPC. No publicar desde ramas históricas ni activar pruebas vivas F0-C10. Revertir código a versiones anteriores no revierte DO/Container ni datos. No hacer cambios de bindings, migraciones o secretos como parte de un release documental.

Las pruebas de staging-control-mcp con InMemoryTransport no llaman DO reales. La validación de selecciones de modelo no demuestra disponibilidad ni coste. Descargas externas son enlaces, rutas internas no lo son. Los límites de salida no prueban aislamiento físico ni concurrencia 10/10. Ver [incidente #90](https://github.com/aamvtrampa36-del/opencode-harness-example/issues/90) y registros de F0-C10.
