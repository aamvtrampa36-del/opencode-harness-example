# Informe técnico: captura acotada de salida Linux y seguimientos

**Corte:** 2026-11-22 UTC  
**Repositorio:** `aamvtrampa36-del/opencode-harness-example`  
**Ámbito:** reparación desplegada en OpenCode Cloud Staging. No incluye cambios ni despliegues a Producción.

## Resumen

Se sustituyó en `DevContainer.run()` la lectura acumulativa `process.output()` por el drenaje concurrente de stdout y stderr con retención acotada. El cambio está desplegado en Staging y pasó CI, el build de Cloudflare y una autoprueba Linux aislada.

Esta evidencia demuestra que la implementación se construye y que Staging ejecutó una prueba Linux de humo. No demuestra cuánto disminuyó el uso máximo de memoria durante un comando real ni que esta ruta causara el OOM histórico de la issue [#90](https://github.com/aamvtrampa36-del/opencode-harness-example/issues/90).

## 1. Incidencia y evidencia previa

En el commit base de Staging `1702ae62e7c740af975511e47acd5a7a93d52ccd`, `src/dev-container.ts` decodificaba los buffers devueltos por `process.output()` y luego aplicaba `slice(MAX_SHELL_OUTPUT)`. Como el buffer completo ya existía antes del recorte, una salida extensa podía ocupar memoria proporcional al tamaño total de stdout y stderr dentro del Durable Object.

La evidencia del defecto es el orden de esas operaciones en el código anterior. No se reprodujo un OOM con el código anterior, ni se midió memoria de Worker antes y después. Por ello, la incidencia de captura no acotada se separa de la explicación causal del OOM histórico.

## 2. Implementación abierta reutilizada

- El helper y las pruebas de `captureBoundedOutput` ya existían en la rama de la PR #105; se portaron a la rama de Staging para evitar una solución competidora.
- La PR documenta como referencia de diseño `@deepseek-ai/dsh-bash-local`, proyecto MIT: [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/shell/bash-local/README.md).
- También se siguió la guía de Cloudflare para drenar stdout y stderr simultáneamente: [Cloudflare Containers: execute commands](https://developers.cloudflare.com/containers/guides/execute-commands/).
- No se copió código literal de DeepSeek. Se adaptó la solución existente del propio repositorio a la API de Cloudflare Containers. No se añadió una dependencia.

## 3. Corrección aplicada

Commit desplegado en Staging: [`11161dd6f2c4b5237a2da59d7275ff693e0afdbe`](https://github.com/aamvtrampa36-del/opencode-harness-example/commit/11161dd6f2c4b5237a2da59d7275ff693e0afdbe).

Archivos:

- `src/bounded-process-output.ts`: drena el stream a medida que produce datos, conserva como máximo `MAX_SHELL_OUTPUT` bytes de contenido (mitad inicial y mitad final) y añade un marcador con el número de bytes omitidos.
- `src/bounded-process-output.test.ts`: cubre salida corta y Unicode, límites, truncamiento, flujo vacío, límite inválido, entrada sintética de 16 MiB y drenaje concurrente de ambos canales.
- `src/dev-container.ts`: `DevContainer.run()` consume `process.stdout` y `process.stderr` con `Promise.all`, espera el `process.exitCode` real y elimina la llamada a `process.output()` en esa ruta.

La salida extensa ahora conserva principio y final en vez de solo el prefijo anterior. El marcador de truncamiento se añade además de los bytes de contenido retenidos.

## 4. Verificaciones ejecutadas

| Verificación | Resultado | Alcance |
| --- | --- | --- |
| GitHub Actions [run #44983062854](https://github.com/aamvtrampa36-del/opencode-harness-example/actions/runs/44983062854) sobre el commit desplegado | PASS | Pruebas unitarias, preview real, typecheck, build de Worker/web e invariantes |
| Cloudflare Workers Build `64171f42-7837-4ae4-8b97-0f5133937832` | PASS | `build_outcome=success` para el commit `11161dd6`; el build incluye `bun test`, typecheck, preview, invariantes, build y `bunx wrangler deploy` |
| Autoprueba Linux aislada de OpenCode Cloud | PASS | Proyecto `agent-check-38d73ccd65b5`, sesión `ses_dfe929357ffexAmxlU18uMxOW5`, `toolCalls=1`, `fileVerified=true` |
| Prueba de flujo sintético grande | PASS en CI | El colector drena 16 MiB y conserva una carga limitada en memoria; no equivale a medir el Worker ni a ejecutar 16 MiB en el Container real |

No se ejecutó una prueba RED que midiera el pico de memoria del código anterior. Tampoco se probó en vivo un comando Linux de varios MiB con códigos cero y no cero y salida capturada de ambos canales. La autoprueba Linux es un smoke test, no esa prueba de carga.

## 5. Integración y estado de Staging

- Rama: `staging/opencode-g1-rpc-safe-20261120`.
- Commit de despliegue: `11161dd6f2c4b5237a2da59d7275ff693e0afdbe`.
- Versión Cloudflare activa: **#371**, `7e25ba19-4893-4e4f-a089-380ef8e01377`, con 100% del tráfico de Staging.
- Estado del Worker consultado después del despliegue: `ok`.
- La PR [#105](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/105) permanece abierta y en borrador contra `main`. No se fusionó a `main` ni a Producción.

**Clasificación de esta corrección:** `RESOLVED` en el destino autorizado de Staging. La promoción a `main` queda pendiente de revisión y autorización separadas.

## 6. Seguimientos conocidos

### Issue #90: reinicio/OOM histórico

Permanece abierta. La causa raíz no está demostrada; no hay reproducción controlada ni medición de memoria que atribuya el incidente a la captura de salida. El cambio reduce una posible vía de acumulación, pero no cierra esa investigación.

Próximo paso con evidencia útil: si reaparece, correlacionar hora, versión desplegada, fase/herramienta activa y logs del Worker; después probar cada mecanismo sospechoso en Staging de forma aislada. No provocar un OOM en un entorno compartido como prueba.

### Integración GitHub MCP y alcance de herramientas MCP

Queda como seguimiento, según la decisión del usuario. El Worker Staging reportó `githubConfigured=true` y `githubWrite=true`; la lista de servidores MCP remotos consultada incluía `cdf-workbench` y `cloudflare`, sin un servidor `github`. No se instaló el conector GitHub ni se cambió el enrutamiento.

La pregunta pendiente es cómo delimitar servidores/herramientas MCP por chat o proyecto y cómo evitar solapamientos con el GitHubBridge nativo. Este documento no afirma que el conector oficial vaya a duplicar herramientas: la integración no fue instalada ni probada.

### Respuesta parcial de diagnósticos

Una consulta posterior al despliegue a `staging_diagnostics({limit:10})` devolvió 16 registros junto con `_responseTruncated:true`; los registros incluían proyecto/herramienta, pero no un campo `taskId` independiente. El resultado se considera parcial y no basta por sí solo para clasificarlo como defecto del Worker: queda por verificar si el límite/resumen pertenece al endpoint, al adaptador MCP o al truncamiento de respuesta.

## 7. Resultado verificable

La ruta Linux desplegada drena stdout y stderr durante la ejecución y limita los bytes de contenido retenidos por canal. Las pruebas del helper, el CI, el build/deploy de Cloudflare y el smoke test Linux pasaron. Siguen sin demostrarse la reducción real del pico de memoria, la causa del OOM histórico y la prueba de carga Linux en vivo.
