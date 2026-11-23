# OpenCode Cloud — Segunda ronda F0-C10: diez encargos de continuidad y T11

**Uso:** pegar cada bloque T01–T10 en el mismo chat que realizó esa especialidad; T11 se reserva para este chat maestro una vez terminada la segunda ronda. No equivale a iniciar Remote en paralelo. **Estado inicial:** #126 candidata, no publicada, COMPLETE PASS pendiente.

---

# PROMPT R2-T01 — Diagnóstico del OOM mediante perfiles por fase

**Meta de este chat:** preparar una corrección comprobable de T01 para que F0-C10 termine con diez trabajos reales simultáneos y diez resultados íntegros. **Tu punto de partida especial es la PR #116**, ahora incorporada o referenciada en #126.

## Problema focal y trabajo técnico

Tu bloqueo abierto: el ensayo #90 produjo seis resets `exceededMemory` y 0/10 resultados, pero el último RPC `startSupervisedTask` no identifica el objeto que provocó la presión. La PR #116 ya trazó eventos y demostró, en sintético, la memoria retenida por `history()` antes de recortar. #106/#114 contienen parte del problema, todavía no en runtime. **No dupliques las guardas existentes.**

1. Determina puntos medibles del ciclo `admit → sessions.create/fork → setModel → submit → status → alarm → recover`, incluyendo SDK/Harness, historial y serialización MCP; usa Cloudflare Observability/profiling en lectura y corrige sesgos por isolate compartido.
2. Diseña instrumentación de contadores/bytes y perfiles de memoria con redacción de PII y cardinalidad acotada, y fixtures que reproduzcan presión por fase sin tocar DO reales. Contrasta Heap, RSS de Container y isolate Worker como métricas diferentes.
3. Implementa instrumentación **aislada o con bandera desactivada por defecto** si el repositorio lo permite; no conviertas logging en una nueva fuente de OOM.
4. Compara con OpenHands/DeepSeek y técnicas de workerd, con commits y licencias exactos.
5. Entrega matriz «hipótesis → evidencia → prueba falsable» y una recomendación cuantitativa para T02/T03; no declares causalidad única si falta un perfil live.

**Superficie primaria:** fixtures de observabilidad y `docs/f0-c10/01_DIAGNOSTICO.md`; si necesitas `src/server.ts`, crea hunk acotado contra #126 y documenta dependencias T02/T05.

## Contexto y continuidad

Estás en **el mismo chat** que investigó esta área en la primera ronda. Relee tu propia entrega previa, pero contrástala con el repositorio `aamvtrampa36-del/opencode-harness-example`, el issue #90, el plan `docs/f0-c10/F0_C10_PLAN_INTEGRAL.md` y `docs/f0-c10/00_COORDINACION.md`. La primera integración es la PR #126 (`f0-c10/t11-integration-20261122`, HEAD histórico `1268ba22f26330d619b046fcf551ca846cb69d0f`; base histórica `11161dd6f2c4b5237a2da59d7275ff693e0afdbe`). **Revalida HEAD, PR, CI y Staging antes de confiar en esos datos.** No repitas trabajo ya integrado: contribuye con un defecto pendiente comprobable y su reparación.

## Lote autorizado y seguridad

Autorizo investigación pública, lecturas de GitHub, Cloudflare y OpenCode Remote, pruebas offline/sintéticas, desarrollo en **rama R2 propia** basada en el SHA verificado, commits únicamente de tu área, documentación propia y PR **draft** hacia la base Stage apropiada. Permito ejecutar CI correspondiente y verificar el resultado exacto de tu HEAD. Trabaja dentro del lote sin microaprobaciones; si una etapa resulta bloqueada, completa las independientes. **No** modifiques la rama #126, `main`, Producción, Workers publicados, secretos, Access, bindings, migraciones, recursos persistentes ni ramas ajenas; no fusionar, desplegar, borrar ni iniciar carga múltiple real. Prefiere que OpenCode programe, pero solo usa acciones Remote con efectos cuando el alcance, el lease atómico de Staging, el preflight y el corte **efectivo** de gasto estén comprobados. Sin ellos, trabaja offline y etiqueta la autoría real de ChatGPT; no simules ejecución de OpenCode. No llames MCP dinámico asumiendo que es lectura; no canceles tareas ajenas ni reintentes operaciones ambiguas.

## Entrega y cierre

Implementa el cambio mínimo útil mediante OpenCode cuando sea seguro, o directamente en rama permitida con autoría correcta; contrasta con soluciones abiertas (repo, archivo, commit, licencia) y ejecuta RED→GREEN, pruebas negativas, Bun/typecheck/build/invariantes pertinentes y CI del HEAD. Registra comandos, exit codes, IDs reales, costes observados/desconocidos, límites, conflicto con #126 y validaciones pendientes. Después de las pruebas actualiza **tu informe canónico** `01_DIAGNOSTICO.md` en `docs/f0-c10/` dentro de tu rama; publica evidencia y PR draft en GitHub. Deposita una copia pequeña del informe/fixtures no sensibles en Biblioteca personal **solo si** la herramienta y permisos están disponibles y verificas el recibo; en caso contrario entrega archivos descargables, sin afirmar subida. No sobreescribas el trabajo de otro especialista. `PASS` individual ≠ COMPLETE PASS F0-C10. Cierra con `RESULTADO | EVIDENCIA | BLOQUEANTE | PRÓXIMA ACCIÓN`, enlaces, SHAs y actor real, sin pedir continuidad rutinaria.


---

# PROMPT R2-T02 — Residencia del Harness y aislamiento real

**Meta de este chat:** preparar una corrección comprobable de T02 para que F0-C10 termine con diez trabajos reales simultáneos y diez resultados íntegros. **Tu punto de partida especial es la PR #115**, ahora incorporada o referenciada en #126.

## Problema focal y trabajo técnico

Tu evidencia anterior: un solo `OpenCodeAgent.getByName("opencode-supervisor-v1")` concentra el supervisor y Harness; los Containers Linux se asignan por proyecto, pero múltiples Durable Objects pueden compartir isolate. PR #115 hizo benchmark sintético, **no** demostró el límite real.

1. Traza referencias fuertes del Harness, cachés, sesiones, sockets, conexiones, logs, handles e inicialización en la versión fijada del SDK. Identifica cómo se liberan al finalizar/cancelar/reiniciar.
2. Mide o prepara benchmark ejecutable en workerd/local DO que contraste 1,2,4,10 sesiones sintéticas, retención tras cierre y consumo base por sesión, con límites explícitos de que no es cloud live.
3. Compara reparación mínima por liberación/límites vs coordinador ligero + ejecutores aislados; documenta invariantes de estado, costes, compatibilidad MCP, migraciones y rollback.
4. Propón cambio arquitectónico solo si los datos descartan el parche mínimo; si puedes demostrar fuga en tests, repara con un PR focalizado que no cambie migraciones efectivas.
5. Coordina interfaz con T01 para medición y con T03 para admisión. No presupongas que diez nombres de DO son diez heaps físicamente aislados.

