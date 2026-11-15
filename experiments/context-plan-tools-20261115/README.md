# OpenCode Cloud — Experimento 5: curaduría de herramientas en el contexto del modelo

**15 de noviembre de 2026 · PR #60 · Rama `experiment/context-plan-tool-catalog-20261115` · NO FUSIONAR / NO DESPLEGAR.**

## 1. Archivos de experimentos anteriores protegidos

Los experimentos 1–4 quedan cerrados para investigación posterior y **no fueron modificados**:
- PR #55: espera del Harness; solo simulación.
- PR #56: transporte incremental WebSocket; validación parcial.
- PR #57: lectura incremental del historial; validación parcial.
- PR #59: lecturas repetidas de GitHub por commit; validación parcial (90 %, 75 %, 55,6 % de reducción de GET según caso, con HTTP simulado). Persiste el riesgo de retraso de 15 s en revocación externa de acceso con la misma credencial. Conservados `experiment/pinned-read-reuse-20261115` y `experiments/pinned-read-20261115/` intactos.

No se fusionó, desplegó o editó ninguna de esas PR ni sus ramas.

## 2. Inspección y elección

**Fuente:** `src/workspace.ts` de `main` desde `e2736d1221247b5186879cda3beb9230b4b977f5`. `workspacePlugin` ya usa `ctx.session.hook("context")` para quitar herramientas globales a sesiones con proyecto y quitar GitHub a proyectos sin repositorio. Sin embargo, cuando la sesión usa el agente `plan`, se exponen **`linux`**, cuya ejecución está expresamente bloqueada por `assertAgentToolPermission`, y **`github`** genérica. Las acciones GitHub permitidas en Planificación (`repo`, `read`, `review`) ya están cubiertas por `repo_info`, `repo_read` y `repo_review`, que resuelven el repositorio del ámbito de sesión autorizado. `inspect_linux` sigue siendo la opción permitida de inspección Linux.

Se examinaron las definiciones y contratos de `@opencode/plugin@2.0.24`, `@cloudflare/computer@0.10.0` y `agents@0.33.0`. Como orientación de la API, la fuente pública de OpenCode inspeccionada en `anomalyco/opencode`, commit `aa2960fa266e898cf4d0bf0cd1c86beed23e3591`, describe que `SessionContext` incluye `agent` y `tools`. No se demostró que ese commit público corresponda al código exacto del paquete instalado; las compilaciones y pruebas del repositorio verifican compatibilidad con las dependencias fijadas.

Se eligió la hipótesis H1 por ser una modificación localizada del **catálogo real de herramientas expuesto al modelo** sin alterar el texto histórico o las políticas. No hay trazas de uso real suficientes para afirmar que esta duplicación determine la mayor parte de los tokens.

Otros candidatos (compactación de mensajes, reorganización de prefijos, truncamiento de resultados) se posponen por requerir telemetría de modelos o implicar riesgos de integridad del contexto.

## 3. Cambio interno

El módulo real `src/workspace.ts` acepta ahora el parámetro opcional `contextCatalogMode: "existing" | "plan-safe" = "existing"`.

En el hook `context`:
- Solo con el modo experimental `plan-safe` y `agent === "plan"` se oculta `linux` si existe `inspect_linux`.
- Con repositorio vinculado y las tres herramientas `repo_info`, `repo_read`, `repo_review` presentes, se oculta `github` genérica.
- Si falta alguna alternativa, la herramienta genérica permanece accesible. No se eliminan las implementaciones de los ejecutores: el cambio es **únicamente al conjunto de definiciones anunciado al modelo**.
- `build`, sesiones sin proyecto y el modo por defecto son idénticos al original. Ninguna llamada operativa habilita `plan-safe`.

La lógica de `assertAgentToolPermission`, el ámbito de sesión, los accesos a GitHub y Linux, credenciales, configuraciones de modelos y mensajes de usuario se mantienen sin cambios.

## 4. Evidencia y medición

El protocolo de `protocol.json` se guardó **antes** de medir. La primera CI `43766639840` falló por un error del adaptador de prueba (el simulador `agent.transform` no invocaba el callback con su editor), no por una comparación de comportamiento. El fallo no se suprime.

**Línea base antes de modificar la función:** run `43766699537`, job `132973346648`, commit `556d8ed4b3584730a21236fde03c02a278d56980`. 12 ejecuciones, 12 PASS.

**Comparación con el mecanismo modificado:** run `43767069266`, job `132974483389`, commit `a7d527d1b078861de959a18472ca19fb0f4357d0`. 24 ejecuciones en 3 pares A/B por escenario, todos PASS. Los registros íntegros de inicio y final, transcritos desde el log original de GitHub Actions después de cada CI, se guardaron en `baseline-runs.jsonl` y `paired-runs.jsonl`.

