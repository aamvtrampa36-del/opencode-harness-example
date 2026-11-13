# OpenCode Cloud — Ejecución del hito G2 (9 de noviembre de 2026)

**Dictamen vigente: G2 APROBADO (09-11-2026, 17:43 UTC).** La etapa histórica de este informe recoge el bloqueo original; el acta definitiva de cierre al final prevalece. El agente interno NO llegó a ejecutarse en la prueba G2, porque staging carece de credencial GitHub. No hay código desarrollado por ese agente, commit, PR ni pruebas finales atribuibles a G2. El bloqueo se detectó antes de consumir inferencia, se desactivó el disparador y se retiró la instrumentación temporal.

## 1. Fuentes y alcance

Se recuperaron y leyeron íntegramente el informe maestro `Informe_Integral_OpenCode_Cloud_V1.pdf` (21 páginas/1524 líneas) y `docs/HITO_G1_EJECUCION_2026-11-09.md`, `docs/V1_EXECUTION_PLAN.md` y `docs/ARCHITECTURE_DECISION_2026-11-08.md`, todos accesibles. G1 ya está aprobado mediante dos reparaciones reales independientes; no se reabrió.

**Alcance exclusivo de G2:** un cambio verdadero al repositorio `aamvtrampa36-del/opencode-harness-example` **efectuado por OpenCode Cloud**, con prueba inicial del defecto, herramientas reales, edición, test verde, commit y PR borrador `opencode/*`, sin escritura en producción. El informe maestro indica que G3 corresponde después de G2.

## 2. Estado inicial verificado

- PR #28: borrador sin fusionar, rama `fix/repeatable-agent-verification-20261108`; último commit documentado de G1: `ab60ba8e4575a059f739d63460b909c8980c0ea7`.
- Staging tenía una publicación fuera de orden anterior al último commit, aunque sin Cron y protegido por Cloudflare Access. Se corrigió publicando nueva versión desde el código vigente.
- Producción `opencode-harness-example` se mantuvo en `1d70eb77-316e-408d-bd14-5f19b171dedf`.
- Staging mantiene `G1_DEV_UNLIMITED_CHECKS=true`: no se reimplantaron cuotas diarias internas.
- El repositorio GitHub es público y el puente interno `GitHubBridge` permite acciones `repo/read/branch/write/pr` restringidas a ramas `opencode/*`; requiere una credencial GitHub propia guardada en el Worker o en `PersonalSettings`.

## 3. Incidencia G2 seleccionada

En `src/github.ts`, las acciones `branch` y `pr` toman la rama predeterminada `defaultBranch`. Como tarea de autodesarrollo se seleccionó admitir una referencia base opcional y validada, conservando el comportamiento actual por omisión, con regresiones en `src/github.test.ts`. El agente debía clonar el repo público, demostrar el defecto, corregirlo en Linux, ejecutar tests, registrar la corrección en una rama `opencode/g2-base-ref-20261109` y abrir PR borrador **con sus propias herramientas**.

El supervisor NO implementó esa corrección ni creó la rama/PR de G2.

## 4. Preparación, CI y resultado real

Se creó instrumental **solo de staging**, sin exponer nuevas rutas HTTP:
- `src/server.ts`: método temporal `g2ProofTick()` que comprueba credencial GitHub y autorización al repo antes de iniciar una sesión del Harness; solo habría una sesión y no reintentos infinitos.
- `src/g2-proof-runner.ts`: entrada programada temporal; evento `G2_PROOF_20261109`.
- `wrangler.g1.jsonc`: entrada y Cron temporal de un minuto, con Cloudflare Access y aislamiento intactos.
- Commit `5725b076052b3164141eacb2068dbca60ffd8709` pasó GitHub Actions **#135** y Cloudflare Workers Builds `88fca4d1-4698-4346-861c-1fe0915fb89b` (success).
- Versión de staging desplegada para el intento: `6fdf55f7-6d26-429d-9ba7-e75145b64a0a`; el script publicado contenía el runner y el controlador.
- Los Cron Triggers tardaron en propagarse; se comprobó continuamente su estado, la configuración publicada y los registros reales.

### Evento concluyente

**2026-11-09 16:12:41 UTC:** Cloudflare Workers Observability registró:

```text
G2_PROOF_20261109 {"status":"blocked","reason":"GitHub credential absent from staging settings"}
```

