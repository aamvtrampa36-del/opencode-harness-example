# F0-OOM-02/T03 — integridad binaria del Worker MCP

**Fecha de corte:** 2026-11-22/23 UTC. **Actor:** ChatGPT, inspección autorizada de GitHub Actions y Cloudflare; verificación adicional local del ZIP. **Entorno:** Staging únicamente. **Resultado:** `PASS` de auditoría de integridad y procedencia; `NOT PROMOTED / NO RUNTIME PASS`.

## 1. Identidades verificables

| Referencia | Valor |
| --- | --- |
| Repositorio | `aamvtrampa36-del/opencode-harness-example` |
| Issue | [#90](https://github.com/aamvtrampa36-del/opencode-harness-example/issues/90) |
| Código candidato / PR | [#106](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/106) — `19bba24d81be5b0673acbf2a56b500aed4fa0b66` |
| Base Staging de PR #106 | `11161dd6f2c4b5237a2da59d7275ff693e0afdbe` |
| Workflow candidato de dos Workers | [run 45038446357](https://github.com/aamvtrampa36-del/opencode-harness-example/actions/runs/45038446357) — `completed/success` |
| Artifact MCP | ID `14760378207`; ZIP `782092` bytes |
| Worker actual | `opencode-staging-control-mcp` |
| Deployment actual consultado dos veces | `9fdaf22d-beeb-44a0-ab68-77ecd5745fa1` |
| Versión activa | **#19** / `196240c0-1052-47b3-aaa7-02cf5baa87f0`, **100 %** |
| Fuente del build publicado | `74632f75db010223cc90d99ba4a801ce0e6414e5` según auditoría [T01](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/108) y [T05](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/110), distinta del candidato |

Los IDs de despliegue y versión se leyeron de Cloudflare mediante GET; el deployment permaneció invariable antes y después del contraste. Las fechas de corte son snapshots, no un bloqueo operativo del Worker.

## 2. Evidencia del artefacto original — verificación sin reconstrucción

Se reutilizó el archivo ZIP original `f0-mcp.zip` descargado con el conector GitHub en T04. Una lectura local independiente con `zipfile`, `tarfile`, `hashlib.sha256` y `json` produjo:

- ZIP SHA-256 **`4c268d686cb0bdb60ef790da20525e287627fcc1df128b511a1974e2cf41563d`**, igual al digest declarado por GitHub Actions.
- `payload.tar.gz` SHA-256 **`ce2e9befb78020261836c53d9781041d2b616d90a15cb3daa5580577d375c5b9`**, coincidente con `SHA256SUMS`.
- `manifest.json`: `sourceSha=19bba24d81be5b0673acbf2a56b500aed4fa0b66`, `workerName=opencode-staging-control-mcp`, cuatro entradas de inventario.
- `.f0-oom02/mcp-dry-run/worker.js`: **1 286 914 bytes**, SHA-256 **`4b9323d8df60605132521bb0075045e7d75445f0dc898a8ec358ade5ce836a50`**, incluye `SUPERVISOR_TRANSCRIPT_UNAVAILABLE_UNBOUNDED`.
- `.f0-oom02/mcp-dry-run/worker.js.map`: 2 865 898 bytes; `README.md`: 129 bytes; `wrangler.mcp-staging.jsonc`: 667 bytes. Los cuatro `path/bytes/sha256` coinciden con el inventario del manifiesto; no se emitieron ni ejecutaron módulos locales.
- El candidato conserva `STAGING_HEALTH` como service binding hacia `opencode-g1-staging` y `STAGING_SUPERVISOR` como DO binding hacia `OpenCodeAgent` del mismo Worker. Fecha compatible `2026-11-17`, `nodejs_compat`; el MCP no es propietario de migraciones DO.

El workflow previo [T04 / PR #109](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/109), [run 45066206624](https://github.com/aamvtrampa36-del/opencode-harness-example/actions/runs/45066206624), confirmó `wrangler versions upload --dry-run --no-bundle` con Wrangler `4.158.0`, Bun `1.4.4` y **`MCP_PREBUILT_BYTES_PASS 1/1`**. Era una preparación offline, no una versión subida.

## 3. Comparación con el contenido actualmente publicado

Se ejecutó **solo lectura** Cloudflare GET `/accounts/{account_id}/workers/scripts/opencode-staging-control-mcp/content/v2`. La respuesta fue un contenedor `multipart/form-data` textual cuya parte `Content-Disposition: form-data; name="worker.js"; filename="worker.js"` corresponde al código JS publicado. Se retiraron exclusivamente la cabecera MIME, el delimitador multipart y el CRLF final del encuadre. SHA-256 se calculó sobre el cuerpo UTF-8, sin normalizar código, espacio, imports ni saltos de línea.

| Propiedad | Worker publicado #19 | Candidato 19bba24d |
| --- | --- | --- |
| Contenido `worker.js` (bytes) | **4 128 344** | **1 286 914** |
| SHA-256 | **`3c7ef3c941679eec32b76ab1c6d26d67e12bab6f8664a38c447dc4db6991b3a4`** | **`4b9323d8df60605132521bb0075045e7d75445f0dc898a8ec358ade5ce836a50`** |
| `SUPERVISOR_TRANSCRIPT_UNAVAILABLE_UNBOUNDED` | No observado en cuerpo publicado | Sí, observado en candidato |
| Igualdad binaria | **NO** | **NO** |

**Conclusión demostrada:** el MCP publicado **no** es el binario candidato de F0-OOM-02. El guard de transcript que contiene el candidato no está en el código publicado. La discrepancia del build fuente ofrece una explicación probable; **no** se afirma conocer todas las diferencias semánticas ni la causa raíz de OOM.

**Límite de medición:** el API del conector entregó el cuerpo multipart como texto, y su cuerpo se recodificó a UTF-8. No se obtuvo una segunda exportación de bytes HTTP raw; el valor publicado representa exactamente los caracteres del script entregados por esta API después de retirar el encuadre. SHA-256, tamaño y marcador bastan para demostrar una divergencia amplia, pero no certifican cada atributo de configuración del Worker.

## 4. Invariantes, efecto y decisión

- Cloudflare seguía sirviendo #19 al 100 % en el corte. **No** se creó versión ni deployment nuevos; tampoco se llamó a OpenCode Remote ni se hizo inferencia.
- [T02 / PR #111](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/111) concluye que el principal activo #374 difiere en **21 de 228** módulos; **ambos** Workers actuales permanecen en versiones distintas del candidato SHA `19bba24d`.
- [T05 / PR #110](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/110) presenta 30 invariantes de recursos, assets, migraciones y bindings; PASS de estructura, no autorización de upload.
- **T03: PASS de investigación del MCP**. **F0-OOM-02: BLOCKED / NO COMPLETE PASS**. La prevención de OOM no se ha comprobado en el runtime. Mantener abierta issue #90.
- **Próxima dependencia:** T06 debe revalidar integridad y fuentes, token Cloudflare y ámbito Staging, costes, lifecycle de Workers Assets/Workflows/Containers y rollback antes de cargar **versiones inactivas**; sin activar tráfico ni crear recursos no previstos. Ningún dry-run garantiza ausencia de efectos secundarios del upload real.

**Autorización y coste:** lecturas de GitHub/Cloudflare ya permitidas, hashing local, una PR draft/documentación GitHub. Cero llamadas de escritura en Cloudflare, cero inferencia, sin gastos de versiones creadas; no existe un límite monetario efectivo probado. Ningún secreto o contenido de DO/R2 fue leído ni expuesto.