**Superficie primaria:** prototipos/banco de memoria + `docs/f0-c10/02_DURABLE_OBJECTS.md`; sin migrar ni desplegar.

## Contexto y continuidad

Estás en **el mismo chat** que investigó esta área en la primera ronda. Relee tu propia entrega previa, pero contrástala con el repositorio `aamvtrampa36-del/opencode-harness-example`, el issue #90, el plan `docs/f0-c10/F0_C10_PLAN_INTEGRAL.md` y `docs/f0-c10/00_COORDINACION.md`. La primera integración es la PR #126 (`f0-c10/t11-integration-20261122`, HEAD histórico `1268ba22f26330d619b046fcf551ca846cb69d0f`; base histórica `11161dd6f2c4b5237a2da59d7275ff693e0afdbe`). **Revalida HEAD, PR, CI y Staging antes de confiar en esos datos.** No repitas trabajo ya integrado: contribuye con un defecto pendiente comprobable y su reparación.

## Lote autorizado y seguridad

Autorizo investigación pública, lecturas de GitHub, Cloudflare y OpenCode Remote, pruebas offline/sintéticas, desarrollo en **rama R2 propia** basada en el SHA verificado, commits únicamente de tu área, documentación propia y PR **draft** hacia la base Stage apropiada. Permito ejecutar CI correspondiente y verificar el resultado exacto de tu HEAD. Trabaja dentro del lote sin microaprobaciones; si una etapa resulta bloqueada, completa las independientes. **No** modifiques la rama #126, `main`, Producción, Workers publicados, secretos, Access, bindings, migraciones, recursos persistentes ni ramas ajenas; no fusionar, desplegar, borrar ni iniciar carga múltiple real. Prefiere que OpenCode programe, pero solo usa acciones Remote con efectos cuando el alcance, el lease atómico de Staging, el preflight y el corte **efectivo** de gasto estén comprobados. Sin ellos, trabaja offline y etiqueta la autoría real de ChatGPT; no simules ejecución de OpenCode. No llames MCP dinámico asumiendo que es lectura; no canceles tareas ajenas ni reintentes operaciones ambiguas.

## Entrega y cierre

Implementa el cambio mínimo útil mediante OpenCode cuando sea seguro, o directamente en rama permitida con autoría correcta; contrasta con soluciones abiertas (repo, archivo, commit, licencia) y ejecuta RED→GREEN, pruebas negativas, Bun/typecheck/build/invariantes pertinentes y CI del HEAD. Registra comandos, exit codes, IDs reales, costes observados/desconocidos, límites, conflicto con #126 y validaciones pendientes. Después de las pruebas actualiza **tu informe canónico** `02_DURABLE_OBJECTS.md` en `docs/f0-c10/` dentro de tu rama; publica evidencia y PR draft en GitHub. Deposita una copia pequeña del informe/fixtures no sensibles en Biblioteca personal **solo si** la herramienta y permisos están disponibles y verificas el recibo; en caso contrario entrega archivos descargables, sin afirmar subida. No sobreescribas el trabajo de otro especialista. `PASS` individual ≠ COMPLETE PASS F0-C10. Cierra con `RESULTADO | EVIDENCIA | BLOQUEANTE | PRÓXIMA ACCIÓN`, enlaces, SHAs y actor real, sin pedir continuidad rutinaria.


---

# PROMPT R2-T03 — Admisión durable con capacidad, fencing e idempotencia

**Meta de este chat:** preparar una corrección comprobable de T03 para que F0-C10 termine con diez trabajos reales simultáneos y diez resultados íntegros. **Tu punto de partida especial es la PR #125**, ahora incorporada o referenciada en #126.

## Problema focal y trabajo técnico

PR #125 dejó 13 tests sintéticos verdes y dos RED deliberados; **ningún scheduler durable de runtime quedó instalado**. El lock por `requestId` no limita el coste global ni prueba exclusión de diez inicios diferentes. Tu tarea es cerrar esa brecha sin sustituir el objetivo de diez activos por una cola de dos.

1. Fija un contrato de admisión `requestId + digest(payload)` con journal transaccional, recibos atómicos, capacidad visible, tokens de fencing y rechazo determinista ante payload diferente. Distingue lease de ejecución Remote del lease GitHub de T08.
2. Diseña y, si es posible, implementa un gate durable mínimo en el supervisor que evite carreras de inicio y los resultados `not_found` de origen propio; mantén tests RED de dos solicitantes y recuperación tras pérdida de respuesta.
3. Alinea explícitamente con T04 los estados `preparing/queued/running/unknown/cancelled` y ownership de la creación de sesión para no duplicar journals; coordina T07 para rate/cost gates, sin segundo scheduler.
4. Comprueba FIFO/fairness, fail-closed, expiración y fencing; demuestra que un TTL vencido no permite un segundo efecto persistente.
5. El producto final debe admitir progresivamente **diez simultáneos** cuando los recursos lo soporten, no prometerlo por usar `maxConcurrent=10`.

**Superficie primaria:** módulo y tests de admisión + `docs/f0-c10/03_CONCURRENCIA.md`; cambios a `src/server.ts` únicamente con hunks independientes de T04/T05.

## Contexto y continuidad

Estás en **el mismo chat** que investigó esta área en la primera ronda. Relee tu propia entrega previa, pero contrástala con el repositorio `aamvtrampa36-del/opencode-harness-example`, el issue #90, el plan `docs/f0-c10/F0_C10_PLAN_INTEGRAL.md` y `docs/f0-c10/00_COORDINACION.md`. La primera integración es la PR #126 (`f0-c10/t11-integration-20261122`, HEAD histórico `1268ba22f26330d619b046fcf551ca846cb69d0f`; base histórica `11161dd6f2c4b5237a2da59d7275ff693e0afdbe`). **Revalida HEAD, PR, CI y Staging antes de confiar en esos datos.** No repitas trabajo ya integrado: contribuye con un defecto pendiente comprobable y su reparación.

## Lote autorizado y seguridad

