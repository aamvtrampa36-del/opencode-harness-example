# OpenCode Cloud — G8: aislamiento de CDF CLOUD y WorkBench (10 noviembre 2026)

**Estado de esta intervención:** G8 **IMPLEMENTADO, PRUEBAS DE SEGURIDAD y DOS PR DE PRUEBA VERIFICADAS; PENDIENTE DE PRUEBA OPERATIVA AUTENTICADA EN OPENCODE CLOUD**. G9 es el siguiente hito según el informe maestro, pero no se inicia formalmente hasta completar el gate de G8.

## 1. Informe maestro y línea base

Se leyó íntegramente `Informe_Integral_OpenCode_Cloud_V1.pdf` de 21 páginas, el plan `docs/V1_EXECUTION_PLAN.md` y el acta definitiva de G7. G1–G7 están cerrados en staging, G7 sustentado por captura del titular con incidente real `SHELL_FAILED` (`exitCode 19`).

El gate literal G8 es: «ambas pruebas muestran repositorio correcto, diff correcto, regresiones ausentes y recuperación». Sus dos recorridos son **CDF CLOUD** y **WorkBench**, en ramas nuevas, mediante lectura, cambio no canónico, prueba y PR borrador, sin escrituras a canon, fuentes narrativas ni producción. El siguiente gate G9 corresponde a entrega, pruebas finales y publicación controlada.

## 2. Riesgo anterior y cambio de arquitectura mínimo

Antes de G8 existía una lista de repositorios autorizados para el puente GitHub, pero la selección del proyecto en la interfaz se comunicaba al modelo **solo como texto del prompt**. Una sesión de agente podía pedir un `repo` o `project` distinto en sus argumentos de herramientas, dentro de la lista global autorizada. Esto NO satisfacía aislamiento.

Se corrigió sin añadir otro motor:

- `src/project-scope.ts`: ámbito inmutable por sesión, con identificador de conversación verificado y asociación `{project,repository}`. La asociación del repositorio debe pertenecer a la lista explícitamente autorizada en Configuración. Cambiar de proyecto o repo requiere **otra conversación**; un LLM no puede revincular una sesión.
- `src/server.ts` y `src/sockets.ts`: se fija el ámbito en Durable Object **antes de iniciar una tarea** y se hereda al delegar una revisión. Los tests automáticos internos vinculados al sistema reciben un proyecto aislado. El binding se conserva durante reconexiones o reinicios de Durable Object.
- `src/workspace.ts`: **en el instante de ejecutar la herramienta**, valida el `sessionID` real proporcionado por OpenCode. Rechaza `github` dirigido a otro repositorio, `linux/inspect_linux` dirigido a otro proyecto y escrituras/ejecución global en el Workspace sin límite por proyecto. Sin ámbito, falla cerrado. Plan y Review conservan su restricción de escritura.
- `src/protocol.ts`, `src/use-opencode-session.ts` y `src/client.tsx`: el cliente envía proyecto+repositorio como campos estructurados, no solo instrucciones en lenguaje natural. El panel **Proyectos** muestra repositorios autorizados; elegir uno crea una **conversación nueva**, asignando un proyecto Linux propio.
- `src/github.ts`: además de permitir solo ramas `opencode/*` y PR borradores, rechaza escrituras en rutas claramente canónicas, narrativas, despliegues, workflows y archivos de secretos. La acción nueva `review` obtiene un resumen limitado y **solo lectura** de archivos cambiados contra `main` desde la API oficial GitHub. No puede hacer merge, borrar ramas, cambiar `main` ni desplegar.
- `src/tool-permissions.ts`: permite usar `review` de GitHub también en modo Plan/Revisión sin conceder permisos de escritura.

No se introdujo ninguna dependencia, cola de autoparches, despliegue a producción ni modificación del sistema editorial CDF.

## 3. Dos pruebas reales independientes en GitHub

Se verificó que ambos repositorios privados existen y tienen rama por defecto `main`. Se leyó el README de cada uno y se crearon ramas nuevas específicas de G8. **Las siguientes operaciones se ejecutaron desde el conector GitHub del supervisor, NO desde el navegador OpenCode Cloud**:

