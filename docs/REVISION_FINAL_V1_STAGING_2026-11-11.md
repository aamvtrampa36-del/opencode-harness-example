# OpenCode Cloud V1 — revisión final de staging
Fecha: 11 de noviembre de 2026.

## Dictamen
**V1 bloqueada para el uso completo en staging.** La prueba real detectó dos impedimentos: el shell del agente usa un Container compartido y puede acceder a otros proyectos; el repositorio privado seleccionado no se prepara en Linux, así que el agente no puede ejecutar las pruebas reales del proyecto. La contención temporal desactiva el shell del agente; por tanto tampoco se puede desarrollar ni ejecutar pruebas Linux desde él por ahora. La contención NO constituye aislamiento.

**G9 se cerró históricamente en staging** con la matriz sustitutiva autorizada 12/12, basada en evidencia acumulada; esta revisión posterior halló un defecto que reabre la aptitud de la V1. G8 demostró revisiones reales de ambos repositorios; las PR de prueba las creó el supervisor. G9 demostró una reparación de fixture aislado en el repo OpenCode, no desarrollo autónomo completo en cada proyecto real. No se deshacen ni se vuelven a presentar como pruebas nuevas los resultados anteriores.

## Fuentes, alcance y seguridad
Se leyó íntegro el informe maestro de 21 páginas, se consultaron el plan vigente, actas y pruebas G1–G9, GitHub, Cloudflare y la aplicación staging autenticada. El siguiente paso tras G9 es preparación de publicación controlada; no hay un G10 en el informe. La publicación productiva tiene además bloqueo independiente de datos. Ningún merge, despliegue productivo ni cambio de canon fue autorizado o ejecutado.

## Hallazgos priorizados
| Prioridad | Hallazgo | Estado y evidencia |
| --- | --- | --- |
| Bloqueante | El shell de un proyecto puede acceder a otros. | En la sesión de CDF, `linux` enumeró carpetas y leyó información Git de otro proyecto. La validación del nombre no limita el shell al directorio. Se detuvieron las dos sesiones al detectar el problema. No hay evidencia de modificaciones en otros proyectos. |
| Bloqueante | El repositorio privado seleccionado no está disponible como checkout Linux. | El agente pudo hacer `repo_info`/`repo_read`, pero encontró el proyecto Linux vacío y el clon privado falló por falta de autenticación. No se enviaron credenciales al Container. |
| Contención | El agente no puede ejecutar el shell hasta implementar aislamiento real. | La herramienta ahora rechaza la ejecución; la prueba de integración comprueba que no llama al Container. El aviso aparece en la UI y una llamada real del agente a `pwd` fue rechazada con el mensaje de aislamiento; no hubo salida ni ejecución Linux. Las acciones administrativas existentes no se han certificado como una frontera de aislamiento; producción no incorpora la contención. |
| Corregido | Una conversación Revisar volvía a Desarrollo al recargar. | Modo guardado por sesión/espacio; sesiones desconocidas se abren en Revisar. Comprobado en navegador con recarga y cambio de conversaciones. |
| Corregido | Una tarea en cola podía cambiar el modo/modelo de una tarea aún activa. | Solicitudes serializadas, operaciones aceptadas contabilizadas, cambios de configuración rechazados mientras estén pendientes y pruebas de regresión. |
| Corregido | La UI anunciaba Disponible durante trabajo pendiente. | El estado considera las operaciones aceptadas; en una tarea real se observó Ejecutando y el selector de modo deshabilitado. |
| Corregido | Se mostraban recordatorios internos en el chat. | Se ocultan únicamente los recordatorios sintéticos completos; test automático y verificación en staging. |
| Posterior | Mejoras visuales marginales y costes por tarea exactos. | No bloquean los criterios funcionales; el indicador de OpenRouter es una variación aproximada de cuenta, no un importe exacto por tarea. |

