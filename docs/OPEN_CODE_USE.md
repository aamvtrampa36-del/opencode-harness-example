# OpenCode Cloud — Uso, evidencias y límites (2026-11-17)

**Aplicación:** https://opencode-harness-example.cdf-cloud-mvp-20261019.workers.dev

## Arquitectura y límites de producto

**Esta web no es la interfaz nativa del OpenCode CLI.** Es una integración personal del motor **OpenCode 2.0.24 Workerd** mediante el **OpenCodeHarness experimental** de Cloudflare. La ejecución Linux, el panel web, GitHub, la administración de proyectos y los respaldos pequeños son módulos propios. La aceptación del 17 de noviembre verificó en Staging modelo → herramienta Linux → archivos → vista previa en tres proyectos separados.

En un ensayo separado, el ejecutable nativo **OpenCode CLI 1.19.5** arrancó mediante `opencode serve` y expuso `/doc` en GitHub Actions. Esto verifica la viabilidad inicial de su servidor, **no** una migración ni la equivalencia de los SDK 1.x y 2.x, y tampoco valida herramientas de IA en un proyecto real. La instalación actual sigue intacta.

Para reproducibilidad, el repositorio debe mantener `bun.lock` y ejecutar `bun install --frozen-lockfile`. Las dependencias directas deben permanecer fijadas a versiones probadas; las actualizaciones se realizan en PR separados, con regresiones, nunca en cada despliegue incidental.

## Primera aplicación desde el teléfono o PC

1. Entra por Cloudflare Access con tu cuenta autorizada.
2. Pulsa **Crear app** y sustituye **[describe aquí tu app]** por tu idea.
3. Escoge el modelo sencillo de **Cloudflare** para pruebas gratuitas, o selecciona en OpenRouter un modelo concreto compatible con herramientas. La ruta gratuita de OpenRouter puede agotarse por cuota diaria.
4. Envía el mensaje. En proyectos, la herramienta **linux** ya empieza en la raíz del proyecto; usa rutas relativas, por ejemplo `dist/index.html`.
5. Pulsa **Ver app** solo después de que la vista previa responda HTTP 200 y muestre el contenido esperado. No uses `/bundle` ni rutas absolutas: ese árbol no es el Container Linux del proyecto.
6. Pulsa **Descargar** para obtener un `.tar.gz` de los archivos. Se excluyen .git, node_modules, .env, llaves y certificados comunes. **Revisa el paquete** si tus archivos contienen otros secretos.

La interfaz es una web autónoma: ChatGPT no tiene que estar conectado para ejecutar el agente, pero se necesita una clave propia de modelo si se quiere usar OpenRouter.

## Conectar OpenRouter de forma privada — una única configuración

1. Crea una clave de API dedicada en https://openrouter.ai/settings/keys .
2. Para mantener la prueba sin gasto, usa un modelo gratuito si está disponible. No compres créditos solo porque se agote la cuota diaria gratuita.
3. En OpenCode abre **Configurar → OpenRouter** e introduce la clave en el campo privado. El Worker la valida sin mostrarla ni guardarla en el navegador.
4. Cuando el panel lo indique, actualiza la sesión y selecciona un modelo económico. Consulta el consumo directamente en Configurar.

La conexión OpenRouter es nativa de OpenCode y **no utiliza el plugin OpenRouter de ChatGPT**.

## Conectar GitHub directamente — una única configuración

1. En https://github.com/settings/personal-access-tokens/new crea un **fine-grained personal access token** restringido a los repositorios `cdf-cloud-engine`, `CDF-WorkBench-` y `opencode-harness-example`.
2. Permisos mínimos: **Contents: Read and write**, **Pull requests: Read and write**, **Metadata: Read** (este último suele estar incluido).
3. En OpenCode abre **Configurar → GitHub** y pega el token en el campo privado; solo se acepta el propietario autorizado.
4. La herramienta **github** puede leer archivos, crear ramas `opencode/*`, escribir archivos de texto y preparar pull requests en borrador sin compartir el token con Linux.

La herramienta no puede fusionar PR, borrar repositorios ni escribir directamente a `main` o `master`. Solo admite tres repositorios autorizados, con rutas validadas y 100 KB para escrituras completas. En OpenCode Staging permite reemplazar un fragmento único en un archivo de hasta 128 KB, si se proporciona el HEAD actual de la rama y fragmentos de hasta 8192 bytes.

