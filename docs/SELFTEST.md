# Selftest E2E reutilizable (`scripts/selftest.mjs`)

Mecanismo de autoprueba del código que OpenCode cambia, para que Armando no
tenga que probar botones ni comandos a mano. Bajo coste: sin red externa, sin
Workers AI, sin wrangler dev; solo Bun + un build de Vite + el servidor de
preview HTTP propio del proyecto.

## Qué reutiliza (no duplica)

- `bun test`, `bun run typecheck`, `scripts/check-invariants.mjs` y
  `scripts/test-preview.mjs` siguen siendo los checks canónicos de CI; con
  `--full` el selftest los **delega** y registra su resultado en el recibo.
- El entorno HTTP es el **mismo** `src/preview-server.ts` que ya prueba
  `test-preview.mjs`, pero alimentado con el artefacto real de `dist/client`.
- La validación de proyecto usa `validateProject` de `src/dev-guard.ts` y la
  prueba de runtime usa un nonce fresco, patrón de `src/agent-check.ts`: una
  salida simulada o vieja nunca pasa.

## Uso

```sh
bun scripts/selftest.mjs --branch opencode/<tarea> --commit <sha>      # E2E esencial
bun scripts/selftest.mjs --branch opencode/<tarea> --commit <sha> --full --reuse-dist
bun scripts/selftest.mjs --resume .selftest/receipt-fail.json          # solo lo afectado
```

Flags: `--project <slug>` (nombre servido, por defecto `selftest-candidate`),
`--allow-uncommitted` (solo iteración local), `--receipt <ruta>`,
`--only <a,b>`, `--force-build`. Códigos de salida: `0` pass, `1` fail,
`2` fail-closed.

## Etapas

1. `preflight` — Bun real, prueba de spawn con nonce fresco
   (`SELFTEST_PROOF_OK:<nonce>`), prueba de escritura temporal.
2. `build` — `bun run build` real (artefacto candidato); registra SHA-256 de
   `dist/client/index.html` y del bundle del Worker
   `dist/opencode_harness_example/index.js`.
3. `serve` — copia `dist/client` a un directorio temporal y arranca
   `PREVIEW_SOURCE` (node o bun) con `/__health` como sonda.
4. `http` — checks contra el entorno real: índice 200 `text/html`
   **byte-idéntico** al artefacto, asset real 200 `javascript` byte-idéntico,
   y tres negativos: 404 (inexistente con nonce), 403 (árbol fuente fuera de
   `dist`), 405 (POST).

`receipt.json` recoge: esquema, runId, project/branch/commit
(`commitLinked`), runtime, etapas con exit/ms/cola de log, checks esperado vs
real con SHA-256, artefacto, veredicto (`pass` | `fail` | `fail-closed`) y la
nota móvil. Se niega a escribirse si contuviera un posible secreto
(mismos patrones que `check-invariants.mjs`).

## Fallar cerrado

Nunca se atribuye PASS a una simulación. Evidencia real obtenida en staging
(contenedor Linux de 1,1 GB):

- sin Bun (`node scripts/selftest.mjs`) → `exit 2`, mensaje limpio, sin PASS;
- rama no-`opencode/*` → `exit 2` (`target.branch`);
- sin `--commit` y sin `--allow-uncommitted` → `exit 2` (`target.commit`);
- heap por defecto de tsc (512 MB) → `SIGABRT` `exit 134`; heap sin techo en
  vite → `SIGKILL` del OOM del sistema `exit 137`. Por eso el runner fija
  `NODE_OPTIONS` por defecto (`build` 768 MB, `typecheck` 2048 MB), solo si
  el entorno no define `NODE_OPTIONS`; sobreescribíble.
- build roto → `verdict "fail"`, `exit 1`, con la línea exacta del error en el
  recibo; el `dist` obsoleto queda **sin certificar** (`buildArtifact: null`)
  y no se sirve ni se prueba HTTP.

### Integración en CI (pendiente de aprobación del propietario)

Intentar añadir el paso a `.github/workflows/ci.yml` fue **bloqueado**: esa ruta
está protegida contra escrituras de OpenCode. El propietario puede añadirlo a
mano tras el paso de invariantes (que ya deja `dist/` compilado):

```yaml
      - name: E2E selftest on the built artifact
        run: bun scripts/selftest.mjs --project selftest-candidate --branch "${GITHUB_HEAD_REF:-$GITHUB_REF_NAME}" --commit "$GITHUB_SHA" --reuse-dist
```

Un `workflow_dispatch` desde `main` recibirá `GITHUB_REF_NAME=main` y el
guardián de rama fallará cerrado a propósito: el selftest solo declara
aislamiento sobre ramas de revisión `opencode/*`.

## Reejecución solo de lo afectado

`--resume <recibo>` lee el recibo anterior y reejecuta las etapas fallidas más
sus dependientes (`preflight → build → serve → http`); las que pasaron se
registran como `skipped: "passed previously"`. Si el SHA-256 del artefacto en
disco cambió (o `--force-build`), el build se rehace. Ciclo demostrado en
staging: sabotaje real (`src/tool-permissions.ts:26:27`) → `fail` con
evidencia corregible → revertir → `--resume` → `pass` reejecutando solo
`build`, `serve`, `http`.

## Ejecución móvil

La verificación móvil sigue en su automatización compatible ya existente
(`.github/workflows/android-apk.yml` compila y verifica el APK con firma,
manifiesto y permisos). El recibo lo declara y **no afirma hardware real**:
ningún resultado de este selftest implica pruebas en dispositivo físico.

## Límites honestos

Cubre el artefacto web compilado servido por HTTP y el bundle del Worker como
archivo. No ejercita el runtime de workerd ni el bucle del agente en el
Durable Object (eso requeriría `wrangler dev` con binding remoto de Workers AI,
con coste); para eso siguen valiendo las pruebas de `test-preview.mjs` y el
despliegue controlado.
