# OpenCode Cloud — G7: diagnóstico pasivo y autorreparación acotada (10 noviembre 2026)

**Dictamen de esta intervención:** G7 **IMPLEMENTADO Y VALIDADO AUTOMÁTICAMENTE EN STAGING; pendiente de prueba operativa mínima en staging protegido**. No confundir CI / test de un ejecutor real en CI con una llamada authenticated al Worker del propietario.

**Fuentes recuperadas íntegramente:** informe maestro `Informe_Integral_OpenCode_Cloud_V1.pdf` (21 páginas, 1.524 líneas), `docs/V1_EXECUTION_PLAN.md` y actas G1–G6. G6 permanece aprobado en staging con evidencia del usuario: perfil Decisiones y respuesta `G6-OK` de un modelo real.

## 1. Alcance, definición de éxito y tramo siguiente

G7 busca detectar un fallo real **independientemente de la descripción generada por la IA**, clasificarlo con códigos estables, agrupar repeticiones y evitar ciclos de parches equivalentes. El plan requiere evidencias acotadas (conteo, primera/última ocurrencia, causa sospechada, estado y acción), sin guardar prompts completos ni credenciales.

Su sucesor es **G8 — proyectos CDF CLOUD y WorkBench**: aislar repositorios, limitar escrituras al proyecto seleccionado y demostrar dos recorridos seguros en ramas y PR de borrador.

## 2. Implementación efectuada

Se reutilizan los Durable Objects y la API ya existentes, sin nuevas dependencias, cron, motor de agentes ni ejecutor Linux.

- `src/incident-diagnostics.ts`: clasificador de nueve tipos estables de incidente (**MODEL_UNAVAILABLE, TOOL_MISSING, SHELL_FAILED, TEST_FAILED, SESSION_STALLED, LATENCY_TIMEOUT, PERSISTENCE_FAILED, RETRY_EXHAUSTED, AGENT_FAILURE**), con evidencia limitada a códigos, fuente, proyecto válido, tipo de herramienta y números de estado/exitCode. *Nunca* persiste comando, prompt, stdout, stderr ni texto bruto de una excepción. Cada incidente tiene identificador estable, primer/último registro, recuento, causa sugerida, estado y acción. La huella distingue código de salida y HTTP status, evita agrupar fallos distintos del mismo proyecto. Solo conserva 64 grupos recientes para acotar almacenamiento.
- Repeticiones: los eventos con la misma huella aumentan su contador, no crean listas de parches. La función `retryDecision` concede elegibilidad de reintento **solo para errores transitorios** y máximo dos ocurrencias. Un fallo de test determinista, shell o persistencia nunca es elegible para reintento automático. **Importante:** esto es una política de diagnóstico y elegibilidad, no un interceptor universal de todos los reintentos internos del Harness. OpenCode Cloud no crea por sí mismo una cola de autoparches ni despliega reparaciones a producción.
- `src/personal-settings.ts`: registro atómico de incidentes mediante `ctx.storage.transaction` en el Durable Object de configuración, con almacenamiento `incident-ledger-v1`. No toca las claves previas de credenciales o especializaciones.
- `src/server.ts`: captura fallos por código de salida y excepciones de `linuxRunner.run` y `inspect`; captura independientemente los resultados de `POST /api/dev/run`; las autopruebas que fallan su verificación técnica también generan incidente. Añade `GET /api/dev/incidents` de solo lectura y sin cache, dentro del Worker protegido por Cloudflare Access. Si falla el registro de telemetría, no convierte el resultado correcto de la herramienta en error.
- `src/sockets.ts`: registra errores del despachador WebSocket y eventos `fault` del agente, incluso cuando el modelo no genera una explicación útil; jamás envía el prompt al registro.
- `src/agent-check-panel.tsx`: panel **Incidentes técnicos** en Configuración, con conteo, estado, causa, evidencia tipada y acción recomendada, más actualización manual. Incluye un botón de verificación operativa: ejecuta **una sola vez por pulsación** un comando Linux predefinido que finaliza con `exitCode=19` en el proyecto aislado `g7-diagnostics`, después consulta el registro persistente y solo muestra éxito si el incidente realmente existe. Sin tokens de IA, sin modificar proyectos previos; puede iniciar un Container facturable.