## Evidencias de pruebas reales

- Cloudflare Observability: `OPENCODE_LINUX_SMOKE_V1` => **pass**. Node/npm, una prueba Node, instantánea, destrucción, restauración y segunda prueba: salida 0.
- Cloudflare Observability: `OPENCODE_LIVE_PREVIEW_V1` => **pass**. npm install/test/build 0, HTML compilado servido por Container con HTTP 200, descarga gzip HTTP 200 y contenido esperado.
- Cloudflare Observability: `OPENCODE_GIT_SMOKE_V1` => **pass**. Git 2.47.3, git init/add/commit/log con salida 0.
- GitHub Actions revisa por PR pruebas de Bun, TypeScript, compilación, aislamiento de HTTP/archivos, descarga gzip y reglas GitHub.

El propietario confirmó antes de esta aceptación una lectura real de `package.json` mediante GitHub. Esta corrida no hizo escrituras en GitHub ni volvió a probar el conector.

## Aceptación y lecciones prácticas (2026-11-17)

- Staging sirvió la versión `6f337801-5cd2-4ba0-b7a6-b14ce7f234af` al 100 % durante la prueba de proyectos y conectores; la versión `c15c5630-b386-4ecf-bf21-f12ccad199dd` estuvo al 100 % durante la prueba móvil final. Los resultados y el commit vigente se registran en la PR #58.
- Playwright en 393 × 852 verificó conversaciones, reconexión, selector de modelos y ausencia de desbordamiento horizontal. Una tarea real siguió ejecutándose mientras se leía arriba, la barra superior y el compositor permanecieron visibles, se cambió de conversación y se recuperó el resultado Linux.
- Tres aplicaciones distintas se crearon en tres proyectos Linux; cada una produjo `dist/index.html` y una vista previa HTTP 200 con su título esperado.
- CDF WorkBench Staging completó lecturas de estado, catálogo y documentación con sus herramientas MCP de solo lectura. La herramienta de lectura falló en un intento y el siguiente terminó correctamente; el primer error no quedó capturado en el informe de la prueba.
- TokenEconomizer ejecutó cuatro `SessionEnd` reales y devolvió 156 caracteres de contexto aprendido en el siguiente turno. Linux informó `pytest` ausente con salida 127 mientras `node --test` pasó. El adaptador ahora extrae `exitCode` del JSON Linux y lo entrega como `isError`/`exit_code` al hook y como error en su transcripción.
- GitHub Actions pasó 304 pruebas en 52 archivos, TypeScript, build, vista previa estática e invariantes (`44005814547`). La corrida de CDF/proyectos fue `44004506241`; TokenEconomizer, `44003403812`; la prueba móvil en segundo plano, `44005832338`.
- Monte Carlo de 100.000 muestras, prior Beta(1,1): con 3/3 proyectos aprobados, la media posterior de éxito por proyecto fue 80 % (intervalo creíble 95 %: 40–99 %) y la probabilidad predictiva de aprobar otros tres seguidos fue 57 %. Con 4/4 sesiones TokenEconomizer, la media fue 83 % (48–99 %) y la probabilidad predictiva de aprobar otras cuatro seguidas fue 56 %. La muestra es pequeña y correlacionada; sirve para mostrar incertidumbre, no para prometer fiabilidad estadística.
- Cloudflare Analytics registró 7.570 neuronas usadas de la asignación diaria gratuita de 10.000 al cerrar la aceptación; el dato es de cuenta y puede incluir otros usos. La aceptación no generó gasto en OpenRouter.
- El selector guardó Auto Router, Auto Code, OpenRouter Free, un modelo concreto y el regreso al perfil sencillo. El propietario ya había confirmado una ejecución real con AutoRouter; no se repitieron llamadas OpenRouter porque la cuota gratuita estaba agotada.

Hallazgos que evitan regresiones:

1. En una sesión de proyecto, **linux** obtiene el proyecto desde la sesión confiable y su directorio actual ya es la raíz autorizada. Usa rutas relativas. `/bundle` pertenece a otro entorno y los archivos escritos allí no aparecen en la vista previa del Container.
2. La herramienta compartida `execute` no pertenece al proyecto; se oculta en sesiones vinculadas y se conserva en sesiones globales. Usa **linux** para las operaciones Linux y revisa su `exitCode`, no solo el estado de la llamada.
3. Un comando Linux puede devolver una llamada de herramienta completada con `exitCode` no cero. TokenEconomizer debe leer ese valor del JSON para aprender correctamente los fallos de shell.
4. Para probar Node en el Container administrado, usa una aserción directa o exportaciones compatibles de `node:assert`; el import por defecto usado en un primer fixture no ofrecía `assert.equal`.
5. Comprueba la vista previa por HTTP y por contenido; la respuesta del agente o una tarjeta de herramienta terminada no bastan como prueba de que el artefacto quedó en el proyecto correcto.

