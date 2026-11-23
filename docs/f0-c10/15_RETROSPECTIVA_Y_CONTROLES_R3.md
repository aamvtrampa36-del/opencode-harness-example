# F0-C10 — Retrospectiva de integración T11 y controles obligatorios para R3

**Corte:** 2026-11-23 UTC. **Objeto:** actuación observable de ChatGPT en T11 y auxiliares #127/#143/#144/#145, no acceso a razonamiento interno. **Estado:** auditoría del proceso; no se pretende aprender permanentemente ni afirmar autonomía futura. **Fuentes:** PR/commits/CI de GitHub, issue #90, documentos en `docs/f0-c10/`, conversación de coordinación. Algunos riesgos son hipótesis, no defectos reproducidos.

## 1. Logros verificables (no confundir con aceptación E2E)

- PR #143 fuente R2: integración acumulada desde #126, 56 archivos; 5 workflows #45101962752, #45101962733, #45101963290, #45101962704, #45101962786 terminaron satisfactoriamente sobre `160eafbb0e4842063e37c71425f1a5c2e08b18b2`. **Solo suites offline e integración de código**.
- PR #144 fuente T03/T04: HEAD `baebc30a71dbaa8abca722c0780d4d658e2192c8`, CI #45103313716 PASS. Introdujo ID determinista, turnos/CAS y cierre de una carrera de capacidad que no se había detectado al abrir la primera versión del PR.
- PR #145 recuperación/readmisión: HEAD `a49e985909cb56bb42c609c9cd5cb4250a620169`, workflow #45106083359 PASS (Bun, fault-injection offline, preview, typecheck, build e invariantes). **No** SDK/DO E2E live, ni diez ejecuciones activas.
- Cloudflare seguía en Worker principal `3546687b-4cd2-4e22-8ea9-ee5ea8fd02cb` y MCP `196240c0-1052-47b3-aaa7-02cf5baa87f0`. No despliegues en estos lotes. Remote `supervisedCountAtLeast=96`, recuento incompleto; no prueba trabajo activo.

## 2. Debilidades y errores de actuación, sin inflar conclusiones

