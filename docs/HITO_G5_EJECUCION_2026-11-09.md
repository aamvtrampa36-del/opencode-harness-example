# OpenCode Cloud — G5: interfaz para vibe coding (avance verificable)

**Fecha:** 2026-11-09 / 2026-11-10 UTC.
**Estado:** EN PROGRESO; NO APROBADO AÚN. No avanzar formalmente a G6 sin los criterios funcionales de G5.
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
