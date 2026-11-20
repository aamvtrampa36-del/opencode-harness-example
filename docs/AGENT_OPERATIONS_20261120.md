# OpenCode Cloud — operaciones de agentes y consultas verificables

**Corte de investigación:** 2026-11-20. **Ámbito:** este repositorio y colaboraciones con `cdf-cloud-engine` y `CDF-WorkBench-`. Esta guía es operativa, no acredita paridad con producción. Para instrucciones obligatorias leer primero `AGENTS.md`.

## 1. Capacidad real antes de elegir método

Este proyecto usa OpenCode v2 **embebido en Workerd/Durable Object**, no la CLI nativa. El Container Linux y sus puentes son componentes separados. No suponer que todas las funciones de la documentación de OpenCode CLI (incluidos los worktrees nativos) existen en este harness.

Ruta comprobada el 2026-11-20: el supervisor Staging responde `ok`, enumera tres repositorios autorizados (este, CDF Engine y WorkBench), expone sesiones supervisadas y descubrimiento MCP. Su catálogo MCP Staging solo expone `workbench_status`, `workbench_catalog` y `workbench_read` del servidor `cdf-workbench-staging`. **No** asumir que todas las herramientas CDF son invocables desde ese supervisor.

En la extensión documentada `docs/OPEN_CODE_EXTENSIONS_20261115.md`, `start_subagent` crea hijos **solo lectura**, máximo 3 activos y 8 por conversación, sin hijos de segundo nivel. Una sesión hija no equivale a otro escritor independiente. Las sesiones supervisoras sí están aisladas por proyecto y rama; el supervisor no fusiona ni despliega.

## 2. Ruta de consulta a GitHub (consulta mínima suficiente)

**Descubrimiento dentro de OpenCode:** cuando aún no conozcas el número de PR, utiliza `repo_pr_search({query:"F-27"})` sobre el repositorio inmutable de la sesión y recorre `possibleNextPage` cuando la cobertura lo exija. Esta herramienta devuelve candidatos de un índice autenticado, no estados definitivos; comprueba cada candidato con `repo_pr_info` y sus SHA. Rechaza operadores booleanos y calificadores suministrados por el modelo para no ampliar el alcance. Si no está desplegada o autorizada, indica la ausencia y usa el conector GitHub disponible sin inventar resultados.

1. **Resolver identidad:** repositorio exacto, issue/PR numérico, `base`, `head`, SHA y última observación. Las búsquedas no sustituyen los identificadores.
2. **Descubrir:** para una incidencia sin número de PR, buscar por repositorio y asunto (`repo:OWNER/REPO is:pr F-27`, por ejemplo), luego comprobar cada candidato. Conservar referencias `repo#number`; no inferir relación solo por nombres.
3. **Leer metadatos primero:** `get_pr_info` o `gh pr view NUMBER --repo OWNER/REPO --json number,state,isDraft,baseRefName,headRefName,headRefOid,updatedAt,mergeable,statusCheckRollup` según la herramienta autorizada. El nombre de una acción no implica que el check se haya ejecutado.
4. **Escalar según la pregunta:** listado de archivos modificados → parche del archivo afectado → diff completo solo cuando sea imprescindible. Para conflictos, comparar archivos **y contenido**, base, HEAD y dependencias.
5. **Verificar CI exactamente contra el SHA de HEAD** y distinguir `success`, `failure`, `pending`, `not_run`, `unknown`. Un PR en draft con CI verde **no** es una aprobación de release.
6. **Para integrar:** comprobar base actualizada, cambios concurrentes, revisión, pruebas, autorización y ausencia de despliegue implícito. GitHub es autoridad del código; la infraestructura desplegada requiere comprobación independiente.
7. **Registrar evidencia:** URL de PR, SHA, workflow/run, fecha UTC y límite de la verificación. Si cambia HEAD, los resultados anteriores requieren revalidación.

Evitar consultar el diff de todos los PR al iniciar; no asumir que el resultado truncado de búsqueda es exhaustivo. Usar paginación real y filtros. En GitHub REST, preferir llamadas secuenciales para evitar límites secundarios; ETag/If-None-Match en consultas autenticadas repetidas, respetando `Retry-After`. No registrar tokens ni URLs firmadas.

## 3. Concurrencia sin pisar trabajo

**División:** generar unidades con `task_id`, propietario, alcance de archivos, base SHA, dependencias y prueba de aceptación. Paralelizar solamente trabajos realmente independientes. Si dos tareas escriben los mismos archivos o APIs, reducir simultaneidad, aislar ramas y exigir integración serial.

**Aislamiento:** una rama distinta por tarea; el nombre de la rama no es un lock. Un PR en curso es una propuesta, no un permiso para modificar la rama ajena. En el supervisor usar `requestId` de 16 caracteres hexadecimales como llave idempotente y no reutilizarlo para otro objetivo.

**Dependencias:** no iniciar una tarea sucesora a partir de una implementación aún no integrada como si estuviera en `main`. Si una PR depende de otra, fijar su base real y registrar vínculo `depends_on`. Revisar si su base es una release/staging distinta.

**Límites:** hijos de OpenCode de solo lectura pueden investigar y revisar sin escribir; escritores aislados necesitan supervisión de PR y reconciliación. Ningún agente debe aprobar su propia promoción. No ejecutar en paralelo escrituras sobre la misma ruta mediante GitHub Contents API.

