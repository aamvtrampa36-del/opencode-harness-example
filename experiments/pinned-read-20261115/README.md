# OpenCode Cloud · Experimento 4 — Reutilización segura de lecturas GitHub fijadas

**15/11/2026 · Solo experimento · PR #59 (borrador) · NO FUSIONAR / NO DESPLEGAR.**

## 1. Estado anterior

Los experimentos 1–3 permanecen separados: PR #55 (espera del Harness, solo simulación), PR #56 (reducción parcial de tráfico WebSocket) y PR #57 (lectura incremental del historial, almacenamiento simulado). Ninguno fue modificado en el Experimento 4. El objetivo cambió a operaciones redundantes de herramientas, no a lectura del historial o envío de eventos.

## 2. Diagnóstico basado en código

El `GitHubBridge.execute({action:"read"})` de `src/github.ts` solicita siempre `GET /repos/{owner}/{repo}/contents/{path}?ref={ref}`; no había reutilización por revisión. `src/server.ts` crea un puente nuevo para cada operación, por lo que una optimización dentro de una única instancia no podría reutilizar lecturas de pasos distintos. El adaptador `executeBoundRepositoryAction` impone primero el repositorio vinculado a la sesión y el permiso de la operación.

No se recuperaron trazas de sesiones reales que permitan medir cuántas veces los modelos repiten lecturas idénticas. La frecuencia de este patrón en producción es **UNKNOWN**, no un hecho demostrado. Se eligió como hipótesis comprobable por su costo de I/O externo y repetición potencial en tareas de código.

## 3. Cambio experimental

- `src/experimental-pinned-read-cache.ts`: reutilización de resultados únicamente si `ref` es SHA de commit exacto de **40 dígitos hexadecimales**. Caché pequeña y efímera (máximo 32 objetos, 1 MB, TTL 15 s); deduplicación de solicitudes concurrentes; se invalida al cambiar la credencial; no guarda fallos. La clave conserva el texto exacto de la revisión para no modificar la respuesta pública.
- `src/github.ts`: el mecanismo opcional funciona después de `repoChecked` y `pathChecked`; sin caché activa, conserva el comportamiento previo. Ramas, `HEAD`, tags, `main`, refs ausentes y operaciones de escritura **nunca** se reutilizan.
- `src/server.ts`: mantiene una instancia por Durable Object, pero **solo activa la variante con la variable explícita `OPENCODE_EXP4_PINNED_READ_CACHE=enabled-for-isolated-tests`**. Por defecto la caché está desactivada; los entornos operativos no fueron modificados.
- `src/pinned-read-experiment.test.ts`: ejecuta `GitHubBridge.execute` y `executeBoundRepositoryAction` reales con un servidor HTTP determinista simulado. También prueba autorización, aislamiento entre tokens, rechazo de errores, ortografía exacta del SHA, rotación de credencial durante la petición y ocho lecturas concurrentes.

**No se eliminaron datos del contexto del modelo:** las respuestas a herramientas conservan el contenido íntegro. Por tanto, esta variante NO acredita reducción de tokens.

## 4. Protocolo y evidencia

`protocol.json` se fijó antes del primer benchmark. El primer intento, CI `43764670138`, falló porque el comparador consideraba diferentes objetos con las mismas propiedades en distinto orden JSON. Se corrigió **el comparador**, no el comportamiento de GitHub, y se volvió a ejecutar toda la línea base; el fallo no se oculta.

- **Línea base aprobada:** run `43764760157`, job `132967259769`, commit `2251fca270c40b8135fc85afff3b4a019d3eda8c`. 12 comienzos, 12 finales, 12 PASS. Registrados en `baseline-runs.jsonl` antes de introducir la variante.
- **Comparación final A/B:** run `43765245699`, job `132968757180`, commit `0cee05b6de3100be6179fb3506ac2c119441e8ef`. 24 comienzos y 24 finales, todos PASS, 3 pares por escenario en orden AB/BA. Registrados en `paired-runs.jsonl`, agregados en `summary.json`.
- Los registros fueron recuperados del stdout de CI **después de cada ejecución** y persistidos en la rama; el log original de GitHub Actions es la evidencia primaria. Las filas se releen posteriormente desde GitHub para verificar ausencia de IDs perdidos o duplicados.

| Escenario sintético | GET original | GET candidato | Reducción |
| --- | ---: | ---: | ---: |
| Mismo archivo de commit 10 veces | 10 | 1 | **90 %** |
| Tres archivos de commit, 12 consultas | 12 | 3 | **75 %** |
| Rama `main` mutable, 8 lecturas | 8 | 8 | 0 % |
| Tarea mixta con 9 lecturas | 9 | 4 | **55,6 %** |

El cuerpo HTTP recibido disminuyó en la misma proporción aproximada (90 %, 75 %, 0 % y 55,8 %). Los resultados completos de `repo/path/sha/ref/content` fueron exactamente iguales para las tareas fijadas. Todas las comprobaciones de integridad y autorización local realizadas pasaron.

La latencia de benchmark con **2 ms artificiales por GET** fue aproximadamente 22,88 → 2,58 ms para diez lecturas fijadas; no representa el tiempo de GitHub ni del modelo. No se midieron tokens ni costos de inferencia, rendimiento real de Durable Objects, cache hit del proveedor, ni tiempo del agente completo.

## 5. Riesgos y limitaciones de integración

1. **Revisión:** el dato de un commit SHA es inmutable. Una rama mutable no se cachea para evitar información obsoleta.
2. **Autorización:** se mantienen las comprobaciones locales y el aislamiento de credenciales. **Pero una revocación de permisos aplicada directamente por GitHub podría no detectarse hasta vencer el TTL de 15 segundos** cuando sigue siendo válida la misma credencial local. El requisito de permisos actuales en todo momento requeriría una estrategia adicional o renunciar a ese caché. Esto bloquea cualquier aprobación de integración con el comportamiento actual.
3. **Persistencia:** el estado es temporal y se pierde al evictar/hibernar el Durable Object, lo que evita una segunda fuente persistente pero limita el efecto.
4. **Beneficio de uso:** no existen métricas reales que indiquen que repetir lecturas de un mismo commit sea frecuente. No se justifica automáticamente habilitar esta variante.
5. **Tokens:** se evita red, no texto devuelto al modelo. Costo de inferencia sin cambios por diseño salvo efectos indirectos **no medidos**.
6. **Comparación:** el beneficio observado es una prueba de integración de la ruta GitHub con HTTP falso, no un experimento real de OpenRouter o Cloudflare remoto.

## 6. Veredicto

**VALIDADO PARCIALMENTE** para ahorrar llamadas de red cuando el mismo commit se consulta repetidamente bajo una misma identidad. **INCONCLUSIVE** para el costo total por tarea en producción; **NO CHANGE** para los entornos operativos. Con la duda de revocación de acceso, **NO APROBAR la variante para Producción** sin resolver ese riesgo.

La siguiente hipótesis potencial, **sin iniciarla aquí**, es el tamaño y reutilización de declaraciones de herramientas/contexto enviadas al proveedor: puede afectar tokens en cada turno, pero requiere telemetría real de modelos y pruebas de calidad antes de justificar un cambio.

## 7. Reproducibilidad

En la rama `experiment/pinned-read-reuse-20261115`:

```sh
bun install --frozen-lockfile
bun test src/pinned-read-experiment.test.ts src/github.test.ts src/scoped-github.test.ts
bun run typecheck
bun run build
```

El experimento quedó aislado. No se fusionó, desplegó ni modificó el entorno operativo ni las PR #54–#57.
