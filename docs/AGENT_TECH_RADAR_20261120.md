# Radar técnico de agentes y MCP — evaluación al 20-11-2026

**Propósito:** decisiones de adopción basadas en compatibilidad y evidencia, no una lista de modas. Complementa [AGENT_OPERATIONS_20261120.md](AGENT_OPERATIONS_20261120.md). Cada estado se limita a lo investigado este día: las versiones, permisos y runtimes pueden cambiar. No es un permiso de despliegue.

| Técnica o novedad | Fuente primaria | Estado para OpenCode + CDF | Decisión y prueba necesaria |
| --- | --- | --- | --- |
| GitHub PR por metadatos, archivos y patches focalizados; CI ligado a HEAD; REST ETag | [GitHub REST prácticas](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api) | Procedimiento documentado | **ADOPTAR en instrucciones**. Medir solicitudes y completitud antes/después con mismo conjunto de PR. REST ETag solo si el cliente realmente expone headers y auth; no adjudicarlo a la herramienta MCP existente. |
| Git worktrees y scripted runs de OpenCode | [OpenCode v2.2.6](https://opencode.ai/changelog/v2.2.6), [Tools](https://opencode.ai/docs/tools/) | OpenCode aquí embebido en Workerd con SDK v2.0.24; no CLI nativa | **PILOTO condicionado**. Comprobar soporte en harness/Container. Las ramas aisladas del supervisor siguen siendo ruta vigente hasta prueba de migración segura. |
| Conexiones MCP compartidas entre proyectos y lista de jobs por sesión | [OpenCode v2.2.6](https://opencode.ai/changelog/v2.2.6) | Publicado en OpenCode; paridad del harness no demostrada | **EVALUAR** en sesión aislada: permisos OAuth por proyecto, revocación, separación de catálogos, latencia en arranque y conteo de conexiones. No compartir auth con ámbitos diferentes. |
| Skills bajo demanda y subagentes especializados | [OpenCode Skills](https://opencode.ai/docs/skills/), [Agents](https://opencode.ai/docs/agents/) | Ya hay 11 Skills CDF y subagentes read-only; distinto entre clientes | **REUTILIZAR**. Evitar otro kernel; validar que sesión subordinada recibe solo contexto y herramientas autorizadas. |
| MCP 2026-07-28: discovery opcional, listas cacheables, routing headers, MRTR | [Especificación MCP](https://blog.modelcontextprotocol.io/posts/2026-07-28/) | Nuevas capacidades del protocolo, negociación existente no auditada | **PILOTO de compatibilidad**, no migración automática. Capturar versión negociada, comportamiento OAuth y fallbacks, llamadas `tools/list`, caducidad y autorización; comparar tamaños/latencias. |
| Cloudflare Code Mode y optimización de conversión de schemas | [Cloudflare Agents SDK 2026-07-22](https://developers.cloudflare.com/changelog/post/2026-07-22-mcp-codemode-updates/) | OpenCode ya dispone del backend `dynamic-mcp` propio | **COMPARAR, NO DUPLICAR**. Un laboratorio aislado determina si `search/describe/execute` ahorra llamadas sin ampliar permisos ni modificar la fuente de servidores. |
| Retries automáticos a Durable Objects (05-11-2026) | [Cloudflare changelog](https://developers.cloudflare.com/changelog/post/2026-11-05-durable-objects-automatic-retries/) | Cambio de plataforma pertinente a F-27; interacción con reintentos propios desconocida | **AUDITAR antes de modificar**. Separar fallos pre-entrega, entrega ambigua y errores propios; verificar no doble efecto, ID de operación y límites de intento. |
| Durabilidad mejorada durante runtime updates (19-11-2026) | [Cloudflare changelog](https://developers.cloudflare.com/changelog/post/2026-11-19-durable-objects-runtime-update-reliability/) | Cambio ya activo globalmente; no demuestra resolución de F-27 | **OBSERVAR con trazas**. Correlacionar errores y reinicios con request ID/fecha; no atribuir mejora a código propio ni cerrar incidencia sin evidencia. |
| DO SQLite PITR nativo y restauración | [Cloudflare SQLite DO](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/) | Laboratorios F-27 con PR aisladas en CDF Engine | **CONSERVAR LÍNEA EXISTENTE**. Solo PASS si restauración nativa real, readback, reanudación y aislamiento demostrados; no sustituir con rollback manual. |
| Eventos MCP para alertas Cloudflare | [Cloudflare changelog](https://developers.cloudflare.com/changelog/product-group/developer-platform/) | Requiere habilitación, permisos y receptor de webhook; no verificado en este proyecto | **POSPONER**. No añadir escucha permanente antes de medir necesidad y coste frente a observabilidad bajo demanda. |
| Búsqueda semántica gestionada sobre el corpus | [Cloudflare AI Search](https://developers.cloudflare.com/ai-search/) | CDF ya tiene índices léxicos/estructurados, hashes y procedencia | **NO ADOPTAR POR INERCIA**. Piloto solo si existen consultas reales fallidas y se garantizan ACL, privacidad, revisiones e indicadores de cobertura. |

## Regla de promoción de técnicas nuevas

1. Anotar versión observada y fuente oficial; un changelog no implica disponibilidad en este deployment.
2. Proponer **una** hipótesis con métricas: exactitud de selección, llamadas, latencia, tokens cuando sean medibles, permisos y casos de error.
3. Probar con el mismo conjunto sintético y el mismo SHA, fijando entorno y modelo. Registrar resultados sin extrapolar.
4. Rechazar cambios que aumenten privilegios, deuda de mantenimiento o riesgo de duplicar escrituras sin beneficios significativos.
5. Integrar mediante PR y revisión independiente. No declarar `LIVE_PASS` ni `RELEASE_ACCEPTED` por un benchmark local.

### Caso prioritario

El mejor candidato inmediato **ya implementado parcialmente** es la recuperación enfocada de PR y el handoff con procedencia. Validar ese camino entre dos agentes antes de desplegar gestores de memoria compartida, embeddings o coordinación distribuida.

Las cifras de ahorro siguen **NOT_MEASURED**. La actualización documental y el validador de JSON no son una prueba de reducción de coste ni de coordinación efectiva entre escritores concurrentes.
