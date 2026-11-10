# OpenCode Cloud — G5: interfaz para vibe coding (avance verificable)

**Fecha:** 2026-11-09 / 2026-11-10 UTC.
**Estado definitivo de esta intervención:** BLOQUEADO PARA CIERRE DE G5 por falta de prueba de usuario Android autenticado. Implementación y CI de G5 avanzados; no hay evidencia suficiente para aprobar el criterio E2E. No iniciar G6 formalmente.
**Fuente:** informe maestro OpenCode Cloud V1 (21 páginas), plan `docs/V1_EXECUTION_PLAN.md`, cierre G4 y comprobaciones de GitHub/Cloudflare.

## 1. Línea base recuperada

G1–G4 figuran aprobados en sus actas y en el plan actualizado. G4 verificó restauración real desde backup SQLite de DO en un Container nuevo, con 4/4 hashes y tests Node correctos. La rama de staging es `fix/repeatable-agent-verification-20261108`, PR #28 borrador. La PR #29 corresponde al autodesarrollo G2. El Worker productivo `opencode-harness-example` seguía en la versión `1d70eb77-316e-408d-bd14-5f19b171dedf` durante esta intervención y se mantuvo fuera del alcance.

## 2. Cambios de G5 realizados

- `src/client.tsx`: incorporar el formulario de **restauración** desde un respaldo ya guardado hacia un nombre nuevo, incluso si el proyecto original no figura en la lista de proyectos actuales. Validación local de nombre y colisiones conocidas; la API `POST /api/dev/restore/{origen}` del G4 sigue haciendo la validación autoritativa, comprobación SHA y publicación no destructiva.
- Tras una restauración satisfactoria, seleccionar el proyecto recuperado para continuar trabajando y mostrar el aviso de comprobar pruebas/archivos.
- Guardar opcionalmente la referencia a la sesión actual al respaldar el proyecto activo, sin afirmar que el transcript queda exportado.
- Mostrar cerca del editor de tareas **proyecto activo**, acceso a cambiarlo y recuento de herramientas completadas/fallidas **observadas en esa sesión**.
- Vincular el proyecto Linux seleccionado al texto de las nuevas tareas de desarrollo; **esto es orientación del agente, no frontera de seguridad del servidor**. El aislamiento obligatorio de repositorios de CDF CLOUD y WorkBench continúa reservado a G8.
- Hacer visible el panel de proyectos al abrirlo desde la parte inferior del móvil y actualizar el texto antiguo que afirmaba incorrectamente que no había restauración.

No se añadieron dependencias, nuevos modelos, nuevos servicios, cron, permisos, ni capas de interfaz independientes. No se tocó producción, el canon narrativo, secretos ni datos de otros proyectos.

## 3. Evidencia

- Commit de funcionalidad: `74b17f28a8414e1576616b9126ce79558c265b07`.
- GitHub Actions **#175**, ejecución `42729277908`: **success**. Instalación, pruebas unitarias, servidor real de vista previa estática, TypeScript, compilación Worker/cliente y validación de invariantes aprobaron.
- Cloudflare Workers Builds: build `4fcdb59d-79c6-41ad-9d1b-0479561a045c`, resultado **success** vinculado al mismo commit; desplegado a Worker protegido de staging `opencode-g1-staging`, versión `cb93ddb7-5634-4a47-bf38-f50a552442df` (100 %).
- Commit correctivo posterior `ce2cd83ba9279d0bd309d1594b6b98454e4a09b4`: ajustar el separador entre contexto y tarea y etiquetar el conteo como perteneciente a una sesión. **La CI y versión de staging correspondientes deben consultarse por separado antes de dar ese commit como validado.**

**Importante:** las pruebas de compilación y el despliegue de staging no equivalen a una prueba manual Android con Cloudflare Access autenticado.

## 4. Matriz honesta de aceptación de G5