Autorizo investigación pública, lecturas de GitHub, Cloudflare y OpenCode Remote, pruebas offline/sintéticas, desarrollo en **rama R2 propia** basada en el SHA verificado, commits únicamente de tu área, documentación propia y PR **draft** hacia la base Stage apropiada. Permito ejecutar CI correspondiente y verificar el resultado exacto de tu HEAD. Trabaja dentro del lote sin microaprobaciones; si una etapa resulta bloqueada, completa las independientes. **No** modifiques la rama #126, `main`, Producción, Workers publicados, secretos, Access, bindings, migraciones, recursos persistentes ni ramas ajenas; no fusionar, desplegar, borrar ni iniciar carga múltiple real. Prefiere que OpenCode programe, pero solo usa acciones Remote con efectos cuando el alcance, el lease atómico de Staging, el preflight y el corte **efectivo** de gasto estén comprobados. Sin ellos, trabaja offline y etiqueta la autoría real de ChatGPT; no simules ejecución de OpenCode. No llames MCP dinámico asumiendo que es lectura; no canceles tareas ajenas ni reintentes operaciones ambiguas.

## Entrega y cierre

Implementa el cambio mínimo útil mediante OpenCode cuando sea seguro, o directamente en rama permitida con autoría correcta; contrasta con soluciones abiertas (repo, archivo, commit, licencia) y ejecuta RED→GREEN, pruebas negativas, Bun/typecheck/build/invariantes pertinentes y CI del HEAD. Registra comandos, exit codes, IDs reales, costes observados/desconocidos, límites, conflicto con #126 y validaciones pendientes. Después de las pruebas actualiza **tu informe canónico** `03_CONCURRENCIA.md` en `docs/f0-c10/` dentro de tu rama; publica evidencia y PR draft en GitHub. Deposita una copia pequeña del informe/fixtures no sensibles en Biblioteca personal **solo si** la herramienta y permisos están disponibles y verificas el recibo; en caso contrario entrega archivos descargables, sin afirmar subida. No sobreescribas el trabajo de otro especialista. `PASS` individual ≠ COMPLETE PASS F0-C10. Cierra con `RESULTADO | EVIDENCIA | BLOQUEANTE | PRÓXIMA ACCIÓN`, enlaces, SHAs y actor real, sin pedir continuidad rutinaria.


---

# PROMPT R2-T04 — Reconciliar sesiones creadas sin recibo y cancelaciones

**Meta de este chat:** preparar una corrección comprobable de T04 para que F0-C10 termine con diez trabajos reales simultáneos y diez resultados íntegros. **Tu punto de partida especial es la PR #120**, ahora incorporada o referenciada en #126.

## Problema focal y trabajo técnico

PR #120 introdujo journal `sessionCreationAttempted` y rechazo conservador de duplicaciones; CI pasó, pero sigue abierto un caso esencial: `sessions.create/fork` puede tener éxito y perder la respuesta, dejando una sesión sin `sessionId` recuperable. Los IDs históricos #90 `a642be2611220007` y `a642be2611220009` siguen como `unknown/not_found` según T11; no alteres sus registros.

1. Inspecciona si el SDK permite idempotency key del llamador, listar/fijar identidad o vincular un marcador durable antes de crear; no supongas que una sesión puede recuperarse si el SDK no ofrece esa propiedad.
2. Construye fixture DO/SQLite descartable que inyecte interrupciones inmediatamente antes/después de crear sesión, persistir identidad, ejecutar `submit`, cancelar y recibir operaciones.
3. Define protocolo de reconciliación acotado. Cuando no sea posible identificar el efecto, conserva `unknown` con razón/operación y no repitas creación.
4. Implementa el menor cambio probado; carrera `continue` vs `cancel` con CAS/journal y test de dos aspirantes. No hacer migraciones de datos activos.
5. Acuerda con T03 transición y fencing, y con T05 formato del recibo de Remote sin falsos `passed:true`.

**Superficie primaria:** `src/supervisor-control.ts`, tests recovery y `docs/f0-c10/04_RECUPERACION.md`; `src/server.ts` se modifica solo en tu rama y con contrato claro.

## Contexto y continuidad

Estás en **el mismo chat** que investigó esta área en la primera ronda. Relee tu propia entrega previa, pero contrástala con el repositorio `aamvtrampa36-del/opencode-harness-example`, el issue #90, el plan `docs/f0-c10/F0_C10_PLAN_INTEGRAL.md` y `docs/f0-c10/00_COORDINACION.md`. La primera integración es la PR #126 (`f0-c10/t11-integration-20261122`, HEAD histórico `1268ba22f26330d619b046fcf551ca846cb69d0f`; base histórica `11161dd6f2c4b5237a2da59d7275ff693e0afdbe`). **Revalida HEAD, PR, CI y Staging antes de confiar en esos datos.** No repitas trabajo ya integrado: contribuye con un defecto pendiente comprobable y su reparación.

## Lote autorizado y seguridad

Autorizo investigación pública, lecturas de GitHub, Cloudflare y OpenCode Remote, pruebas offline/sintéticas, desarrollo en **rama R2 propia** basada en el SHA verificado, commits únicamente de tu área, documentación propia y PR **draft** hacia la base Stage apropiada. Permito ejecutar CI correspondiente y verificar el resultado exacto de tu HEAD. Trabaja dentro del lote sin microaprobaciones; si una etapa resulta bloqueada, completa las independientes. **No** modifiques la rama #126, `main`, Producción, Workers publicados, secretos, Access, bindings, migraciones, recursos persistentes ni ramas ajenas; no fusionar, desplegar, borrar ni iniciar carga múltiple real. Prefiere que OpenCode programe, pero solo usa acciones Remote con efectos cuando el alcance, el lease atómico de Staging, el preflight y el corte **efectivo** de gasto estén comprobados. Sin ellos, trabaja offline y etiqueta la autoría real de ChatGPT; no simules ejecución de OpenCode. No llames MCP dinámico asumiendo que es lectura; no canceles tareas ajenas ni reintentes operaciones ambiguas.

## Entrega y cierre

Implementa el cambio mínimo útil mediante OpenCode cuando sea seguro, o directamente en rama permitida con autoría correcta; contrasta con soluciones abiertas (repo, archivo, commit, licencia) y ejecuta RED→GREEN, pruebas negativas, Bun/typecheck/build/invariantes pertinentes y CI del HEAD. Registra comandos, exit codes, IDs reales, costes observados/desconocidos, límites, conflicto con #126 y validaciones pendientes. Después de las pruebas actualiza **tu informe canónico** `04_RECUPERACION.md` en `docs/f0-c10/` dentro de tu rama; publica evidencia y PR draft en GitHub. Deposita una copia pequeña del informe/fixtures no sensibles en Biblioteca personal **solo si** la herramienta y permisos están disponibles y verificas el recibo; en caso contrario entrega archivos descargables, sin afirmar subida. No sobreescribas el trabajo de otro especialista. `PASS` individual ≠ COMPLETE PASS F0-C10. Cierra con `RESULTADO | EVIDENCIA | BLOQUEANTE | PRÓXIMA ACCIÓN`, enlaces, SHAs y actor real, sin pedir continuidad rutinaria.


---

# PROMPT R2-T05 — Paginación segura de Remote, MCP y transcripts

