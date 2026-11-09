# OpenCode Cloud — Plan maestro ejecutable V1 (2026-11-08)

**Producto**: alternativa personal a Codex Cloud para tres proyectos: OpenCode Cloud, CDF CLOUD y WorkBench. **Estado**: EN DESARROLLO; ninguna prueba CI equivale a autonomía verificada. **Cambios**: solo en rama y PR, no en producción.

## 0. Decisión de alcance y criterio de éxito

Priorizar un **agente que edite, ejecute, corrija, confirme y permita recuperar** antes que funciones avanzadas. Una tarea completa debe dejar un diff real, pruebas antes/después, códigos de salida y una rama Git reversible. El usuario solo elige proyecto, plantilla, modelo y escribe la tarea.

**Arquitectura candidata**: conservar el Worker de acceso personal, un Container Linux activado bajo demanda, OpenCode nativo (CLI/web + herramientas propias), GitHub como historial de código y DO como coordinación mínima. La implementación Workerd/Harness existente sigue operativa hasta demostrar mejor funcionamiento y recuperación en el piloto nativo; nunca efectuar sustitución por suposición.

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
| Ejecutar agente, herramientas y procesos | **Un OpenCode nativo en Linux**, piloto aislado | Reimplementar bash/read/edit/grep |
| Configuración de modelos, agentes y MCP | Archivos/configuración de OpenCode + clave de proveedor protegida | Motor de enrutamiento LLM propio |
| Código y versiones | GitHub, ramas por tarea y PR borradores | Estado de código sin historial |
| Contexto y sesiones | Persistencia documentada y verificada de OpenCode | Prometer migración Workerd→CLI no soportada |
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

### G3 — Piloto de motor nativo OpenCode
- Preparar una instancia separada y temporal de `opencode web` o `opencode serve` en un Container; usar las herramientas nativas de shell, lectura, edición y Git sin los puentes custom.
- Usar un único proyecto de prueba, un modelo económico con capacidades de herramientas verificadas y la entrada protegida existente.
- Comparar A=Workerd/Harness vs B=nativo: bucle de reparación, latencia observable, reintentos, estado tras apagar/encender, consumo mensual estimado, complejidad neta.
- **Hecho cuando**: seleccionar ganador por evidencia. Preferir B si pasa todos los gates; conservar A si B no cumple. Nunca cortar tráfico ni borrar datos sin respaldo verificado.

### G4 — Persistencia y recuperación
- Diseñar estructura simple por repositorio y sesión: identificación del proyecto, git checkout/rama, directorio y snapshots.
- Exportar contenido y metadatos valiosos fuera del Container. Confirmar lectura y hash después de restaurar; las snapshots beta expiran a los 30 días.
- Probar detener el Container con un trabajo guardado y reanudarlo; probar fallo durante escritura.
- **Hecho cuando**: la recuperación funciona de verdad y existe una ruta de reversión documentada.

### G5 — Interfaz para vibe coding
- Pantalla principal: proyecto → tarea → modelo automático/elegido → ejecutar. Mostrar eventos reales, archivos cambiados, coste aproximado, terminar/reanudar.
- Reutilizar OpenCode Web cuando sea adecuado; crear solo un selector ligero de proyectos/plantillas si la UI nativa carece de él.
- Probar con Android y ancho pequeño, reconexión WebSocket y estado luego de recargar.
- **Hecho cuando**: usuario puede completar flujo sin terminal ni configuración manual.

### G6 — Plantillas sin arquitectura adicional
- Predeterminadas: Desarrollo, Diagnóstico, Revisión, Planificación, Decisiones, Flujo, Documentación.
- Cada plantilla = nombre + instrucciones limitadas + modo + modelo sugerido; CRUD simple, copiar/restablecer, sin conceder permisos extra por texto.
- **Hecho cuando**: editar y reutilizar una plantilla modifica realmente la conducta sin desplegar código.

### G7 — Diagnóstico pasivo y autorreparación acotada
- Aprovechar logs/eventos existentes, clasificar incidentes con códigos estables: modelo no disponible, herramientas ausentes, fallo shell, tests fallidos, sesión bloqueada, latencia, persistencia y exceso de reintentos.
- Agrupar incidencias iguales con conteo, primera/última aparición, causa sospechada, evidencia, estado y acción. No guardar prompts ni claves íntegros.
- Reintentar fallos transitorios hasta un límite pequeño; detener bucles idénticos; no reintentar tests determinísticamente rotos sin modificar causa.
- Las reparaciones de código ocurren en rama y se verifican antes de ofrecer integración; no desplegar por sí mismo un fix a producción.
- **Hecho cuando**: fallo real queda registrado aunque el modelo no lo explique, y una incidencia repetida no genera una cadena de parches equivalentes.

### G8 — Proyectos CDF CLOUD y WorkBench
- Configurar repositorios por separado; impedir que una sesión escriba fuera de su proyecto seleccionado.
- Probar en ramas nuevas: leer, modificar un archivo no canónico de ejemplo, compilar/probar y producir PR borrador. Prohibir escrituras a fuentes narrativas oficiales y a producción.
- **Hecho cuando**: ambas pruebas muestran repositorio correcto, diff correcto, regresiones ausentes y recuperación.

### G9 — Endurecimiento mínimo y entrega
- Eliminar adaptadores reemplazados por OpenCode nativo, código muerto, dependencias duplicadas, flags incompatibles y documentación temporal, **solo después** del reemplazo comprobado.
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

**Implementado en rama**: comprobación repetible (PR #28), selección de modelos limitados, mensajes de fallo, timeout, fixture rojo→verde verificado externamente en lógica, tests y documentación de arquitectura.

**Validación pendiente**: ejecutar el fixture por el modelo en el Worker con sesión autenticada, registrar herramientas reales y demostrar desarrollo del repositorio. Ningún test de unidad sustituye esto.

**Prohibido declararse V1 completa** mientras falten G1, G2, G4, G8 y las pruebas E2E. Este archivo es una guía de ejecución y evidencia, no una afirmación de características terminadas.