| Criterio | Estado |
| --- | --- |
| Elegir proyecto y sesión | Implementado; requiere prueba móvil real |
| Enviar tarea y elegir modelo | Implementado previamente; mejora de contexto en este cambio |
| Ver eventos de herramientas | Tarjetas de herramientas existentes + contadores; compilación aprobada |
| Detener/reconectar | Controles y WebSocket existentes; reconexión real tras fallo aún no repetida |
| Guardar/restaurar sin terminal | UI implementada sobre G4; **restauración lanzada desde Android pendiente** |
| Ver archivos modificados en resumen claro | Parcial: aparecen salidas de herramientas, no hay diff resumido obligatorio |
| Costo aproximado por tarea | Pendiente: no atribuir consumo de cuenta a una tarea concreta sin telemetría |
| Flujo integral desde Android | Pendiente: requiere sesión del propietario autenticada por Cloudflare Access |

## 5. Continuación exacta y regla de cierre

**Mantener G5 abierto.** La siguiente intervención debe usar staging ya protegido y una sesión auténtica del titular para completar en Android: elegir proyecto; instruir al agente; comprobar herramientas y cambios; observar finalización; guardar respaldo; restaurarlo en un nombre diferente; ejecutar un test y comprobar reconexión tras recarga. No compartir cookies, contraseñas ni tokens en el chat ni eliminar Access.

Con evidencia anterior, completar la visibilidad de archivos modificados y costo por tarea usando eventos existentes si lo permiten. No inventar métricas. Corregir defectos concretos con tests y volver a probar. Sólo cerrar G5 cuando el flujo principal pueda usarse sin terminal con resultados comprobables; entonces iniciar **G6 — plantillas declarativas editables**, reutilizando el sistema de especializaciones ya presente.

**Producción:** sin despliegue autorizado ni solicitado. **Principio:** recuperar → comparar → ejecutar → validar → cerrar → avanzar; ninguna afirmación de cierre se basa solo en CI.

## 6. Ejecución complementaria — interfaz operable y evaluación final (9–10 noviembre 2026 UTC)

### Alcance ejecutado sin añadir servicios

Se recuperó y verificó la versión íntegra del informe maestro PDF (21 páginas) y las actas G1–G5 antes de modificar. La PR #28 permaneció abierta como borrador, sin fusionar. Se revisaron los archivos de UI, transporte WebSocket, modelos, respaldo/restauración y el flujo de Linux existente.

**Cambios ejecutados en `src/client.tsx`:**

- `86c8433f07247b0d49e97d91021dc8aa7c6a2858`: botón **Revisar archivos** en el selector de proyectos. Usa el endpoint ya protegido `POST /api/dev/run` para consultar `git status --short`, `git diff --stat` y último commit. Si no existe repositorio Git, muestra un listado acotado y lo identifica expresamente como **no equivalente a un diff**. El usuario no necesita introducir comandos.
- Mismo commit: indicador de consumo durante una ejecución OpenRouter, comparando el valor acumulado antes/después desde `GET /api/settings/openrouter/usage`. El texto advierte que es un **incremento aproximado de la cuenta**, no la factura de una tarea: puede incluir uso paralelo y no cubre Workers AI. Si no hay datos verificables, no muestra importes inventados.
- `4ea1a02afbcf883ac6ac368d6c84902d9367b0c4`: el listado de conversaciones en móvil se abre como panel superpuesto, se puede cerrar y vuelve al chat al elegir una sesión; evita dividir el alto de pantalla en dos filas.
- `5a0bba8974cb9b9f82db773d84ff81f48a1788a0`: botón **Reintentar** disponible cuando se pierde conexión; recarga la página conservando la sesión seleccionada en almacenamiento local y solicita otra vez el estado desde el servidor. No se afirma recuperación automática de una herramienta que estaba a mitad de ejecución.

El flujo existente de G5 conserva selección de proyectos, redacción de tareas en lenguaje natural, modelos configurados, controles de detener/continuar, estado real de herramientas, respaldos y restauración no destructiva.