**Meta de este chat:** preparar una corrección comprobable de T05 para que F0-C10 termine con diez trabajos reales simultáneos y diez resultados íntegros. **Tu punto de partida especial es la PR #114**, ahora incorporada o referenciada en #126.

## Problema focal y trabajo técnico

PR #114 limita 128 registros crudos/64 visibles/8192 bytes de progreso y #106 impide algunas lecturas completas de transcripts, pero el SDK podría materializar un evento gigante antes de entregar `next()`, y la lectura histórica sigue sin paginación funcional.

1. Audita todas las rutas de `progress/status/inspect/transcript/exportSessionData` y del MCP; rastrea límites **antes** de materializar y serializar, no después de `slice()`.
2. Prueba eventos individuales enormes, razones filtradas, cursores truncados, duplicados, gaps, timeouts en `next()` y diez lectores intercalados. Evita lecturas de historiales reales sensibles.
3. Diseña un transcript paginado con cursor durable autenticado, bytes y tiempo acotados, o contrato explícito `UNAVAILABLE_LEGACY` cuando el SDK impide paginar sin memoria gigante.
4. Implementa la reparación mínima respaldada por tests sobre Worker principal y MCP; valida compatibilidad de contratos, fallos y errores sin inventar `verified`.
5. Usa OpenHands/MCP SDK como referencias de implementación de logs durables y paginación, con licencias/commits. Coordina con T01 sobre métricas y T09/T10 sobre outputs y telemetría.

**Superficie primaria:** `src/supervisor-progress.ts`, MCP y tests + `docs/f0-c10/05_REMOTE_MCP.md`; señalar los hunks que choquen con T03/T04 en `src/server.ts`. No desplegar.

## Contexto y continuidad

Estás en **el mismo chat** que investigó esta área en la primera ronda. Relee tu propia entrega previa, pero contrástala con el repositorio `aamvtrampa36-del/opencode-harness-example`, el issue #90, el plan `docs/f0-c10/F0_C10_PLAN_INTEGRAL.md` y `docs/f0-c10/00_COORDINACION.md`. La primera integración es la PR #126 (`f0-c10/t11-integration-20261122`, HEAD histórico `1268ba22f26330d619b046fcf551ca846cb69d0f`; base histórica `11161dd6f2c4b5237a2da59d7275ff693e0afdbe`). **Revalida HEAD, PR, CI y Staging antes de confiar en esos datos.** No repitas trabajo ya integrado: contribuye con un defecto pendiente comprobable y su reparación.

## Lote autorizado y seguridad

Autorizo investigación pública, lecturas de GitHub, Cloudflare y OpenCode Remote, pruebas offline/sintéticas, desarrollo en **rama R2 propia** basada en el SHA verificado, commits únicamente de tu área, documentación propia y PR **draft** hacia la base Stage apropiada. Permito ejecutar CI correspondiente y verificar el resultado exacto de tu HEAD. Trabaja dentro del lote sin microaprobaciones; si una etapa resulta bloqueada, completa las independientes. **No** modifiques la rama #126, `main`, Producción, Workers publicados, secretos, Access, bindings, migraciones, recursos persistentes ni ramas ajenas; no fusionar, desplegar, borrar ni iniciar carga múltiple real. Prefiere que OpenCode programe, pero solo usa acciones Remote con efectos cuando el alcance, el lease atómico de Staging, el preflight y el corte **efectivo** de gasto estén comprobados. Sin ellos, trabaja offline y etiqueta la autoría real de ChatGPT; no simules ejecución de OpenCode. No llames MCP dinámico asumiendo que es lectura; no canceles tareas ajenas ni reintentes operaciones ambiguas.

## Entrega y cierre

Implementa el cambio mínimo útil mediante OpenCode cuando sea seguro, o directamente en rama permitida con autoría correcta; contrasta con soluciones abiertas (repo, archivo, commit, licencia) y ejecuta RED→GREEN, pruebas negativas, Bun/typecheck/build/invariantes pertinentes y CI del HEAD. Registra comandos, exit codes, IDs reales, costes observados/desconocidos, límites, conflicto con #126 y validaciones pendientes. Después de las pruebas actualiza **tu informe canónico** `05_REMOTE_MCP.md` en `docs/f0-c10/` dentro de tu rama; publica evidencia y PR draft en GitHub. Deposita una copia pequeña del informe/fixtures no sensibles en Biblioteca personal **solo si** la herramienta y permisos están disponibles y verificas el recibo; en caso contrario entrega archivos descargables, sin afirmar subida. No sobreescribas el trabajo de otro especialista. `PASS` individual ≠ COMPLETE PASS F0-C10. Cierra con `RESULTADO | EVIDENCIA | BLOQUEANTE | PRÓXIMA ACCIÓN`, enlaces, SHAs y actor real, sin pedir continuidad rutinaria.


---

# PROMPT R2-T06 — Procesos descendientes, cancelación y aislamiento Linux

**Meta de este chat:** preparar una corrección comprobable de T06 para que F0-C10 termine con diez trabajos reales simultáneos y diez resultados íntegros. **Tu punto de partida especial es la PR #121**, ahora incorporada o referenciada en #126.

## Problema focal y trabajo técnico

La PR #121 añadió `timeout --kill-after=5s` y fixtures locales de diez procesos; #105 ya acotaba stdout/stderr. Esas pruebas NO demuestran limpieza de nietos detached, aislamiento efectivo de Containers ni diez ejecuciones reales en Cloudflare.

1. Reconstituye `DevContainer.run()`, filesystem, límites de CPU/memoria, señales y comportamiento de kill/timeout en runtime del Container; distingue shell, proceso hijo, grupo y descendientes.
2. Construye fixture Linux seguro y descartable que cree árbol de procesos, salida intensa por dos canales, salida binaria, cancelación y exit codes no cero, con detección de huérfanos y limpieza.
3. Compara el pipeline de subprocess/streams de DeepSeek Harness (revisar licencia MIT y commit concreto) contra el script actual; `bash-local` no es sandbox.
4. Implementa mejoras de grupos de procesos y truncamiento/backpressure solo si las pruebas demuestran portabilidad y preservación de exit code. Sin `pkill` global ni borrar directorios no creados por la prueba.
5. Contrasta hasta diez procesos en entorno aislado local y entrega una matriz de lo que falta por comprobar en Containers auténticos sin lanzar carga Stage.

**Superficie primaria:** `src/dev-container.ts`, fixtures y `docs/f0-c10/06_LINUX_CONTAINERS.md`. No tocar Worker bindings ni configuración desplegada.

## Contexto y continuidad