CDF CLOUD Producción no se validó en esta aceptación: su OAuth mostró `CDF_OAUTH_TEMPORARILY_UNAVAILABLE`. El propietario indicó que ese fallo temporal no impide el funcionamiento restante. No se afirma que CDF CLOUD esté conectado.

## Persistencia y seguridad

- Mensajes y herramientas del OpenCode Harness: Durable Objects SQLite.
- Archivos de proyecto Linux: snapshots del sistema de archivos (beta), guardados periódicamente antes de suspender el Container.
- **Advertencia importante:** Cloudflare indica que las instantáneas caducan a los **30 días** desde creación o última restauración; no constituyen una copia independiente permanente.
- **Descargar** exporta el proyecto manualmente. En **Proyectos → Guardar respaldo** existe una copia adicional en Durable Object para archivos de hasta 2 MiB comprimidos. No incluye restauración automática, no reemplaza el respaldo fuera de Cloudflare ni protege proyectos mayores.
- Todas las URL principales permanecen bajo Cloudflare Access; las URLs de previsualización Worker independientes están deshabilitadas.
- El Container no recibe las claves de OpenRouter ni GitHub desde el Worker.

## Costos y restricciones

- Workers Paid: **US$ 5/mes**, existente.
- Container `basic`: 1/4 vCPU, 1 GiB RAM y 4GB disco; cobra cuando está encendido.
- Asignación mensual de Workers Paid, compartida por todos los Containers de la cuenta: 25 GiB-h RAM, 375 vCPU-min CPU activo, 200 GB-h disco.
- Exceso: RAM US$0.0000025 por GiB-segundo; CPU US$0.000020 por vCPU-segundo; disco US$0.00000007 por GB-segundo. Tráfico saliente y otros productos se cobran aparte. Precios consultados en https://developers.cloudflare.com/containers/platform/pricing/ .
- Ejemplo **solo ilustrativo** si el *basic* fuera el único Container: ~25 h/mes puede caber en las asignaciones de RAM/disco; ~240 h/mes a CPU activa 20% podrían añadir ~US$2.5 por memoria/disco/CPU, mientras al 100% CPU añadirían ~US$6; no incluye red/modelos ni otros servicios.
- Cada instrucción de Linux tiene tope de 180 s: los trabajos prolongados necesitan dividirse y no hay todavía una cola totalmente autónoma persistente.
- OpenRouter y GitHub se conectan mediante **Configurar**. No hace falta editar Cloudflare manualmente. El catálogo de OpenRouter puede estar disponible aunque la cuota gratuita del proveedor se haya agotado.
- CDF WorkBench Staging sí tuvo lectura real en esta aceptación; CDF CLOUD Producción no, por su error OAuth temporal descrito arriba. No hay respaldo automático de proyectos grandes ni prueba de navegación en dos dispositivos. Los modos de agentes utilizan sesiones nativas; no constituyen caché de repositorios versionada.

OpenCode Cloud queda verificado para el uso personal probado: chat móvil, ejecución Linux aislada, vista previa, aprendizaje de TokenEconomizer y lectura de CDF WorkBench. La aceptación no certifica recuperación prolongada, generación real de imágenes, escritura/PR de GitHub, ni CDF CLOUD Producción; no los presentes como verificados.

## Incidentes del runner y mantenimiento

- [Informe histórico del 21-11-2026, con actualización de estado](OPEN_CODE_TOOL_FAILURES_2026-11-21.md): hechos, riesgos y mitigaciones; no es un PASS de concurrencia.
- [Evidencia original de OpenCode, tarea 0a62c322d8f44b8d](opencode-remote-control-e2e/0a62c322d8f44b8d.md): límites del contrato MCP histórico y reconciliación posterior.
- [SANEAMIENTO-01](maintenance/SANEAMIENTO_01.md): equivalencias de PR y límites de integración/despliegue.