| Clasificación | Evidencia concreta | Diagnóstico técnico | Control obligatorio R3 | Verificación/propietario |
|---|---|---|---|---|
| **Demostrado — integración por contexto textual** | En T11 se reprodujeron hunks de #133/#139 con coincidencia exacta y se copiaron algunos archivos enteros en #143. El propio informe #143 reconoce que coincidencia textual no demuestra compatibilidad funcional | El parche puede aplicar y conservar el build sin asegurar transiciones correctas | Comprobar contratos/owner de máquina de estados antes del patch; tests de carrera e invariantes de interfaz tras combinar | T03/T04/T05/T09, auditado por T11 |
| **Demostrado — corrección posterior al primer CI** | #144 necesitó ajustar comprobación del slot en la misma transacción del turno después de la primera versión verde | Un preflight separado permitía carrera de reclaim/restart aun si tests individuales eran verdes | Usar fail-injection interleaving antes del primer PR; no aceptar la ejecución de CI de un HEAD anterior | T03/T04 y T11 |
| **Demostrado — varias PR apiladas y commits** | `compare_commits` #126→#143 reporta 78 commits/56 archivos; #143→#144 17 commits/9 archivos; #144→#145 9 commits/5 archivos. **Incluye ancestros especializados, no todos del integrador.** | Aumenta superficie de revisión, ruido de CI, dependencia de orden y riesgo de doble cherry-pick | Mapa de bases y autoría; agrupar cambios lógicos cuando herramienta permita; no duplicar PR cuyo código ya sea ancestro | T08 y T11, comparar DAG + diff |
| **Demostrado — deducciones por contrato insuficiente** | #144 y #145 se implementaron antes de prueba en DO real de `create({id})` y `sessions.get({sessionID})`; docs reconocen el STOP | El código demuestra forma de llamada/SDK, no semántica completa bajo un creador externo todavía activo | Verificar versión y código exacto, test descartable DO con crash, no reintentar efectos unknown | T04 + T11 |
| **Demostrado — UI ajena o inconsistente** | Primer panel de copia respondió con HTML aparte; después una UI en el chat con prompts acortados frente al archivo canónico R2 (casi 50 KB) | Apariencia de botón ≠ copia exacta del contenido prometido; aumenta trabajo del propietario | Generar UI y archivo Markdown desde **una sola fuente**; comprobar 11 IDs, número de caracteres y SHA-256 del texto copiado, no mostrar tarjetas decorativas | T11 coordinación, QA automatizado antes de responder |
| **Demostrado — deuda de observabilidad y gasto** | #90 sigue 0/10; T01/T02 son fixtures; #142 coste offline; #141 E2E firmados offline; #145 STOP sin DO real | CI y unit tests no miden memoria/isolate, cuota, costes, diez solapamientos, Android | Gate por dimensiones: source/CI/runtime/autonomía/costes/outputs; no COMPLETE PASS de prueba sintética | T01/T02/T07/T09/T10 y T11 |
| **Demostrado — atribución de agencia** | #143–#145 fueron implementadas por ChatGPT con conector GitHub, según PR e informes, no por ejecución de OpenCode Remote | El producto final busca autonomía, pero estos avances no prueban autoría ni ejecución autónoma OpenCode | Registar actor por commit/cambio/prueba y separar coordinación ChatGPT de acción Remote | Todos los T, T11 evalúa |
| **Riesgo — costes indirectos** | Gastos de GitHub Actions no se midieron aunque las suites fueron ejecutadas; R2-T07 describe gate no instalado | No calcular coste total del lote con `0` basándose solo en ausencia de inferencia explícita | Capturar minutos CI cuando disponibles, presupuestos/no medición, hard stop proveedor efectivo | T07 y T11 |
| **Riesgo — APIs del SDK y control de capacidad legacy** | #145 admite legacy fuera del ledger y lectura exact-ID sin verificación workerd real | Diez slots no son diez operaciones concurrentes totales si hay rutas viejas | Inventario bounded de rutas y política conservadora, entorno descartable para recuperación | T03/T04/T10 |
| **Riesgo — documentación paralela** | #127 sigue draft separado; #143 copió plan/coord pero no prompts R2 al candidato, por lo que fuentes viven en más de una rama | Un chat nuevo puede leer documento desactualizado o asumir sincronización Biblioteca-GitHub | Conservar ruta canónica de docs en base integrada, PR documental apilada, manifest de archivos y handoff T11 | T11, comprobar HEAD e inventario |

## 3. Protocolo R3 corregido — ejecutar, no solo recomendar

**Preflight antes de escribir:** fijar base SHA y comparación con latest, leer funciones/SDK/versiones realmente importados, identificar archivos y owner, anotar hipótesis RED y límite de gasto/riesgo, verificar permiso de rama. Una operación Remote con efectos nunca se invoca por inferencia de su nombre.

**Lote de código:** una PR draft pequeña por T, no modificar ramas de otros, menos commits redundantes, no copiar módulos completos incompatibles; cada nuevo contrato requiere unit + negativo + caso de interleaving/crash. Evitar CI duplicado del mismo HEAD. Presentar pruebas de `not_found`/`unknown` y falsos PASS.

**Verificación:** comparar diff final contra base, luego `bun test`, preview, typecheck, build Workers/web, invariantes, checks de HEAD exacto. Distinguir prueba mock, Linux local, workerd/DO local, Staging live y Android real.

**Handoff:** los diez especialistas cierran su propia área y publican `HANDOFF A F0-C10/R3-T11`, con PR/HEAD/CI/actor/scope/costes/bloqueante. T11 descubre y compara, no solicita al propietario organizar mecánicamente.

**UI:** archivo Markdown `16_RONDA_3_PROMPTS.md` y panel de 11 botones nativos se generan desde una única lista de textos completos; verificar caracteres y SHA de cada botón, prohibidos HTML externo y versiones abreviadas. La Biblioteca requiere recibo explícito y no se toma por espejo automático de GitHub.

**Criterio de cierre:** No se necesita una cuarta ronda si R3 integra un candidato suficientemente probado; si persiste STOP operativo, T11 entrega una única siguiente decisión con evidencia. Cada área puede ser `PARTIAL` sin disimularlo. `COMPLETE PASS` pertenece al E2E live de diez agentes, tres rondas, bajo controles efectivos y autorización independiente.