Estás en **el mismo chat** que investigó esta área en la primera ronda. Relee tu propia entrega previa, pero contrástala con el repositorio `aamvtrampa36-del/opencode-harness-example`, el issue #90, el plan `docs/f0-c10/F0_C10_PLAN_INTEGRAL.md` y `docs/f0-c10/00_COORDINACION.md`. La primera integración es la PR #126 (`f0-c10/t11-integration-20261122`, HEAD histórico `1268ba22f26330d619b046fcf551ca846cb69d0f`; base histórica `11161dd6f2c4b5237a2da59d7275ff693e0afdbe`). **Revalida HEAD, PR, CI y Staging antes de confiar en esos datos.** No repitas trabajo ya integrado: contribuye con un defecto pendiente comprobable y su reparación.

## Lote autorizado y seguridad

Autorizo investigación pública, lecturas de GitHub, Cloudflare y OpenCode Remote, pruebas offline/sintéticas, desarrollo en **rama R2 propia** basada en el SHA verificado, commits únicamente de tu área, documentación propia y PR **draft** hacia la base Stage apropiada. Permito ejecutar CI correspondiente y verificar el resultado exacto de tu HEAD. Trabaja dentro del lote sin microaprobaciones; si una etapa resulta bloqueada, completa las independientes. **No** modifiques la rama #126, `main`, Producción, Workers publicados, secretos, Access, bindings, migraciones, recursos persistentes ni ramas ajenas; no fusionar, desplegar, borrar ni iniciar carga múltiple real. Prefiere que OpenCode programe, pero solo usa acciones Remote con efectos cuando el alcance, el lease atómico de Staging, el preflight y el corte **efectivo** de gasto estén comprobados. Sin ellos, trabaja offline y etiqueta la autoría real de ChatGPT; no simules ejecución de OpenCode. No llames MCP dinámico asumiendo que es lectura; no canceles tareas ajenas ni reintentes operaciones ambiguas.

## Entrega y cierre

Implementa el cambio mínimo útil mediante OpenCode cuando sea seguro, o directamente en rama permitida con autoría correcta; contrasta con soluciones abiertas (repo, archivo, commit, licencia) y ejecuta RED→GREEN, pruebas negativas, Bun/typecheck/build/invariantes pertinentes y CI del HEAD. Registra comandos, exit codes, IDs reales, costes observados/desconocidos, límites, conflicto con #126 y validaciones pendientes. Después de las pruebas actualiza **tu informe canónico** `06_LINUX_CONTAINERS.md` en `docs/f0-c10/` dentro de tu rama; publica evidencia y PR draft en GitHub. Deposita una copia pequeña del informe/fixtures no sensibles en Biblioteca personal **solo si** la herramienta y permisos están disponibles y verificas el recibo; en caso contrario entrega archivos descargables, sin afirmar subida. No sobreescribas el trabajo de otro especialista. `PASS` individual ≠ COMPLETE PASS F0-C10. Cierra con `RESULTADO | EVIDENCIA | BLOQUEANTE | PRÓXIMA ACCIÓN`, enlaces, SHAs y actor real, sin pedir continuidad rutinaria.


---

# PROMPT R2-T07 — Gate de inferencia y control real de coste

**Meta de este chat:** preparar una corrección comprobable de T07 para que F0-C10 termine con diez trabajos reales simultáneos y diez resultados íntegros. **Tu punto de partida especial es la PR #117**, ahora incorporada o referenciada en #126.

## Problema focal y trabajo técnico

PR #117 probó un proveedor falso de diez tareas: máximo dos inferencias en vuelo bajo simulación; **no** midió capacidad ni gasto reales. El modelo `economy` no implica cuota ilimitada. Debes crear un contrato aplicable, no añadir otro catálogo o servicio sin necesidad.

1. Reconstruye la selección actual de modelo, llamadas del SDK y reintentos internos, con fuentes y versiones exactas. Revalida límites publicados del proveedor y separa RPM, concurrencia, tokens y restricciones del Durable Object.
2. Implementa en rama un adaptador de presupuestos/contabilidad simulado con reservas idempotentes por `requestId`, reconciliación de respuesta perdida, deuda desconocida y corte vinculante a la **ruta de llamada**, si es técnicamente viable.
3. Coordina con T03 para que el limitador por proveedor/modelo reutilice su admisión durable; no implantes un scheduler independiente. Garantiza que un fallo de facturación no silencie trabajo con coste indeterminado.
4. Tests RED/GREEN: 429, ráfaga, token truncado, timeout, presupuesto agotado, fallback no autorizado, diez solicitudes con distintos tiempos, doble cobro tras retry.
5. Entrega evidencia de cuáles controles son mocks/código y cuáles están **efectivamente aplicados** en infraestructura; no propongas una campaña live si falta corte real de gastos y límites globales de Workers/Containers/CI.

**Superficie primaria:** módulo de inferencia/ledger de pruebas y `docs/f0-c10/07_INFERENCIA_COSTES.md`; nada de nuevas claves o modelos activos.

## Contexto y continuidad

Estás en **el mismo chat** que investigó esta área en la primera ronda. Relee tu propia entrega previa, pero contrástala con el repositorio `aamvtrampa36-del/opencode-harness-example`, el issue #90, el plan `docs/f0-c10/F0_C10_PLAN_INTEGRAL.md` y `docs/f0-c10/00_COORDINACION.md`. La primera integración es la PR #126 (`f0-c10/t11-integration-20261122`, HEAD histórico `1268ba22f26330d619b046fcf551ca846cb69d0f`; base histórica `11161dd6f2c4b5237a2da59d7275ff693e0afdbe`). **Revalida HEAD, PR, CI y Staging antes de confiar en esos datos.** No repitas trabajo ya integrado: contribuye con un defecto pendiente comprobable y su reparación.

## Lote autorizado y seguridad

Autorizo investigación pública, lecturas de GitHub, Cloudflare y OpenCode Remote, pruebas offline/sintéticas, desarrollo en **rama R2 propia** basada en el SHA verificado, commits únicamente de tu área, documentación propia y PR **draft** hacia la base Stage apropiada. Permito ejecutar CI correspondiente y verificar el resultado exacto de tu HEAD. Trabaja dentro del lote sin microaprobaciones; si una etapa resulta bloqueada, completa las independientes. **No** modifiques la rama #126, `main`, Producción, Workers publicados, secretos, Access, bindings, migraciones, recursos persistentes ni ramas ajenas; no fusionar, desplegar, borrar ni iniciar carga múltiple real. Prefiere que OpenCode programe, pero solo usa acciones Remote con efectos cuando el alcance, el lease atómico de Staging, el preflight y el corte **efectivo** de gasto estén comprobados. Sin ellos, trabaja offline y etiqueta la autoría real de ChatGPT; no simules ejecución de OpenCode. No llames MCP dinámico asumiendo que es lectura; no canceles tareas ajenas ni reintentes operaciones ambiguas.

