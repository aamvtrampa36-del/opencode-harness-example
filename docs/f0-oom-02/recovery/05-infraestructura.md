# F0-OOM-02 — T05: infraestructura, compatibilidad y recuperación

**Fecha de corte:** 2026-11-22 UTC, lecturas autenticadas de GitHub y Cloudflare.  
**Encargo:** [F0-OOM-02/T05], issue [#90](https://github.com/aamvtrampa36-del/opencode-harness-example/issues/90).  
**Actor:** ChatGPT, auditoría técnica de lectura y escritura **solo documental** en GitHub autorizada para T05. No se usó OpenCode Remote ni se ejecutaron tareas de Staging.  
**Resultado T05:** **PASS limitado — estructura e invariantes compatibles y mecanismo de detección definido**.  
**Gate de carga y hito F0-OOM-02:** **BLOCKED / NO COMPLETE PASS**; no se autoriza inferir que exista compatibilidad binaria activa, que un upload no tendrá efectos laterales ni que se resolvió el OOM.

> Las versiones que se enumeran representan el corte consultado, no una garantía de permanencia. Releer antes de T06: terceros pueden publicar en los mismos Workers. Un rollback de Worker **no** revierte DO, R2, Containers ni estado de Workflows.

## 1. Autoridad y alcance

- Código y fuentes: repositorio [aamvtrampa36-del/opencode-harness-example](https://github.com/aamvtrampa36-del/opencode-harness-example). Base documental Staging [11161dd6f2c4b5237a2da59d7275ff693e0afdbe](https://github.com/aamvtrampa36-del/opencode-harness-example/commit/11161dd6f2c4b5237a2da59d7275ff693e0afdbe), rama **staging/opencode-g1-rpc-safe-20261120**. Candidato inmutable [19bba24d81be5b0673acbf2a56b500aed4fa0b66](https://github.com/aamvtrampa36-del/opencode-harness-example/commit/19bba24d81be5b0673acbf2a56b500aed4fa0b66), [PR #106](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/106) abierta y draft. [PR #107](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/107) preserva evidencia de build y también sigue draft.
- Artefactos de GitHub Actions efectivamente descargados para lectura: principal **14760462966** y MCP **14760378207**. ZIP SHA-256 respectivo **707afab14232ea867eed4de187069f2514bbc8c4ceacce50a6a538a619d84a59** y **4c268d686cb0bdb60ef790da20525e287627fcc1df128b511a1974e2cf41563d**. Se cotejaron ZIP, SHA256SUMS, manifiestos y configuraciones; ambos manifiestos especifican **directlyDeployable: false**. Fuente SHA idéntica en ambos: **19bba24d81be5b0673acbf2a56b500aed4fa0b66**.
- Cloudflare leído mediante API autenticada con **GET** de versiones, deployments, settings, script-runtime, namespaces DO, aplicación Container, bucket R2, Workflow, versiones Workflow y schedules; **sin consultar secretos, bases de datos ni objetos R2**. No hubo POST/PUT/PATCH/DELETE, tráfico al Worker, ejecución, tests ni modificaciones de configuración.
- Informes precedentes: [T01, PR #108](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/108) y [T04, PR #109](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/109). T04 informó preparación binaria byte-identical y CI de **dry-run** exitoso en el [HEAD final](https://github.com/aamvtrampa36-del/opencode-harness-example/actions/runs/45066206624). **No implica que se subieran versiones ni que exista credencial Cloudflare adecuada.** No se identificó entrega publicada T02/T03 en los comentarios de #90 consultados.
- No se creó PR, issue, merge, tag o despliegue por el componente runtime durante T05. Esta rama es exclusivamente documental.

## 2. Snapshot inmutable de publicaciones en el corte

| Worker | Deployment ID | Version ID | Número | Fecha UTC | Tráfico |
|---|---|---|---:|---|---:|
| **opencode-g1-staging** | 36ef84b3-0f99-4dd4-ab8e-c11ee450dd23 | 3546687b-4cd2-4e22-8ea9-ee5ea8fd02cb | 374 | 2026-11-22 18:16:17 | 100 % |
| **opencode-staging-control-mcp** | 9fdaf22d-beeb-44a0-ab68-77ecd5745fa1 | 196240c0-1052-47b3-aaa7-02cf5baa87f0 | 19 | 2026-11-22 18:17:59 | 100 % |

Cloudflare Workers Builds, conforme a la auditoría T01, atribuye el código activo de ambos al commit **74632f75db010223cc90d99ba4a801ce0e6414e5**, no al candidato **19bba24d…**. Las versiones anteriores **#373/dbb18fc0-6160-4d53-96b4-2a37f7370f1e**, **#371/7e25ba19-4893-4e4f-a089-380ef8e01377**, **MCP #18/2afcceff-e54d-465f-8afa-c1916c28761c** y **MCP #17/83a3eb1f-7f22-47d8-89a9-17208ed440bd** respondieron por GET /versions/{id}. Estar disponibles no verifica una restauración ni su efecto sobre datos.

## 3. Matriz obligatoria de invariantes

**Fuentes:** G = GitHub, archivo del commit candidato; A = contenido del artefacto SHA-validado (principal config efectiva **dist/opencode_g1_staging/wrangler.json** y fuente **wrangler.g1.jsonc**; MCP **wrangler.mcp-staging.jsonc**); C = Cloudflare GET efectivo; T01/T04 = documentos y CI de esas tareas. **PASS** significa compatibilidad de estructura observada, no simulación de un upload. **INCOMPLETO** significa que la evidencia no certifica todo el requisito.

| ID / invariante | Valor esperado | Valor real observado | Fuente | Resultado | Consecuencia / regla de parada |
|---|---|---|---|---|---|
| I01 — Identidad principal | opencode-g1-staging, sin Production | Nombre activo y candidato iguales | G/A/C | PASS | Cambiar el nombre o el account detiene T06 |
| I02 — Identidad MCP | opencode-staging-control-mcp | Nombre activo y candidato iguales | G/A/C | PASS | Impedir crear script nuevo por nombre erróneo |
| I03 — Date principal | 2026-06-11 | 2026-06-11 | A/C | PASS | Cualquier diferencia exige evaluación |
| I04 — Flags principal | nodejs_compat, durable_object_io_tasks_prevent_eviction | Exactamente ambos | A/C | PASS | No añadir/quitar flags inadvertidamente |
| I05 — Date/flags MCP | 2026-11-17 y nodejs_compat | Coinciden | A/C | PASS | No trasladar flags principales al MCP |
| I06 — DO OpenCodeAgent | Binding OpenCodeAgent → clase OpenCodeAgent en principal | Clase publicada y namespace existente 0a43752314b24fe4a89327c7ecda787c | A/C | PASS | Nunca recrear namespace |
| I07 — DO DevContainer | DEV → DevContainer | Clase publicada; namespace bb8b042de894489f82b9efeb486da157 | A/C | PASS | Compartido con aplicación Container; preservar ID |
| I08 — DO PersonalSettings | SETTINGS → PersonalSettings | Clase publicada; namespace 5923eec987984f9eb9b6a18de4d91073 | A/C | PASS | No crear DB de settings nueva |
| I09 — DO respaldo | SESSION_BK → SessionBackupDrillAgent | Clase publicada; namespace 8bb2e0b25cb94fcbb0e9cf4cf18b81d2 | A/C | PASS | No sustituir referencia de respaldo |
| I10 — Migración base | v1: OpenCodeAgent; v2: DevContainer; v3: PersonalSettings; v4: SessionBackupDrillAgent, todas new_sqlite_classes | Serie exacta v1–v4 en A; runtime activo migration_tag=v4 | A/C | PASS estructural / historial INCOMPLETO | Cualquier v5, cambio de clase o migración destructive: BLOCKED, autorización específica |
| I11 — Container | Clase DevContainer; scheduling_policy=durable_object; aplicación opencode-g1-staging-devcontainer | Aplicación bb8b042de894489f82b9efeb486da157, política durable_object, namespace vinculado | A/C | PASS | No crear aplicación nueva ni reconfigurar imagen |
| I12 — Bucket R2 | RECOVERY_R2 → opencode-v1-recovery-20261112 | Binding y bucket existente; clase Standard, jurisdiction default | A/C | PASS | No crear bucket nuevo, no listar ni modificar objetos |
| I13 — Workflow | SUPERVISOR_WORKFLOW → opencode-supervisor-stage / OpenCodeSupervisorWorkflow | Binding y Workflow 98aaaebf-4bc4-4fb4-84fb-2784956a739d; script_name principal, clase correcta | A/C | PASS actual; uploads INCOMPLETO | Snapshot de Workflow version obligatorio; si se altera por upload, STOP |
| I14 — AI | Binding AI del Worker principal | Publicado como tipo ai; candidato ai.remote=true | A/C | PASS binding; remote efectivo INCOMPLETO | No inferir que configuración remota equivale a operación funcional |
| I15 — LOADER | LOADER worker_loader | Binding activo tipo worker_loader | A/C | PASS | No eliminar/renombrar; no cargar scripts |
| I16 — Variables principal | G1_DEV_UNLIMITED_CHECKS; OPENCODE_SUPERVISOR_ENABLED | Dos nombres plain_text en settings | A/C | PASS de nombres | No leer ni sobrescribir valores sensibles |
| I17 — Variable MCP | MCP_ENABLED | Nombre plain_text activo | A/C | PASS de nombre | No sobrescribir |
| I18 — STAGING_HEALTH | Service binding → opencode-g1-staging | Destino publicado igual; environment=production en servicio Cloudflare de ese Worker | A/C | PASS de script destino | El nombre de entorno interno del service binding NO es despliegue del Worker Production **opencode-harness-example**; verificar destino por script, no etiqueta |
| I19 — STAGING_SUPERVISOR | DO externo → OpenCodeAgent @ opencode-g1-staging | Igual en versión #19 | A/C | PASS | Si script_name o class_name cambia: STOP |
| I20 — Assets principal | dist/client y SPA; routes API preceden assets | En candidato directorio y index.html; runtime activo not_found_handling=single-page-application, serve_directly=true | A/C | PASS de routing; bytes activos INCOMPLETO | La versión y el manifiesto de assets deberán certificarse juntos |
| I21 — Rutas prioritarias | /agents/*, /api/health, /api/dev/*, /api/session/*, /api/settings/*, /api/settings, /api/supervisor/* | Coinciden exactamente con script_runtime.assets.raw_run_worker_first de #374 | A/C | PASS | Cualquier route diferencial bloquea creación hasta revisión |
| I22 — Assets MCP | Sin assets propios | Ningún assets declarado por MCP, ni script_runtime.assets | A/C | PASS | Evitar injertar assets principal en MCP |
| I23 — Cron | Ambos sin cron | /schedules devolvió [] para ambos | A/C | PASS | Nuevos triggers requieren autorización |
| I24 — Observabilidad | Activada | script-settings observability.enabled=true en ambos | G/C | PASS | Conservar telemetría, no relajar guardas |
| I25 — Scripts y handlers | Principal fetch + 4 DO + Workflow, MCP fetch | Named handlers principal: DevContainer, OpenCodeAgent, PersonalSettings, SessionBackupDrillAgent, OpenCodeSupervisorWorkflow; MCP fetch | A/C | PASS | No perder exports ni entrypoint |
| I26 — Identidad binaria publicada | Candidato SHA 19bba24d… | Activos atribuidos a SHA 74632f75…; no se certificó identidad hash actual→artefacto | G/A/C/T01 | FAIL para equivalencia publicada | No declarar F0-OOM-02 desplegado |
| I27 — Binarios preparados | Originales, sin rebuild | T04: prebuilt MAIN 228/228, MCP 1/1, dry-run --no-bundle PASS; manifiestos marcan directlyDeployable=false | A/T04 | PASS para preparación, NO para upload | Trasladar bytes exactos; no usar wrangler deploy por defecto |
| I28 — Recuperación | IDs anteriores accesibles | Principal #371/#373 y MCP #17/#18 responden por GET | C | PASS de existencia | Rollback de datos persistentes **NO DEMOSTRADO** |
| I29 — Control de efectos | Crear solo versiones inactivas; sin cambio de deployment ni dependencias | No se ha efectuado upload real ni prueba de efectos de creación sobre Workflows/Container/assets | A/C/T04 | INCOMPLETO / BLOCKED para T06 | Autorizar operación real solo con pre/post snapshot y política de parada |
| I30 — Credenciales y coste | Token con alcance restringido a dos scripts + control de presupuesto | El conector no demuestra credencial Actions ni límite real de gasto | T04 | INCOMPLETO / BLOCKED para T06 | No asumir token o presupuesto aplicado |

### Detalle de assets y migraciones

La configuración efectiva del principal dentro del paquete tiene **name=opencode-g1-staging**, **main=index.js**, **assets.directory=../client**, flags y migraciones v1–v4 idénticos a la fuente. El paquete contiene **dist/client/index.html** y su árbol de assets; el modo SPA y las siete rutas de Worker-primero están incluidos en el runtime activo. La asociación lógica está presente, pero **no existe aquí un hash independiente de assets activos** ni un test de navegación real: deben verificarse el manifest/asset version y la política de rutas después de crear la nueva versión, sin tocar tráfico.

Los bindings DO registrados y sus namespaces son los del principal Staging; la configuración de MCP **no define una migración de DO propia**: enlaza el DO existente del principal. En una preparación de publicación no se debe crear ni renombrar ninguna clase, clase de contenedor o namespace. v4 es el último tag **esperado**; no es evidencia de consistencia interna de las SQLite DB ni de reversibilidad de migraciones.

## 4. Riesgos materiales de Wrangler / Cloudflare en T06

1. **Reconstrucción equivocada.** La ejecución normal de Wrangler sobre otra rama o con Vite en entorno incorrecto puede modificar código, rutas y assets. Los ZIP de evidencia no son directamente publicables sin transformación verificable; T04 propone reconstruir el paquete de upload **sin re-bundling** y probó dry-run offline con Wrangler **4.158.0** y Bun **1.4.4**, pero no verificó una carga Cloudflare real.
2. **Creación de recursos implícita.** Un comando de deploy o un cambio de configuración que altere bindings/migrations/Container/Workflow puede aprovisionar o versionar dependencias. Hay evidencia de Workflow versionado automáticamente alrededor del despliegue principal #374 (última versión 0981a430-a751-437b-8daf-3663750f8007, creada 2026-11-22 18:16:20 UTC). **No se ha demostrado** que el camino de upload inactivo deje intacta la versión Workflow. Tratar como riesgo a detectar, no como daño demostrado.
3. **Separación de versiones.** La pareja principal/MCP debe mantener STAGING_HEALTH y STAGING_SUPERVISOR al script de Staging y conservar clases. Crear una nueva versión del principal no prueba que el MCP actual sea compatible con sus RPC; la comprobación funcional requiere lote posterior y permiso.
4. **Fuente activa divergente.** Ambos Workers activos derivan de otro commit. Antes de subir, no sobrescribir su código operativo ni activar un candidato sin conciliar los HEAD y la prueba de T02/T03.
5. **Persistencia.** NO intentar rollback de DO, R2 o Container mediante rollback de Worker. Las versiones anteriores quedan solo como puntos de referencia de código. Si aparece migración nueva o alteración persistente, **BLOCKED**, autorización y plan separado de reparación.
6. **Riesgo de OOM independiente.** La reproducción de [diez solicitudes en #90](https://github.com/aamvtrampa36-del/opencode-harness-example/issues/90#issuecomment-7083567558) reportó 0/10 completadas, 6 errores de memoria y referencias ambiguas. No es una prueba de la rama F0-OOM-02; el problema global de memoria continúa sin causa raíz demostrada.

## 5. Invariantes pre/post para una futura creación de versiones

**Preflight obligatorio y sin mutaciones**

1. Congelar par de versiones/deployments activos, porcentajes, etags, source SHA y timestamp de las lecturas; registrar la referencia del candidato, zip SHA, tar/payload SHA, inventory, el SHA de config efectiva, Workers Assets y la verificación de byte-identidad del código prebuilt.
2. Obtener de GET /versions/{id}, /settings, /script-settings, /schedules y GET de namespaces/Container/Workflow/R2 los campos de I01–I30. Guardar snapshots **redactados** sin secretos ni contenidos persistentes; no basta con hash global de una respuesta si contiene campos volátiles.
3. Rechazar cambios concurrentes en HEAD, deployments o versiones Workflow con respecto al snapshot. Verificar token exacto para dos Workers y control real del gasto antes de iniciar una operación autorizada. Confirmar expiración de ZIP (aprox. **2026-11-29 15:28 UTC**); no reconstruir silenciosamente.
4. Usar solo un procedimiento aprobado de **versiones inactivas** con bytes y configuración verificados; un **dry-run no equivale** a garantía de ausencia de efectos al publicar.

**Postflight si algún lote posterior autoriza una carga**

1. Confirmar que **ambos deployment IDs y sus 100 % siguen iguales**, y que los nuevos IDs son exclusivamente versiones inactivas de los scripts correctos. No modificar endpoints ni tráfico.
2. Comparar etags/metadata de las versiones nuevas con fuentes previstas y bytes verificables, incluidos **assets** del cliente y rutas; confirmar DO binding IDs y migration_tag=v4.
3. Confirmar que **namespace IDs, Container app ID/policy, bucket R2, Workflow ID/versión, schedules, AI, LOADER, tres nombres plain_text y ambos bindings MCP** permanecen sin cambios; registrar cualquier variación con diagnóstico, sin correcciones ciegas.
4. Ante versión de Workflow distinta, nuevo recurso, migración inesperada, modificación de tráfico, destino incorrecto, mismatch binario, permisos insuficientes o saldo no controlado: **STOP / BLOCKED**. No hacer redeploy, rollback persistente ni reintentos automáticos. La reversión de código/versions será objeto de autorización independiente y no equivale a restauración de datos.

**Criterio objetivo para declarar T05:** los contratos estructurales y destinos de ambos Workers coinciden con el candidato y se dispone de invariantes precisas antes/después: **PASS limitado**. El contrato de operación segura no está demostrado hasta comprobar T02/T03, autenticar el procedimiento T04 y ejecutar pre/post real en T06 bajo permiso específico.

## 6. Dependencias y mínima corrección antes de T06

- **T02/T03:** certificar, con sus informes independientes, el contraste binario principal/MCP contra las versiones activas y aceptar sus discrepancias. No sustituir esos gates por la inspección estructural T05.
- **T04:** **PASS de preparación verificada**, [PR #109](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/109) y [CI del HEAD](https://github.com/aamvtrampa36-del/opencode-harness-example/actions/runs/45066206624); queda pendiente únicamente una ruta **autenticada y explícitamente autorizada** para creación real de versiones inactivas, con permisos y coste comprobados.
- **T06:** antes de cualquier write Cloudflare exigir snapshot actualizado y política explícita para posibles effects sobre Workers Assets/Workflow/Container. El primer upload real debe detenerse si aparecen efectos inesperados. T05 no autoriza T06 ni T07.
- **Issue #90:** mantener abierta; ni compatibilidad de bindings, ni CI, ni upload demuestran estabilidad frente al OOM.

## 7. Evidencias y enlaces reproducibles

- [Issue #90](https://github.com/aamvtrampa36-del/opencode-harness-example/issues/90), [T01 comentario](https://github.com/aamvtrampa36-del/opencode-harness-example/issues/90#issuecomment-7083647199) y [T04 comentario](https://github.com/aamvtrampa36-del/opencode-harness-example/issues/90#issuecomment-7085223302).
- [PR #106 — contención transcript](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/106); [PR #107 — artefactos](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/107); [PR #108 — T01](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/108); [PR #109 — T04](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/109).
- Artifact IDs principal **14760462966**, MCP **14760378207**; [CI T04 de transferencia](https://github.com/aamvtrampa36-del/opencode-harness-example/actions/runs/45066101348); [CI T04 del HEAD final](https://github.com/aamvtrampa36-del/opencode-harness-example/actions/runs/45066206624).
- Cloudflare API, solo GET, para deployment y versions #374/#19, referencias #373/#371 y MCP #18/#17, settings, resources.script_runtime, DO namespaces, Workflow, Container, bucket R2 y schedules. No se incluye URL de consola no verificada.
- Documentos de planificación adjuntos al Proyecto son antecedentes históricos; no sustituyen los metadatos en vivo.

**Límites de autoría:** esta entrega T05 no realizó versiones, cambios de Cloudflare, pruebas E2E, rollback, inferencia, modificación de código fuente, merge o cierre de issue. La verificación previa de T04 y su CI pertenece a ese encargo, no se ejecutó de nuevo en T05.