La prueba usa `workspacePlugin` y su `ctx.session.hook("context")` auténticos, y captura las descripciones y los esquemas de entrada que registra `ctx.tool.transform`. Simula el contexto de invocación y el Workspace, sin conexión a un modelo ni operaciones externas.

| Contexto | Herramientas antes/después | Bytes de sus definiciones antes/después | Cambio |
|---|---:|---:|---:|
| Planificación + repositorio | 6 → 4 | 4.017 → 2.113 | **−47,4 %** |
| Planificación sin repositorio | 2 → 1 | 1.461 → 773 | **−47,1 %** |
| Desarrollo + repositorio | 6 → 6 | 4.017 → 4.017 | 0 % |
| Desarrollo sin proyecto | 7 → 7 | 4.915 → 4.915 | 0 % |

**Unidad y alcance de esta métrica:** bytes UTF-8 de `JSON.stringify` de **solo las definiciones de herramientas del plugin** (`description` e `input`) tras el hook. No incluye el prompt del sistema, mensajes, definiciones externas, formato final del proveedor ni contabilización de tokens. **No representa un 47 % menos de tokens ni de costo real.**

Las duraciones inferiores a milisegundos del callback son muy variables y no justifican una afirmación de mejora de latencia.

## 5. Seguridad y capacidades conservadas

`src/context-plan-capabilities.test.ts` ejecuta las implementaciones auténticas de herramientas del plugin con ejecutores deterministas y comprueba:
1. `repo_read`, `repo_info`, `repo_review` siguen funcionando bajo repositorio vinculado, y `inspect_linux` bajo proyecto vinculado.
2. Las herramientas `linux` y `github` siguen rechazando ejecución de comandos/escrituras cuando el agente es `plan`, aunque se invoquen directamente fuera del catálogo anunciado.
3. Si falta alguna herramienta dedicada, `github` permanece visible para no eliminar funciones permitidas.

Estas pruebas son de **capacidad de herramientas**, no de la habilidad de un modelo real para elegir correctamente las herramientas. Las decisiones del modelo, la calidad semántica de respuestas y la tasa de tareas resueltas siguen siendo UNKNOWN.

## 6. Auditoría de registros

Se volvieron a leer `protocol.json`, `baseline-runs.jsonl`, `paired-runs.jsonl` y `summary.json` desde GitHub tras conservarlos. El recuento verificado fue:

- Baseline: 12 BEGIN + 12 END, 12 IDs únicos, 0 FAIL.
- Comparación: 24 BEGIN + 24 END, 24 IDs únicos, 0 FAIL.
- Los porcentajes de los cuatro escenarios se recalcularon a partir de las filas individuales y coinciden con el resumen.
- La salida original de GitHub Actions es la fuente primaria; la copia en el repositorio es una transcripción posterior, no un registro escrito en tiempo real.

## 7. Riesgos, límites y recomendación

**VALIDADO PARCIALMENTE**: se reducen las definiciones del plugin anunciadas en `plan` sin que las operaciones de consulta autorizadas desaparezcan en las pruebas.

**INCONCLUSIVE**: impacto en tokens, aciertos de caché, costo por tarea correcta, precisión y latencia real. No se utilizaron OpenRouter, Workers AI ni modelos reales, y no se produjeron gastos de inferencia. No se ha medido si el proveedor de un modelo compensa el tamaño de los esquemas mediante caché.

El principal riesgo de funcionalidad es que ocultar la herramienta genérica cambie las decisiones de un agente real, incluso si quedan alternativas equivalentes. Se necesita un pequeño conjunto de tareas con modelo real, presupuesto autorizado, telemetría de tokens/cache/costo y comprobación de corrección. No activar sin esa validación.

**Decisión:** conservar PR #60 en borrador, sin fusión ni despliegue. La aplicación mantiene `contextCatalogMode="existing"` por defecto, por lo que los entornos operativos conservan su comportamiento.

**Siguiente oportunidad no iniciada:** comparar el costo real de prefijos y definiciones de herramientas entre llamadas consecutivas; investigar si el catálogo del proveedor y los cambios de instrucciones reducen los aciertos de caché. Esto requiere observabilidad de requests/token usage del modelo y un presupuesto explícito antes de hacer inferencias.

## 8. Reproducción local

```sh
bun install --frozen-lockfile
bun test src/context-catalog-experiment.test.ts src/context-plan-capabilities.test.ts
bun run typecheck
bun run build
```
