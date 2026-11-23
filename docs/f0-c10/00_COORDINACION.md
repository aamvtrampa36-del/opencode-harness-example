# F0-C10 — Coordinación de segunda ronda (R2)

**Corte:** 2026-11-22, America/Sao_Paulo. **Estado:** plan, no aceptación E2E. **Autoría:** ChatGPT. Documento del maestro; especialistas no deben sobrescribirlo.

## Autoridades y snapshots

- Plan focal: `docs/f0-c10/F0_C10_PLAN_INTEGRAL.md` (versión R2); archivo adjunto del Proyecto/Biblioteca no se sincroniza automáticamente con GitHub.
- Fuente de integración: [PR #126](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/126), base `11161dd6f2c4b5237a2da59d7275ff693e0afdbe`, HEAD candidato `1268ba22f26330d619b046fcf551ca846cb69d0f`, draft/unmerged al corte. CI de dicho HEAD: `45093134023`, `45093134014`, `45093134038`, completed/success.
- Incidente: [issue #90](https://github.com/aamvtrampa36-del/opencode-harness-example/issues/90), sin COMPLETE PASS. Worker activo `3546687b-4cd2-4e22-8ea9-ee5ea8fd02cb`, MCP `196240c0-1052-47b3-aaa7-02cf5baa87f0`. Revalidar antes de usar.
- Source of truth: GitHub para código/CI; Cloudflare para binarios/runtime; OpenCode Remote solo para la ejecución que demuestre; Biblioteca como copia de artefactos, nunca fuente única.

## Mapa de trabajos

| Encargo | PR previa | Bloqueo R2 | Superficie principal | Dependencia |
|---|---|---|---|---|
| T01 | #116 | atribución del OOM, heap por etapa | diagnóstico/telemetría | T02/T05 |
| T02 | #115 | memoria de supervisor único vs aislamiento | benchmark arquitectura/prototipos | T01/T03 |
| T03 | #125 | admisión durable/fencing | scheduler/ledger | T04/T07 |
| T04 | #120 | crear sesión sin recibo y cancel race | journal/recovery | T03 |
| T05 | #114 + #106 | evento gigante/transcript y cursor | RPC, MCP/progreso | T01/T04 |
| T06 | #121 | descendientes/orfandad de procesos | Linux/Container | T02 |
| T07 | #117 | límites upstream y corte real de gasto | proveedor/contabilidad | T03 |
| T08 | #122 + #124 | carrera de escritores GitHub | bridge/repos | T03 (solo interfaz) |
| T09 | #123 | endpoint/lectura autenticada de bytes | archivos/UI | T10 |
| T10 | #118 + #119 | telemetría live autenticada | harness/evaluación | T01/T09 |

## Reglas operativas de las diez continuaciones

1. Cada especialista continúa **en el mismo chat** de su entrega anterior, no asume contexto de otros chats, y revalida todo contra GitHub.
2. Crear rama propia `f0-c10/r2-tXX-<fecha>` desde el SHA correcto; no escribir `main`, Staging, #126 ni ramas ajenas. El PR draft debe declarar actor, head/base, diff, pruebas y coste.
3. Preferir OpenCode para programación solo con lease exclusivo, control técnico de gasto y permisos de herramienta verificables. Si no hay tales condiciones, trabajar con código/CI/fixtures offline y atribuir a ChatGPT su autoría.
4. No efectuar merge, deploy, cambios de Worker, DO/Containers persistentes, Access, secretos o pruebas masivas. No reutilizar IDs `unknown/not_found` para reintentar efectos; nunca inventar tiempos o resultados.
5. Antes de cambiar `src/server.ts`, comparar #126, T03/T04/T05 e identificar hunks. No duplicar el scheduler ni un sistema de colas innecesario. El siguiente T11 integra.
6. Actualizar el informe de TXX **en su propia rama** con sección R2 (o nuevo `XX_CONTINUACION_R2.md` si es más seguro). Guardar informe y evidencia en Biblioteca personal **solo si** existe permiso/conexión y se comprueba el recibo; si no, entregar archivo descargable y marcar no publicado.
7. Cerrar cada T con `RESULTADO | EVIDENCIA | BLOQUEANTE | PRÓXIMA ACCIÓN`, separando PASS de subsistema, CI y runtime. Ninguno declara COMPLETE PASS global.

## Cadena de integración

R2 investigaciones y PR separados → T11 consolida frente a #126 → CI del HEAD integrado y revisión de seguridad → preflight de despliegue/coste/lease si se autoriza expresamente → E2E de 1→2→4→10 → tres rondas 10/10 con telemetría auténtica, descargables y sin OOM → auditoría y aceptación del propietario.

**STOP** ante lease ambiguo, límite de gasto no aplicado, OOM, pérdida de identidad SHA, evento o dato sensible, migración no autorizada o mezcla de proyectos.