### Verificaciones efectuadas

| Prueba | Resultado |
| --- | --- |
| GitHub Actions #178 — commit `86c8433` | **success**; Bun, preview, TypeScript, compilación e invariantes |
| GitHub Actions #179 — commit `4ea1a02` | **success** |
| GitHub Actions #180 — commit `5a0bba8` | **success** |
| Workers Builds `81ea2661-bc6c-4a25-ba94-05367bc82fc9` | **success**, commit `86c8433` |
| Workers Builds `3fefc734-df44-464a-b42a-6195ae9f3e28` | **success**, commit `4ea1a02` |
| Workers Builds `fc9b72dc-3b4d-463d-bef0-c591d07f3c96` | **success**, commit `5a0bba8` |
| Staging `opencode-g1-staging` | Despliegues automáticos de la rama; Cloudflare Access sigue configurado |
| Worker productivo `opencode-harness-example` | **Sin modificación**: versión `1d70eb77-316e-408d-bd14-5f19b171dedf` |
| Cron en staging | **Sin tareas activas**: `schedules=[]` |
| Prueba real desde navegador Android autorizado | **NO EJECUTADA**: no existe sesión de navegador autenticada accesible al supervisor |

Cloudflare Access tiene una aplicación de tipo `self_hosted` para `opencode-g1-staging.cdf-cloud-mvp-20261019.workers.dev`, con una política configurada. El acceso de API del administrador no equivale a la sesión interactiva que permite probar el flujo en un navegador. No se intentó suplantarla, desactivar Access, entregar cookies o crear una credencial temporal.

### Criterios de aceptación finales

| Criterio G5 del plan | Estado verificable |
| --- | --- |
| Seleccionar proyecto y tarea | Implementado en UI; no validado en Android real |
| Ejecutar y ver herramientas | Soportado por WebSocket y tarjetas de resultados; pruebas G1 y G2 acreditan el motor, no esta sesión móvil |
| Revisar archivos y pruebas sin terminal | Implementado: consultas Git en UI y trazas de herramienta; no probado desde Android |
| Mostrar consumo aproximado sin engaño | Implementado para uso incremental OpenRouter disponible; no se pretende desglose exacto ni costo Workers AI |
| Detener, reconectar, recuperar historial | Controles y protocolo existentes más botón de reintento; falta prueba de interrupción en Android |
| Guardar y restaurar desde la interfaz | Formulario sobre API G4 implementado; recorrido Android sin comprobar |
| Flujo Android completo bajo Cloudflare Access | **PENDIENTE Y BLOQUEANTE** |

**Dictamen: G5 BLOQUEADO para aprobación E2E.** La construcción automatizada satisfactoria y el despliegue separado no certifican la funcionalidad desde el teléfono del titular. No hay prueba de que falle; hay falta de evidencia independiente.

### Acción mínima que desbloquea el cierre

Desde Android, el titular debe abrir `https://opencode-g1-staging.cdf-cloud-mvp-20261019.workers.dev` y autenticarse mediante Cloudflare Access **sin comunicar credenciales al supervisor**. En un proyecto de prueba no crítico:

1. Seleccionar o crear un proyecto, elegir modelo y enviar una tarea pequeña con herramienta Linux; comprobar que se registran operaciones y resultados reales.
2. Abrir **Proyectos → Revisar archivos**, comprobar el cambio y las pruebas; guardar respaldo y restaurar en un destino nuevo con el formulario G5, verificando el resultado.
3. Recargar/cerrar y volver a abrir la sesión en el mismo dispositivo; comprobar el historial y, cuando corresponda, la reconexión. Probar detener una operación de prueba si está en curso y volver a iniciar de forma segura.

Anotar fecha, resultado observable y fallo concreto si aparece; no hace falta crear un segundo servicio ni publicar una consola. Ante un fallo reproducible, corregirlo en rama y volver a validar. **No fusionar a producción ni marcar G5 APROBADO** sin esa evidencia.

