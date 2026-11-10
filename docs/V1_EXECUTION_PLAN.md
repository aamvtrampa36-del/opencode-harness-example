# OpenCode Cloud — Plan maestro ejecutable V1 (2026-11-08)

**Producto**: alternativa personal a Codex Cloud para tres proyectos: OpenCode Cloud, CDF CLOUD y WorkBench. **Estado**: EN DESARROLLO; ninguna prueba CI equivale a autonomía verificada. **Cambios**: solo en rama y PR, no en producción.

## 0. Decisión de alcance y criterio de éxito

Priorizar un **agente que edite, ejecute, corrija, confirme y permita recuperar** antes que funciones avanzadas. Una tarea completa debe dejar un diff real, pruebas antes/después, códigos de salida y una rama Git reversible. El usuario solo elige proyecto, plantilla, modelo y escribe la tarea.

**Arquitectura seleccionada para V1 (G3, 2026-11-09)**: conservar el Worker de acceso personal protegido por Cloudflare Access, **OpenCode Workerd/Harness** en Durable Objects, el Container Linux aislado bajo demanda mediante la herramienta actual, GitHub como historial de código y DO como coordinación. G1 y G2 demostraron reparaciones reales y una PR generada por el agente. El motor OpenCode nativo **no puede instalarse en el entorno disponible según la restricción operativa comunicada por el titular**; no se ha comparado ni se sostiene que Workerd sea técnicamente superior. No condicionar G4–G9 a instalar el nativo. Toda migración futura requiere prueba independiente y autorización.

**No construir**: dos sistemas de agentes en producción, otro framework de autorización, un segundo ejecutor Linux, scheduler siempre activo, otra plataforma de logs, multitud de servicios o una interfaz propia que replique toda la interfaz oficial de OpenCode.

## 1. Inventario comprobado / no comprobado

- Repositorio GitHub: `aamvtrampa36-del/opencode-harness-example`; despliegue Cloudflare Worker `opencode-harness-example`.
- Motor actual: `@opencode/sdk/workerd` + `agents/harness/opencode` en DO; Linux en `DevContainer` aparte mediante herramienta personalizada.
- GitHub Bridge, OpenRouter, MCP remoto, UI móvil y perfiles existen en código, pero no se ha verificado un ciclo integral de agente con un modelo real.
- PR #28 incluye la reparación del bloqueo de autoprueba, selección de modelos económicos, clasificación de fallos, plazo máximo y un **ensayo aislado de reparación** (test Node inicialmente fallido, código corregido por el modelo y verificación del servidor). Esto NO modifica el repositorio real ni constituye por sí solo autodesarrollo.
- Limitación operativa actual: la sesión interactiva del propietario está protegida por Cloudflare Access. Las API administrativas de Cloudflare no equivalen a un navegador autenticado ni autorizan impersonarlo.
- Pruebas GitHub Actions: unidades, preview, TypeScript, build, invariantes; pruebas de runtime con IA requieren verificación adicional.

## 2. Arquitectura final mínima propuesta

| Responsabilidad | Solución prevista | Evitar |
|---|---|---|
| Acceso web, proxy y selección de proyecto | Worker actual con Access ya configurado | Nuevo registro de usuarios |
| Ejecutar agente, herramientas y procesos | **Workerd/Harness vigente + herramienta Linux en Container aislado** | Migrar a motor nativo sin demostrar compatibilidad |
| Configuración de modelos, agentes y MCP | Configuración vigente de OpenCode + claves protegidas; capacidades no verificadas se prueban en su hito | Motor de enrutamiento LLM propio |
| Código y versiones | GitHub, ramas por tarea y PR borradores | Estado de código sin historial |
| Contexto y sesiones | Estado actual de Workerd/DO; **persistencia y recuperación aún pendientes de validar en G4** | Suponer durabilidad de archivos efímeros o migración no probada |
| Recuperación del sistema de archivos | Exportación verificable fuera del Container y snapshots temporales | Confiar solo en snapshots beta de 30 días |
| Plantillas | 7 perfiles declarativos, editables y con valores por defecto | 7 contenedores/servicios agentes |
| Diagnóstico | Logs de Workers + eventos/resultado del agente + resumen por incidencia | Observabilidad duplicada |