## Entrega y cierre

Implementa el cambio mínimo útil mediante OpenCode cuando sea seguro, o directamente en rama permitida con autoría correcta; contrasta con soluciones abiertas (repo, archivo, commit, licencia) y ejecuta RED→GREEN, pruebas negativas, Bun/typecheck/build/invariantes pertinentes y CI del HEAD. Registra comandos, exit codes, IDs reales, costes observados/desconocidos, límites, conflicto con #126 y validaciones pendientes. Después de las pruebas actualiza **tu informe canónico** `07_INFERENCIA_COSTES.md` en `docs/f0-c10/` dentro de tu rama; publica evidencia y PR draft en GitHub. Deposita una copia pequeña del informe/fixtures no sensibles en Biblioteca personal **solo si** la herramienta y permisos están disponibles y verificas el recibo; en caso contrario entrega archivos descargables, sin afirmar subida. No sobreescribas el trabajo de otro especialista. `PASS` individual ≠ COMPLETE PASS F0-C10. Cierra con `RESULTADO | EVIDENCIA | BLOQUEANTE | PRÓXIMA ACCIÓN`, enlaces, SHAs y actor real, sin pedir continuidad rutinaria.


---

# PROMPT R2-T08 — Eliminar carrera de publicación entre escritores GitHub

**Meta de este chat:** preparar una corrección comprobable de T08 para que F0-C10 termine con diez trabajos reales simultáneos y diez resultados íntegros. **Tu punto de partida especial es la PR #122**, ahora incorporada o referenciada en #126.

## Problema focal y trabajo técnico

PR #122 concilia recibos perdidos para PR draft y #124 demuestra que dos preflights pueden ver estado libre y enviar POST simultáneamente. Se integró el código de #122 y el test adicional de #124 en #126; **la exclusión atómica global no está implementada**.

1. Reconstruye flujo exacto de publicación `branch → commit → PR`, permisos server-side, ref esperada, idempotency y efectos de POST ambiguos.
2. Diseña protocolo mínimo de exclusión atómica con fencing y/o operaciones condicionadas a SHA para una intención de PR; distingue estado durable de una rama o etiqueta informal. No confundir exclusión entre chats con un lock del agente.
3. Implementa el cambio mínimo de puente GitHub sin sustituirlo por el conector oficial ChatGPT y sin quitar restricciones de rama/proyecto.
4. Tests RED/GREEN deterministas con 2 escritores competidores, 10 ramas independientes, HEAD cambiado durante preflight, respuesta HTTP 5xx después de efecto y contenido divergente. Probar que no hay doble POST ciego.
5. Investiga casos equivalentes de Aider, SWE-agent, Git/GitHub y sus licencias/commits; incorpora recomendaciones de T03 solo si no duplican su scheduler.

**Superficie primaria:** `src/github.ts`, tests y `docs/f0-c10/08_GITHUB_INTEGRIDAD.md`; no crear PR sobre ramas de otros ni modificar protección de `main`.

## Contexto y continuidad

Estás en **el mismo chat** que investigó esta área en la primera ronda. Relee tu propia entrega previa, pero contrástala con el repositorio `aamvtrampa36-del/opencode-harness-example`, el issue #90, el plan `docs/f0-c10/F0_C10_PLAN_INTEGRAL.md` y `docs/f0-c10/00_COORDINACION.md`. La primera integración es la PR #126 (`f0-c10/t11-integration-20261122`, HEAD histórico `1268ba22f26330d619b046fcf551ca846cb69d0f`; base histórica `11161dd6f2c4b5237a2da59d7275ff693e0afdbe`). **Revalida HEAD, PR, CI y Staging antes de confiar en esos datos.** No repitas trabajo ya integrado: contribuye con un defecto pendiente comprobable y su reparación.

## Lote autorizado y seguridad

Autorizo investigación pública, lecturas de GitHub, Cloudflare y OpenCode Remote, pruebas offline/sintéticas, desarrollo en **rama R2 propia** basada en el SHA verificado, commits únicamente de tu área, documentación propia y PR **draft** hacia la base Stage apropiada. Permito ejecutar CI correspondiente y verificar el resultado exacto de tu HEAD. Trabaja dentro del lote sin microaprobaciones; si una etapa resulta bloqueada, completa las independientes. **No** modifiques la rama #126, `main`, Producción, Workers publicados, secretos, Access, bindings, migraciones, recursos persistentes ni ramas ajenas; no fusionar, desplegar, borrar ni iniciar carga múltiple real. Prefiere que OpenCode programe, pero solo usa acciones Remote con efectos cuando el alcance, el lease atómico de Staging, el preflight y el corte **efectivo** de gasto estén comprobados. Sin ellos, trabaja offline y etiqueta la autoría real de ChatGPT; no simules ejecución de OpenCode. No llames MCP dinámico asumiendo que es lectura; no canceles tareas ajenas ni reintentes operaciones ambiguas.

## Entrega y cierre

Implementa el cambio mínimo útil mediante OpenCode cuando sea seguro, o directamente en rama permitida con autoría correcta; contrasta con soluciones abiertas (repo, archivo, commit, licencia) y ejecuta RED→GREEN, pruebas negativas, Bun/typecheck/build/invariantes pertinentes y CI del HEAD. Registra comandos, exit codes, IDs reales, costes observados/desconocidos, límites, conflicto con #126 y validaciones pendientes. Después de las pruebas actualiza **tu informe canónico** `08_GITHUB_INTEGRIDAD.md` en `docs/f0-c10/` dentro de tu rama; publica evidencia y PR draft en GitHub. Deposita una copia pequeña del informe/fixtures no sensibles en Biblioteca personal **solo si** la herramienta y permisos están disponibles y verificas el recibo; en caso contrario entrega archivos descargables, sin afirmar subida. No sobreescribas el trabajo de otro especialista. `PASS` individual ≠ COMPLETE PASS F0-C10. Cierra con `RESULTADO | EVIDENCIA | BLOQUEANTE | PRÓXIMA ACCIÓN`, enlaces, SHAs y actor real, sin pedir continuidad rutinaria.


---

# PROMPT R2-T09 — Descargas byte-exact vinculadas a tarea y Android

**Meta de este chat:** preparar una corrección comprobable de T09 para que F0-C10 termine con diez trabajos reales simultáneos y diez resultados íntegros. **Tu punto de partida especial es la PR #123**, ahora incorporada o referenciada en #126.

## Problema focal y trabajo técnico

PR #123 documentó `opencode.task-output.v1` y probó GET de bytes en loopback; **no existe aún evidencia de endpoint autenticado real** para artefactos de diez tareas ni descarga Android. La PR #100 renderiza `file` seguro, pero `/bundle/...` es una ruta, no un enlace.

