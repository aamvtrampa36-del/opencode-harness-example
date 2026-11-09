# OpenCode Cloud — G3: selección arquitectónica V1 (2026-11-09)

**Dictamen: G3 APROBADO BAJO ALCANCE REVISADO.** Se selecciona la arquitectura actualmente funcional **Workerd/Harness (A)** para la V1. **No se ejecutó ni se aprobó una comparación A/B con OpenCode nativo**: el titular comunica que su instalación no es posible en el entorno disponible. La decisión afirma suficiencia probada de A para avanzar, no superioridad frente a B.

## 1. Fuentes obligatorias recuperadas

Se accedió y leyó íntegramente el **Informe técnico integral — OpenCode Cloud V1** (21 páginas/1.524 líneas), `docs/HITO_G1_EJECUCION_2026-11-09.md`, `docs/HITO_G2_EJECUCION_2026-11-09.md`, `docs/V1_EXECUTION_PLAN.md` y `docs/ARCHITECTURE_DECISION_2026-11-08.md`.

El plan maestro original exigía para G3 instalar `opencode serve`/web nativo en Container y comparar A contra B. **Ese criterio se sustituyó explícitamente por una decisión arquitectónica justificada sobre A** debido a la restricción comunicada. No se simuló ni se documentó como superada la comparación original.

## 2. Estado inicial verificado

- Repositorio: `aamvtrampa36-del/opencode-harness-example`; rama de desarrollo: `fix/repeatable-agent-verification-20261108`, PR #28 abierta como borrador, sin fusionar. PR #29 del agente, rama `opencode/g2-base-ref-20261109`, también abierta como borrador, sin fusionar.
- Evidencia G1: dos reparaciones reales independientes de `calc.mjs` en Linux, prueba inicialmente fallida, edición del agente, test verde y verificación independiente; referencia: acta final de G1.
- Evidencia G2: sesión `ses_e3e9e8729ffatpooTEb0xeB1yi`, 6 llamadas GitHub + 6 Linux, dos commits auténticos, diff limitado a `src/github.ts` y `src/github.test.ts`, PR #29 de 2026-11-09 17:43 UTC, commit HEAD `d303dfe7c2edb6cad969023af07d014b1f091586`. GitHub Actions **#147** completó todas las verificaciones (test, preview, typecheck, build e invariantes). La PR no fue fusionada ni desplegada a producción. CI documental de G2 #150 también aprobó.
- Cloudflare comprobado **2026-11-09 21:04:57 UTC**: staging `opencode-g1-staging` versión `44b85bf3-95cd-416f-ba42-935fea958bff`; producción `opencode-harness-example` versión `1d70eb77-316e-408d-bd14-5f19b171dedf`; Cron `[]`, Containers `active:0, starting:0`; Access con política `allow` en el dominio protegido `opencode-g1-staging.cdf-cloud-mvp-20261019.workers.dev`.
- Configuración de staging: `G1_DEV_UNLIMITED_CHECKS=true` (sin cuota interna diaria artificial). El Worker publicado no contiene `G2_SELFDEV_20261109` ni `g2SelfDevTick`; conserva GitHub y el flag de desarrollo. **No se leyeron ni modificaron secretos**.
- Presupuesto externo comunicado de OpenRouter: **US$2/día**. No se eludió ni se establecieron nuevos cupos artificiales. Costo de inferencia y Container exacto: no verificado; no se inventan cifras.

## 3. Arquitectura seleccionada

**A = Cloudflare Worker con Access + OpenCode Workerd/Harness y Durable Objects + Linux aislado por herramienta `linux` en Container bajo demanda + GitHub para ramas/commits/PR y proveedores de inferencia ya conectados.**

**Por qué:** A ha demostrado reparación autónoma y autodesarrollo real, con tests y commits verificables. Ya se encuentra desplegada en staging y bajo controles de identidad y aislamiento. G3 no necesitaba instalar otro motor ni reiterar la inferencia de G1/G2 para demostrar eso.

**Qué NO se concluye:** la arquitectura no está demostrada superior al CLI nativo; este último no pudo evaluarse según la limitación informada por el titular. Tampoco se ha validado durabilidad frente a parada del Container, recuperación de sesiones, funcionamiento móvil completo, los proyectos CDF CLOUD y WorkBench o los E2E finales. Son trabajo de G4–G9.

**Riesgos residuales y destino:**
- Discos y estado de Container no son respaldo independiente; snapshots de retención limitada tampoco sustituyen un backup: **G4**.
- Cambios en UX y reconexión del usuario: **G5**.
- Plantillas, incidentes pasivos y confiabilidad estadística de herramientas/modelos: **G6–G7**.
- Repositorios y datos protegidos de CDF CLOUD y WorkBench: **G8**.
- Entrega completa, rollback, pruebas E2E y mantenimiento: **G9**.
- Instalación y comparación del motor nativo **solo si** la restricción desaparece y una necesidad verificable justifica evaluar B. No es un gate de la V1 actual.

## 4. Cambios realizados y pruebas de aceptación