**Importante**: el servidor OpenCode expuesto en red necesita una única protección de acceso; nunca publicar una terminal con credenciales sin control de entrada.

## 3. Orden obligatorio de implementación (gates; no paralelizar lo que depende de otro gate)

### G0 — Diagnóstico y regresiones del Harness existente
- Verificar rama, despliegue, fallos de modelo, registro de herramientas, estado de sesión, Container y snapshots.
- Repetir pruebas unitarias y de preview; no cambiar producción.
- **Hecho cuando**: existe una base reversible y todos los defectos confirmados tienen prueba o explicación causal.

### G1 — Capacidad de usar herramientas y reparar código (bloqueante)
- Probar bajo cuenta autorizada, modelo real y coste acotado, primero archivo Linux y después fixture JavaScript **rojo→verde**.
- El servidor prepara un test inicialmente fallido. El agente debe invocar Linux, consultar el error, editar SOLO el archivo fuente, pasar el test y devolver evidencia real de herramientas. El servidor verifica el código, que el test no haya cambiado y que Node devuelve cero.
- Capturar: proveedor/modelo, estado del catálogo, sesión, herramientas y sus salidas, fallo inicial, diff y resultado final, con los secretos fuera del informe.
- Si falla, clasificar: proveedor/registro; ausencia de herramientas; fallo Linux; fallo de persistencia; timeout. Resolver **la causa** antes de agregar más características.
- **Hecho cuando**: al menos una ejecución auténtica de reparación supera la prueba independiente, y el fallo inducido es visible cuando la reparación no sucede.
- Si no hay acceso autenticado en esta ejecución, registrar BLOQUEO, no fingir la prueba.

### G2 — Autodesarrollo del repositorio (bloqueante)
- Seleccionar una incidencia pequeña y reproducible del propio OpenCode Cloud. Usar exclusivamente rama de revisión y sin despliegue.
- Encargar al agente la lectura de archivos reales, edición, pruebas con fallo previo y corrección, commit y PR borrador.
- El supervisor revisa diffs, ejecuciones, límites de herramientas, archivos tocados, dependencias y coste. Rechaza resultados basados en prosa.
- **Hecho cuando**: el agente interno completa un cambio real; el supervisor comprueba diff y pruebas sin haber realizado él mismo el cambio atribuido al agente.

### G3 — Validación y selección arquitectónica de V1 (alcance revisado; APROBADO 2026-11-09)
- **Restricción operativa:** el titular comunica que no es posible instalar OpenCode nativo en el entorno disponible. El antiguo piloto A/B queda **no ejecutado/no evaluable**, no aprobado ni declarado favorable a ninguna arquitectura. Se conserva su propuesta como antecedente en la decisión histórica.
- **Seleccionado para V1:** motor **Workerd/Harness** en Durable Objects, Worker con Cloudflare Access, herramienta `linux` en Container aislado, GitHub en ramas revisables y proveedores ya configurados. No crear otro motor ni nuevo servicio.
- **Evidencias:** G1 cerró dos reparaciones autónomas verificadas; G2 produjo la PR borrador #29, dos commits de agente y CI #147 exitoso. Staging protegido, sin Cron ni Containers activos; producción sin cambios. No extrapolar estos resultados a recuperación, continuidad prolongada, consumo real ni MCP remotos.
- **Hecho cuando:** la elección queda formalizada, el plan actualizado, seguridad y aislamiento verificados, y G4 habilitado sin dependencia de instalar motor nativo. **Estado: cumplido; ver `docs/HITO_G3_EJECUCION_2026-11-09.md`.**
- **Reconsideración futura, no bloqueante:** únicamente si desaparece la restricción de instalación y existe una razón medible (compatibilidad, mantenimiento, costo o confiabilidad) para ensayar nativo aislado; nunca migrar producción sin pruebas y reversión.

