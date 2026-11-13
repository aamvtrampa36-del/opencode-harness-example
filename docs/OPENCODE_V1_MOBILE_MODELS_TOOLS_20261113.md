# OpenCode Cloud V1 — Actualización móvil / OpenRouter / herramientas (13-11-2026)

**Estado:** candidata en PR #54 (draft), sin fusión, sin publicación en Producción. G9 continúa cerrado.

## Diagnóstico basado en código y sesiones reales

1. El cliente ofrecía solo cinco `MODEL_PRESETS`; el protocolo y `sockets.ts` rechazaban cualquier ID fuera de esos presets.
2. El plugin `workspace.ts` anunciaba herramientas de un Workspace global y luego rechazaba su ejecución para sesiones de proyecto. Esto produjo los errores observados de `ls` y `find` contra `/bundle`. **El rechazo era una medida de seguridad correcta; ofrecer las herramientas era el problema.**
3. `inspect_linux` exigía que el modelo repitiera exactamente el identificador de proyecto aunque la sesión ya tuviera un scope inmutable. El error `opencode-harness-example` vs `repo-opencode-harness-example` era una selección inválida, no una razón para relajar permisos.
4. La barra de cabecera existente contenía numerosos botones y selectores con scroll horizontal en Android, y la lista de conversaciones ocupaba toda la pantalla.

## Cambios

- **UI móvil:** cajón lateral de conversaciones con fondo oscurecido, barra superior compacta, configuración secundaria desplegable, modelo visible en la barra superior, mensajes centrados, entrada redondeada y consideración de safe area. Mantiene opciones de temas y modos existentes.
- **Modelo:** selección simple de cinco perfiles sin cambiar etiquetas ni IDs; selección avanzada de modelos OpenRouter con búsqueda de catálogo remoto y filtro por soporte `tools`; routers oficiales `openrouter/auto` y `openrouter/auto-code`. Muestra precios por millón de tokens si el catálogo los proporciona, **sin atribuir precio fijo a routers**.
- **Integración:** el modelo avanzado se transmite por WebSocket hasta `handle.setModel({providerID:"openrouter", id})`. El selector se guarda por sesión en el navegador; las plantillas conservan sus presets. El backend comprueba credenciales y, para modelos concretos, pertenencia al catálogo compatible.
- **Seguridad:** API del catálogo con el mismo control Cloudflare Access que el resto del Worker; no transmite claves. El agente con scope ya no recibe herramientas globales de Workspace; `linux` e `inspect_linux` resuelven la identidad de proyecto a partir del scope confiable, rechazando identificadores incompatibles.
- **Compatibilidad:** los formularios legados que envían `project` siguen funcionando si coincide con la sesión, y las selecciones de perfil históricas siguen siendo válidas.

## Evidencia y límites

- Pruebas nuevas: validador de IDs y de catálogo OpenRouter, enrutamiento real hacia `setModel` de sesiones del harness para Auto y Auto Code, denegación sin clave, resolución de proyecto en ámbito correcto y rechazo de IDs cruzados.
- CI en PR #54: `bun test`, vista previa HTTP estática, `tsc --noEmit`, `vite build` e invariantes. **No declarar PASS hasta leer la ejecución correspondiente al HEAD definitivo.**
- La comprobación automática prueba código y empaquetado, pero **no** prueba interacción táctil en Android, costes reales de OpenRouter ni una inferencia pagada. Faltan una revisión humana móvil y una petición de bajo costo con un modelo y Auto Router en sesión autorizada.
- Riesgo conocido: en sesiones con guardia de scope, las herramientas genéricas de Workspace dejan de estar disponibles también cuando el usuario no vincula ningún proyecto. Se priorizan GitHub y Linux aislados; revisar si alguien requiere el flujo antiguo antes de publicar.
- El catálogo usa metadatos públicos de OpenRouter; si su API falla, el selector mostrará error sin exponer secretos. La selección de Auto Router no equivale a un precio fijo; se debe mantener límite de gasto de la clave en el proveedor.
- **No** desplegar esta rama directamente con el `wrangler.jsonc` de producción en Staging. Antes de un ensayo remoto verificar nombres de Worker, bindings y migraciones. Preferible CI y revisión de diseño sin mutaciones de Staging.

## Publicación

No utilizar autorizaciones de G9 como permiso de despliegue. Mantener PR draft hasta concluir las pruebas relevantes, presentar el commit/CI y pedir **autorización explícita para fusionar en main y publicar**. La versión productiva anterior debe permanecer recuperable.