### Hito siguiente según el informe y el plan

Una vez **aprobado G5**, continuar con **G6 — Plantillas sin arquitectura adicional**. Acción inicial: reutilizar el CRUD ya existente de especializaciones para ofrecer los siete perfiles declarativos previstos (Desarrollo, Diagnóstico, Revisión, Planificación, Decisiones, Flujo de trabajo y Documentación), con configuración editable y pruebas de que cambian la conducta del agente sin crear otros ejecutores.

**No convertir G6 en requisito para cerrar G5 ni anticipar tareas G7–G9.** Este registro no constituye una autorización de merge ni de despliegue productivo.

## 7. Corrección concreta de continuidad de tareas y validación (10 noviembre 2026 UTC)

### Defecto detectado

Al revisar el flujo de G5 se comprobó que `useOpenCodeSession` descartaba silenciosamente los mensajes cuando el WebSocket dejaba de estar `OPEN` justo antes de llamar a `send`. En la interfaz, el texto de la tarea se limpiaba **antes** de verificar ese envío. Esto podía perder el borrador de trabajo incluso cuando el servidor no recibía la orden. También podían perderse sin aviso las órdenes de detener o crear una sesión.

### Corrección aplicada

- `src/use-opencode-session.ts`: el envío devuelve `boolean`; un fallo de conexión presenta un error visible. La creación de sesiones rechaza inmediatamente la promesa si no se envía su orden, en lugar de aguardar innecesariamente.
- `src/client.tsx`: el borrador se limpia solo si la orden fue aceptada localmente por el WebSocket; en caso contrario permanece editable para reintentar. El cambio no modifica el servidor, permisos ni el entorno productivo.
- `src/ws-send.ts` y `src/ws-send.test.ts`: comprobaciones unitarias para socket abierto, socket desconectado/conectando y excepción al enviar.

**Límite explícito:** aceptar una trama en el WebSocket local **no garantiza** su recepción o ejecución remota. La corrección cubre la pérdida silenciosa antes del envío, no sustituye el reconocimiento de órdenes del servidor ni las pruebas reales de reconexión.

### Commits y evidencias

- `a6e97541ac7ce5d20b8ab3a669791edd3f0f2bd5`: aviso y resultado booleano de envío.
- `88ec4428340dbad871178f9c8dc767c6fcbb7d7e`: conservar borrador cuando no se consigue enviar la tarea.
- `d40a340c2fe82ce67aae8e7e176268c894e2b96c`: helper de envío comprobable.
- `5190353003137daca9c59c2a8a13a40bbe241704`: tres pruebas unitarias de comportamiento negativo/positivo.
- `902f2badcfea2ba19a35eef5e503c9fcf60e355a`: usar helper verificado en el hook.
- GitHub Actions **#185**, run `42756516484`: `completed/success` (Bun tests, preview, TypeScript, build de Worker/cliente, invariantes).
- Cloudflare Workers Builds `8cbb3830-1686-4306-bcd9-e241a533d396`: `stopped/success` para `902f2bad`.
- Staging verificado en versión `06c20f75-4a3a-439b-aa5f-b935201c2426`. Producción sin cambios en `1d70eb77-316e-408d-bd14-5f19b171dedf`. Cron staging vacío.

### Estado de aceptación después de la corrección

**G5 sigue BLOQUEADO PARA CIERRE** únicamente por la prueba funcional integral real de Android bajo Cloudflare Access que consta en §6. No se debe reabrir G1–G4 ni volver a corregir preventivamente código ya probado. Ninguna prueba unitaria, compilación ni verificación de Cloudflare API puede acreditar por sí sola que el titular completó desde el teléfono el recorrido de proyecto → tarea → herramientas → revisión → respaldo → restauración → recarga/reconexión.

