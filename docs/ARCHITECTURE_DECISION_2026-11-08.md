# OpenCode Cloud — arquitectura y criterios de sustitución (2026-11-08)

## Decisión vigente para la V1 — G3 (2026-11-09)

**Seleccionada: arquitectura A = OpenCode Workerd/Harness + Durable Objects + Worker protegido por Cloudflare Access + herramienta `linux` en Container aislado bajo demanda + GitHub y proveedores de inferencia conectados.**

**Motivo:** el entorno actual demostró un ciclo auténtico modelo→herramienta→reparación→prueba en G1 (dos reparaciones independientes verificadas) y un cambio al propio repositorio en G2 ([PR #29](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/29), dos commits del agente, seis llamadas `github` y seis `linux`, GitHub Actions #147 exitoso). Por tanto A es **suficientemente funcional para continuar la V1**, no una prueba de superioridad frente a otros motores.

**Restricción:** el titular del proyecto comunica que **OpenCode CLI/servidor web nativo no puede instalarse en el entorno disponible**. No se repitió la instalación ni se ejecutó el antiguo piloto comparativo A/B; sus métricas no existen. La imposibilidad se registra como restricción operativa, **no como un diagnóstico de incompatibilidad técnica demostrado por G3**. B queda como alternativa futura no evaluada, y **no bloquea G4 ni la entrega V1**.

### Fronteras operativas de A

- **Worker + Cloudflare Access:** autenticación, interfaz y entradas protegidas; no abrir terminal ni rutas públicas sin autorización.
- **Workerd/Harness + Durable Objects:** motor de agente y coordinación/sesiones vigentes. No presumir compatibilidad o transferencia de sesiones hacia CLI nativo.
- **Container Linux existente:** lectura, edición, procesos, tests y Git a través de la herramienta aislada `linux`; encendido bajo demanda. No confundir su disco efímero con persistencia verificada.
- **GitHub:** commits en ramas de revisión `opencode/*` y PR borrador; `main` y producción no se editan automáticamente.
- **Inferencia:** conectar y utilizar proveedores permitidos; presupuesto externo OpenRouter **US$2/día** informado por el titular. **Sin cuotas internas diarias artificiales de pruebas en staging**; respetar gastos externos, permisos y detención de bucles sin progreso.

### Evidencia, límites y condición de reconsideración

| Área | Estado |
|---|---|
| Reparación autónoma con pruebas y comprobación externa | **Demostrada en G1** |
| Autodesarrollo, commit y PR propios del agente | **Demostrado en G2** |
| CI de contribución + staging protegido + producción no modificada | **Demostrado** |
| Persistencia fiable de archivos/sesiones, reinicio y restauración por hash | **No demostrado: G4** |
| Flujo móvil y UX de desarrollo, plantillas, diagnóstico estable | **G5–G7** |
| Trabajo con CDF CLOUD y WorkBench, entrega E2E y rollback | **G8–G9** |
| Comparación frente a motor OpenCode nativo | **No evaluable bajo la restricción actual** |

**Reconsiderar B solo si** deja de existir la restricción de instalación **y** se identifica una razón material y verificable (compatibilidad, riesgo, costo o mantenimiento). Se exigiría prueba aislada, equivalencia funcional, recuperación y reversión antes de cualquier corte de tráfico. No crear un segundo motor o servicio como requisito para G4.

**G3 cerrado por selección de A bajo alcance revisado. Siguiente prioridad: G4 — respaldar el proyecto fuera del Container, detener/restaurar el entorno y comprobar hashes, estado útil y tests.** La decisión completa queda en `docs/HITO_G3_EJECUCION_2026-11-09.md`. No fusionar ni desplegar a producción por esta decisión.

---

**Las secciones siguientes conservan la propuesta del 8 de noviembre como registro histórico. Donde hablan del “objetivo preferido B”, del CLI nativo o de migración, no prevalecen sobre la decisión vigente anterior.**


## Evidencia recuperada

- `main` en `67b44a92177d176d177dc4607f580808102d36ff` (PR #27).
- El producto ejecuta `@opencode/sdk/workerd` 2.0.24 con `agents/harness/opencode` experimental dentro de Durable Objects. **Sí hay motor OpenCode real**, pero no se utiliza el CLI nativo en el Container.
- Linux real existe en `DevContainer` mediante la herramienta propia `linux`. El Docker/Container es independiente del motor OpenCode; las herramientas nativas del CLI no están activas.
- El primer experimento del servidor nativo OpenCode CLI 1.19.5 en GitHub Actions arrancó `opencode serve` y publicó su especificación HTTP; no es prueba del agente ni migración de sesiones.
- Hay pruebas previas de shell/Node/Git, previews y snapshots aislados, y CI de TypeScript/unidades/build; faltan evidencias del bucle completo modelo → herramienta → ejecución → corrección.
- Las PR #20–#26 fortalecieron permisos, perfiles, MCP, inspector, autoprueba y respaldos, pero ninguno de esos cambios demuestra el bucle completo.
- Las configuraciones de proveedores están parcialmente codificadas como presets; una clave de OpenRouter no demuestra que el ID de un modelo exista o permita llamadas a herramientas.

## Decisión reversible

**Objetivo preferido: B, OpenCode CLI/servidor web nativo dentro de un Container Linux.**
La preferencia depende de demostrar en una instancia aislada que sustituye herramientas/plugins propios sin perder funciones importantes. **Hasta entonces, el Harness actual (A) sigue siendo la instalación activa.**

Ventaja potencial de B: usar las herramientas nativas de archivos, shell, Git, agentes, MCP y proveedores en lugar de mantener un puente por capacidad. Riesgos: coste por Container en ejecución, arranque, almacenamiento efímero, expiración de snapshots, incompatibilidad de sesiones Workerd/CLI y dificultad para asegurar el tráfico HTTP y las credenciales.

No crear todavía un nuevo servicio activo, un Worker público, credenciales duplicadas ni un despliegue productivo.

## Fronteras deseadas

- **Cloudflare Worker + Access**: identidad, autorización, encaminamiento protegido y arranque/parada bajo demanda.
- **Un Container Linux**: ejecuta `opencode serve`/web y herramientas nativas del proyecto.
- **OpenCode nativo**: proveedor/modelos, ciclo de agente, archivos, comandos, Git, skills, agentes y MCP.
- **Persistencia**: una fuente principal de estado persistente con respaldo independiente verificable; DO para metadata/coordinación, no segunda copia parcial de archivos presentada como recuperación universal.
- **GitHub**: trabajos en ramas de desarrollo; revisiones/merges/despliegues sujetos a autorización; no compartir claves con prompts.

## Prueba de aceptación antes de migrar

1. Arrancar el servidor nativo en Container **aislado** y comprobar autenticación, origen y acceso desde Android/PC.
2. Con un modelo real económico que soporte herramientas: pedir una app mínima, registrar eventos reales de lectura/escritura/ejecución, introducir un test fallido y observar cómo el agente corrige y pasa los tests.
3. Guardar evidencia: modelo y versión, IDs de sesión, herramientas solicitadas y ejecutadas, códigos de salida, registro de prueba antes/después, archivos resultantes y costo/tiempo aproximado.
4. Reiniciar o detener el entorno; restaurar los mismos archivos y la sesión; comprobar hashes y estado sin hacer cambios en corpus de producción.
5. Validar OpenRouter, permisos, GitHub y un MCP remoto con capacidades y credenciales de prueba. Clasificar lo no verificado como pendiente.
6. Medir la cantidad de archivos/puentes eliminables y el consumo real del Container; volver a A si falla la prueba o su coste es claramente peor.

## Migración y reversión

Antes del cambio, enumerar proyectos y sesiones actuales, descargar fuentes fuera de Cloudflare, verificar los hashes de las copias, obtener respaldos independientes donde el límite de tamaño lo permita y documentar qué historial de Workerd **no** puede importarse de forma fiable. Las snapshots beta no son respaldo permanente: su retención es de 30 días desde su creación o última restauración.

Levantar B **en paralelo** y sin reutilizar ni borrar recursos o datos productivos de A. Comparar rutas críticas, preservar A accesible y solo después de pruebas más autorización explícita realizar un corte. Tener procedimiento para volver el tráfico a A; el rollback del Worker no revierte por sí mismo el estado de Container/DO.

## Congelación de complejidad

Ninguna nueva funcionalidad avanzada antes del éxito del bucle de agente. Corregir primero fallos reproducibles y documentar el resultado. La autoprueba de agente debe permitir reintentos tras resultado terminal sin cuota interna diaria artificial en staging; no duplicar una ejecución aún pendiente ni eludir límites económicos externos. No dejar Cron ni workflows temporales persistentes.

Fuentes técnicas:
- https://opencode.ai/docs/cli/web/
- https://opencode.ai/docs/tools
- https://opencode.ai/docs/providers
- https://developers.cloudflare.com/containers/api/durable-object-container/
- https://developers.cloudflare.com/containers/guides/snapshots/
- https://developers.cloudflare.com/containers/platform/pricing/

## Diagnóstico puntual del error de modelos (telemetría)

Cloudflare Workers Observability, consulta de solo lectura del 7 al 9 de noviembre de 2026: **un evento** `SessionRunnerModel.ModelUnavailableError`, disparado durante un `alarm` de `OpenCodeAgent` el 8 de noviembre, 18:21 UTC. El mensaje exacto identifica `cloudflare/@cf/meta/llama-3.3-70b-instruct-fp8-fast` durante `SessionRunnerModel.resolve` → `SessionContext.load` → `SessionRunner.advanceToStep`. Sucedió antes de la llamada a herramienta.

Este ID **no** figura en los presets actualmente permitidos en `src/model-presets.ts` (el predeterminado es GPT-OSS 20B). Sin embargo, `@cf/meta/llama-3.3-70b-instruct-fp8-fast` figura en el catálogo público oficial de Workers AI, por lo que **no** está demostrado que Cloudflare haya retirado el modelo. La causa local comprobada es una selección de sesión que el registro activo de modelos de OpenCode no consigue resolver; faltan datos para distinguir la desconexión del proveedor, el descubrimiento del modelo o la persistencia de una selección antigua.

Próxima prueba de raíz: inspeccionar en un entorno autorizado el catálogo habilitado de OpenCode en el momento de reanudación; comparar el modelo persistido de la sesión con dicho catálogo y con Workers AI; corregir solamente la capa que discrepe. No sustituir modelos de sesiones automáticamente ni borrar su historial sin conservar los datos. Un endpoint directo de Workers AI que responda no prueba su registro dentro de Workerd.

Referencias: https://developers.cloudflare.com/workers-ai/models/llama-3.3-70b-instruct-fp8-fast/ y https://opencode.ai/docs/models .