- **`docs/V1_EXECUTION_PLAN.md`:** se actualizó el alcance/estado de G3, arquitectura de V1, estado del proyecto, condición de limpieza de G9 y transición a G4. Commit `bcbb85029173cd54d2a5039c4238df3f6d3bbc55`.
- **`docs/ARCHITECTURE_DECISION_2026-11-08.md`:** se añadió decisión vigente V1; se conservó la propuesta nativa anterior como historial, sin adjudicarle resultados falsos; se aclaró que las pruebas de desarrollo en staging no están sujetas a cuota diaria interna arbitraria. Commit `ca4f5d9ed95aae65e1c88419cfcef97b463a8ffd`.
- **Este documento:** acta de G3, trazabilidad y siguiente prioridad.
- **No se modificaron archivos ejecutables, contratos, secretos ni permisos.** No se instalaron CLI, Containers o servicios. No se iniciaron nuevas sesiones de inferencia; G1/G2 bastaban. No se tocaron PR #29, producción, CDF CLOUD o WorkBench.
- **Validación de GitHub Actions y Cloudflare del commit documental final:** completar una vez que este archivo esté publicado; una validación automatizada de documentos no sustituye las evidencias reales previamente registradas.

| Criterio revisado | Verificación |
|---|---|
| Cinco fuentes completas disponibles | Sí |
| G1/G2 con evidencias independientes auténticas | Sí: reparaciones verificadas, PR #29, CI #147 |
| Staging protegido, seguro, sin recursos temporales | Sí en comprobación previa; validar nuevamente tras publicar |
| Motor nativo no instalable, A/B no evaluado | Registrado con honestidad |
| Selección de A para continuar V1 | Formalizada |
| Plan maestro actualizado sin dependencia B | Sí |
| Producción sin cambios | Confirmado antes de los commits documentales |
| Habilitación de G4 | Sí, no requiere B |

## 5. Siguiente prioridad única: G4 — Persistencia y recuperación

**G4 no se ejecuta durante G3.** La siguiente intervención deberá demostrar recuperación real sin perder trabajo:

1. Preparar un proyecto Linux aislado y un cambio de prueba con checksums, historial Git y metadatos de sesión pertinentes.
2. Guardar una copia **fuera del Container** y verificar sus hashes y lectura. No usar snapshots beta como único respaldo duradero.
3. Detener el entorno de prueba, reiniciarlo y restaurar los archivos, la rama/estado útil y metadatos disponibles.
4. Comparar hashes y ejecutar los tests originales; introducir también un fallo durante escritura y verificar que no deja un estado irrecuperable.
5. Conservar evidencia, costos conocidos y procedimiento reversible. **No tocar producción o fuentes canónicas**.

**Criterio de cierre G4:** estado de proyecto realmente restaurado, archivos y cambios íntegros, tests verdes tras reinicio y ruta de reversión documentada. Si el historial completo de sesiones no es recuperable, distinguirlo de los datos verificados, no prometer continuidad inexistente.

### Referencias verificables

- [PR #28 — trabajo de staging](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/28)
- [PR #29 — autodesarrollo de OpenCode](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/29)
- [GitHub Actions #147 — validación de contribución](https://github.com/aamvtrampa36-del/opencode-harness-example/actions/runs/42667355172)
- [GitHub Actions #150 — cierre G2](https://github.com/aamvtrampa36-del/opencode-harness-example/actions/runs/42682147880)
- [Plan maestro](https://github.com/aamvtrampa36-del/opencode-harness-example/blob/fix/repeatable-agent-verification-20261108/docs/V1_EXECUTION_PLAN.md)
- [Decisión arquitectónica vigente](https://github.com/aamvtrampa36-del/opencode-harness-example/blob/fix/repeatable-agent-verification-20261108/docs/ARCHITECTURE_DECISION_2026-11-08.md)


## 6. Validación final de G3 (2026-11-09 21:09 UTC)

La publicación inicial de esta acta, commit `48254eb7d30f3c6ecabbf5455821f0f010ee31d6`, fue comprobada de forma independiente:

- **GitHub Actions #153**, ejecución `42699654431`: job `validate` con `completed/success` y ninguna etapa fallida.
- **Cloudflare Workers Builds:** build `13af98ed-b58a-4967-beef-5c9dd0fae380`, resultado `success` y commit de origen `48254eb7d30f3c6ecabbf5455821f0f010ee31d6`.
- **Staging activo comprobado tras esa compilación:** versión `5774ef2d-caa6-4ce0-a692-76deee1c7365`. Su código no contiene `g2SelfDevTick` ni `g1ProofTick`, y conserva `G1_DEV_UNLIMITED_CHECKS`.
- **Cron:** `[]`. **Containers:** `active=0`, `starting=0`. **Access:** dominio protegido con política `allow`.
- **Producción:** versión `1d70eb77-316e-408d-bd14-5f19b171dedf`, sin cambios.
- Las PR #28 y #29 permanecen borradores sin fusionar. G3 no creó ni ejecutó agentes nuevos, no instaló el motor nativo y no inició costos de inferencia.

Esta sección registra una comprobación puntual del commit de publicación inicial; cualquier commit puramente documental posterior puede obtener un nuevo ID de despliegue sin alterar la arquitectura seleccionada.

**Dictamen definitivo: G3 cerrado bajo el alcance revisado. Siguiente y única prioridad: G4 — persistencia, respaldo externo al Container y recuperación comprobada.**
