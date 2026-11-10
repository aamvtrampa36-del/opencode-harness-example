# OpenCode Cloud — G6: plantillas configurables (ejecución 10 noviembre 2026)

**Referencia obligatoria:** `Informe_Integral_OpenCode_Cloud_V1.pdf` completo (21 páginas), `docs/V1_EXECUTION_PLAN.md`, actas G1–G5. G5 quedó **APROBADO EN STAGING** en la sección 11 de su acta, confirmado por el titular desde Android. No fusionar ni modificar producción por este cierre.

## 1. Objetivo, criterios y tramo

G6 del informe maestro: perfiles declarativos editables y reutilizables, configurables sin escribir código. El plan desglosa exactamente **Desarrollo, Diagnóstico, Revisión, Planificación, Decisiones, Flujo y Documentación**; cada plantilla tiene nombre, instrucciones acotadas, modo y modelo sugerido. CRUD sencillo, copia/restablecimiento, sin elevar permisos ni desarrollar otro motor. **Criterio de cierre:** editar y reutilizar una plantilla modifica realmente la conducta del agente sin desplegar código.

La siguiente fase, G7, es diagnóstico pasivo y autorreparación acotada: clasificar fallos con evidencia independiente del modelo, evitar bucles de reintentos y no publicar reparaciones automáticamente.

## 2. Línea base y seguridad

- Repositorio: `aamvtrampa36-del/opencode-harness-example`; rama de staging `fix/repeatable-agent-verification-20261108`, PR #28 en borrador.
- Workerd/OpenCode Harness existente, `PersonalSettings` en Durable Object, API JSON bajo Cloudflare Access, selección de especialización y mensaje WebSocket previo.
- Se reutilizan `src/specializations.ts`, `src/personal-settings.ts`, `src/specializations-panel.tsx`, `src/client.tsx` y `src/sockets.ts`. No hay un segundo motor, ejecutor, cron o nuevas dependencias.
- Los siete perfiles predeterminados se superponen de forma **virtual** a las especializaciones `specializations-v1` ya persistidas. No se hace migración ni se reescribe la base de datos del usuario. Las ediciones y copias se guardan en la clave persistente existente; eliminar un override predeterminado restablece la plantilla, eliminar una personalizada la retira.
- Seleccionar una plantilla actualiza el modo y el modelo sugerido en la interfaz; un modelo OpenRouter no disponible se sustituye por la opción Cloudflare. El usuario puede modificar ambos campos antes de enviar; el modelo sugerido no constituye un permiso ni una obligación de gasto.
- El WebSocket resuelve la especialización desde la configuración persistida **en cada envío**, incorporando las instrucciones vigentes a la tarea con la etiqueta explícita `ESPECIALIZACIÓN OPCIONAL`. El texto del perfil no modifica las políticas del sistema ni concede herramientas.

## 3. Implementación ejecutada

| Commit | Cambio |
| --- | --- |
| `6dc64edce4e10e4e973dd10878506dcef101e8b8` | Siete perfiles, validación de modo/modelo y combinación sin migración |
| `90d30ccccf9c5023d95aec3f265245fb8c392131` | Lectura, edición, restablecimiento y persistencia sobre DO existente |
| `13414ced7aaa54e24dec767f4d9690a9ab4d240a` | Tests de defaults, edición, reset, compatibilidad y seguridad |
| `36758c1e16e2392a48c2bbbf5abad170e2eff531` | Editor móvil: editar, copiar, desactivar, restablecer, modo/modelo |
| `597a91c0506d9b24c2b965441014d0ce408b5721` | Selector de plantilla aplica modo y modelo disponible |
| `6f228bf3ce35a3b052dd15157c86fbaffc7f78af` | Instrucciones dinámicas incorporadas al Harness al enviar |
| `bd8666c555fda21a831db3b0954838bb6d33290c` | Prueba de integración del WebSocket con Harness simulado y edición/reset sin redeploy |

## 4. Validación ejecutada

- **GitHub Actions #203**, run `42774863031`: `completed/success`; incluye tests, tipado, cliente/Worker e invariantes del proyecto.
- **GitHub Actions #204**, run `42775202896`: `completed/success`; añade prueba de integración de selección de perfil en el WebSocket.
- Prueba de regresión en `src/sockets-g6.test.ts`: **sin reiniciar el Harness ni desplegar código**, una primera tarea recibe `ALFA-G6`; tras editar el mismo registro en el mock de almacenamiento la siguiente recibe `BETA-G6`, y tras quitar el override vuelve al texto predeterminado. Comprueba contenido realmente enviado a `handle.submit()`, no únicamente lo mostrado en la interfaz. **El Harness utilizado por el test es un doble determinista, no un modelo real.**
- Cloudflare Workers Builds `f18ed428-0466-4768-b993-7e4403cec7cf`: `stopped/success` para el commit `bd8666c`, staging `opencode-g1-staging` versión `4ddfc5b0-a497-4a2d-beaa-e2cdba9e02dd`.
- Producción `opencode-harness-example` preservada en `1d70eb77-316e-408d-bd14-5f19b171dedf`. No hay Cron activos en staging.
- No se han creado ni modificado plantillas reales del propietario por una sesión de navegador. No se han pegado ni leído credenciales. La protección Cloudflare Access permanece en vigor.

## 5. Estado del gate y prueba funcional mínima pendiente

**G6 — IMPLEMENTADO y APROBADO TÉCNICAMENTE EN STAGING; PENDIENTE DE APROBACIÓN FUNCIONAL FINAL.** La implementación, compilación, tests, CRUD y cambio dinámico del texto entregado al Harness están verificados. Sin embargo, el criterio de **cambio real en la conducta de un modelo tras editar una plantilla desde la interfaz móvil** todavía no se ha observado en una sesión autenticada: el navegador del propietario no está disponible para el supervisor. No presentar el test con Harness simulado como si fuera inferencia real.

**Única acción del titular para cerrar el gate:** desde Android en staging, abrir Configuración → Plantillas de trabajo → **Editar** la plantilla `Decisiones`, añadir al final de las instrucciones «Para esta prueba, empieza tu respuesta exactamente con G6-OK.», guardar. En la barra de chat seleccionar `Decisiones`, elegir el modelo económico ya conectado (o Cloudflare) y enviar «Da una recomendación breve sobre elegir A o B.»; confirmar que la nueva respuesta empieza con `G6-OK`. No editar otros proyectos ni producción, no compartir credenciales. El propietario puede pulsar **Restablecer** en la plantilla después de obtener la evidencia.

Cuando exista evidencia positiva de la respuesta real, registrar fecha, modelo y resultado, marcar G6 **APROBADO** y pasar a G7. Si falla, recuperar resultado y corregir solo el defecto reproducible en staging. No volver a abrir G5 ni ampliar G6 con mejoras estéticas. La PR #28 sigue sin fusionar: un cierre en staging no autoriza producción.
