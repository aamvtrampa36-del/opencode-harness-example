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
