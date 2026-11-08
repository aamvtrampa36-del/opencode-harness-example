# OpenCode Cloud — Uso, evidencias y límites (2026-11-08)

**Aplicación:** https://opencode-harness-example.cdf-cloud-mvp-20261019.workers.dev

## Primera aplicación desde el teléfono o PC

1. Entra por Cloudflare Access con tu cuenta autorizada.
2. Pulsa **Crear app** y sustituye **[describe aquí tu app]** por tu idea.
3. Escoge el modelo: sin OpenRouter configurado, utiliza Cloudflare GPT-OSS 20B; con OpenRouter, **Económico · DeepSeek Flash** como valor predeterminado.
4. Envía el mensaje. El agente puede usar **linux** para crear archivos, instalar dependencias, compilar y ejecutar pruebas.
5. Cuando complete la compilación dentro de \`/workspace/projects/<slug>/dist/\`, pulsa **Ver app**. La vista previa solo sirve el directorio de compilación y está protegida dentro de la web autenticada.
6. Pulsa **Descargar** para obtener un \`.tar.gz\` de los archivos. Se excluyen .git, node_modules, .env, llaves y certificados comunes. **Revisa el paquete** si tus archivos contienen otros secretos.

La interfaz es una web autónoma: ChatGPT no tiene que estar conectado para ejecutar el agente, pero se necesita una clave propia de modelo si se quiere usar OpenRouter.

## Conectar OpenRouter de forma privada — una única configuración

1. Crea una clave de API dedicada en https://openrouter.ai/settings/keys .
2. Define un límite inicial de gasto **US$ 2–5** directamente en el proveedor si tu cuenta ofrece esa opción.
3. En OpenCode abre **Configurar → OpenRouter** e introduce la clave en el campo privado. El Worker la valida sin mostrarla ni guardarla en el navegador.
4. Cuando el panel lo indique, actualiza la sesión y selecciona un modelo económico. Consulta el consumo directamente en Configurar.

La conexión OpenRouter es nativa de OpenCode y **no utiliza el plugin OpenRouter de ChatGPT**.

## Conectar GitHub directamente — una única configuración

1. En https://github.com/settings/personal-access-tokens/new crea un **fine-grained personal access token** restringido a los repositorios \`cdf-cloud-engine\`, \`CDF-WorkBench-\` y \`opencode-harness-example\`.
2. Permisos mínimos: **Contents: Read and write**, **Pull requests: Read and write**, **Metadata: Read** (este último suele estar incluido).
3. En OpenCode abre **Configurar → GitHub** y pega el token en el campo privado; solo se acepta el propietario autorizado.
4. La herramienta **github** puede leer archivos, crear ramas `opencode/*`, escribir archivos de texto y preparar pull requests en borrador sin compartir el token con Linux.

La herramienta no puede fusionar PR, borrar repositorios ni escribir directamente a \`main\` o \`master\`. Solo admite tres repositorios autorizados, con rutas de archivos validadas y 100 KB de límite por archivo.

## Evidencias de pruebas reales

- Cloudflare Observability: \`OPENCODE_LINUX_SMOKE_V1\` => **pass**. Node/npm, una prueba Node, instantánea, destrucción, restauración y segunda prueba: salida 0.
- Cloudflare Observability: \`OPENCODE_LIVE_PREVIEW_V1\` => **pass**. npm install/test/build 0, HTML compilado servido por Container con HTTP 200, descarga gzip HTTP 200 y contenido esperado.
- Cloudflare Observability: \`OPENCODE_GIT_SMOKE_V1\` => **pass**. Git 2.47.3, git init/add/commit/log con salida 0.
- GitHub Actions revisa por PR pruebas de Bun, TypeScript, compilación, aislamiento de HTTP/archivos, descarga gzip y reglas GitHub.

La prueba de GitHub nativo por ahora utiliza un HTTP simulado: **no es una conexión autenticada real**. Las pruebas de una conversación de modelo desde la interfaz autenticada tampoco han podido realizarse sin credenciales externas de navegador/API.

## Persistencia y seguridad

- Mensajes y herramientas del OpenCode Harness: Durable Objects SQLite.
- Archivos de proyecto Linux: snapshots del sistema de archivos (beta), guardados periódicamente antes de suspender el Container.
- **Advertencia importante:** Cloudflare indica que las instantáneas caducan a los **30 días** desde creación o última restauración; no constituyen una copia independiente permanente.
- La opción **Descargar** es una copia manual recuperable, no un servicio de respaldo periódico.
- Todas las URL principales permanecen bajo Cloudflare Access; las URLs de previsualización Worker independientes están deshabilitadas.
- El Container no recibe las claves de OpenRouter ni GitHub desde el Worker.

## Costos y restricciones

- Workers Paid: **US$ 5/mes**, existente.
- Container \`basic\`: 1/4 vCPU, 1 GiB RAM y 4GB disco; cobra cuando está encendido.
- Asignación mensual de Workers Paid, compartida por todos los Containers de la cuenta: 25 GiB-h RAM, 375 vCPU-min CPU activo, 200 GB-h disco.
- Exceso: RAM US$0.0000025 por GiB-segundo; CPU US$0.000020 por vCPU-segundo; disco US$0.00000007 por GB-segundo. Tráfico saliente y otros productos se cobran aparte. Precios consultados en https://developers.cloudflare.com/containers/platform/pricing/ .
- Ejemplo **solo ilustrativo** si el *basic* fuera el único Container: ~25 h/mes puede caber en las asignaciones de RAM/disco; ~240 h/mes a CPU activa 20% podrían añadir ~US$2.5 por memoria/disco/CPU, mientras al 100% CPU añadirían ~US$6; no incluye red/modelos ni otros servicios.
- Cada instrucción de Linux tiene tope de 180 s: los trabajos prolongados necesitan dividirse y no hay todavía una cola totalmente autónoma persistente.
- OpenRouter y GitHub se conectan mediante **Configurar** usando claves del usuario. No hace falta editar Cloudflare manualmente; las llamadas autenticadas todavía requieren prueba con credenciales.
- Todavía no hay integración MCP propia con CDF CLOUD/WorkBench, ni copia periódica independiente, ni prueba de navegación en dos dispositivos. Los modos de agentes son sesiones nativas, no orquestación completa ni caché de repositorios versionada.

La plataforma está mejorada y demostrada para ejecución de código, pruebas, vista previa, Git local y recuperación básica, **pero todavía no es una sustitución completa de Codex Cloud**. No presentar como "100%" hasta completar y probar conectores, modelo, navegación y recuperación prolongada.
