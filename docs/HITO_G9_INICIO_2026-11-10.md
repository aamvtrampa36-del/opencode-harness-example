# OpenCode Cloud — G9: inicio de entrega reversible (10 noviembre 2026)

**Estado: TRANSICIÓN ABIERTA, G9 NO APROBADO.** El hito anterior G8 fue **APROBADO EN STAGING** con evidencia real del propietario desde Android y cierre registrado en `docs/HITO_G8_EJECUCION_2026-11-10.md` §12. No publicar ni fusionar PR por este cambio de hito.

## Condición de cierre heredada del plan V1

`docs/V1_EXECUTION_PLAN.md` establece para G9:

1. Endurecimiento **mínimo y motivado por defectos reales**, sin cambio de arquitectura innecesario ni eliminación de adaptadores sin reemplazo demostrado.
2. Ejecutar **las 12 pruebas E2E del encargo**, registrando evidencia enlazable y limitaciones.
3. Preparar una versión/tag **reversible** con los gates P0 verificados.
4. Comprobar que el usuario puede desarrollar un cambio real sin intervención humana de administrador.
5. Solo tras autorización separada, considerar una publicación productiva controlada.

**Advertencia de fuente:** el informe maestro `Informe_Integral_OpenCode_Cloud_V1.pdf` (21 pp, 8–9 nov) define las capacidades a verificar —acceso, edición, herramientas, autorreparación, GitHub, persistencia, recuperación, diagnóstico y Android—, pero **no enumera literalmente las doce pruebas con sus nombres y pasos**. El plan se refiere a ellas como «12 pruebas del encargo». No suponer que esas nueve categorías equivalen a una lista de doce. Recuperar el encargo original antes de presentar una matriz exhaustiva, o identificar explícitamente los casos faltantes como no documentados.

## Línea base verificada que se puede reutilizar

| Prueba o capacidad | Evidencia disponible | Alcance |
| --- | --- | --- |
| G1 — Herramientas y reparación real | Acta G1; ejecución roja→verde de Node por un agente y verificación independiente | Staging |
| G2 — Autodesarrollo | Acta G2 y PR de desarrollo | Staging, sujeto a comprobaciones finales de G9 |
| G3 — Motor elegido | Decisión Workerd/Harness con restricción operativa del nativo documentada | No declarar equivalencia con OpenCode nativo |
| G4 — Persistencia y recuperación | Snapshot destruido, DO recuperado, hashes de archivos y tests | No asumir que backups pequeños preservan todo Git/transcript |
| G5 — UX Android | Capturas y ejecución de app de prueba por propietario, navegación usable | Staging |
| G6 — Plantillas | Siete perfiles y edición con efecto real sobre modelo, captura Android `G6-OK` | Staging |
| G7 — Diagnóstico | Incidente `SHELL_FAILED`, exitCode 19, captura Android y pruebas | Staging |
| G8 — CDF CLOUD/WorkBench | Dos PR draft no canónicas, `repo_review` de dos agentes reales con resultado aprobado en Android, aislamiento y verificación por código | **APROBADO EN STAGING**, PR creadas por el supervisor, no por esos agentes |
| Descarga privada GitHub | ZIP real de CDF CLOUD descargado en Brave, 204 archivos y CRC íntegro | Staging |

La lista es **inventario de evidencias**, no sustituto de los doce E2E ni de gates P0 de publicación.

## Primera acción ejecutable de G9

**Recuperar la formulación exacta de las 12 pruebas de aceptación del encargo original** y cruzarlas con las evidencias arriba; marcar para cada caso `probado`, `pendiente` o `no especificado`, enlazando acta, CI y/o resultado de sesión. Evitar repetir lo ya acreditado. La primera nueva prueba de alta prioridad que sigue siendo necesaria para entrega V1 es un flujo **agente real → edición en rama aislada → tests ejecutados → diff revisable → recuperación**, con autorización de proyecto y sin asistencia de administrador. Usar repositorio de prueba y archivos no canónicos; nunca alterar el canon CDF ni producción.

Después, resolver solamente los P0 pendientes; comprobar que la publicación es reversible; preparar release/tag candidata sin desplegar productivo ni fusionar hasta autorización explícita.

## Estado conservado y seguridad

- Rama staging: `fix/repeatable-agent-verification-20261108`; [PR OpenCode #28](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/28) draft, sin merge.
- [CDF CLOUD PR #160](https://github.com/aamvtrampa36-del/cdf-cloud-engine/pull/160) y [WorkBench PR #36](https://github.com/aamvtrampa36-del/CDF-WorkBench-/pull/36) draft, sin merge.
- Código funcional al cierre de G8: CI OpenCode #278 `completed/success`, último staging Workers Builds `success`, Access `self_hosted`, ningún Cron.
- Versión productiva sin cambios: `1d70eb77-316e-408d-bd14-5f19b171dedf`.
- No se crean tokens, servicios, mecanismos de publicación ni tareas programadas para el simple traspaso.

**Criterio de salida G9:** batería E2E completa y respaldada, P0 verdes, flujo real reproducible sin intervención del administrador, rollback/release verificados y autorización explícita antes de producción. Si cualquiera falta, G9 permanece abierto; no declarar V1 liberada.