## Evidencia de ejecución y límites
- En staging se seleccionó CDF Cloud: el agente real ejecutó `repo_review`, `repo_read` y `repo_info`; se observó resultado de solo lectura, no escritura autónoma.
- Posteriormente se iniciaron sesiones de desarrollo separadas para CDF Cloud y WorkBench. La sesión CDF llegó a enumerar proyectos ajenos desde Linux; ambas se detuvieron. No se completó desarrollo ni PR de esas tareas. No usar esas sesiones como prueba de aceptación.
- Se han verificado recarga y recuperación de la conversación, modos y estado de trabajo en el navegador de escritorio. Los anteriores G5/G6 cuentan con aceptación Android documentada, pero **los nuevos cambios no se comprobaron aún en Android físico**.
- CI #325 en el commit `f716041fe054b551b7ec1589f0344d747d7e155a`: unidades, preview, TypeScript, build e invariantes aprobados. El test de contención es automatizado y no demuestra una solución de aislamiento real.
- Workers Builds `031e267c-5cb2-490b-b98d-236e53559463` finalizó con éxito para ese SHA; staging versión `0b5c91ac-be35-4271-aa4b-971c51d3eae8`.
- Staging: rama `fix/repeatable-agent-verification-20261108`; [PR #28](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/28) y [PR #31](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/31) draft. #31 incluye la candidata V1 completa por tener base main; revisar incrementalmente desde `90c59b185f5798cf74333cc8a2bac624418d0201`, sin fusionar ambas por separado.
- El tag histórico `g9-v1-rc-20261111` apunta a `ff5c88e7735469864d8264cc93fa56c6a7eaae62` y no incluye las correcciones recientes. Fijar nueva candidata solo después de superar las puertas pendientes.
- Producción permanece en versión `1d70eb77-316e-408d-bd14-5f19b171dedf`. Un push a main activa el despliegue productivo, por lo que no debe fusionarse sin autorización explícita. Los objetos productivos contienen datos, pero no se ha probado un respaldo íntegro ni su recuperación. El respaldo G4 de staging restauró 4 archivos con hashes iguales, limitado a 2 MiB y sin `.git`, secretos, dependencias ni transcript completo.

## Plan cerrado de acciones pendientes
1. **Aislar realmente Linux y conservar datos.** Diseñar e implementar un límite efectivo de proceso y sistema de archivos por proyecto. Mantener accesibles los datos existentes y respaldos; migrar solo con copia verificada y sin sobrescritura. Probar que un comando arbitrario de A no puede leer ni modificar B, ni escapar con rutas relativas, rutas absolutas o enlaces simbólicos. La comprobación del slug y el bloqueo temporal no son suficiente evidencia. Registrar coste e impacto reales.
2. **Preparar el repositorio privado seleccionado en su entorno aislado.** Descargar el código de forma autorizada sin entregar tokens al modelo ni al Container, sin sobrescribir trabajo existente y con procedencia verificable. Debe ser posible ejecutar pruebas sobre el código real y llevar los cambios revisados a una rama `opencode/*`.
3. **Reactivar y validar extremo a extremo.** Retirar la contención solo después de que los tests de aislamiento y preservación pasen. Usar el agente en una tarea pequeña y justificada en cada repositorio CDF y WorkBench: proyecto correcto, rama aislada, cambio, prueba real con salida, revisión del diff y PR borrador; no tocar canon ni producción. Verificar el mismo flujo y el estado de controles en Android o documentar bloqueo concreto.
4. **Cerrar staging y preparar la publicación.** Pasar CI, probar funcionamiento real, documentar el SHA y actualizar este informe. Antes de cualquier decisión productiva, verificar datos reales, copias independientes y restauración en destino aislado; comprobar la reversión de código y la compatibilidad de datos por separado.
5. **Decisión del titular.** Solo después de satisfacer las puertas anteriores presentar candidata exacta, pruebas, respaldo, recuperación y riesgos; solicitar autorización separada para merge y/o publicación. No utilizar una etiqueta Git como respaldo de datos.

## Prompt de continuación
```
@Cloudflare Retoma OpenCode Cloud desde el informe REVISION_FINAL_V1_STAGING_2026-11-11.md y el informe maestro completo. La V1 está bloqueada: el shell del agente compartía el Container entre proyectos y podía acceder a otros; como contención se suspendió su ejecución. Además, el repositorio privado seleccionado no se prepara en el entorno Linux.

Implementa aislamiento efectivo por proyecto y una forma segura de preparar el repositorio privado sin exponer credenciales, preservando los datos y respaldos existentes. Comprueba con pruebas adversariales reales que un proyecto no puede leer ni modificar otro, y que no se pierde trabajo. Retira la contención solo después de verificar esas garantías.

Después ejecuta con el agente una tarea real y aislada en CDF Cloud y otra en WorkBench: cambio justificado, pruebas contra el código real, revisión del diff y PR borrador. Verifica la UI en Android, corrige regresiones y documenta evidencia independiente. Reutiliza los hitos G1–G9 ya aprobados sin repetir pruebas sin motivo; distingue fixture, test automatizado y funcionamiento real.

Actualiza el informe, cierra staging únicamente si se cumplen los criterios y prepara respaldo/restauración de datos antes de proponer la publicación controlada. Trabaja en ramas aisladas; no fusionar, tocar canon ni publicar en producción sin autorización específica. Si necesitas al titular, termina primero el trabajo independiente y pide una sola acción sencilla desde Android.
```


## Avance de reanudación — 11 noviembre 2026

- Se retomó la revisión íntegra y el código desde staging. La contención del shell sigue activa y el Container anterior, sus proyectos y sus respaldos no se han migrado ni borrado.
- Una prueba **real** en staging inició dos Containers identificados por proyecto y usó archivos sintéticos. En la UI se observó «Prueba superada»: el segundo no pudo leer el archivo del primero por ruta directa ni enlace, y las escrituras de prueba en su propia vista no alteraron el primero. Cloudflare listó dos instancias distintas. Prueba en commit `f25b3629f4049161399f87406a759b0fdcbba03f`, CI #327 y build `0bd878c8-95a7-4d82-8b3b-49b10186df32`. Esto demuestra ese ensayo, no que el agente ya esté conectado ni que se haya probado la recuperación.
- [PR #32](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/32) continúa en borrador, sin merge. Se preparó un importador de archivos autenticado en Worker, que fija el commit y entrega únicamente los bytes al Container. La extracción rechaza enlaces y sobrescritura; prueba local y CI #329 aprobadas para `5baad969717cfb3473eae8f791847c5a53f0cbdd`. La importación real y su integración están pendientes.
- La V1 continúa **bloqueada**. No retirar la contención hasta completar importación real, enrutamiento aislado, persistencia/restauración y pruebas integrales; no confundir esta prueba con el cierre.

- **Importación real verificada en staging:** el importador cargó en Containers de prueba separados CDF Cloud (204 archivos, commit `f5967fe84e22c2e629ae60a8aedabcceff016735`) y WorkBench (308 archivos, commit `0a7b0e8109d288481908d920b85e33eb28c105a2`). Ambos SHA coinciden con GitHub; las credenciales permanecen en Worker. Las salidas no equivalen a una tarea real del agente ni prueban respaldo.
- Se ha preparado en PR #32 la conexión de proyectos a Containers separados y restauración entre ellos, todavía en pruebas. **El agente continúa pausado en staging** hasta verificar esa integración y la recuperación; los datos y el Container anteriores se conservan.

- **Recuperación aislada real:** staging probó un respaldo sintético y lo restauró en otro Container con el contenido original intacto; también se restauró el respaldo existente `app-mwabn7ns` como `qa-legacy-20261111`, sin sobrescribir el original. La copia anterior y sus respaldos siguen listados. La prueba usa código `24900da7b65936ff228f9b0a9232cddd5958f78d` y no demuestra recuperación de sesiones ni de datos productivos.
- La candidata `acbc2b0fc03fedea1871da50df4459245eaff5df` conecta el agente a Containers por proyecto y cambia de conversación al seleccionar/restaurar proyectos; CI #339 aprobada. Se prepara su despliegue en staging para probar tareas reales. La importación de fuente y la restauración se fijan a la autorización y no entregan tokens al Container.


## Verificación y contención — 11 noviembre 2026, 12:26 Curitiba

- Cloudflare confirmó que staging había desplegado el commit `acbc2b0fc03fedea1871da50df4459245eaff5df` como versión `f3b17b4d-4c1b-48e1-83f5-269fa09a7d6b` (build `f32f9abb-3845-442d-b8eb-7b91962e3149`). El código de esa candidata dirige el shell por proyecto, pero ya no contiene el rechazo temporal anterior. No se verificó aquí la prueba integral de aislamiento del agente, persistencia y recuperación que autorizaría retirarlo.
- Se restableció en staging, sin forzar comprobaciones de despliegue, la versión de contención `0b5c91ac-be35-4271-aa4b-971c51d3eae8`, documentada anteriormente con rechazo real del shell. Deployment `6ebb9ada-9654-4009-b9e6-0f5d069f5ab2`; Cloudflare confirmó 100 % de tráfico asignado. No se ha repetido la prueba desde la interfaz autenticada; no afirmar rechazo en vivo comprobado en esta intervención.
- La candidata de aislamiento sigue disponible en PR #32, commit `acbc2b0fc03fedea1871da50df4459245eaff5df`; CI para ese commit figura aprobada. Los ensayos de importación y recuperación reseñados arriba son evidencia histórica, no nuevas pruebas de esta intervención.
- Producción sigue en la versión `1d70eb77-316e-408d-bd14-5f19b171dedf`. No se alteraron datos, repositorios privados, backups ni canon en esta intervención. No se validó recuperación de datos de producción. No se ejecutaron las dos tareas reales, pruebas Android ni revisión integral del aislamiento. Staging continúa bloqueado y no se declara listo para publicación.
- Precaución operativa: el trigger automático de staging sigue asociado a `fix/repeatable-agent-verification-20261108`; un nuevo push a esa rama podría volver a desplegar código sin la contención. Verificar el despliegue activo antes de usar el agente.

- Después del restablecimiento, el navegador mostró el aviso «Ejecución Linux pausada temporalmente: falta aislar los proyectos». La pantalla estaba conectando y el cuadro de mensaje deshabilitado; no se realizó una nueva llamada del agente al shell. La observación confirma el aviso visual, no una prueba funcional completa ni Android físico.


## Revisión adicional y corrección candidata — 11 noviembre 2026

**Dictamen: BLOQUEADA.** G9 conserva su aprobación histórica dentro de su alcance; la debilidad de aislamiento descubierta posteriormente impide aceptar la V1 actual. La siguiente etapa es publicación controlada después de cerrar estas garantías y validar respaldo y restauración productivos; no se inventa un hito G10.

### Evidencia nueva de esta intervención

- Cloudflare confirma staging en versión de contención `0b5c91ac-be35-4271-aa4b-971c51d3eae8`, deployment `6ebb9ada-9654-4009-b9e6-0f5d069f5ab2`. La interfaz mostró de nuevo el aviso de pausa, pero no se efectuó una nueva llamada Linux real.
- Una solicitud HTTP sin sesión fue redirigida a Cloudflare Access y existe una política de acceso restringida al propietario; esto verifica ese control de entrada para la ruta probada, no todos los vectores de acceso.
- PR #32 sigue borrador con cabeza `acbc2b0fc03fedea1871da50df4459245eaff5df`; CI del commit completada con éxito.
- Nueva [PR #33](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/33), borrador hacia la rama de #32, cabeza `3af5fd5a1b67e2933da49c7079ad1a1f0d3965de`: el registro real de la herramienta del agente rechaza Linux antes de invocar al ejecutor, mantiene la comprobación de alcance y muestra aviso de pausa en la interfaz. Revisión independiente del diff: tres archivos. No está desplegada. El rechazo cubre la herramienta del agente; los caminos administrativos no se consideran aislados por esta prueba.
- La prueba de regresión se observó fallar sobre la candidata original y pasar después. En el checkout local: 132 pruebas, typecheck, build, preview e invariantes aprobados; el build informa paquetes grandes. CI remoto de #33 no se ha verificado. Tests automatizados no certifican separación real de Containers.
- El navegador autenticado abrió staging y mostró una conversación histórica que confirma la lectura de carpetas ajenas desde WorkBench y el fallo de clon privado. Se abrió una nueva conversación para inspección; no se envió ninguna tarea ni se ejecutó Linux en esta intervención. Android físico no fue probado.
- Producción permanece en versión `1d70eb77-316e-408d-bd14-5f19b171dedf`. No hubo fusiones, despliegue productivo, modificación de canon ni operaciones sobre datos o backups en esta intervención.

### Clasificación y acciones pendientes

1. **Bloqueante — aislamiento real y preservación:** desplegar una candidata de staging con la pausa activa, sin alterar datos existentes. Comprobar en Containers reales A→B y B→A lectura y escritura, rutas absolutas y relativas, enlaces, cambios de proyecto/sesión, rutas administrativas y conservación/restauración sin sobrescritura. Documentar hashes y resultados independientes. La prueba sintética anterior no demuestra todos esos caminos.
2. **Bloqueante — preparación y trabajo real:** comprobar la importación de la revisión exacta en el proyecto seleccionado y el comportamiento ante archivos preexistentes e interrupción, sin credenciales en Linux. El archivo importado no incluye `.git`; comprobar si las pruebas concretas lo necesitan. Tras cumplir el punto 1, retirar la pausa en una candidata controlada y ejecutar una tarea real pequeña por cada repositorio CDF Cloud y WorkBench: salida de pruebas, diff y PR draft verificables.
3. **Necesario para uso — Android y recuperación de sesión:** verificar la interfaz y el flujo actualizado en Android, especialmente selección, aviso, ejecución, errores, resultados y recarga. Probar recuperación del trabajo tras interrupción sin sobrescritura; documentar cobertura y límites.
4. **Cierre:** CI y build de la candidata final, revisión de su SHA, informe actualizado y ningún P0 pendiente. Solo entonces declarar staging apto.
5. **Publicación controlada posterior:** inventario de datos productivos, copias independientes, restauración real en destino aislado, compatibilidad y reversión de código y datos por separado. Pedir autorización independiente para merge/publicación.
6. **Posterior:** optimización de tamaño del bundle y medición exacta por tarea, salvo que se demuestre impacto que bloquee el uso.

### Prompt de continuación

```
@Cloudflare Retoma OpenCode Cloud desde docs/REVISION_FINAL_V1_STAGING_2026-11-11.md en la rama ops/staging-containment-review-20261111 y el informe maestro de 21 páginas. G9 fue aprobado históricamente, pero la V1 permanece bloqueada por la revisión posterior del aislamiento. Staging está en la versión de contención 0b5c91ac-be35-4271-aa4b-971c51d3eae8. Revisa las PR #32 y #33 y verifica sus SHA y el estado real antes de actuar.

Mantén el shell del agente pausado hasta demostrar en staging, con pruebas reales y bidireccionales de lectura/escritura, rutas absolutas, relativas y enlaces, que los proyectos están aislados y que los datos y respaldos existentes se conservan y restauran sin sobrescritura. Usa la candidata con contención de #33 en una rama aislada; no confundas CI con pruebas reales. Comprueba la importación de ambos repositorios privados sin exponer credenciales y reconoce que el archivo importado no incluye .git.

Solo después de superar esas garantías, habilita el agente en staging y realiza una tarea justificada en CDF Cloud y otra en WorkBench, cada una con código real, pruebas ejecutadas, revisión independiente del diff y PR borrador. Verifica los flujos nuevos en Android y la recuperación tras interrupción. Reutiliza G1–G9 aprobados cuando sigan siendo válidos.

Actualiza este informe con SHA, evidencia y pendientes; cierra staging solo si se cumplen todos los criterios. Después prepara copias y restauración verificables de los datos productivos y un plan de reversión, sin fusionar, modificar canon ni publicar en producción. Solicita autorización separada para merge y publicación; si necesitas ayuda, pide una única acción sencilla en Android.
```


## Actualización posterior — validación aislada del 11 de noviembre

**Dictamen vigente: V1 todavía bloqueada para cierre de staging.** Esta actualización prevalece sobre el dictamen anterior respecto a la pausa: tras las pruebas descritas, el shell se habilitó para validación en staging. No se ha cerrado la V1 ni autorizado producción.

### Candidatas y evidencias

- PR #32: cabeza observada acbc2b0; PR #33: cabeza observada 3af5fd5, mantenía el shell pausado. Ambas permanecen sin fusionar.
- PR #34, rama `fix/bidirectional-isolation-probe-20261111`, commit `fbbd4539695f942584577be84f0f109b3016e5e7`: prueba extendida en ambos sentidos con rutas absolutas, relativas y enlaces simbólicos, intentos de lectura y escritura y comprobación de originales. Despliegue staging `626fb58c-9047-4317-a067-d313e50b7470`, build `53bbd11d-06cf-4bef-9922-7ae8cafc9595`, con pausa activa. La interfaz informó prueba superada; Cloudflare mostró dos instancias distintas project-v1:isocheck-a-37f5d0cbd93d y project-v1:isocheck-b-37f5d0cbd93d. La evidencia cubre estos ensayos sintéticos, no todos los posibles canales o ataques.
- Respaldo sintético: la interfaz informó respaldo y restauración entre Containers distintos. Se restauró el respaldo previo app-mwabn7ns a qa-preservacion-20261111, nombre nuevo; permanecieron listados el proyecto y respaldo originales y se inspeccionaron archivos de la copia. La interfaz impidió seleccionar un destino ya existente; las pruebas locales del servidor cubren rechazo de destino existente, pero no se hizo aquí una llamada directa en vivo para comprobar esa negativa del servidor. El respaldo tiene límite de 2 MiB y no incluye .git, secretos, dependencias ni necesariamente la conversación completa. No demuestra recuperación de datos productivos.
- Importaciones privadas: CDF Cloud commit `f5967fe84e22c2e629ae60a8aedabcceff016735` (204 archivos) y WorkBench `0a7b0e8109d288481908d920b85e33eb28c105a2` (308 archivos); importaciones de código fuente fijado, sin .git. El token no se introdujo en comandos del agente ni se expuso en la salida observada. El primer diagnóstico antes de enviar mensaje falló por sesión aún no vinculada pese al selector visual; después de enviar mensaje funcionó. Pendiente corregir la confusión del botón.
- Hallazgo adicional: la lectura genérica del espacio compartido no aplicaba el control de proyecto. Una prueba de integración local demostró el acceso al backend sin guardia; no se observó exfiltración ni se ha demostrado que hubiera datos accesibles. PR #35, `fix/scope-shared-workspace-20261111`, commit `e3673143961e1126a904ccee0e6aed755fcffe2c`, bloquea las herramientas genéricas para sesiones de proyecto. La prueba falló antes del arreglo y pasó después; 133 pruebas locales, typecheck y build correctos. En staging `1b91c6c4-8b28-48ee-a5a1-26d6ad3f7e83`, build `5f3d8373-1f5d-4752-99c5-f406886115eb`, una llamada real read fue rechazada. Una llamada inspect_linux dirigida a un proyecto ajeno también fue rechazada.
- Tras esa evidencia se retiró la pausa del shell en staging para tareas controladas: PR #36, `fix/staging-isolated-agent-validation-20261111`, commit `5ae148e3452602fb0a53f9cfaf228e85795928f2`; versión desplegada `d6411197-285c-4c2b-9857-299a5fc2b77c`, build `74b47d4b-811d-426d-abfc-0a08ca7ddee0`, despliegue `1f87076f-0040-46c6-a0fb-7ae30c8efe75`. 133 pruebas locales, typecheck y build pasaron. Se conserva la versión con pausa para reversión. Los PR #34–#36 son dependientes; no fusionar sin autorización.

### Tareas reales del agente

- WorkBench [PR borrador #38](https://github.com/aamvtrampa36-del/CDF-WorkBench-/pull/38), commit `bd553f241cb801208d3c450865a24bc42f210193`, base `0a7b0e8109d288481908d920b85e33eb28c105a2`. Agrega una comprobación de traversal con separadores Windows al test real del runner. `node --test test/runner.test.mjs`: 8/8, código 0. Revisión independiente de GitHub: un archivo, +1/−0; SHA-256 del archivo probado y remoto `361dc5c461b6c8e1cce3047aaee259c06a83247e3620e877a319c44481f3ed88`. [CI](https://github.com/aamvtrampa36-del/CDF-WorkBench-/actions/runs/43054250140) éxito.
- CDF Cloud [PR borrador #161](https://github.com/aamvtrampa36-del/cdf-cloud-engine/pull/161), commit `36fb4e1f4ed750e7a6b67c7b792571a6800d7453`, base `f5967fe84e22c2e629ae60a8aedabcceff016735`. Pruebas adicionales para revisiones no enteras, cadenas y enteros inseguros; no es reparación de un defecto funcional. `node --test test/core.test.mjs`: 8/8, código 0. Revisión independiente de GitHub: un archivo de pruebas, +7/−0; blob remoto `b293a88f65b9e951a9ee8ca7c2af62ce7ad3639c` coincide con el archivo local probado (SHA-256 `4543a480bc9df04ecb475ca2262d917e640a2c02c5a537e995c271f35be017e0`). [CI](https://github.com/aamvtrampa36-del/cdf-cloud-engine/actions/runs/43054768479) terminó correctamente (test-and-package: success). El Container carece de python3; la suite integral Python de CDF no se ejecutó en ese Container.
- Tras recargar el navegador se recuperaron la sesión CDF, mensajes y resultados. No se probó recuperación tras interrupción de una ejecución en curso ni tras caída del Container. La comprobación fue en navegador de escritorio; no se ha demostrado aceptación en Android físico.

### Pendientes ordenados y criterio de cierre

1. Corregir la confusión del diagnóstico de importación antes de vincular la sesión y verificarla en staging.
2. Demostrar conservación y recuperación de un trabajo sintético tras interrupción real en curso y recuperación de Container, sin sobrescribir datos existentes. Registrar resultados y límites.
3. Comprobar el flujo completo de la interfaz en Android, incluidos selección de proyecto, envío, progreso, revisión, errores y recuperación; corregir regresiones y conservar evidencia.
4. Verificar CI final de los PR, revisar los cambios de seguridad y consolidar la evidencia sobre la versión exacta candidata. Solo cerrar staging cuando todos los criterios obligatorios estén satisfechos.
5. Después del cierre, inventariar datos productivos y preparar una copia consistente, restauración aislada con verificación de integridad y plan de reversión documentado; aún no se ha realizado ni demostrado. Publicación y fusiones requieren autorización específica.

No se fusionaron PR, modificó canon ni publicó producción.


## Actualización de recuperación y diagnóstico — 11 de noviembre de 2026, 13:20 Curitiba

**Estado: staging sigue abierto y la V1 no se cierra.** No se fusionó nada, no se modificó canon ni se tocó producción.

### Corrección candidata del diagnóstico de importación

- La PR borrador #37 está abierta y sin fusionar. Base: fix/staging-isolated-agent-validation-20261111 (#36); cabeza: fix/repository-import-prebind-20261111, commit c6b23c7180916732d6a3e367fc9d0ee832c9d0f2. Incluye 4 archivos (+42/−3).
- La revisión del diff confirma que el cliente envía el repositorio seleccionado antes del primer mensaje; el Worker lo valida contra la lista autorizada y lo enlaza al alcance inmutable de la sesión antes de obtener el repositorio y preparar el Container. El token permanece en el Worker. Las pruebas unitarias añadidas cubren las selecciones autorizadas de CDF/WorkBench y las selecciones ausentes o no autorizadas.
- Límite: no se encontraron ejecuciones CI ni checks en el SHA de #37. La corrección todavía no está desplegada ni probada en staging. El endpoint Cloudflare Workers Builds consultado no tiene una configuración ni triggers registrados para opencode-g1-staging; no se hizo un despliegue manual inseguro. Por tanto, el diagnóstico anterior al primer mensaje sigue pendiente de aceptación real, aunque el arreglo ya está implementado en la rama candidata.
- El despliegue activo continúa en el commit de la candidata #36, versión d6411197-285c-4c2b-9857-299a5fc2b77c, deployment 1f87076f-0040-46c6-a0fb-7ae30c8efe75, 100 % del tráfico. La prueba de aislamiento y las dos tareas reales previas siguen siendo evidencia de su alcance documentado, no una prueba de #37.

### Interrupción y recuperación sintética

- En la sesión aislada repo-cdf-cloud-engine se ejecutó una tarea controlada que escribió solo en /tmp/opencode-v1-interruption-20261111/marker.txt y luego esperaba antes de añadir una línea final. Se pulsó Detener; el agente marcó la ejecución Linux como interrumpida y la sesión volvió a Disponible.
- Al reanudar la lectura, Linux recuperó exactamente «checkpoint-qa-7c19d2» y el SHA-256 228cd95c343803ff0760cc39e5cd5ef43f00536e573f5c137f5415e7123f75ce. No apareció la línea «completed». Cloudflare mostró el Container del proyecto corriendo de nuevo tras su estado detenido, con el mismo identificador lógico y started_at 2026-11-11T16:20:13.582Z. El marcador sobrevivió la interrupción y el arranque posterior; no se escribió ni leyó un archivo real del repositorio durante esa prueba.
- Se intentó comprobar el proceso con pgrep, pero el binario no está instalado en la imagen. La ejecución original retornó como interrumpida y el marcador no contiene la escritura final; el informe no presenta pgrep como comprobación exitosa.
- En una verificación aparte de la importación ya desplegada, tras la parada por inactividad el archivo de código probado mantuvo su SHA-256 4543a480bc9df04ecb475ca2262d917e640a2c02c5a537e995c271f35be017e0 y .git siguió ausente. La evidencia de backing/restauración sintética previa sigue vigente; no se modificaron los proyectos o backups existentes en esta intervención.

### Android, dictamen y acciones pendientes

No había dispositivo Android ni emulador ADB disponible en este entorno. La interfaz real se observó en navegador de escritorio; no afirmo una aceptación Android. Tampoco se verificó el nuevo flujo en #37 porque no está desplegado.

1. Desplegar de forma controlada la candidata #37 en staging y ejecutar CI/build en el SHA exacto; luego repetir antes del primer mensaje el diagnóstico de importación en CDF Cloud y WorkBench, verificando código fuente, conteo/hash, ausencia de .git y que ninguna credencial llegue al Container.
2. Completar una comprobación Android de la versión candidata: selección del proyecto, importación antes del primer mensaje, envío, progreso, resultado, revisión del diff y recuperación. Este entorno no expone Android; se requiere una comprobación desde tu teléfono una vez desplegada la candidata.
3. Revisar el resultado y cerrar staging solo si pasan todos los criterios, sin bloqueantes ni errores de seguridad. El dictamen se mantiene BLOQUEADO.
4. Solo después de cierre, inventariar datos productivos, verificar una copia/restauración aislada y documentar reversión de aplicación y datos. Nada de ello se ha ejecutado.

