# OpenCode Cloud Remote — evaluación experimental como laboratorio de SYSTEM Prompts

**Fecha de la ejecución:** 2026-11-21 por la noche (America/Sao_Paulo); eventos persistidos 2026-11-22 01:40–01:43 UTC.  
**Carácter:** exploratorio, no destructivo; documentación de ejecución real, no especificación de producto.  
**Veredicto para SYSTEM Prompts reales:** **EVIDENCIA INSUFICIENTE**.  
**Veredicto limitado para evaluación de prompts de usuario:** **APTO CON LIMITACIONES**, en una misma sesión.

## 1. Objetivo y alcance

Determinar si la instalación OpenCode Cloud Remote se puede usar como laboratorio aislado, repetible y medible para introducir **mensajes auténticos con rol system**, comparar políticas, y preservar independencia de las sesiones sin afectar proyectos. No confundir escribir «SYSTEM:» en un mensaje de usuario con enviar un mensaje con rol real de sistema.

Se inspeccionó la interfaz conectada del supervisor y se hicieron pruebas reales de salida textual y continuidad. No se ejecutó ningún benchmark auténtico de SYSTEM Prompts porque la interfaz de ejecución descubierta **no expone** un parámetro de roles arbitrarios ni un campo independiente para system. La inexistencia del parámetro en esta interfaz **no demuestra** que el runtime subyacente o el proveedor sean incapaces de usar mensajes system.

### Entorno observado

- Worker: **opencode-g1-staging**; salud **ok**, runtime **workerd**; supervisor **opencode.staging-control.v2**, ready=true.
- Selección usada: **economy** → proveedor **cloudflare**, ID de modelo **@cf/deepseek-ai/deepseek-v4.1-flash-1017**, tal como figuraba en el catálogo consultado. No se verificó un identificador de versión de pesos más específico.
- Catálogo de modelos seleccionables accesible; OpenRouter figuraba **configurado**. El catálogo reportó **catalogueTruncated=true**, por tanto no fue una enumeración exhaustiva.
- Proyecto de prueba: **supervised-b36a000000000001**; tarea **b36a000000000001**; sesión **ses_dff16ebf3ffeT3Lf3ZVASZTJz8**.
- Repositorio de ejemplo autorizado: **aamvtrampa36-del/opencode-harness-example**.
- Rama supervisada preparada automáticamente: **opencode/staging-b36a000000000001**, desde el commit base **1702ae62e7c740af975511e47acd5a7a93d52ccd**.
- La tarea de prueba terminó con **toolCalls=0, completedTools=0, failedTools=0**. No se observaron commits, llamadas a shell, fusiones ni despliegues efectuados por el agente.
- El supervisor reportó también **reviewRequired=true**, **passed=false**, **verified=false** aun cuando sus eventos y estados de ejecución indicaban **succeeded/finished**. Esos campos son de validación del supervisor y NO equivalen a incumplimiento de las sondas textuales.
- Las funciones disponibles permitían iniciar tarea, continuar sesión, consultar estado/progreso/historial, inspeccionar sesión y seleccionar modelo. Los contratos examinados no daban acceso a temperature, seed, top_p, mensajes estructurados por rol ni payload saliente íntegro.

### Importante sobre aislamiento

La creación de una tarea supervisada preparó una rama GitHub del repositorio de ejemplo, aun sin invocar herramientas por parte del modelo. Por tanto el mecanismo **no está demostrado como totalmente independiente de repositorios**. No se abrió una segunda tarea para la prueba de aislamiento entre sesiones por ese efecto lateral. Tampoco se testó aislamiento de sistema de archivos, CPU/red, secretos o herramientas.

## 2. Casos y resultados

| Caso | Estado | Evidencia y límite |
|---|---|---|
| A. SYSTEM básico auténtico | **BLOCKED** | El control remoto no expone campo system ni traza del rol enviado al proveedor; no se inyectó uno. |
| B. Jerarquía system/developer/user/tool | **BLOCKED** | No se puede armar una prueba controlada con roles efectivos distintos mediante estos contratos. |
| C. Aislamiento entre sesiones | **BLOCKED** | Solo una sesión experimental; no se puede inferir ausencia de filtraciones entre sesiones. |
| D. Reproducibilidad simple | **PASS PARCIAL** | 3/3 respuestas textuales idénticas en la misma sesión; no prueba reproducibilidad entre sesiones nuevas. |
| E. Comparación de formatos | **PASS PARCIAL** | A=JSON 3/3; B=CSV 3/3, alternados, todos como instrucciones de usuario y con contexto acumulado. |
| F. Persistencia/continuidad | **PASS PARCIAL** | La clave ficticia fue recordada después; eventos «Continuing after restart». No se verificó un reinicio limpio controlado. |

