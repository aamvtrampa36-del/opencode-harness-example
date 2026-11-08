# Preparación de OpenCode para CDF — 2026-11-08

## Estado y arquitectura
- **Runtime existente:** OpenCode v2 experimental embebido en un Cloudflare Durable Object SQLite, con Workers AI y herramientas de Workspace. No hay sistema Linux, shell, npm ni ejecutor de compiladores.
- **Interfaz:** Worker y React; sesión WebSocket; reanudación y persistencia mediante el SDK. Los objetos se asignan actualmente por UUID aleatoria de cada navegador guardada en localStorage: **no sincroniza automáticamente sesiones entre distintos dispositivos**.
- **Producción:** `opencode-harness-example.cdf-cloud-mvp-20261019.workers.dev`; protegido por Cloudflare Access para el propietario, sesión 720 h y rutas de prueba deshabilitadas.
- **Modelo gratuito preexistente:** `@cf/moonshotai/kimi-k2.7-code` por el binding Workers AI. El uso de Workers AI puede cobrarse y no debe considerarse gratis.
- **Propuesta en esta rama:** secreto privado opcional para OpenRouter, descubrimiento nativo de modelos cuando hay secreto, selección desde interfaz, validación de presets en el servidor y condiciones de seguridad para CDF.

## Activar OpenRouter SIN copiar la clave a conversaciones ni a GitHub
1. En https://openrouter.ai/settings/keys crea **una clave nueva dedicada** llamada `cdf-opencode`.
2. Establece un **límite de gasto bajo** para esa clave (sugerencia inicial US$ 2-5), si la interfaz actual de OpenRouter lo permite. Usa límites del proveedor como barrera de facturación; un aviso en el chat NO es un límite.
3. Abre https://dash.cloudflare.com/?to=/:account/workers-and-pages y selecciona `opencode-harness-example`.
4. Busca **Settings → Variables and Secrets → Add**. Agrega un **Secret** (no un campo de texto público) llamado **`OPENROUTER_API_KEY`**, pega la clave allí y guarda.
5. Ten en cuenta que guardar secretos puede crear un nuevo despliegue. Verifica que se conserve la política Cloudflare Access y `preview_urls: false`.
6. La nueva versión del código solo debe activarse si ha pasado TypeScript, build y pruebas. Cuando esté desplegada, abre OpenCode y comprueba que el selector muestra las opciones de OpenRouter. Si no, revisa registros sin imprimir secretos.
7. Ejecuta una prueba mínima con un modelo económico y consulta el uso real en OpenRouter; no pruebes primero el modelo premium.

**Nota:** el conector ChatGPT OpenRouter puede mostrar créditos, pero ello no entrega ni sincroniza automáticamente un API key con Cloudflare.

## Presets previstos
- **Cloudflare · Kimi K2.7**: recurso ya existente y alternativa cuando falta OpenRouter.
- **Económico · DeepSeek V4.1 Flash 1017** (`openrouter/deepseek/deepseek-v4.1-flash-1017`): tareas repetitivas y código ligero.
- **Avanzado · Gemini 4 Argon** (`openrouter/google/gemini-4-argon`): tareas complejas; modelo caro, usar únicamente cuando sea necesario.
- **Creativo · Gemini 3.8 Flash** (`openrouter/google/gemini-3.8-flash`): narrativa y análisis.

Las tarifas son variables: consulta el catálogo real de OpenRouter antes de ampliar uso. Las opciones de OpenRouter quedan deshabilitadas en UI hasta configurar un secreto; el servidor también valida cada selección.

## Procedimiento de prueba
- `bun install`
- `bun run typecheck`
- `bun run build`
- `bun scripts/check-invariants.mjs`
- Validar a través de navegador autenticado: creación de archivo, lectura, modificación, ejecución de módulo JavaScript y clonación de repositorio público permitido.
- Validar la selección OpenRouter únicamente después de configurar el secreto: una llamada económica, una herramienta de lectura y comparación de saldo antes/después.
- Recargar la página y verificar continuidad de sesión. Probar desde el mismo navegador, **no otro dispositivo**, hasta implementar migración/compartición segura de identidad de Durable Object.
- Confirmar que el Worker de OpenCode y las aplicaciones productivas CDF WorkBench/CDF CLOUD no cambien por accidente.

## Límites y próximas mejoras
**Aún NO equivalentes a Codex:**
- Compilar proyectos y ejecutar shells/npm/test suites reales → hace falta **Sandbox/Containers** separado; estimar gasto real antes de desplegar.
- Push a repositorios privados, ramas y pull requests desde el agente → crear credenciales GitHub con permisos mínimos y un conector de escritura con aprobaciones, no introducir tokens personales en prompts.
- MCP CDF CLOUD y WorkBench → identificar URLs, tipo de autenticación y permisos del MCP. No asumir que los conectores disponibles en ChatGPT están automáticamente disponibles en OpenCode.
- Sincronización entre móviles/PC y acceso vía CLI a la misma sesión → requiere diseño explícito de identidad y migración para no perder las sesiones ya creadas.
- Presupuesto, contadores de costo y hard caps dentro de OpenCode → actualmente la protección exigible es un límite por clave OpenRouter. Evaluar telemetría agregada sin registrar contenido privado.
- Backups exportables de Durable Object y documentos → requiere un flujo verificado de snapshot a almacenamiento separado.

## Normas de operación
Ningún modelo ni plugin debe alterar producción de CDF, canonizar obras, publicar capítulos, borrar originales o elevar gastos de forma automática. Los cambios en código, sin embargo, pueden implementarse en ramas de desarrollo autorizadas sin un flujo de aprobaciones excesivo.

## Criterio de salida
No confundir **configurado**, **compilado**, **desplegado** y **probado en funcionamiento**. Registrar por separado las cuatro condiciones y enlazar los resultados de las pruebas. El usuario puede empezar a utilizar el ejemplo actual, pero **no** debe considerarse sustituto completo de Codex antes de una prueba de desarrollo real con Linux y GitHub.
