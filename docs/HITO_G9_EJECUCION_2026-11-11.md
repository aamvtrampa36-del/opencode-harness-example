# OpenCode Cloud — G9: ejecución y preparación de entrega V1 (11 noviembre 2026)

**ESTADO VIGENTE (11 noviembre 2026): G9 BLOQUEADO ÚNICAMENTE PARA CIERRE DOCUMENTAL DE LAS 12 E2E DEL ENCARGO.** El propietario completó en Android la aceptación real de desarrollo autónomo; GitHub confirmó la PR borrador #30 creada por el agente, su diff acotado y CI #300 verde. Ver §9, cuyo resultado prevalece sobre los estados anteriores de este informe. La lista literal de doce casos E2E no se encuentra disponible. La V1 NO está publicada.

## 1. Condición obligatoria y recuperación

- Se comprobó el archivo `Informe_Integral_OpenCode_Cloud_V1.pdf`: **21 páginas**, texto completo extraído y leído, desde la portada a las conclusiones; documento histórico con corte 8–9 de noviembre de 2026.
- Se recuperaron `docs/V1_EXECUTION_PLAN.md`, `docs/HITO_G9_INICIO_2026-11-10.md`, las actas G1–G8 y PR #28; no se sustituyó el informe por recuerdos.
- G8 figura **APROBADO EN STAGING**: la captura del titular mostró que dos sesiones auténticas completaron `repo_review` sobre CDF CLOUD y WorkBench. Los proyectos se mantuvieron separados y sus PR #160 y #36 siguen draft y sin merge. No reabrir G8.
- **G2** tiene una demostración anterior de autodesarrollo de OpenCode, sesión `ses_e3e9e8729ffatpooTEb0xeB1yi`: agente real, seis llamadas GitHub y seis Linux, dos commits y [PR #29](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/29), GitHub Actions #147 aprobado. Esta evidencia prueba autonomía asistida por instrumental de ensayo, **no demuestra por sí sola** el flujo de entrega iniciado directamente desde Android sin administración.
- G4 verificó en un Container nuevo cuatro hashes idénticos después de restaurar backup SQLite DO; G5 validó flujo Android; G6 plantillas; G7 incidente Linux `exitCode 19`; no se repitieron sin evidencia de regresión.
- Cloudflare protegía staging con Access `self_hosted` (una política), Cron vacío y Worker productivo anterior sin modificaciones.

## 2. Falta de fuente: las doce pruebas del encargo

El informe maestro dice que la V1 debe probar **acceso, edición de código, uso de herramientas, autocorrección, GitHub, persistencia, recuperación, diagnóstico y funcionamiento móvil**; las etapas G1–G9 desarrollan además plantillas y separación de proyectos. **No enumera 12 pruebas E2E específicas con IDs, pasos ni condiciones individuales**.

`docs/V1_EXECUTION_PLAN.md` remite a «las 12 pruebas del encargo», pero tampoco lista sus doce definiciones. La búsqueda de los archivos recuperables y del texto original no produjo el encargo literal. **No se fabricó un conjunto nuevo de doce pruebas ni se declaró cumplida esa condición.**

Se conservaron evidencias existentes para las capacidades descritas en los documentos, y se separan de las doce pruebas no disponibles. Para cerrar G9 hace falta recuperar el encargo literal o una aprobación explícita del titular de una matriz sustitutiva. No modificar silenciosamente el contrato original.

## 3. Nueva prueba autónoma de entrega: implementación

Para probar desde Android una secuencia completa sin administración se añadió el circuito **«Probar desarrollo real G9 (una vez)»** dentro de la aplicación ya protegida, sin nuevos servicios ni scheduler.

- `src/g9-selfdev.ts`: caso de prueba reproducible, únicamente en `aamvtrampa36-del/opencode-harness-example`, rama `opencode/g9-selfdev-20261111` y proyecto Linux `g9-selfdev-proof`. Archivo fuente inocuo `tests/g9-proof/add.mjs` inicialmente incorrecto (`a - b`) y test inmutable `tests/g9-proof/add.test.mjs`, que exige `add(2,3) === 5`.
- **Preparación del servidor**: verifica GitHub autorizado y conectado antes de crear recursos; crea la rama desde `main`, añade los dos archivos de fixture de prueba en ella (NO se atribuye esta preparación al modelo) y ejecuta Node en Linux para comprobar que el test empieza **rojo**. Ningún archivo existente ni producción se modifica.
- **Trabajo exigido al agente**: sesión nueva y asociada inmutablemente al repo/proyecto, modo Desarrollo, modelo económico registrado si está disponible o Cloudflare. Tiene que observar con `linux` el test rojo, leer la fuente GitHub, cambiar realmente el archivo fuente mediante `github write` en esa rama, ejecutar el test verde en Linux, revisar el diff y crear una **PR borrador**. No puede editar `main` ni otros repositorios; los guards anteriores siguen aplicados.
- **Aceptación independiente**: `assessG9History` examina las partes `tool` reales, exige el orden **rojo → commit GitHub del agente → verde → revisión correcta → PR borrador**, y rechaza prosa optimista, otra rama o repo, herramientas fallidas, archivos extra y PR no draft. Después el servidor relee GitHub, confirma fuente corregida y test inalterado, compara el diff que debe contener exactamente esos dos archivos y ejecuta **otra prueba Node externa al modelo** con salida 0.
- El estado y motivo de aprobación o fallo se guardan en Durable Object. El mismo botón **no inicia una segunda inferencia**: reabrir la página recupera el resultado. El API es de mismo origen y el inicio está disponible solo en el hostname de staging conocido. No se transfieren secretos a Linux o al modelo.
- `src/client.tsx`: botón con aviso explícito de coste de inferencia/Container y creación de una rama y PR de borrador, más resultado visible. No requiere terminal ni que el usuario escriba código.

**No se ha pulsado todavía el botón desde la sesión autenticada del propietario, por lo que no existe una PR G9 generada por el modelo durante esta intervención.** Tampoco se ejecutaron llamadas de inferencia por el supervisor en preparación.

## 4. Pruebas, correcciones y resultados

Commits de código en rama staging:
- `268694e37402c58f1905335dbe4bc9f547ae0c6f`: definición del caso de autodesarrollo y verificador independiente.
- `2d15f60a4c2f0ab27d0debf6df14e689a1681de4`, `d2668edb94ae496f0f5e4e6182ee0a93893e6f16`: instrucciones de fixture y fuente corregida esperada.
- `9335ac244fc4b5327731b890fd3a5001ac4622e3`: orquestación real del agente, rama, Linux, PR y aceptación.
- `238e889c1205451fa03e23a2e967f6d038ba91f4`: interfaz de una pulsación.
- `2abddbebc59255928b64d25b5d7353cc42c4f52a`: pruebas de orden y rechazo de evidencia falsa.
- **#287 falló**: el verificador aceptaba erróneamente PR antes de revisión o verde antes de escritura. Corrección causal `8c2e66368e1e34cc701b5923b955b598343392c5`; **CI #288 completó success**.
- `f5fe60a96daf9f2ec1d51bf1b5d190afcc6f8ea1`: aceptar un salto de línea final opcional en la fuente corregida, sin permitir otros contenidos. **CI #289 completó success**: pruebas Bun, TypeScript, preview HTTP, compilación Worker/cliente e invariantes. Cloudflare Workers Builds de este commit, **success**.
- Se ejecutó además una prueba Node local independiente para confirmar el fixture: `node --test --test-reporter=tap add.test.mjs` devuelve **exit 1** con fuente de resta y **exit 0** con suma. **Es una comprobación del fixture por el supervisor, no una prueba del agente real.**

**No se introdujeron dependencias externas, herramientas con privilegios ampliados, cambios de Docker, nuevas cuentas, claves ni permisos.**

## 5. Candidata reversible preparada (no publicada)

Se creó y actualizó la rama de referencia **[`release/g9-v1-candidate-20261111`](https://github.com/aamvtrampa36-del/opencode-harness-example/tree/release/g9-v1-candidate-20261111)** apuntando al commit exacto de código **`ff5c88e7735469864d8264cc93fa56c6a7eaae62`**, cuyo CI #297 está aprobado. La actualización fue un avance directo con comprobación del SHA previo, sin reescribir historia ni tocar `main`.

Esta es una **referencia reversible de trabajo** y no una release publicada, un tag firmado ni una V1 aprobada. Se puede volver a la versión staging anterior o abandonar esa rama sin cambiar `main`; la reversión del Worker **no** equivale por sí sola a restaurar datos persistentes de otra versión. La autorización de despliegue productivo no está concedida.

Infraestructura verificada tras ese commit:
- Worker staging `opencode-g1-staging`: versión `b13f5e53-99d9-4ba6-8b31-bc5f48d38772`, Access `self_hosted` con una política, Cron `[]`, build exitoso.
- Worker productivo `opencode-harness-example`: **`1d70eb77-316e-408d-bd14-5f19b171dedf`**, sin cambios.
- PR [#28](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/28), [#29](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/29), [CDF CLOUD #160](https://github.com/aamvtrampa36-del/cdf-cloud-engine/pull/160) y [WorkBench #36](https://github.com/aamvtrampa36-del/CDF-WorkBench-/pull/36) no tienen autorización de merge.

## 6. Matriz de aceptación de G9

| Criterio | Estado | Evidencia y limitación |
| --- | --- | --- |
| Informe maestro completo y G8 cerrado | **CUMPLIDO** | PDF 21 pp; actas y PR |
| Autodesarrollo real del agente | **ANTECEDENTE PROBADO** | G2: agente creó PR #29, CI #147; no es prueba actual Android |
| Flujo de desarrollo completo iniciado por propietario sin administrador | **PENDIENTE** | Botón G9 en staging y tests; falta ejecución con el modelo real en la sesión del titular |
| Prueba roja/verde del fixture | **CUMPLIDO TÉCNICAMENTE** | Node local 1→0; el agente aún no la ha ejecutado |
| 12 pruebas E2E exactas del encargo | **BLOQUEADO POR FUENTE AUSENTE** | No se localizó la lista original; no inventar |
| Endurecimiento necesario y regresiones de código | **CUMPLIDO EN CAMBIOS EJECUTADOS** | Falso positivo de secuencia corregido; CI #289 |
| Rama candidata reversible | **PREPARADA** | `release/g9-v1-candidate-20261111` al commit probado |
| Datos y producción | **PROTEGIDOS** | Sin fusiones ni despliegues productivos; Access, DO y Cron conservados |
| Gate P0 final y V1 publicable | **NO APROBADO** | Falta aceptar el recorrido real del titular y definición/ejecución de las doce E2E |

**Dictamen final de esta intervención: G9 BLOQUEADO PARA CIERRE FORMAL, con trabajo independiente terminado y staging listo para la aceptación pendiente.** No prometer V1 liberada ni llamar definitiva a una candidatura.

## 7. Intervención mínima y siguiente paso

**Acción 1 (Android, una pulsación):** abrir staging protegido `https://opencode-g1-staging.cdf-cloud-mvp-20261019.workers.dev`, menú **Proyectos**, botón **«Probar desarrollo real G9 (una vez)»**. Solo si el usuario acepta el coste de un modelo y un Container. El sistema crea una rama y dos archivos de fixture, solicita al modelo la corrección y verifica el resultado. La pantalla informa éxito o error. Si falla, comunicar únicamente el primer motivo; no pulsar varias veces ni compartir claves.

**Acción 2 (documental):** proporcionar el texto/archivo del **encargo original donde se definieron las 12 pruebas E2E**, si existe; o autorizar explícitamente elaborar la matriz de aceptación a partir de los criterios literales del informe maestro. No declarar doce resultados inexistentes.

Una vez se superen ambos gates, actualizar el informe, verificar P0 completos y preparar una **publicación controlada** con autorización productiva separada. No fusionar PR automáticamente.


## 8. Endurecimiento P0 adicional y CI final

Durante la revisión de la nueva prueba se detectó un riesgo concreto: la sesión G9 tenía el repositorio autorizado, pero el puente genérico GitHub permitía escribir en **cualquier otra rama `opencode/*` del mismo repositorio**, si el modelo lo solicitaba. Eso era reversible, pero podía alterar trabajos ajenos. Se corrigió en el **límite del ejecutor de herramientas**, no mediante una instrucción opcional al modelo:

- `src/project-scope.ts` y `src/workspace.ts`: envían la operación y rama GitHub en los metadatos del control de sesión.
- `src/g9-selfdev.ts`: `assertG9BoundGitHubOperation` rechaza crear ramas adicionales y ejecutar `github write` o `github pr` fuera de **`opencode/g9-selfdev-20261111`**. Mantiene lectura y revisión sin escritura.
- `src/server.ts`: al ejecutar una herramienta, solo aplica ese bloqueo de rama a la sesión G9 correspondiente, en función del identificador persistido en Durable Object. Otros agentes y proyectos conservan sus permisos previos.
- `src/g9-selfdev.test.ts`: verifica la denegación de escrituras y PR fuera de esa única rama.

**Corrección y CI:** commits `01f8d15dbe75d8b8a407776894fd859d1df107c3`, `645584703bb1f3246c463c5356063a3f7e84f34f`, `27db5518b69a1651603ab8ad6b087b438c6b7f4a`, `851da47ead0b01616b8886344b8faff4bd094e09`, `4f8f25763ac217dcd8f33ff8fd44565a3e60439d`. CI #296 falló únicamente en el tipado de una operación GitHub opcional; corregido en `ff5c88e7735469864d8264cc93fa56c6a7eaae62`. **GitHub Actions #297 `completed/success`**, con 105 tests unitarios, TypeScript, servidor preview y compilación. Cloudflare Workers Builds del mismo commit también `success`, staging `b13f5e53-99d9-4ba6-8b31-bc5f48d38772`.

La rama candidata `release/g9-v1-candidate-20261111` se movió mediante avance directo seguro desde `f5fe60a9` a **`ff5c88e7`**, sin force ni merge. Esta referencia sigue siendo **candidata preliminar no aprobada**: falta el resultado auténtico del agente y la lista original de doce pruebas E2E.

**Dictamen sin cambios:** G9 continúa **BLOQUEADO PARA CIERRE**, pero el código que permite la última prueba real está listo, verificado y restringido a staging; no se ha disparado una tarea de inferencia ni creado una PR del agente en G9.


## 9. Aceptación funcional real G9 desde Android y PR creada por agente (11 noviembre 2026)

**GATE DE AUTODESARROLLO: APROBADO EN STAGING.**

El propietario realizó desde Brave/Android la única intervención solicitada y aportó captura de la pantalla privada de OpenCode Cloud. El panel **G9 · Desarrollo autónomo** mostraba el botón de repetición deshabilitado y el mensaje:

> Desarrollo autónomo G9 aprobado: arreglo, prueba roja→verde, commit, diff, PR borrador y verificación independiente. https://github.com/aamvtrampa36-del/opencode-harness-example/pull/30

El mensaje solo se genera si el servidor devolvió `status: "passed"` tras leer el historial real de herramientas del agente, comprobar el orden rojo → escritura GitHub → verde → revisión → PR borrador y ejecutar una verificación independiente del contenido de los archivos y del test Node. La captura es evidencia de sesión autenticada aportada por el titular; **esta conexión no leyó directamente el historial interno de Durable Object ni controló su navegador**.

**Verificación independiente en GitHub**:

- [PR #30](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/30), `test(g9): agent fixes isolated red-to-green fixture`: `state=open`, **`draft=true`**, `merged=false`. Rama `opencode/g9-selfdev-20261111` frente a `main`, tres commits por delante, cero por detrás.
- HEAD `b7fdfa2efac87ff5c17d877b01fc1fa314f9880b`, commit del agente `fix(g9): correct isolated add fixture`. La PR contiene solo **dos archivos añadidos**: `tests/g9-proof/add.mjs` (función `add` corregida con suma) y `tests/g9-proof/add.test.mjs` (test Node de `add(2,3) === 5`).
- La descripción de PR escrita por el agente registra un Linux rojo (`exitCode=1`, `-1 !== 5`) y verde (`exitCode=0`), así como la lectura, edición, comprobación GitHub y revisión. La evidencia primaria de ejecución no se reduce a esa descripción: el verificador de la aplicación rechazaba resultados de texto sin tool calls válidas, y la captura acredita su estado aprobado.
- [GitHub Actions #300](https://github.com/aamvtrampa36-del/opencode-harness-example/actions/runs/42975249373) para ese HEAD: **`completed/success`**, pruebas independientes adicionales sobre la rama del agente. El diff GitHub `main...opencode/g9-selfdev-20261111` coincide con la PR; no hay escrituras productivas.
- La pantalla de Android estaba visualizando un proyecto CDF, pero **la prueba G9 es autónoma y utiliza deliberadamente un proyecto Linux y un repositorio OpenCode definidos exclusivamente por el servidor**, en una sesión de agente propia. Por tanto la selección visible del proyecto en el chat no implica que el agente haya escrito en CDF.

**Criterios definitivamente satisfechos:** ejecución real iniciada por propietario, código escrito por el agente, test previo fallido realmente observado, reparación, test verde, diff independiente, PR draft, aislamiento por repo/rama, CI externa, reversibilidad en rama y ausencia de merge. No repetir la prueba ni abrir más PR de ensayo.

**Único gate obligatorio pendiente para G9:** la **definición y cobertura verificable de las 12 E2E del encargo original**. Ese encargo no aparece íntegro en el informe maestro ni en el plan. Recuperarlo o recibir autorización explícita para una matriz sustitutiva. No declarar G9 APROBADO, liberar V1 ni publicar producción hasta satisfacer ese requisito. G8 permanece cerrado, no se reabre.

**Siguiente acción específica:** solicitar el encargo original que enumera los 12 casos o la autorización expresa para derivarlos del informe maestro, reutilizar G1–G9, comprobar los casos residuales y preparar dictamen G9. La PR #30 queda en borrador: es prueba, no una funcionalidad que deba fusionarse.