## 3. Pruebas y CI

- `src/incident-diagnostics.test.ts`: ejecuta **un proceso Node real que termina con exit code 19** en el entorno de GitHub Actions, registra el resultado en la agregación y verifica que tres repeticiones dan **un grupo con count=3**; también tests de fallos TAP, timeout, proveedor, persistencia, límites de reintento, separación por exitCode, protección de datos y cota de 64 entradas.
- `src/sockets-g7.test.ts`: un Harness simulado **lanza una excepción de proveedor antes de responder**; el despachador WebSocket crea el incidente `MODEL_UNAVAILABLE` sin depender de texto de IA. Tres despachos iguales producen un solo grupo con contador 3 y sin prompt almacenado. No se afirma que esta prueba haya llamado a un proveedor real.
- **CI #214 falló** en un test por no clasificar la frase «stuck session»; corregido en commit `a3afdfb`. Los runs posteriores **#217 y #221 finalizaron con éxito** (tests, compilación, TypeScript e invariantes).
- Workers Builds final: `ad905b86-de5d-4b32-858b-f4acf66ff196` con `success`, commit `d589db588d05fa58919a57b205dbd7023908457c`; versión publicada en staging: `00d3c46b-a097-4818-8130-b19070cd9807`.
- Worker productivo sigue en `1d70eb77-316e-408d-bd14-5f19b171dedf`; Cron de staging vacío; aplicación Cloudflare Access `self_hosted` con una política. PR #28 abierta como borrador, sin fusionar.

## 4. Criterios de aceptación: resultados y única comprobación pendiente

| Criterio | Estado y evidencia |
| --- | --- |
| Fallo real reconocido sin explicación del modelo | **PROBADO EN CI** con proceso Node que devuelve 19; integrado en servidor y registro Durable Object |
| Incidentes repetidos agrupados | **PROBADO** por tests de contador, huella técnica y persistencia lógica; panel disponible |
| Evidencia limitada y sin secretos | **PROBADO** por tests de sanitización (no prompts ni stdout) |
| Reintentos acotados y no cadenas equivalentes de parches | **PROBADO COMO POLÍTICA**; no hay cola de reintentos de shell/parches; el registro desaconseja reintentos deterministas. No se declara que la política controle todos los reintentos internos del motor |
| Persistencia real del incidente en staging del propietario | **PENDIENTE** hasta activar el smoke de un toque bajo Cloudflare Access |

**Única acción externa de aceptación:** desde Android, abrir `https://opencode-g1-staging.cdf-cloud-mvp-20261019.workers.dev` → engranaje **Configuración** → **Comprobar autonomía real / Incidentes técnicos** → pulsar **Comprobar registro con un fallo real**. Aceptar únicamente si aparece **«Verificado: Linux devolvió exitCode 19 y el fallo se registró sin utilizar IA.»** y un incidente `SHELL_FAILED` del proyecto `g7-diagnostics`. No hace falta elegir modelo ni escribir comandos. La acción puede activar temporalmente el Container y consumir cuota de infraestructura, pero **no usa tokens de IA**. No pedir contraseñas ni cookies.

El conector administrativo de Cloudflare no permite controlar el navegador autenticado de la persona propietaria; tampoco es aceptable retirar temporalmente Cloudflare Access para simular esa prueba. No inventar evidencia.

**Estado: G7 pendiente solo de esa comprobación operativa.** Si funciona, registrar confirmación, declarar G7 APROBADO EN STAGING y pasar a G8, empezando por aislamiento de CDF CLOUD y WorkBench. Si falla, usar el error concreto y corregir únicamente el defecto reproducible. Nunca fusionar ni desplegar producción sin autorización.