| Proyecto | Rama de prueba | Commit | PR borrador | Diff comprobado |
| --- | --- | --- | --- | --- |
| CDF CLOUD, `aamvtrampa36-del/cdf-cloud-engine` | `opencode/g8-cdf-isolation-20261110` | `f1e4027b9d35b4e885ce0fbe86ee43c2df20bf35` | [#160](https://github.com/aamvtrampa36-del/cdf-cloud-engine/pull/160) | Solo `docs/opencode-g8/isolated-review-20261110.md`, 16 líneas añadidas |
| WorkBench, `aamvtrampa36-del/CDF-WorkBench-` | `opencode/g8-workbench-isolation-20261110` | `85502acb534cb28ce7e8cd1774d4fcdbff280e13` | [#36](https://github.com/aamvtrampa36-del/CDF-WorkBench-/pull/36) | Solo `docs/opencode-g8/isolated-review-20261110.md`, 16 líneas añadidas |

Cada archivo contiene un marcador distinto (`G8-CDF-ISOLATION-PROOF` y `G8-WORKBENCH-ISOLATION-PROOF`). Se recuperaron ambos archivos desde sus ramas y se comprobó que cada uno contiene **solo su propio marcador**, el repo correcto y la rama correcta. Se consultó el patch de las dos PR y se confirmó un único archivo `added` en cada una. La misma ruta de prueba **no existe en `main`** de ningún repositorio. Ninguna PR se fusionó; recuperar consiste en cerrar cada borrador o abandonar la rama sin modificar `main`.

**Regresiones y CI de repositorios:** el PR de WorkBench tiene GitHub Actions **#161** `completed/success`. Para CDF CLOUD no se recuperó ningún run asociado con el commit de la rama de prueba; su README indica expresamente que cambios en `docs/**` no activan despliegues. Al ser una adición documental sin archivos operativos cambiados, no hay cambios de runtime que probar en esas dos PR. **No se declara que se hayan ejecutado las compilaciones completas de CDF CLOUD o WorkBench desde OpenCode Cloud.**

## 4. Tests del aislamiento y verificación sin IA

- `src/project-scope.test.ts`: repos válidos, ámbitos inmutables, rechazo de cruces de repositorios/proyectos, bloqueo de herramientas sin ámbito y de escrituras globales.
- `src/sockets-g8.test.ts`: prueba de despacho con Harness simulado; liga la sesión antes de enviar, rechaza cambiar de CDF CLOUD a WorkBench en la misma conversación y permite continuar en el repositorio original.
- `src/github.test.ts`: niega `main`, `../`, escritura a rutas oficiales y de despliegue; prueba nueva acción `review` solo lectura y diff limitado.
- `src/g8-smoke.ts` y `src/g8-smoke.test.ts`: un verificador que utiliza el mismo `GitHubBridge` de OpenCode Cloud. Lee metadatos, archivos reales y diffs de **ambas ramas de prueba**, rechaza cruces y cualquier marcador/diff inesperado. No ejecuta acciones GitHub de escritura ni consulta un modelo. Tests con puente simulado verifican ese contrato y el rechazo de marcadores incorrectos.
- `src/server.ts`: endpoint `POST /api/dev/g8-verify` protegido por Cloudflare Access y petición JSON de mismo origen; utiliza la conexión GitHub de **OpenCode Cloud** y la lista de repositorios autorizados, no credenciales que circulen por ChatGPT. `src/client.tsx`: botón **Comprobar aislamiento CDF CLOUD y WorkBench** en el panel Proyectos; una pulsación realiza las lecturas reales y muestra éxito solo si ambos repositorios están correctos. Puede fallar con indicación de conectar GitHub en Configuración. No usa tokens de IA, ramas nuevas ni escrituras.
- GitHub Actions del repositorio OpenCode Cloud: **#226 y #229 `completed/success`** tras introducir y probar el aislamiento; el último cambio del UI también superó Cloudflare Workers Builds para `11b705a923305e96d25c4bf17bdc4de365ac3a49`.
- Staging publicado: `db45748a-19a3-4ef4-8be7-5def172cbab1`. Producción `opencode-harness-example` sigue en `1d70eb77-316e-408d-bd14-5f19b171dedf`. Cron vacío. Staging conserva Cloudflare Access.

## 5. Criterios de cierre y bloqueo externo mínimo

| Requisito G8 | Evidencia | Dictamen |
| --- | --- | --- |
| Identificar correctamente ambos repositorios | Metadata privada y readback de ramas por GitHub conectado | **APROBADO (conector GitHub del supervisor)** |
| Rama nueva, archivo no canónico, PR borrador y diff correcto | PR #160 y #36; un único archivo agregado en cada una; `main` intacto | **APROBADO (conector GitHub del supervisor)** |
| No escribir fuera del proyecto seleccionado | Validación servidor por `sessionID` y tests de rechazo, compilación de staging | **APROBADO TÉCNICAMENTE; sin prueba de denegación real en un agente del propietario** |
| Regresiones y recuperación | CI de aislamiento OpenCode y WorkBench; CDF no lanzó CI documental. PRs reversibles y no fusionadas | **Evidencia suficiente para cambios de documentación; no hay compilación CDF de esta rama** |
| Integración real con la conexión GitHub **dentro de OpenCode Cloud** | Endpoint seguro y botón de verificación implementados, **aún no invocados con la sesión autenticada** | **PENDIENTE** |
| Ciclo agente de OpenCode que usa herramienta GitHub con sesión ligada | Hay pruebas de binding y bridge, pero todavía no una traza real de agente sobre las dos ramas | **PENDIENTE** |

**Dictamen vigente: G8 IMPLEMENTADO Y VALIDADO AUTOMÁTICAMENTE EN STAGING, PERO NO APROBADO FUNCIONALMENTE.** Las PR reales por el conector GitHub externo no sustituyen las pruebas del cliente OpenCode. No afirmar que G8 está cerrado o que G9 ha iniciado.

### Acción mínima del propietario

1. Abrir `https://opencode-g1-staging.cdf-cloud-mvp-20261019.workers.dev` desde Android → **Proyectos** → **Comprobar aislamiento CDF CLOUD y WorkBench**. Si la aplicación aún no tiene GitHub conectado, el botón estará deshabilitado y habrá que conectarlo desde Configuración dentro de la aplicación (no pegar tokens aquí).
2. Confirmar que aparece: **«Verificado: CDF CLOUD y WorkBench están aislados. Dos diffs correctos, ninguna escritura o inferencia durante la comprobación.»**. Si falla, compartir solo el mensaje, nunca secretos.
3. Después, para el gate de *agente real*, abrir una conversación aislada por cada repositorio desde el selector y pedir una **revisión de solo lectura de la rama G8**, con acciones `github repo/read/review`. Confirmar que ambas respuestas usaron herramientas reales y los diffs correctos. No pedir nuevas escrituras: las PR de prueba ya existen.

Si estas pruebas pasan, actualizar matriz, cerrar G8 y comenzar G9 — pruebas de entrega y publicación controlada. En caso contrario, corregir únicamente el defecto observado, sin ampliar G8. No desplegar producción ni fusionar PRs sin autorización explícita.