El siguiente paso operativo es **verificar ese recorrido con una sesión autorizada de Android en el staging protegido**, registrando resultados y corrigiendo exclusivamente defectos reproducibles. Se mantiene la PR #28 como borrador sin fusionar. Tras la aceptación real de G5, iniciar **G6 — Plantillas sin arquitectura adicional**, reutilizando el CRUD de especializaciones existente. Ningún despliegue a producción ni ampliación de permisos fue necesario para esta intervención.


## 8. Revalidación final y dependencia de aceptación (10 noviembre 2026)

Releído íntegramente el informe maestro de 21 páginas y consultadas las actas G1–G5. No se detectaron cambios posteriores en el código de la rama que invalidaran la aprobación técnica documentada en §7. No se reabren los hitos G1–G4 ni se amplía el alcance de G5 por perfeccionismo.

**Evidencias de estado actual verificadas de forma independiente:**

- Rama de revisión PR #28, aún abierta como borrador, HEAD `3078f872df15e5c73ff3ad5e41d133b24e1e0cb4`.
- GitHub Actions **#186** (run `42756664949`) completó con `success` para ese commit de documentación.
- Cloudflare Workers Builds terminó con `success` para `3078f872`; Worker de staging `opencode-g1-staging` en versión `4d3486da-dc14-4a9c-8f6d-0d9a9f43e51d`.
- Worker de producción `opencode-harness-example` sin modificaciones, versión `1d70eb77-316e-408d-bd14-5f19b171dedf`; no hay Cron de staging (`[]`).
- Cloudflare Access mantiene aplicación `self_hosted` y una política para el dominio protegido.
- La sesión de navegador vinculada no estaba disponible en este contexto: el conector solo funciona desde el contexto de navegador de origen. Por tanto **no se ejecutó E2E autenticado en Android**, ni se sustituyó por una prueba con privilegios de administrador o desactivando Access.

**Dictamen: G5 BLOQUEADO únicamente para aceptación funcional Android; desarrollo y CI validados.** Los controles y APIs están implementados, pero no constituyen prueba suficiente del recorrido real completo desde el teléfono. No hay fundamento técnico para añadir nuevas funciones hasta recibir un defecto reproducible o esa evidencia.

**Única acción necesaria para desbloquear:** el propietario abre `https://opencode-g1-staging.cdf-cloud-mvp-20261019.workers.dev` desde Android con su acceso habitual y ejecuta una tarea pequeña en un proyecto de prueba, comprueba herramientas y revisión de cambios, guarda un respaldo, lo restaura en otro proyecto, recarga y verifica historial/reconexión. Registrar éxito o fallo específico. No compartir contraseñas, cookies ni tokens. Si falla, reparar solo el defecto reproducible en la rama y volver a validar.

Una vez demostrado el recorrido, marcar **G5 APROBADO** y pasar a **G6: plantillas declarativas editables**, reutilizando el CRUD de especializaciones existente (Desarrollo, Diagnóstico, Revisión, Planificación, Decisiones, Flujo de trabajo y Documentación). El informe maestro define el orden; esta verificación no autoriza merge ni despliegue en producción.


## 9. Fallo real detectado en Android: vista previa sin CSS ni JavaScript (10 noviembre 2026)

### Evidencia del propietario y causa probable

El propietario ejecutó **desde Android / Brave**, bajo su autenticación habitual de Cloudflare Access, una tarea con DeepSeek en el proyecto de prueba `app-mwabn7ns`. El historial exportado aporta cuatro herramientas Linux completadas y una llamada previa `inspect_linux` fallida porque el proyecto aún no existía, seguida de creación correcta del proyecto. `npm test`, `npm run build` y la comprobación HTTP *dentro del Container* finalizaron correctamente. No hubo intervención del supervisor en los archivos de la aplicación generada.

La captura del navegador Android confirmó un fallo de aceptación de G5: **se veían el título «Prueba G5» y el botón «Funciona», pero no se aplicaban los estilos CSS y el botón no respondía**. El origen exacto de las peticiones rechazadas no se pudo inspeccionar sin una sesión autenticada de navegador conectada. La explicación técnica más probable es la combinación de CSP `sandbox allow-scripts` (origen opaco) y solicitudes de recursos separados en un dominio protegido por Cloudflare Access, que pueden quedar sin cookies autorizadas. La anterior autoprueba HTTP local no podía detectar ese problema.