### G4 — Persistencia y recuperación (APROBADO 2026-11-09)
- La copia independiente ya existente en SQLite de Durable Objects (hasta 2 MiB comprimidos) ahora tiene **restauración no destructiva**: `POST /api/dev/restore/{proyecto}` exige un destino **nuevo**, valida el archivo, comprueba SHA-256 y publica los archivos atómicamente. `POST /api/dev/backup/{proyecto}` puede guardar la referencia de sesión; se conserva rama y commit Git cuando están disponibles. Estas referencias no equivalen a respaldar el transcript ni a preservar `.git`.
- **Prueba real:** Container aislado destruido, imagen nueva confirmada vacía, respaldo leído desde DO y cuatro archivos restaurados con hashes iguales; prueba Node verde y sobrescritura rechazada. Fallo durante escritura y reintento validados en CI; las snapshots beta (30 días) no fueron utilizadas como único respaldo.
- El historial de sesión Workerd sigue en almacenamiento DO separado: se verificó que una sesión histórica de G2 continúa registrada con 20 mensajes. **No se afirma reanudación automática de una ejecución que estaba en progreso**, ni respaldo de dependencias, secretos o Git internals. La ampliación a proyectos mayores de 2 MiB queda para cuando exista necesidad demostrada.
- **Hecho cuando:** existe restauración real, independiente de una snapshot, con integridad y reversión documentadas. **Cumplido en alcance V1 personal; evidencias y límites en `docs/HITO_G4_EJECUCION_2026-11-09.md`.** Siguiente: G5 (interfaz para vibe coding).

### G5 — Interfaz para vibe coding — APROBADO EN STAGING (2026-11-10)
- **Gate cerrado:** el titular validó desde Android el proyecto `app-mwabn7ns`, ejecución con herramientas y pruebas reales, vista previa CSS/JS tras corrección, revisión de archivos, respaldo/restauración en destino nuevo y persistencia de sesión tras recarga. Capturas/transcript documentan ejecución/vista previa; para la revisión y recuperación móvil el respaldo de aceptación es la declaración explícita de éxito del titular. Evidencias y riesgos residuales en `docs/HITO_G5_EJECUCION_2026-11-09.md` §11. No se fusionó la PR ni se desplegó producción.
- Pantalla principal: proyecto → tarea → modelo automático/elegido → ejecutar. Mostrar eventos reales, archivos cambiados, coste aproximado, terminar/reanudar.
- Reutilizar OpenCode Web cuando sea adecuado; crear solo un selector ligero de proyectos/plantillas si la UI nativa carece de él.
- Probar con Android y ancho pequeño, reconexión WebSocket y estado luego de recargar.
- **Hecho cuando**: usuario puede completar flujo sin terminal ni configuración manual.

### G6 — Plantillas sin arquitectura adicional — APROBADO EN STAGING (2026-11-10)
- **Gate cerrado:** siete plantillas con CRUD editable/copiable/restablecible, modo/modelo sugerido y persistencia de overrides; GitHub Actions #206 y Workers Builds aprobados. Test WebSocket `ALFA-G6 → BETA-G6 → predeterminado` sin redeploy y evidencia real aportada por el titular desde Android: selección de `Decisiones` y respuesta del modelo empezando `G6-OK` tras la edición de instrucciones. Diferenciar evidencia visual/confirmación de usuario de los tests con Harness simulado. Acta: `docs/HITO_G6_EJECUCION_2026-11-10.md` §6. Sin merge ni despliegue productivo.
- **Siguiente hito: G7 — Diagnóstico pasivo y autorreparación acotada.** Primera acción: inventariar telemetría y fallos capturados y añadir clasificación/deduplicación mínima sin registrar datos sensibles ni crear un segundo motor.
- Predeterminadas: Desarrollo, Diagnóstico, Revisión, Planificación, Decisiones, Flujo, Documentación.
- Cada plantilla = nombre + instrucciones limitadas + modo + modelo sugerido; CRUD simple, copiar/restablecer, sin conceder permisos extra por texto.
- **Hecho cuando**: editar y reutilizar una plantilla modifica realmente la conducta sin desplegar código.