## 4. Handoff persistente mínimo

Un resumen narrativo sin procedencia no acredita progreso. Para transferir una tarea, escribir un JSON acotado `agent.handoff.v1` en el seguimiento autorizado. Validar, si existe Node, con `node scripts/validate-agent-handoff.mjs archivo.json`; el validador solo comprueba contrato **estructural**, no autenticidad, secreto, permisos ni corrección del código.

Ejemplo **sintético** (SHA y nombres inventados deliberadamente; jamás interpretar como ejecución real):

```json
{
  "schema": "agent.handoff.v1",
  "task_id": "synthetic-pr-audit",
  "repository": "aamvtrampa36-del/opencode-harness-example",
  "branch": "docs/synthetic-example",
  "head_sha": "0000000000000000000000000000000000000000",
  "owner": "agent-reviewer",
  "objective": "Verificar un PR de ejemplo sin fusionar",
  "status": "BLOCKED",
  "write_scope": ["docs/example.md"],
  "depends_on": [],
  "evidence": [],
  "checks": [{"name": "integration", "status": "not_run"}],
  "next_action": "Obtener evidencia de ejecución real",
  "updated_at": "2026-11-20T00:00:00Z"
}
```

**Preflight de dos o más agentes:** `node scripts/validate-agent-handoff.mjs --conflicts task1.json task2.json` detecta, por repositorio, ramas compartidas, IDs de tarea duplicados y solapamientos **declarados** de archivos o directorios. Para declarar un directorio usa barra final (por ejemplo `src/`). El resultado `NO_DECLARED_CONFLICTS` **no** es autorización de escritura ni garantía de ausencia de conflictos: comparar además los diffs de Git, la base SHA, dependencias y permisos actuales.

Estados admitidos: `ACTIVE`, `BLOCKED`, `READY_FOR_REVIEW`, `COMPLETE_VERIFIED`. El último exige evidencia y checks observados; aún así, el revisor debe verificar las fuentes. Nunca registrar contenido narrativo, credenciales ni resultados sensibles en el handoff.

## 5. Elección de herramienta y contexto

- Empezar por contratos mínimos: `AGENTS.md` y la guía de la operación. Abrir Skills o referencias solo al necesitarlas.
- Descubrir servidor MCP y herramientas autorizadas antes de llamar. Usar el esquema completo y actual **de la herramienta elegida**; no reutilizar un schema antiguo porque nombre coincida.
- Agrupar consultas compatibles de lectura cuando exista un endpoint batch y el ámbito sea idéntico. Las escrituras conservan operación/idempotencia, ACL, revisión y readback.
- Si un resultado viene resumido o truncado, marcar cobertura `PARTIAL`; no inferir ausencia.
- Conservar IDs, revisiones, hashes y límites del snapshot al compactar contexto; resúmenes no sustituyen fuentes.
- Los controles de CDF Cloud sobre canon editorial y fuentes tienen prioridad en su propio dominio.

## 6. Innovaciones verificadas externamente, **no adoptadas automáticamente**

La matriz de descubrimientos, compatibilidad, decisión y pruebas exigidas está en [AGENT_TECH_RADAR_20261120.md](AGENT_TECH_RADAR_20261120.md). No requiere leerla para tareas ordinarias.

- OpenCode documenta Skills con descubrimiento bajo demanda y nuevas funciones de subagentes/worktrees. Estas corresponden al producto original: comprobar la compatibilidad con la versión embebida y el conjunto de herramientas del harness antes de migrar. https://opencode.ai/docs/skills/ , https://opencode.ai/docs/tools/
- MCP especificación **2026-07-28** añadió descubrimiento `server/discover`, catálogo cacheable y encabezados de ruta `Mcp-Method`/`Mcp-Name`. Compatibilidad de cliente/servidor, negociación y auth necesitan pruebas separadas antes de alterar Gateway. https://modelcontextprotocol.io/specification/2026-07-28/ ; https://blog.modelcontextprotocol.io/posts/2026-07-28/
- GitHub recomienda consultas condicionadas, filtradas y seriales bajo límites secundarios. https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api
- Cloudflare añadió reintentos automáticos de ciertas llamadas a DO el **2026-11-05**; no añadir bucles ciegos sobre RPC con efectos. Validar versión, entrega previa, idempotencia y manejo de errores reales. https://developers.cloudflare.com/changelog/post/2026-11-05-durable-objects-automatic-retries/

## 7. Gates de aceptación y límites

Pruebas mínimas: búsqueda de PR sin número → recuperación de metadata → checks del SHA exacto → diff selectivo → handoff validado → reanudación por otro agente → detección de conflicto de archivos/ramas. Para CDF, además validación de fuente/ACL/snapshot sin escritura canónica.

Una prueba local de estructura, CI en verde, una respuesta de modelo o un estado de salud por separado no constituyen `COMPLETE PASS`. Diferenciar `LOCAL_PASS`, `CI_PASS`, `LIVE_PASS`, `RELEASE_ACCEPTED` y `NOT_VERIFIED`, con alcance, fecha, versión y recibo.

**Fuentes de este repositorio:** `AGENTS.md`, `README.md`, `docs/OPEN_CODE_EXTENSIONS_20261115.md`, `docs/SUPERVISOR_REMOTE_CONTROL_STAGING_20261111.md`. Para comportamiento nuevo, verificar en el runtime antes de convertir documentación en contrato.
