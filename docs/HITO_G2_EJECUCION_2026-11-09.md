# OpenCode Cloud — Ejecución del hito G2 (9 de noviembre de 2026)

**Dictamen vigente: G2 BLOQUEADO, NO APROBADO.** El agente interno NO llegó a ejecutarse en la prueba G2, porque staging carece de credencial GitHub. No hay código desarrollado por ese agente, commit, PR ni pruebas finales atribuibles a G2. El bloqueo se detectó antes de consumir inferencia, se desactivó el disparador y se retiró la instrumentación temporal.

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