### G7 — Diagnóstico pasivo y autorreparación acotada — APROBADO EN STAGING (2026-11-10)
- **Gate cerrado:** clasificación pasiva y huellas de fallos Linux/agente, contador y primera/última aparición, evidencias sanitizadas en Durable Object, panel de incidentes y política de reintentos transitorios acotados sin autoparches ni autodespliegue. CI #223 y Workers Builds verdes. **Prueba Android real del titular:** pulsó «Comprobar registro con un fallo real» y observó «Verificado: Linux devolvió exitCode 19 y el fallo se registró sin utilizar IA», junto con `SHELL_FAILED · 1 incidente`, `linux · g7-diagnostics · exitCode 19`. El ciclo de fallo → almacenamiento → lectura autenticada queda demostrado. La repetición/deduplicación se probó en CI, no en otro ciclo Android.
- **Acta de cierre:** `docs/HITO_G7_EJECUCION_2026-11-10.md` §5; no fusionar ni modificar producción sin autorización.
- **Hito actual G8 — CDF CLOUD y WorkBench:** empezar por revisar el aislamiento por repositorio/proyecto y permisos antes de efectuar cambios en ramas no canónicas.
- Aprovechar logs/eventos existentes, clasificar incidentes con códigos estables: modelo no disponible, herramientas ausentes, fallo shell, tests fallidos, sesión bloqueada, latencia, persistencia y exceso de reintentos.
- Agrupar incidencias iguales con conteo, primera/última aparición, causa sospechada, evidencia, estado y acción. No guardar prompts ni claves íntegros.
- Reintentar fallos transitorios hasta un límite pequeño; detener bucles idénticos; no reintentar tests determinísticamente rotos sin modificar causa.
- Las reparaciones de código ocurren en rama y se verifican antes de ofrecer integración; no desplegar por sí mismo un fix a producción.
- **Hecho cuando**: fallo real queda registrado aunque el modelo no lo explique, y una incidencia repetida no genera una cadena de parches equivalentes.