### Corrección segura ejecutada

- `src/preview-inline.ts`: reescritura limitada y verificable de referencias a CSS y JavaScript **locales y exclusivos del directorio `dist/` del mismo proyecto**, incorporándolos al documento HTML durante la respuesta del Worker. El Worker obtiene los recursos desde el `DevContainer.preview` ya existente, sin exponer carpetas de código ni conceder acceso externo al Container. Se limitan cantidad y tamaño.
- `src/server.ts`: aplica la reescritura solo a respuestas HTML `GET` correctas de `/api/dev/preview/:project/...`; elimina el encabezado `Content-Length` después de modificar el contenido. `HEAD`, archivos individuales, descarga y todos los demás endpoints conservan su comportamiento.
- `src/preview-inline.test.ts`: pruebas para CSS + JavaScript locales, rutas relativas y absolutas dentro del proyecto, URLs externas y navegación fuera de `dist/`, tipo MIME incorrecto y cierre seguro de etiquetas.
- **Se conserva la CSP anterior** (`sandbox allow-scripts` sin `allow-same-origin`) y la protección Cloudflare Access. No se abre un subdominio público ni se crea otro ejecutor. No se tocan proyectos del usuario ni datos productivos.

Esta intervención está dirigida a recursos locales CSS/JS. No equivale todavía a una validación de módulos con importaciones dinámicas, fuentes, imágenes o aplicaciones web arbitrarias.

### Commits y validación

- `f465a8e55dd2fefc014c8e350fdda4742e4fd783`: módulo de reescritura de recursos.
- `cfe99387c910cb211c3a6ca39bce756ab3b2af16`, `ad74d0224b6199742e2182587339d3bcd7ea2d93`: correcciones de patrones de coincidencia.
- `79a465ba0289e72ff3f589ca9f7be85b51637644`: casos de regresión.
- `0a1517cdad739e78cb6e195408b96d6b9ab9bae2`: integración en el Worker.
- **CI #192 falló** por un error de sintaxis en una expresión regular del archivo de pruebas; corregido en `e3d0c1ca376693357f835de95ea39c535ef64ed8`.
- **CI #193** (run `42771520825`): `completed/success`, con pruebas unitarias, previsualización Node, TypeScript, compilación e invariantes.
- **Cloudflare Workers Builds** `d80d37f6-1453-46c7-8902-96f900445fb8`: `stopped/success` para `e3d0c1c`.
- Staging `opencode-g1-staging` quedó publicado en versión `38279871-8d30-44df-9287-ccf80fdf2687`. Worker productivo inalterado: `1d70eb77-316e-408d-bd14-5f19b171dedf`. Cron vacío, política Cloudflare Access conservada.

**G5 AÚN NO APROBADO.** La validación Android demostró que el primer recorrido tenía un fallo verdadero y la corrección ahora está desplegada, pero no se ha recibido todavía una segunda confirmación del dispositivo real.

### Acción única de retest y avance

Desde Android, el propietario debe recargar la vista previa del mismo proyecto `app-mwabn7ns` en staging y verificar **(a)** que reaparece el fondo oscuro y la tarjeta con estilos, **(b)** que al tocar «Funciona» aparece «Prueba completada». No hace falta solicitar otra generación al modelo.

Si funciona, continuar por los criterios G5 aún no demostrados: revisar archivos, guardar respaldo, restaurar con otro nombre y recargar/reconectar el historial de sesión. Si falla, registrar captura y, de ser posible, los códigos HTTP de CSS/JS desde navegador autenticado, antes de realizar otra corrección. Solo después de superar estas condiciones se puede declarar G5 aprobado y avanzar a G6: plantillas configurables sin arquitectura adicional.