1. Traza contrato real `tool output → almacenamiento → MCP → cliente Android`: identidades `requestId`, `projectId`, `artifactId`, permisos, URL, tamaño y hash; no aceptar metadatos autoafirmados sin readback.
2. Propón e implementa en rama un endpoint/handshake mínimo de artefacto seguro, usando primitivas existentes si disponibles; verificación estricta de pertenencia, MIME, extensión, longitud, byte SHA y expiración. Sin introducir R2 nuevo si ya existe almacenamiento suficiente.
3. Tests negativos: path traversal, ID de otra tarea, URL interna, HTML/SVG activo, token caducado, archivo modificado después del recibo, nombres Unicode, 2 MiB y diez finalizaciones desordenadas.
4. Contrasta alternativas de descarga de OpenHands/SWE-agent y normas de seguridad. Preparar comprobación Android real para lote Stage autorizado, no asumirla por Playwright.
5. Coordina los eventos/readback con T10; si la API no puede implementarse aún, deja diff/contrato executable y marca `PARTIAL` sin anunciar descarga funcional.

**Superficie primaria:** API artifacts/fixtures y `docs/f0-c10/09_OUTPUTS_ARCHIVOS.md`; no exponer buckets, rutas privadas ni links ficticios.

## Contexto y continuidad

Estás en **el mismo chat** que investigó esta área en la primera ronda. Relee tu propia entrega previa, pero contrástala con el repositorio `aamvtrampa36-del/opencode-harness-example`, el issue #90, el plan `docs/f0-c10/F0_C10_PLAN_INTEGRAL.md` y `docs/f0-c10/00_COORDINACION.md`. La primera integración es la PR #126 (`f0-c10/t11-integration-20261122`, HEAD histórico `1268ba22f26330d619b046fcf551ca846cb69d0f`; base histórica `11161dd6f2c4b5237a2da59d7275ff693e0afdbe`). **Revalida HEAD, PR, CI y Staging antes de confiar en esos datos.** No repitas trabajo ya integrado: contribuye con un defecto pendiente comprobable y su reparación.

## Lote autorizado y seguridad

Autorizo investigación pública, lecturas de GitHub, Cloudflare y OpenCode Remote, pruebas offline/sintéticas, desarrollo en **rama R2 propia** basada en el SHA verificado, commits únicamente de tu área, documentación propia y PR **draft** hacia la base Stage apropiada. Permito ejecutar CI correspondiente y verificar el resultado exacto de tu HEAD. Trabaja dentro del lote sin microaprobaciones; si una etapa resulta bloqueada, completa las independientes. **No** modifiques la rama #126, `main`, Producción, Workers publicados, secretos, Access, bindings, migraciones, recursos persistentes ni ramas ajenas; no fusionar, desplegar, borrar ni iniciar carga múltiple real. Prefiere que OpenCode programe, pero solo usa acciones Remote con efectos cuando el alcance, el lease atómico de Staging, el preflight y el corte **efectivo** de gasto estén comprobados. Sin ellos, trabaja offline y etiqueta la autoría real de ChatGPT; no simules ejecución de OpenCode. No llames MCP dinámico asumiendo que es lectura; no canceles tareas ajenas ni reintentes operaciones ambiguas.

## Entrega y cierre

Implementa el cambio mínimo útil mediante OpenCode cuando sea seguro, o directamente en rama permitida con autoría correcta; contrasta con soluciones abiertas (repo, archivo, commit, licencia) y ejecuta RED→GREEN, pruebas negativas, Bun/typecheck/build/invariantes pertinentes y CI del HEAD. Registra comandos, exit codes, IDs reales, costes observados/desconocidos, límites, conflicto con #126 y validaciones pendientes. Después de las pruebas actualiza **tu informe canónico** `09_OUTPUTS_ARCHIVOS.md` en `docs/f0-c10/` dentro de tu rama; publica evidencia y PR draft en GitHub. Deposita una copia pequeña del informe/fixtures no sensibles en Biblioteca personal **solo si** la herramienta y permisos están disponibles y verificas el recibo; en caso contrario entrega archivos descargables, sin afirmar subida. No sobreescribas el trabajo de otro especialista. `PASS` individual ≠ COMPLETE PASS F0-C10. Cierra con `RESULTADO | EVIDENCIA | BLOQUEANTE | PRÓXIMA ACCIÓN`, enlaces, SHAs y actor real, sin pedir continuidad rutinaria.


---

# PROMPT R2-T10 — Telemetría E2E autenticada y pruebas 1→2→4→10

**Meta de este chat:** preparar una corrección comprobable de T10 para que F0-C10 termine con diez trabajos reales simultáneos y diez resultados íntegros. **Tu punto de partida especial es la PR #119**, ahora incorporada o referenciada en #126.

## Problema focal y trabajo técnico

PR #119 es el harness seleccionado sobre #118: 26 tests, readback de bytes y negativos; CI pasó, pero **todas las pruebas fueron offline**. Sin un colector runtime confiable, strings `source=runtime` y diez `busy=true` no demuestran diez activos.

1. Define evento real mínimo con `experimentId`, request/session/operation/project/executor, worker/deployment/SHA, tool/inference start/end, exitCode, timestamps, medición de costo y memoria.
2. Implementa recolector/adaptador que obtenga evidencia de una fuente autenticada independiente del JSON del modelo; fixture de procedencia falsa debe ser RED. Reutiliza logs/observabilidad y no leas transcripts completos.
3. Integra a `evaluate.mjs` controles de reloj, duración de intersección de **diez** intervalos auténticos, diez readbacks, ID y hashes; evita falsos positivos por cola, reintentos o múltiples eventos del mismo ejecutor.
4. Mantén el RED histórico del issue #90 y añade fallos de lease, OOM, duplicación, output perdido, anulación/restore y coste desconocido; documenta 1→2→4→10 y tres rondas con límites predeclarados.
5. Haz CI offline exacto de todos los cambios y entrega receta de campaña live para T11, **sin iniciarla**. Coordina con T01/T09 en telemetría y bytes y con T03/T07 en reserva/costos.

**Superficie primaria:** `scripts/f0-c10/`, workflow offline y `docs/f0-c10/10_PRUEBAS_E2E.md`; no iniciar diez tareas en Staging.

## Contexto y continuidad

Estás en **el mismo chat** que investigó esta área en la primera ronda. Relee tu propia entrega previa, pero contrástala con el repositorio `aamvtrampa36-del/opencode-harness-example`, el issue #90, el plan `docs/f0-c10/F0_C10_PLAN_INTEGRAL.md` y `docs/f0-c10/00_COORDINACION.md`. La primera integración es la PR #126 (`f0-c10/t11-integration-20261122`, HEAD histórico `1268ba22f26330d619b046fcf551ca846cb69d0f`; base histórica `11161dd6f2c4b5237a2da59d7275ff693e0afdbe`). **Revalida HEAD, PR, CI y Staging antes de confiar en esos datos.** No repitas trabajo ya integrado: contribuye con un defecto pendiente comprobable y su reparación.