### G8 — Proyectos CDF CLOUD y WorkBench — IMPLEMENTADO EN STAGING; ACEPTACIÓN FUNCIONAL PENDIENTE
- **Estado (10 nov 2026):** el agente tiene ámbitos inmutables por sesión para proyecto/repo y validación obligatoria al ejecutar herramientas; las escrituras globales y los cruces de repositorios se rechazan. Hay dos pruebas reales por GitHub conectado: [CDF CLOUD PR #160](https://github.com/aamvtrampa36-del/cdf-cloud-engine/pull/160) y [WorkBench PR #36](https://github.com/aamvtrampa36-del/CDF-WorkBench-/pull/36), ambas draft con un único archivo no canónico y `main` intacta. WorkBench CI #161 aprobada; CDF no disparó workflow para doc-only. OpenCode CI #229 y Workers Builds aprobados. **Falta la aceptación desde el GitHub interno de OpenCode Cloud**, no sustituible por el conector GitHub de ChatGPT.
- **Acción mínima:** desde Android, Proyectos → «Comprobar aislamiento CDF CLOUD y WorkBench» (sin IA ni escrituras), y después prueba real de herramienta `github` en una sesión por repositorio con revisión de solo lectura. Acta: `docs/HITO_G8_EJECUCION_2026-11-10.md`. No fusionar ni publicar producción.
- **G9** es el siguiente hito, todavía no comenzado.
- Configurar repositorios por separado; impedir que una sesión escriba fuera de su proyecto seleccionado.
- Probar en ramas nuevas: leer, modificar un archivo no canónico de ejemplo, compilar/probar y producir PR borrador. Prohibir escrituras a fuentes narrativas oficiales y a producción.
- **Hecho cuando**: ambas pruebas muestran repositorio correcto, diff correcto, regresiones ausentes y recuperación.

### G9 — Endurecimiento mínimo y entrega
- Eliminar código muerto, dependencias duplicadas, flags incompatibles y documentación temporal que se demuestre innecesaria. **Eliminar adaptadores solo si existe un reemplazo comprobado**; no exigir una migración a OpenCode nativo para completar la V1.
- Ejecutar E2E de las 12 pruebas del encargo; registrar evidencia enlazable y límites conocidos.
- **Hecho cuando**: una release/tag reversible supera los gates P0; el usuario puede desarrollar un cambio real sin intervención humana de administrador.

## 4. Política del agente y límites operativos

- Tareas normales: lectura, edición, ejecución de tests, instalar dependencias del proyecto y commits en rama; delegadas.
- Producción, canon narrativo, secretos, gastos y borrados irreversibles: autorización específica.
- Máximo 1 tarea activa por proyecto durante la V1; reintentos sin progreso terminan.
- Modelos caros no son la opción predeterminada. Registrar uso real y habilitar fallback solo a modelo ya conectado.
- Las tareas se consideran completadas por comprobaciones independientes, nunca por frases del modelo.
- La desactivación remota no debe borrar archivos ni dejar trabajo crítico sin checkpoint.
- No introducir una dependencia o servicio nuevo sin especificar el defecto concreto que resuelve y el componente que reemplaza.

## 5. Indicadores de confiabilidad (sin promesas absolutas)

- **Éxito E2E**: ratio de cambios que pasan test + diff confirmable, con modelo y proveedor identificados.
- **Errores ocultos**: número de sesiones cuyo resultado textual dice éxito pero cuyo resultado independiente falla (objetivo: cero).
- **Recuperación**: checksum de proyecto y transcript tras parada/reinicio; fallos de restauración (objetivo: cero en pruebas).
- **Rendimiento**: tiempo desde tarea hasta primera acción, latencia por herramienta, tiempo total y tiempo inactivo facturado.
- **Calidad**: reaparición de mismo código de error y número de parches sucesivos al mismo componente.
- **Costo**: uso de modelo por tarea y tiempo real de Container; límites mensuales visibles.
- **Ergonomía**: número de decisiones/clics del usuario hasta lanzar una tarea útil.

## 6. Costos y dependencias

Cloudflare Containers (octubre de 2026): Workers Paid USD 5/mes incluye 25 GiB-h de memoria Container, 375 vCPU-min y 200 GB-h de disco, compartidos por cuenta. Una instancia `basic` tiene 1 GiB RAM, 1/4 vCPU y 4 GB de disco. El consumo adicional se factura; las horas activas, Workers, DO, tráfico y llamadas a modelos pueden aumentar el importe. **No prometer coste total fijo antes de medir sesiones reales.**

Ejemplo ilustrativo: 30 horas activas/mes con `basic` implican 30 GiB-h de RAM provisionada (cinco por encima de la franquicia); el coste incremental solo de RAM sería aproximadamente USD 0,045. El CPU, disco, DO, Workers y las inferencias se evalúan por separado según uso real; no es una estimación de factura completa.

Fuentes:
- https://developers.cloudflare.com/containers/platform/pricing/
- https://developers.cloudflare.com/containers/guides/snapshots/
- https://docs.opencode.ai/docs/web/
- https://opencode.ai/docs/models/

## 7. Estado de la entrega / bloqueos

**Estado vigente a 2026-11-09:** G1 aprobado (dos reparaciones autónomas independientes), G2 aprobado ([PR #29](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/29) del agente y CI #147), G3 aprobado bajo la selección arquitectónica revisada (ver su acta). PR #28 y PR #29 siguen como borradores sin fusionar; la documentación de esta rama no afirma entrega a producción.

**G4 APROBADO:** recuperación no destructiva verificada en Linux nuevo desde respaldo persistente en DO, hashes iguales y pruebas verdes; el alcance y las limitaciones constan en su acta. **Siguiente hito G5 — Interfaz para vibe coding**, para que el usuario ejecute tareas, consulte respaldos y restaure sin terminal. No asumir que las snapshots beta equivalen a respaldo duradero.

**No declarar V1 completa** mientras falten G5–G8 y los E2E finales de G9. G5–G7 continúan según sus gates propios. La imposibilidad comunicada de instalar OpenCode nativo no bloquea la V1 y no equivale a haberlo comparado.
