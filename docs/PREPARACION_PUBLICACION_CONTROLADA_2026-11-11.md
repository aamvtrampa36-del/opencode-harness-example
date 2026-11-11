# OpenCode Cloud V1 — preparación de publicación controlada

Fecha de comprobación: 11 de noviembre de 2026.

## Estado y alcance

**G9: aprobado y cerrado en staging** según [acta G9 §12](HITO_G9_EJECUCION_2026-11-11.md). Esta hoja prepara una decisión posterior: **NO autoriza ni ejecuta merge, despliegue productivo ni publicación de GitHub Release**. G9 es el último hito numerado del informe maestro de 21 páginas.

- Candidata Git: tag `g9-v1-rc-20261111` y rama `release/g9-v1-candidate-20261111` apuntan ambos a `ff5c88e7735469864d8264cc93fa56c6a7eaae62`. [CI #297](https://github.com/aamvtrampa36-del/opencode-harness-example/actions/runs/42974263252) aprobada para ese commit.
- PR principal [#28](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/28): draft, abierta, base `67b44a92177d176d177dc4607f580808102d36ff`, HEAD `90c59b185f5798cf74333cc8a2bac624418d0201`, 64 archivos, [CI #310](https://github.com/aamvtrampa36-del/opencode-harness-example/actions/runs/42981783107) aprobada. El diff entre el tag y ese HEAD afecta solo a tres documentos G9/plan, no código. Esto no demuestra equivalencia de los artefactos desplegados.
- Las PR #29 y #30 (OpenCode), #160 (CDF CLOUD) y #36 (WorkBench) son evidencias de prueba; no se proponen para merge como parte de esta entrega.
- Cloudflare reporta producción `opencode-harness-example` en versión `1d70eb77-316e-408d-bd14-5f19b171dedf` y staging en `68cdb953-b49a-4e52-8a69-9823e45c8323`. Cada uno tiene aplicación Access self_hosted con una política allow en la consulta; no se cambió ningún permiso.
- `wrangler.jsonc` de main y de la rama candidata inspeccionada son iguales. Define clases `OpenCodeAgent`, `DevContainer` y `PersonalSettings` y migraciones v1–v3. No se supone por ello que todos los cambios de datos sean reversibles.
- **Disparador productivo confirmado:** la consulta correcta por el identificador interno del Worker devolvió un trigger conectado al repositorio que vigila `main`, con build `npm run build` y despliegue `npm run deploy`. Este último ejecuta `vite build && wrangler deploy`; por tanto **fusionar en `main` puede iniciar automáticamente el despliegue de producción**. El build productivo previo por push a `main` finalizó con éxito. Staging observa exclusivamente `fix/repeatable-agent-verification-20261108` y usa su configuración `wrangler.g1.jsonc`. La consulta previa que utilizó los nombres de Workers en lugar de sus identificadores internos fue insuficiente y queda corregida.

## Alcance y límites de las evidencias

La matriz sustitutiva autorizada registró 12/12 recorridos con evidencia acumulada, no doce ejecuciones nuevas. El agente revisó CDF CLOUD y WorkBench en sesiones separadas; las PR de prueba las preparó el supervisor. La escritura autónoma real G9 corrigió un fixture aislado de OpenCode. No está demostrado desarrollo integral del agente en cada repositorio CDF ni funcionamiento para todos los modelos, MCP largos o interrupciones extremas.

En G4 la restauración real se verificó para un proyecto pequeño en staging: 4/4 hashes. El backup incorporado tiene límite de 2 MiB comprimidos y excluye `.git`, dependencias y secretos; la referencia de sesión no es un respaldo íntegro del historial. La versión anterior de producción y una etiqueta Git no restauran por sí solas datos de Durable Objects, archivos no confirmados, configuración privada ni procesos activos.

## Puertas antes de una publicación

Estado de esta preparación: **NO LISTO PARA EJECUTAR EN PRODUCCIÓN**; la preservación y recuperación real de los datos productivos no se han comprobado en esta intervención.

1. **Fijar el objeto exacto de entrega.** Volver a leer HEAD de PR #28, base y CI inmediatamente antes de cualquier decisión; revisar que el diff desde la candidata siga limitado a los documentos indicados y que no se incorporen los archivos de otras PR de prueba. Examinar el alcance y los cambios sensibles de la PR principal; esta hoja inventaría los archivos, no sustituye una revisión integral de seguridad o código.
2. **Aclarar disparadores.** Identificar la configuración real de Workers Builds, el comportamiento de merge en `main`, el destino de despliegue y cómo se conservan bindings, políticas Access y secretos existentes. No ejecutar merge si un automatismo productivo desconocido pudiera activarse.
3. **Respaldar antes de cambiar producción.** Inventariar trabajo y sesiones que deban preservarse; preparar copias independientes de proyectos y cambios no confirmados, datos de sesión/configuración cuando exista mecanismo fiable, y metadatos de la versión y configuración sin revelar secretos. Registrar hashes y ubicación protegida. Si un proyecto supera 2 MiB o depende de datos excluidos, utilizar un respaldo adecuado aparte. La disponibilidad y restaurabilidad de un respaldo de Durable Objects productivos permanece **sin verificar**.
4. **Comprobar recuperación sin sobrescribir datos.** Validar una restauración representativa en entorno aislado y la posibilidad de volver al Worker `1d70eb77-316e-408d-bd14-5f19b171dedf`. Verificar compatibilidad del estado persistente con la versión anterior; si no puede demostrarse, no prometer rollback de datos ni proceder a la publicación.
5. **Aprobación específica.** Presentar el alcance exacto, SHA, destino, copia y procedimiento verificados. Solicitar autorización explícita para merge a main y/o despliegue productivo; son acciones distintas de cerrar G9.
6. **Si se autoriza y se cumplen las puertas:** ejecutar el mecanismo de entrega verificado, comprobar acceso protegido, selección de proyecto, recuperación de sesión y una tarea inocua con resultado comprobable. Si una comprobación falla, detener actividad, preservar evidencia y evaluar reversión de código y recuperación de datos por separado.

## Decisión actual

La candidata es revisable y el cierre G9 permanece aprobado en staging. **La publicación no está preparada para ejecutarse aún**: falta verificar disparadores efectivos, revisión de alcance y respaldo/recuperación de los datos reales. Ninguna ejecución productiva se efectuó al escribir este documento.


## Actualización: verificación operativa y bloqueo real (11 noviembre 2026)

- Se consultaron los scripts y los triggers de Cloudflare mediante sus **tags internos**, además de la configuración del repositorio y los builds recientes. **Resultado:** el push a `main`, incluyendo un merge, está configurado para construir y desplegar el Worker productivo. El trigger de staging sigue la rama de desarrollo. No se alteró la configuración. Este hallazgo sustituye la consulta anterior con el nombre del Worker, que no permitía sacar conclusiones.
- La versión productiva `1d70eb77-316e-408d-bd14-5f19b171dedf` permanece consultable en Cloudflare como versión 29; eso demuestra que existe una referencia de código, **no** que se haya ejecutado o demostrado un rollback.
- El inventario de Cloudflare devolvió **dos objetos OpenCodeAgent y un DevContainer con `hasStoredData=true`**; un objeto PersonalSettings fue listado con `hasStoredData=false`. Es una señal de datos almacenados, no identifica su contenido ni demuestra si una copia existe o qué importancia tiene. No se leyeron valores privados ni claves.
- Las tres clases figuran en migraciones `new_sqlite_classes`. La [documentación de Cloudflare](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/) describe recuperación por puntos de tiempo para objetos SQLite mediante métodos de almacenamiento dentro del objeto, con ventana de 30 días. No se comprobó aquí un bookmark ni una restauración y no sustituye una copia independiente del Container, configuración y trabajo no confirmado. Restaurar un objeto afecta su estado; no ejecutarlo sin una operación expresamente autorizada.
- El código de producción ofrece descarga y respaldo pequeño de proyectos. **Guardar respaldo reemplaza la copia anterior de ese mismo proyecto después de completar la nueva escritura**; no se ejecutó este botón sin revisar el inventario y la copia previa. No se confirmó la existencia ni la restauración de respaldos productivos.
- Se abrió la aplicación productiva protegida: se requiere autenticación Cloudflare Access. La conexión Cloudflare disponible permite consultar recursos, pero no facilita leer directamente el contenido privado de cada Durable Object mediante los endpoints expuestos. No se sorteó Access ni se solicitaron claves.

**Estado de preparación: BLOQUEADO.** Se ha aclarado el automatismo; faltan inventario autenticado de proyectos y respaldos existentes, verificación de una copia recuperable y estrategia comprobada para el estado persistente. El primer paso de continuación es acceder a la aplicación productiva mediante la sesión autorizada para **consultar la lista de proyectos y respaldos sin pulsar Guardar**, evitando sustituir una copia existente. La protección completa de las sesiones y demás datos persistentes sigue pendiente incluso después de esa consulta. No fusionar #28 ni desplegar producción hasta completar las verificaciones y recibir la autorización específica.