El método revisó tanto `GITHUB_TOKEN` en el entorno como `PersonalSettings.getGitHubKey()` y no encontró ninguno. **No creó una sesión OpenCode ni solicitó inferencia.** Por tanto no hay proveedor/modelo ejecutado, herramientas del agente, test rojo/verde, diff autónomo, commit del agente o PR de G2 que puedan validarse. No afirmar cumplimiento de G2 por el CI del supervisor.

La conexión GitHub del supervisor en ChatGPT es ajena al sistema de OpenCode y no puede sustituirse por una credencial copiada o expuesta. No se realizó bypass de seguridad.

## 5. Limpieza y seguridad

Después de confirmar el bloqueo:
- Se hizo `PUT` al API de Cloudflare para dejar `schedules: []`; respuesta `success:true`.
- Se restauró `wrangler.g1.jsonc` con `main: src/server.ts`, `triggers.crons: []` y observabilidad habitual; commit `6aff4bc9f3059f883aaba0c49c69e2fbc3db777e`.
- Se eliminó el método `g2ProofTick()` de `src/server.ts`; commit `50a8298b944a8c8b431c1e9d36c144f5d891e31f`.
- Se eliminó `src/g2-proof-runner.ts`; commit `8262998e91db4bae3fa40866b05c308f7c6259ea`.
- Las comprobaciones definitivas del despliegue limpio, CI, Cron, Container y producción deben registrarse tras publicar el último commit de este documento.
- No se modificaron `main`, producción, CDF CLOUD ni WorkBench, ni se fusionaron PR. El uso exacto de CPU, builds y recursos Cloudflare no tiene desglose monetario disponible. La verificación previa a inferencia impidió consumo de tokens del modelo para G2.

## 6. Criterios G2 y siguiente operación única

| Criterio | Resultado |
|---|---|
| Fuentes integrales y G1 aprobado | Sí |
| Staging protegido y sin cuotas diarias internas | Sí |
| Incidencia auténtica elegida | Sí, rama base GitHubBridge |
| Credencial GitHub propia y autorización dentro de OpenCode | **No: ausente en staging** |
| Modelo/herramientas ejecutados en G2 | No se inició |
| Código y tests modificados por el agente | No |
| Commit y PR borrador creados por OpenCode | No |
| G2 aprobado | **NO — BLOQUEADO** |

**Siguiente acción imprescindible:** acceder al dominio protegido `https://opencode-g1-staging.cdf-cloud-mvp-20261019.workers.dev`, abrir **Configuración → GitHub**, conectar una credencial propia de GitHub con acceso de lectura y escritura al repositorio `aamvtrampa36-del/opencode-harness-example` y confirmar que la conexión queda activa **en staging**. No introducir claves en el chat ni cambiar la seguridad de Access. Después repetir la única prueba auténtica de G2; el agente debe leer/modificar/testear/commitear/abrir PR. El supervisor valida los resultados de forma independiente.

**Después de aprobar G2:** consultar `docs/V1_EXECUTION_PLAN.md` y abrir **G3: piloto aislado de OpenCode nativo** con comparación de capacidades, costo, mantenibilidad y reversión. No adelantar G3 ante una simple credencial ausente.

## Enlaces

