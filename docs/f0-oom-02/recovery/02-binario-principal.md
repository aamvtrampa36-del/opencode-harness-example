# F0-OOM-02/T02 — Auditoría binaria del Worker principal

**Fecha de corte:** 2026-11-22. **Encargo:** [issue #90](https://github.com/aamvtrampa36-del/opencode-harness-example/issues/90), marcador [F0-OOM-02/T02]. **Estado:** **PASS de investigación binaria / NO PASS de promoción ni de runtime**. Autor: ChatGPT, con lectura autorizada de GitHub y Cloudflare; solo escritura de este informe y referencias documentales. No se modificaron módulos, despliegues, secretos, permisos, DO, assets publicados ni Producción.

## 1. Identidades y cortes verificados

- **Repo y fuente candidata:** aamvtrampa36-del/opencode-harness-example; SHA 19bba24d81be5b0673acbf2a56b500aed4fa0b66, PR [#106](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/106) OPEN/DRAFT, no merged; corrección en src/server.ts.
- **ZIP GitHub Actions:** artifact ID 14760462966, workflow run [45038446357](https://github.com/aamvtrampa36-del/opencode-harness-example/actions/runs/45038446357), origen declarado en manifest.json. Tamaño 24 168 777 bytes, SHA-256 **707afab14232ea867eed4de187069f2514bbc8c4ceacce50a6a538a619d84a59**.
- **Worker:** opencode-g1-staging. El deployment actualmente identificado en los cortes GET inicial/final fue **36ef84b3-0f99-4dd4-ab8e-c11ee450dd23**, versión **#374 / 3546687b-4cd2-4e22-8ea9-ee5ea8fd02cb**, 100 % de tráfico; creado 2026-11-22T18:16:17.020874Z. La referencia histórica **#373 / dbb18fc0-6160-4d53-96b4-2a37f7370f1e** ya no estaba activa.
- **Build de Cloudflare del #374:** df8bbe2b-6964-4f59-86d9-3c2c706da3aa, outcome success; build_trigger_metadata.commit_hash = **74632f75db010223cc90d99ba4a801ce0e6414e5**, distinto de la PR #106. El build documenta comandos Bun y bunx wrangler deploy. Por lo tanto no es promoción directa del ZIP 14760462966. Este metadato atribuye commit al build, no prueba identidad del actor que lanzó la acción.
- **Integridad de corte:** se reconsultó GET /deployments después de extraer y resumir el contenido: mismo deployment #374 al 100 %. No se detectó cambio concurrente durante el tramo consultado. Un despliegue futuro invalidaría la condición de actualidad.

## 2. Integridad del artefacto

ZIP descargado con mcp GitHub download_workflow_artifact y examinado localmente, sin reconstruir código. unzip -t: **exit 0**. sha256sum del ZIP: **exit 0**, digest coincidente arriba. Verificador local Python (ZipFile + TarFile + sha256): **exit 0**.

Los cuatro archivos de SHA256SUMS coinciden:
- payload.tar.gz: c3a74f98a9d50697cac0a2c95b58b2e2199543e2bc00e2661de040b30f9f8b4b
- manifest.json: eb724b696d82c56ad2031f140457617ecf2edbe124b540b60e3f0e3f6a906c9b
- prebuilt-report.json: 936b91569a9049109f68b92db854d91e358a152e00d5dbbf8bd8fd353db4fcc2
- prebuilt-main.tar.gz: a4afa21bedb1e06a1ae9ed834c092ac26176bcccbcbde48ea78fec4f43b40a23

Los **543/543 archivos** del payload concuerdan por ruta, tamaño y SHA-256 con manifest.json, sin omitidos. Los **228/228 archivos JS** de prebuilt-main.tar.gz concuerdan byte a byte con los módulos conservados en payload.tar.gz bajo dist/opencode_g1_staging/; el manifiesto precompilado contiene los SHA-256 por módulo en prebuilt-report.json (outputModuleHashes). El reporte declara cloudflareVersionUploaded=false y directlyDeployable=false: **integridad no significa subida o desplegabilidad inmediata**.

Entrypoint fuente: src/entrypoint.ts; entrypoint del paquete precompilado: index.js, que reexporta desde assets/worker-entry-DyRguOh3.js. El paquete contiene 307 archivos de cliente bajo dist/client/ (sin contar .assetsignore), además de 228 módulos del Worker. El archivo original wrangler.g1.jsonc declara assets de dist/client, SPA fallback y run_worker_first para /agents/* y rutas /api/* explícitas, incluidas /api/supervisor/*.

La configuración efectiva original dist/opencode_g1_staging/wrangler.json apunta a index.js, mantiene compatibility_date 2026-06-11, flags nodejs_compat y durable_object_io_tasks_prevent_eviction, migraciones v1–v4, bindings de OpenCodeAgent, DevContainer, PersonalSettings y SessionBackupDrillAgent, Workflows, Container, R2, AI y LOADER. SHA-256 de wrangler.g1.jsonc: **9c9fef94753da42244e64d5e72106354db96d022f353f53925320cd0946a2cfd**.

El prebuilt-report documenta únicamente el traslado de configPath y userConfigPath (rutas absolutas de GitHub runner a .f0-oom02/restored/): SHA metadata anterior 482d0de2134f6ca9ca31a1197fc2f4835fc844b070b7a2f93caf27560f010e5f, nueva 9055a0f74f8aa3cf502533cd99ff53a0bee016d45ee4bb9304e2323f29d3d420; executableModulesRewritten=false. No se normalizaron estas rutas dentro de los JS comparados.

## 3. Comparación de los 228 módulos del Worker

**Fuente activa:** Cloudflare GET /accounts/{account_id}/workers/scripts/opencode-g1-staging/content/v2 (solo lectura, éxito HTTP). Se separaron las partes multipart por su boundary, se tomó cada name de Content-Disposition y se retiró exclusivamente el encuadre de transporte (cabeceras y CRLF terminal). Cada cuerpo textual JS se recodificó como UTF-8 para medir bytes y SHA-256; **no** se normalizaron finales de línea, imports, nombres, paths ni JS. No se confundió el ETag de la versión con un SHA-256.

- Activo: **228** módulos; 20 936 587 bytes; SHA-256 del inventario canónico completo **cf27b6a8c8520d6484512633d02ee94867dfaf77fb0fc0cbd5efabcdf3b732ca**.
- Candidato: **228** módulos; 20 924 708 bytes; SHA-256 del inventario canónico completo **cb1d3cb59df3dac6897f6abc2f88d770cf8256cec51c61559522c068182d52dc**.
- **207 módulos** comparten ruta, tamaño y SHA-256. Su inventario canónico común tiene SHA-256 **d11911f23ef8ce34f90084292ff376ff683f1169c340ae9fe715abf93ce13246**, computado independientemente desde ambas fuentes.
- Los **21 restantes divergen**: 20 pares con nombre de módulo/hash de build distinto y 1 index.js con igual ruta pero distinto contenido. Todos tienen SHA-256 distinto. La única diferencia de tamaño dentro de estos pares es el worker-entry (activo 10 035 493 bytes; candidato 10 023 614 bytes).

Convención de inventario: para cada módulo, una línea UTF-8 formada por nombre relativo + tab + bytes decimales + tab + SHA-256 hexadecimal + LF; ordenamiento lexicográfico sensible a mayúsculas por nombre; SHA-256 sobre la concatenación. El ZIP, manifest.json y prebuilt-report.json permiten reproducir el inventario candidato. La tabla siguiente, junto a los 207 módulos comunes del reporte candidato, permite reconstruir el inventario activo y verificar su fingerprint.

### Diferencias exactas (por archivo, sin el encuadre multipart)

| Módulo activo #374 | Bytes | SHA-256 activo | Módulo candidato | Bytes | SHA-256 candidato |
|---|---:|---|---|---:|---|
| assets/backend-BeudZVXT.js | 64161 | d46aef93860e5ca9d1a0ef50369008717e81ffa590de96963352e375b9e60697 | assets/backend-DYU5Ejoo.js | 64161 | b23eab2825d4a7f4731071223f392a3604225454320c177fb54d9b9cd41f29ee |
| assets/chat-D-vtpFu0.js | 1887 | 72a14de820b51f9772c943498b35aa6f666b5e49694b95ef84a62952e86e9f15 | assets/chat-Ft7T8KAo.js | 1887 | 9fdea0e2768ca4f80ac97d1a5664c06ccc21591d3aef435e1019a9809a0bdb79 |
| assets/client-NqgsFc6n.js | 16584 | bcc27d12ab8e7f3b34dfd24ede52195a45ecac3f6b2d79c608ca8fcef6310569 | assets/client-dRejCS8x.js | 16584 | b4fe50cd5282f8deb3ac3f381adc4b21592713792f5dcfe7546f9fe833ca6d98 |
| assets/gemini-BRjpRxnH.js | 53 | 6f4577d096ba9a0b7e7c66f02a9eca3e2ee38e11e913bc40c008e6673f919723 | assets/gemini-V-weqKgv.js | 53 | 1a5a9d7f5bcb4f0e2a46fe1d04bf5db802d10112753bc812480be0b11ad9a077 |
| assets/google-vertex-BrSjbFTk.js | 3300 | c79b473a777bfc5300acee1d783bdd92ff14ff6402e34ac1f3bb3572c29a5847 | assets/google-vertex-D9yt1cce.js | 3300 | 46a422dd2d3386e8ecd06acbd319d344c89e1cdee0fb04621adb375ddf0d8e8f |
| assets/google-vertex-shared-DgOSwQvV.js | 2694 | 7ba6fe4d1eb7b29e094c8aae2758a783cdeff83e93907ae41b7735e485a2e045 | assets/google-vertex-shared-DKXiQQZg.js | 2694 | a55b657b844680a96e3363b6ff5bad408deee7af299c2b3fade39d41ec807fdb |
| assets/lib-CZ6INHk7.js | 1343152 | a2e083f300cb3e18bb201cd50d887cdde42c51c9a2380a0c6057ae6a3b51fa1c | assets/lib-DF3wYtj2.js | 1343152 | 94c2db8147930bebf2e1e34bc3d3ec2fc8352878d52c3061aebaac458770f7a3 |
| assets/lib-ICqih90r.js | 482360 | 42e38b0d319f6cca61f2365200ac9aed6a1d15b13f13af048d9a9e046e9f6610 | assets/lib-IZTUXZKt.js | 482360 | a5650b92e98c1ddaa4cebeb84ed33581215eae6aea895b77b34169a08bce4e33 |
| assets/messages-C3Vmvbbb.js | 2694 | d99354630fc66496b458c3db302127638da4c5afdf7d29d8f2593655d7405fd9 | assets/messages-DsCMXu5J.js | 2694 | 7f53b858ca194559f52f00a652f1807b60d80f5c368125c752fe0522118ca9fc |
| assets/multipart-parser-DNscNrrk.js | 8780 | 597d409e5cbe55cef8b0a410119965db401d9bef82075d221181d52bee615cbb | assets/multipart-parser-C_YCav_1.js | 8780 | a922ed51f00f613045399cc61fab419f18973b1a9e90075b73a5f60962166033 |
| assets/oauth-5UxUoPVX.js | 18103 | 53960f43255e287f7431b5ed97b3c24966dc2c074a2a7b7067c99fe06f12546b | assets/oauth-BoQyqGbL.js | 18103 | 497bc7178ffd8a0db0905b7d27dbea2393c322b877d02373a8a93eafa4422dc4 |
| assets/repository-5ng375bv-9ENyVxPC.js | 10989 | 68d0c59dbf5132a950ce925b7eb42b06f0d0bea47e8b68afbc1867531c4d0221 | assets/repository-5ng375bv-CjgvY3se.js | 10989 | 80ce66df6cf7d65d4c0807d430bb60bd3183630040182ddb7936aed4495c314f |
| assets/repository-hkgfm0m5-BYhXorc2.js | 28716 | d65e0687e713bac7d4f93080614d67c9bdcbd3831f5574cfefd504b140392bb7 | assets/repository-hkgfm0m5-PxqIzirU.js | 28716 | a650c30ca6c31ebed2ce3cd7dfee2e0a1badcb471e04191ebc2e850969f51e81 |
| assets/repository-w6gqnbcy-C0qSTB2U.js | 274222 | 827e3e0f09effa581315d10ed2088aed828d65a71b01f164839ff608c413d520 | assets/repository-w6gqnbcy-Ctl2GzPx.js | 274222 | 25b245e708e0420f6fcbbdee01484469257dd038b67c1ace19b3b259e634c41d |
| assets/repository-w7a2abxy-C5e2XpC2.js | 484034 | a25ca7c71f3e9736ea479e58bf6a86bdc022d7f4a4e2e37f153204a4d12bca00 | assets/repository-w7a2abxy-C7x7sQr7.js | 484034 | 314f8b8db8a804571774106c1da2dee4111193f9635ca2453b94fd9c572debb6 |
| assets/responses-DMusqNVQ.js | 2026 | 0c358005bffea7ee3d9858cda1de77733c0544b92005f602c0eb84b4c65c4a0b | assets/responses-DEso72WU.js | 2026 | b35ffd81a035229b4ff08ec97580de2afeeca7f22456f0d6f61e19a41cb799b6 |
| assets/sdk-CQsXYxe1.js | 1465 | 5e9edc164f1b59d264bcad2e245dc2db9bb5f2666fd3aedcf21507dd8baab8a8 | assets/sdk-Ctbh2xz8.js | 1465 | 4d7f1de07d4150c12bb668d22f2149b93b233154247825a7f97f1f8abb386d07 |
| assets/src-1M-pW95A.js | 213509 | a105621be5961342b81c4832fcb7af7d7297a0166d27a25f017c9ffbbc68e8c0 | assets/src-ByqtgWCI.js | 213509 | 3968c78967c6a2565e2e9da3cc109626154c65a59c6ddfd1eb37467e773fac64 |
| assets/src-D3ATkwNz.js | 381404 | 5e44085343e67afc5e15f0f6e559415ec48302a0236acc640ebc77ea67b12c62 | assets/src-6vDJWgFO.js | 381404 | 6ba3772ad57fbef4addeafdb8d2d8f1b964397e2ac19a8c89baa0d0e450e464d |
| assets/worker-entry-CNGwpFzF.js | 10035493 | ae935df86f9a9ec7bcabfc46b5cc9aa52e24a2588e5f1fc7fd3434104f620729 | assets/worker-entry-DyRguOh3.js | 10023614 | 7f5290f7e52e71601869e3b53ad2966bf3d0f58ec37c3213242e1de5f2d03783 |
| index.js | 191 | 728604b2976ca75e5fee952fd12cb7caf6b89418ed97fdb5e04dfec13883f093 | index.js | 191 | e65a3edefd194ea8b63fc197e0b02f82d1053663552c70b78b000fd7dc8a9906 |

**Origen probable de las diferencias:** la evidencia independiente del build asocia #374 con el commit 74632f75..., mientras el candidato procede del commit 19bba24d.... La reconstrucción desde fuente distinta explica la divergencia; no se atribuye cada cambio compilado a una línea de TypeScript sin mapear código fuente/outputs. No se ha probado identidad completa entre #373 y el candidato; #373 es únicamente referencia histórica.

## 4. Comprobación específica de la PR #106

El código fuente src/server.ts del SHA candidato **sí** contiene SUPERVISOR_TRANSCRIPT_UNAVAILABLE_UNBOUNDED y elimina lecturas no acotadas en supervisión; el src/server.ts del SHA Cloudflare #374 **no** contiene ese marcador. El módulo compilado candidato assets/worker-entry-DyRguOh3.js contiene el marcador, pero **ninguno** de los 228 módulos del GET activo #374 lo contiene. Su módulo principal activo es assets/worker-entry-CNGwpFzF.js con SHA-256 ae935df86f9a9ec7bcabfc46b5cc9aa52e24a2588e5f1fc7fd3434104f620729, frente al candidato 7f5290f7e52e71601869e3b53ad2966bf3d0f58ec37c3213242e1de5f2d03783.

**Conclusión precisa:** el binario publicado **no corresponde** al candidato de la PR #106 y **no incorpora esa corrección específica**. No se descarta una protección diferente no analizada en el código activo. No se puede aceptar el despliegue #374 como publicación de F0-OOM-02.

## 5. Procedimiento reproducible, códigos y límites

1. Descargar artifact ID 14760462966 desde GitHub Actions; verificar ZIP de 24 168 777 bytes y SHA-256 esperado; descomprimir como contenedor ZIP (sin recompilar).
2. Verificar cada entrada de SHA256SUMS contra los cuatro archivos del ZIP. Para payload.tar.gz, recorrer los 543 archivos con TarFile y comparar ruta/tamaño/sha256 con manifest.json.
3. Para prebuilt-main.tar.gz, comparar los 228 *.js bajo prebuilt-main/ con dist/opencode_g1_staging/ de payload.tar.gz, byte a byte; comprobar outputModuleHashes y entrypoint.
4. Leer GET /workers/scripts/opencode-g1-staging/deployments y /versions/{version_id}, /builds/builds?version_ids=3546687b-4cd2-4e22-8ea9-ee5ea8fd02cb y /content/v2, usando credenciales ya autorizadas sin mostrarlas. Extraer las 228 partes y calcular SHA-256, tamaños y fingerprint según la convención anterior.
5. Comparar conjuntos por nombre+SHA+bytes, emparejar módulos renombrados por prefijo/rol y tamaño, e inspeccionar el marcador de contención. Repetir GET /deployments al final.

**Resultados observados:** unzip -t exit 0; sha256sum exit 0; script Python de integridad exit 0; GET Cloudflare ejecutados con éxito, sin exit code de shell (son llamadas de API). No hubo POST/PUT en Cloudflare, deploy, Bun build, tests runtime ni inferencia. El código de auditoría local no se incorporó al repo: los hashes y el inventario original del artifact son la fuente reproducible; los comandos anteriores describen el algoritmo comprobado.

**Límites:** el conector Cloudflare entrega content/v2 como multipart textual; se verifican los hashes de los módulos JS extraídos, no una exportación adicional de octetos crudos del transporte. Los 207 módulos coincidentes se acreditan mediante hashes SHA-256 por archivo, no mediante comparación directa de dos buffers remotos. Los assets publicados se observaron en metadata de la versión con SPA y rutas de API, pero **no** se certificó aquí su identidad byte a byte contra dist/client; corresponde a T05. Los campos de configuración de las versiones se consultaron, no se ensayó funcionamiento de DO/Containers.

## 6. Decisión y dependencia

**T02 = PASS investigativo**: identidad de la versión activa y relación binaria con el candidato determinadas; discrepancias delimitadas y documentadas. **F0-OOM-02 = BLOCKED / NOT PROMOTED / NO COMPLETE PASS**. Acción mínima potencial: terminar T03 (Worker MCP), T04 (transferencia verificable del artefacto original), T05 (compatibilidad y assets), revalidar concurrencia y crear versiones inactivas solamente en un lote con autorización específica; después decidir una promoción coordinada y probar runtime sin reproducir cargas inseguras. **No** se puede llamar equivalente a una reconstrucción desde otro commit ni aplicar un deploy para cerrar T02.

Referencias: [T01 documental](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/108), [PR #106](https://github.com/aamvtrampa36-del/opencode-harness-example/pull/106), [workflow artefactos](https://github.com/aamvtrampa36-del/opencode-harness-example/actions/runs/45038446357), [issue #90](https://github.com/aamvtrampa36-del/opencode-harness-example/issues/90). Cloudflare: script opencode-g1-staging, versión 3546687b-4cd2-4e22-8ea9-ee5ea8fd02cb, deployment 36ef84b3-0f99-4dd4-ab8e-c11ee450dd23, build df8bbe2b-6964-4f59-86d9-3c2c706da3aa.