**Condición de control sin system personalizado:** se usaron solicitudes textuales sin inyección explícita de system por parte del experimentador. No se ha demostrado que no exista un system preconfigurado por OpenCode o por el proveedor.

## 3. Ejecuciones auditables

Los mensajes siguientes son instrucciones de **usuario**, no SYSTEM Prompts auténticos.

### Sonda de control inicial

- Solicitud (resumen fiel): responder exclusivamente **CONTROL|azul|7**, sin herramientas, red, archivos ni escrituras; el propio mensaje aclara que no contiene system real.
- Respuesta observada: **CONTROL|azul|7**.
- Resultado en historial: succeeded, 2026-11-22T01:40:15.099Z.

### Sonda F — continuidad de contexto

1. **F1** (turnId **b36b000000000001**): se pidió memorizar la clave artificial **PINAR-47** y contestar **REGISTRADO**. Respuesta: **REGISTRADO**; succeeded 2026-11-22T01:40:52.546Z. El historial muestra «Continuing after restart».
2. **F2** (turnId **b36b000000000002**): se preguntó cuál era la clave de F1 sin repetirla. Respuesta: **PINAR-47**; succeeded 2026-11-22T01:41:07.621Z.

Esto **sí** demuestra continuidad conversacional de la misma sesión; **no** prueba aislamiento, retención indefinida ni persistencia tras crear una sesión totalmente nueva.

### Sonda D — formato repetido tres veces

Instrucción textual idéntica: convertir «nube» a mayúsculas, contestar exclusivamente **D|NUBE|OK**, sin herramientas ni escrituras.

| Repetición | turnId | Respuesta | Fin (UTC) | Duración observada desde entrada a fin |
|---|---|---|---|---|
| D1 | b36c000000000001 | D|NUBE|OK | 01:41:28.515 | 1.140 s |
| D2 | b36c000000000002 | D|NUBE|OK | 01:41:35.614 | 2.762 s |
| D3 | b36c000000000003 | D|NUBE|OK | 01:41:40.643 | 1.760 s |

**3/3 cumplimiento exacto**. Repeticiones dentro de **una sola sesión**, de modo que el historial se acumuló entre ejecuciones.

### Sonda E — alternancia de formatos 3+3

Entrada constante: clasificar «gato» como animal. Variante A: **JSON compacto**; variante B: **CSV en una línea**. Prompts completos en esencia: «SONDA E-A / E-B. Instrucción textual de USUARIO (no es SYSTEM real), sin herramientas ni escrituras. Clasifica gato y responde [con JSON compacto / como CSV] EXACTAMENTE...».

Resultados literales esperados y observados:

~~~json
{"clase":"animal","texto":"gato"}
~~~

~~~text
animal,gato
~~~

| Orden | Variante | turnId | Respuesta | Fin (UTC) | Duración entrada→fin |
|---|---|---|---|---|---|
| E1 | A JSON | b36d000000000001 | JSON exacto | 01:42:17.515 | 8.685 s |
| E2 | B CSV | b36d000000000002 | animal,gato | 01:42:22.878 | 2.383 s |
| E3 | A JSON | b36d000000000003 | JSON exacto | 01:42:29.459 | 2.563 s |
| E4 | B CSV | b36d000000000004 | animal,gato | 01:42:35.359 | 2.075 s |
| E5 | A JSON | b36d000000000005 | JSON exacto | 01:42:48.842 | 9.166 s |
| E6 | B CSV | b36d000000000006 | animal,gato | 01:42:55.457 | 2.879 s |

**A: 3/3; B: 3/3; total: 6/6.** La transcripción incluye eventos «Continuing after restart» en algunas respuestas. Las duraciones resultan de marcas de entrada/fin del historial del supervisor, **no** son métricas puras de latencia del proveedor y pueden incorporar reanudación y orquestación.

### Consolidado

- **12 respuestas**: control (1) + continuidad (2) + D (3) + E (6).
- **12/12** respuestas cumplieron su objetivo **textual local**; esto **NO es tasa de cumplimiento de SYSTEM Prompts**.
- **0** llamadas a herramientas del agente, según estado final de tarea.
- Tokens de entrada/salida, coste imputado y parámetros de muestreo: **no recuperados** de las respuestas de las herramientas de control examinadas. Había eventos **session.usage.recorded**, pero la consulta de progreso no devolvía cantidades.
- No se calculó confianza estadística; muestra exploratoria con problemas triviales y contexto compartido.