## Lote autorizado y seguridad

Autorizo investigación pública, lecturas de GitHub, Cloudflare y OpenCode Remote, pruebas offline/sintéticas, desarrollo en **rama R2 propia** basada en el SHA verificado, commits únicamente de tu área, documentación propia y PR **draft** hacia la base Stage apropiada. Permito ejecutar CI correspondiente y verificar el resultado exacto de tu HEAD. Trabaja dentro del lote sin microaprobaciones; si una etapa resulta bloqueada, completa las independientes. **No** modifiques la rama #126, `main`, Producción, Workers publicados, secretos, Access, bindings, migraciones, recursos persistentes ni ramas ajenas; no fusionar, desplegar, borrar ni iniciar carga múltiple real. Prefiere que OpenCode programe, pero solo usa acciones Remote con efectos cuando el alcance, el lease atómico de Staging, el preflight y el corte **efectivo** de gasto estén comprobados. Sin ellos, trabaja offline y etiqueta la autoría real de ChatGPT; no simules ejecución de OpenCode. No llames MCP dinámico asumiendo que es lectura; no canceles tareas ajenas ni reintentes operaciones ambiguas.

## Entrega y cierre

Implementa el cambio mínimo útil mediante OpenCode cuando sea seguro, o directamente en rama permitida con autoría correcta; contrasta con soluciones abiertas (repo, archivo, commit, licencia) y ejecuta RED→GREEN, pruebas negativas, Bun/typecheck/build/invariantes pertinentes y CI del HEAD. Registra comandos, exit codes, IDs reales, costes observados/desconocidos, límites, conflicto con #126 y validaciones pendientes. Después de las pruebas actualiza **tu informe canónico** `10_PRUEBAS_E2E.md` en `docs/f0-c10/` dentro de tu rama; publica evidencia y PR draft en GitHub. Deposita una copia pequeña del informe/fixtures no sensibles en Biblioteca personal **solo si** la herramienta y permisos están disponibles y verificas el recibo; en caso contrario entrega archivos descargables, sin afirmar subida. No sobreescribas el trabajo de otro especialista. `PASS` individual ≠ COMPLETE PASS F0-C10. Cierra con `RESULTADO | EVIDENCIA | BLOQUEANTE | PRÓXIMA ACCIÓN`, enlaces, SHAs y actor real, sin pedir continuidad rutinaria.


---

# PROMPT R2-T11 — Segunda consolidación, integración y decisión sobre ensayo real

Actúa como director técnico y auditor de integración de F0-C10 **en este mismo chat maestro**, cuando T01–T10 hayan cerrado su segunda ronda, incluidas entregas PARTIAL/BLOCKED. Objetivo invariable: diez tareas activas solapadas y diez respuestas verificables, repetido en tres campañas, con aislamiento/recuperación/bytes/costes. **No confundir PR o CI verde con E2E.**

## Fuentes y continuidad

Repositorio `aamvtrampa36-del/opencode-harness-example`, issue #90, plan `docs/f0-c10/F0_C10_PLAN_INTEGRAL.md` (R2), coordinación `docs/f0-c10/00_COORDINACION.md`, primera integración [PR #126](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/126), HEAD histórico `1268ba22f26330d619b046fcf551ca846cb69d0f` y las tres CI #45093134023/#45093134014/#45093134038. Son referencias históricas: verifica PR/HEAD/CI/despliegues actuales. Recupera las diez PR R2, informes y evidencia de la Biblioteca cuando esté disponible, sin exigirme copiar manualmente los resultados. Consulta Cloudflare/Remote en lectura; diferencia binario publicado, código CI y actor que lo implementó. No uses Codex.

## Operación integrada

1. Crea matriz T01–T10 con resultado, HEAD, archivos, CI, prueba RED/GREEN, código/productivo, experimento real, coste y bloqueo; identifica duplicados, bases divergentes y los hunks conflictivos de `src/server.ts`, proveedor y outputs. Rechaza atribuir a OpenCode un cambio preparado por ChatGPT.
2. Selecciona la combinación de cambios **mínima, segura y medible** sobre #126 (o un nuevo baseline validado si #126 quedó obsoleto). Prefiere contención y journaling antes de una migración distribuida sin medición; si existe evidencia sólida del límite arquitectónico, propone prototipo aislado y rollback.
3. Autoriza en este lote lecturas GitHub/Cloudflare/Remote, investigación, pruebas offline, **nueva rama de integración aislada**, commits solo sobre esa rama, documentación `docs/f0-c10/11_CONSOLIDACION_R2.md` y PR draft; conserva ramas/PR originales. No hacer merge ni desplegar Workers/DO/Containers, ni modificar Prod/main/secrets/Access/almacenamiento real.
4. Ejecuta pruebas de regresión e integración pertinentes (Bun tests, typecheck, build de ambos Workers, invariantes, harness y outputs); verifica GitHub Actions del HEAD exacto. Corrige el candidato únicamente si el cambio está dentro del lote; documenta cada fallo y no repitas CI sin cambio.
5. Comprueba que se resolvieron las carreras de inicio/cancelación, `unknown/not_found`, lectura del transcript, writers GitHub, salida Linux, rate/cost gate y descargas byte-exact. No atribuyas valores sintéticos a runtime.
6. Determina expresamente si existen (a) lease atómico con fencing y control de Staging, (b) corte efectivo de gasto, (c) medición auténtica de diez intervalos de ejecución, (d) correlación de 10 outputs recuperados, (e) plan de rollback de cada Worker/DO. Sin estos preflight: **no inicia carga real**.
7. Cuando y solo cuando exista **otro lote explícito** de promoción/carga con gasto acotado y aislamiento verificado, coordina 1→2→4→10 y tres rondas de diez activos/resultados; detente al primer OOM, pérdida de IDs o coste incierto. El permiso para preparar esta integración NO autoriza esas operaciones.
8. Actualiza GitHub y, si hay permiso y conexión real, guarda una copia no sensible en Biblioteca; verifica recibos. Cierra con `RESULTADO | EVIDENCIA | BLOQUEANTE | PRÓXIMA ACCIÓN`, repositorio/rama/SHAs/PR/CI/versiones/actor/métricas y una decisión `COMPLETE PASS` (solo con evidencia live integral), `PARTIAL`, `BLOCKED` o `FAIL`.

No necesitas mi coordinación mecánica. Si falta una autorización sensible, preserva el trabajo ya comprobado y solicita únicamente la decisión operativa imprescindible, sin prometer ejecución en segundo plano.