- [PR #28](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/28)
- [Plan V1](https://github.com/aamvtrampa36-del/opencode-harness-example/blob/fix/repeatable-agent-verification-20261108/docs/V1_EXECUTION_PLAN.md)
- [Historial de G1](https://github.com/aamvtrampa36-del/opencode-harness-example/blob/fix/repeatable-agent-verification-20261108/docs/HITO_G1_EJECUCION_2026-11-09.md)


## 7. Verificación de cierre de la intervención (16:18 UTC)

Se validó la limpieza posterior en la rama y en Cloudflare, sin inferir resultados a partir de CI solamente:

- **GitHub Actions #139:** `validate` finalizó con `success` sobre el commit documental de cierre `b4c209cf3525d9dbc4925fa87e8e231386a6a52f`.
- **Cloudflare Workers Builds:** compilación `94f474ab-2e82-4410-a23e-7be634e7dc7e` finalizó `success` para el mismo commit. La versión publicada verificada en staging fue `cb80f76c-7928-4d71-a9b5-0fdb4d94d11d`.
- **Código publicado:** no contiene `G2_PROOF_20261109` ni `g2ProofTick`; mantiene `G1_DEV_UNLIMITED_CHECKS` y la integración GitHub normal.
- **Cron:** `schedules=[]`. **Container:** `active=0`, `starting=0`. **Cloudflare Access:** sigue con una política `allow` en el dominio protegido, sin deshabilitar autenticación.
- **Producción:** `opencode-harness-example` mantiene la versión `1d70eb77-316e-408d-bd14-5f19b171dedf`, sin modificaciones.
- **PR #28:** abierta y en borrador, no fusionada. La PR específica de G2 **no existe** porque OpenCode jamás inició una sesión por falta de credencial. No se reclamó éxito.

**Cierre seguro de la intervención:** la instrumentación temporal está retirada; el hito G2 permanece BLOQUEADO. La única acción previa a reintentarlo es conectar GitHub en el entorno protegido de staging. G3 no debe comenzar todavía.


## Acta definitiva — G2 cerrado (9 de noviembre de 2026)

**G2 APROBADO.** Se verificó la ejecución autónoma de OpenCode Cloud: GitHub y Linux usados por un modelo real, código y pruebas modificados por el agente, dos commits reales y una Pull Request borrador. La antigua falta de credencial y los fallos intermedios no son el estado vigente.

### 1. Reanudación y eventos concretos

- El informe integral `Informe_Integral_OpenCode_Cloud_V1.pdf` (21 páginas, 1524 líneas) y los cuatro documentos obligatorios se comprobaron disponibles y completos antes de intervenir. G1 permaneció cerrado.
- GitHub y OpenRouter se configuraron por el usuario. En staging se verificó con `GitHubBridge` lectura autenticada del repositorio. Se detectó y corrigió en `src/server.ts` el error de Worker `Illegal invocation` sustituyendo el `fetch` sin receptor por una función envoltorio que invoca `globalThis.fetch` de forma válida. Esta reparación corresponde **al supervisor**, no al agente que desarrolló los dos archivos de la PR.
- En un primer ensayo `@cf/openai/gpt-oss-20b` se obtuvo una ejecución sin herramientas. Se evitó repetirla sin cambios; en un ensayo posterior una instrucción breve consiguió `github: completed`, pero la instrucción de trabajo no continuó las herramientas.
- Se utilizó un modelo económico con capacidades de herramientas: `providerID: "openrouter"`, modelo `z-ai/glm-5.3-flash`. La clave OpenRouter estaba configurada, pero `refreshOpenRouter().active` devolvió `false` en la comprobación de registro; por tanto **no se afirma que el conector quedara registrado como activo ni un costo facturado concreto**. La sesión y sus herramientas se verificaron en Cloudflare y GitHub.
- **Sesión definitiva:** `ses_e3e9e8729ffatpooTEb0xeB1yi`. Iniciada a las **17:35:58 UTC** (fase de prueba con GitHub), paso a fase de desarrollo a las **17:36:51 UTC**, y registrada como `completed` a las **17:43:49 UTC** con **12 llamadas completadas**: seis `github` y seis `linux`.
- El historial observable muestra lecturas GitHub y llamadas Linux durante el trabajo. La entrega resultante se encuentra en GitHub, y no se generó código equivalente por el supervisor.

### 2. Contribución auténtica del agente

- **Rama creada por OpenCode:** `opencode/g2-base-ref-20261109`, desde `main`, sin modificar `main`.
- **PR #29:** [fix: selectable base refs in GitHubBridge](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/29), creada **17:43:10 UTC**, `draft=true`, `state=open`, `merged=false`; base `main`.
- **Commit HEAD:** `d303dfe7c2edb6cad969023af07d014b1f091586`. Comparación independiente: **dos commits** respecto de `main`, cero commits por detrás, **dos archivos cambiados y ningún otro**:
  - `src/github.ts`: 31 líneas añadidas y 9 eliminadas. La acción `branch` acepta una rama base opcional validada para obtener el SHA de origen; la acción `pr` acepta una rama base opcional validada. Si se omite, ambas preservan `default_branch`. La escritura continúa restringida a ramas `opencode/*`.
  - `src/github.test.ts`: 33 líneas añadidas y una eliminada. Casos de rama base explícita, referencias inseguras rechazadas antes del HTTP y comportamiento predeterminado conservado.
- Los blobs registrados en GitHub (`33bedaac03430aadb56e8a3f446cf37ff5b694c9` y `3d8bceb270a97c3c1357bad0f0bcf5365e50c244`) coinciden con las versiones presentes en la PR.
- La descripción de la PR escrita por el agente documenta prueba previa **roja** (`5 pass / 1 fail`, salida 1) y prueba posterior **verde** (`6 pass / 0 fail`, 33 expectativas) ejecutadas con `npx --yes bun@1.4.4 test src/github.test.ts`. No se inventa una ejecución independiente del test rojo: esa evidencia se atribuye explícitamente a los comandos del agente y su registro de la PR.

### 3. Comprobaciones independientes y seguridad

- **GitHub Actions #147:** `completed/success` para el commit `d303dfe7c2edb6cad969023af07d014b1f091586`: pruebas unitarias, servidor de preview real, typecheck, compilación Worker/cliente e invariantes de seguridad, todos exitosos.
- La comparación GitHub `main...opencode/g2-base-ref-20261109` confirma el diff acotado. El supervisor inspeccionó la validación de `refChecked()`, el uso de `input.ref`, la restricción de ramas de revisión y los tests añadidos; no escribió ni una línea de la corrección que se atribuye a OpenCode.
- La PR permanece borrador, no fusionada, y no se desplegó en producción. Se respetó el techo externo configurado por el usuario de **US$2 diarios de OpenRouter**; no se modificó ni eludió ese control. El costo real exacto no fue recuperado.
- El Cron temporal se desactivó por Cloudflare API (`schedules: []`) al recuperar la sesión terminada, que había continuado registrando `completed` cada minuto. Su eliminación previene invocaciones redundantes; el Container no tenía instancias activas.
- La instrumentación de G2 fue eliminada de la rama de staging: `wrangler.g1.jsonc` restaurado a `main: "src/server.ts"` y `crons: []`, retirado `g2SelfDevTick()` de `src/server.ts` y eliminado `src/g2-selfdev-runner.ts`. Los cambios corresponden al supervisor y no a la rama `opencode/*`.
- Se mantuvo `G1_DEV_UNLIMITED_CHECKS=true` exclusivamente en staging (sin cuotas internas diarias), junto a Cloudflare Access y controles de seguridad. Las conexiones GitHub y OpenRouter del usuario no se tocaron.
- Después de la publicación de este documento se comprueba nuevamente CI, versión activa de staging, Cron, Containers, Access y versión de producción. No confundir un despliegue de documentación con una modificación de producción.

### 4. Dictamen y transición

| Requisito G2 | Dictamen |
|---|---|
| Modelo real en OpenCode y herramientas GitHub + Linux | **Aprobado**: 12 llamadas completadas |
| Inspección de código, regresión roja y verde | **Aprobado**: evidencia del agente; resultado verde respaldado por CI |
| Corrección real propia, sin simulación del supervisor | **Aprobado**: 2 commits y diff en rama creada por el agente |
| PR borrador auténtica y no fusionada | **Aprobado**: [PR #29](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/29) |
| Tests y validación independientes | **Aprobado**: GitHub Actions #147 |
| Producción intacta y aislamiento | **Aprobado**: despliegue solo de staging, protección conservada |
| Instrumental temporal retirado | **Completado en rama**, verificación final remota a continuación |

**G2 queda cerrado.** La contribución del agente demuestra autodesarrollo real; la variabilidad de sesiones y el registro de OpenRouter se dejan como observaciones, no motivos para repetir G2 después de cumplir el criterio.

**Siguiente hito único conforme a `docs/V1_EXECUTION_PLAN.md` y a la decisión arquitectónica:** **G3 — comparar Workerd/Harness con OpenCode nativo en un Container Linux aislado**. Ejecutar la misma tarea de reparación y contrastar herramientas, recuperabilidad, complejidad de mantenimiento, costo y reversibilidad. Elegir un motor por evidencias; no cambiar producción ni eliminar el actual sin una ruta de reversión validada.

**Enlaces:** [PR #29](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/29) · [CI #147](https://github.com/aamvtrampa36-del/opencode-harness-example/actions/runs/42667355172) · [Plan V1](https://github.com/aamvtrampa36-del/opencode-harness-example/blob/fix/repeatable-agent-verification-20261108/docs/V1_EXECUTION_PLAN.md).