## 4. Límites e hipótesis

**Verificado:** ejecución y recuperación del texto, selección de modelo por catálogo, sesiones durables declaradas por el entorno, conservación de conversación demostrada por F, controles de tarea supervisada, rama creada al iniciar tarea.

**No verificado:** rol de system realmente enviado, reemplazo/complementación del system original, tratamiento diferencial de developer y tool, temperatura/top_p/seed, independencia de contexto entre sesiones, aislamiento de ejecución entre workspaces, fidelidad del enrutamiento hacia proveedor final, tokens/coste reales, huella de versión de modelo, latencia de inferencia pura.

**Interpretación causal prudente:** la **interfaz remota** del supervisor es un bloqueo observado para inyectar mensajes de rol arbitrario. No se ha demostrado un defecto de DeepSeek, Cloudflare ni OpenRouter. Tampoco se ha demostrado imposibilidad técnica del OpenCode interno.

## 5. Propuesta mínima para que funcione como benchmark

Mantener OpenCode Remote como ejecutor opcional, pero introducir una vía separada, de solo inferencia y sin repositorios, que:

1. Acepte una estructura de mensajes tipada por rol (system/developer/user/tool cuando el proveedor lo soporte), explicitando si se conserva o transforma la semántica de cada rol; permita adjuntar o sustituir un system configurable.
2. Capture **el payload efectivamente enviado** al proveedor, con redacción segura de secretos; identifique cuándo una instrucción es del supervisor y cuándo del experimentador.
3. Desactive herramientas, escritura, GitHub y filesystem en el modo textual; cree entornos/sesiones limpias y un control sin system personalizado.
4. Registre modelo/versionado visible, parámetros efectivos (incluidos temperatura y seed si se admiten), respuestas, eventos de error, tokens, coste y duraciones con definición.
5. Ejecute varias repeticiones independientes, con orden alternado y casos de referencia. Califique formato y cumplimiento por separado. No mida la jerarquía de roles si no hay roles reales.
6. Guarde un manifiesto y resultados simples en JSONL/SQLite para comparar variantes y reproducirlos; sin infraestructura empresarial.

No se implementó esta propuesta. Se trata de una mejora sugerida, sujeta a revisión del código y la compatibilidad con el proveedor.

## 6. Conclusión

**EVIDENCIA INSUFICIENTE** para afirmar que OpenCode Cloud Remote es hoy un laboratorio **aislado y reproducible de SYSTEM Prompts auténticos**. Sí está demostrado que ejecuta prompts textuales de usuario, devuelve resultados coherentes en casos simples y conserva historial de una sesión. La vía más económica es resolver el **rol efectivo y trazabilidad de la inferencia** antes de ampliar la batería.

## 7. Procedencia y cómo consultar la evidencia

Herramientas de la ejecución (lectura/control): **staging_status**, **staging_models**, **staging_repositories**, **staging_sessions**, **staging_diagnostics**, **staging_start_task**, **staging_task_status**, **staging_task_progress**, **staging_task_continue**, **staging_task_transcript**, **staging_session_inspect**.

Identificadores recuperables:
- Supervisor/task: **b36a000000000001**
- Sesión: **ses_dff16ebf3ffeT3Lf3ZVASZTJz8**
- Operación inicial: **rc-start-b36a000000000001**
- Operaciones de continuación: **rc-turn-b36a000000000001-<turnId>**, con los turnIds en las tablas.
- Rama de prueba: **opencode/staging-b36a000000000001**.
- SHA base de la tarea: **1702ae62e7c740af975511e47acd5a7a93d52ccd**.

El endpoint de transcripción consultado exporta **los últimos 20 mensajes**, por lo que una consulta tardía puede omitir las primeras sondas; se guardaron sus datos relevantes en este informe, pero **no se archivó un volcado bruto integral** de la sesión. La salida de transcripción es sanitizada y no incluye razonamiento interno.

**Nota de integridad:** esta documentación se registra en una rama de GitHub por petición posterior. Ese commit de documentación es **distinto** de la tarea experimental: no constituye una escritura realizada por el agente de OpenCode durante las pruebas. No se solicita ni realiza fusión a main, PR, despliegue o cambios de código.
