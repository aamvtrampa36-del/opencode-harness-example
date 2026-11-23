# F0-C10/R3-T02 — DO descartable local (NO STAGING)

Esta prueba usa **un único Durable Object lógico** `ResidencyProbe` y SQLite local, no el SDK/OpenCode verdadero. No intenta generar diez isolates ni comprobar la memoria física por DO. El archivo `wrangler.jsonc` es **solo del fixture**, con migración local `test-local-only-v1`; no cambia `wrangler.g1.jsonc`, bindings, clases publicadas ni migraciones de Staging.

## Requisitos y límites

- Bun 1.4.4 y Wrangler 4.158.0 instalados desde el `bun.lock` del repo (`bun install --frozen-lockfile`), en una máquina **descartable y sin secretos de producción**.
- Iniciar **solo** `wrangler dev --local`, escuchar `127.0.0.1:8787`. No usar `--remote`, `wrangler deploy` ni iniciar tareas `staging_start_task`.
- Directorio de persistencia local elegido por el operador (p.ej. `mktemp -d`); **usar exactamente el mismo** al reiniciar Wrangler, o no se podrá afirmar recuperación de SQLite.
- CPU y RSS del proceso `workerd`/Wrangler se pueden observar con herramientas locales (`ps`, `time`), pero RSS de proceso **no es heap/isolate real**. El endpoint devuelve `durationMs` por llamada y `memoryIsolateMiB:null`.
- Sin inferencia, sin red remota y sin garantías de seguridad de aislamiento: workerd local **no es un sandbox endurecido**.

## Ejecución propuesta, NO EJECUTADA en este encargo

Terminal A, desde el root del repo:

```sh
DATA_DIR="$(mktemp -d /tmp/f0-c10-r3-t02-XXXXXX)"
echo "$DATA_DIR"
./node_modules/.bin/wrangler dev --local --ip 127.0.0.1 --port 8787 \
  --persist-to "$DATA_DIR" --config scripts/f0-c10/r3-t02-workerd/wrangler.jsonc
```

Terminal B, desde el root del repo:

```sh
node scripts/f0-c10/r3-t02-workerd/smoke.mjs prepare
```

La prueba `prepare` ejecuta series 1→2→4→10 en el mismo DO y **cierra cada serie**; verifica que `activeReferences=0`, salvo la sesión `r3t02_000003e7` preparada para probar recuperación. Registra latencia (`durationMs`) y estado SQLite (sin secretos). **No demuestra concurrencia física ni agentes reales**.

Detener Wrangler con Ctrl-C (sin borrar el directorio de prueba). Iniciar nuevamente Wrangler con **el mismo** `--persist-to` y configuración. Después:

```sh
node scripts/f0-c10/r3-t02-workerd/smoke.mjs verify
```

Debe leer fila `running` persistida, `activeReferences=0` después del nuevo proceso y negativa `RECOVERY_UNCONFIRMED` ante `/step` sin nueva asociación. Si se observa lo contrario: RED / STOP, conservar logs anónimos y no continuar hacia Staging. No se afirma PASS del trabajo inconcluso.

## Pruebas negativas, tiempos y capturas permitidas

- POST `/start` con ID malformado → 400, sin storage; duplicado → 409 `EXISTS`; `/continue` de running/cancelled → 409.
- Once solicitudes únicas simultáneas sobre un DO con capacidad 10 → la 11.ª recibe `CAPACITY` o `EXISTS`, nunca un undécimo registro `running`. **Por hacer**: el driver solo ejecuta series ≤10.
- Timeout del cliente (p.ej. `AbortSignal.timeout(5_000)`): no prueba que el servidor no haya realizado un efecto. No reenviar como nuevo ID sin conciliación. La inyección de un efecto completado tras perder la respuesta está pendiente.
- Comparar mediana/p95 de `durationMs`, conteo de referencias y filas, CPU y RSS **de proceso** antes/durante/después, y `openedAt` diferente tras reinicio. Para **memoria del isolate**, obtener métricas Cloudflare en otro lote, correlacionadas con trazas auténticas; no inventar API `memoryUsage` dentro de workerd.
- No cargar datos reales de `OpenCodeAgent`: clase nueva y SQLite local ficticio. Validar aparte `agents@0.33.0`, `sessions.get({sessionID})`, `create({id})`, `wait`, `log`, leases y alarmas.

**No se ejecutó este fixture**: el entorno disponible tiene Node 22.16.0, no Bun/Wrangler/dependencias ni acceso de red del contenedor. CI ejecuta `node --check` del Worker y driver: sintaxis, **no** semántica workerd/DO. El protocolo está en `docs/f0-c10/02_DURABLE_OBJECTS.md` (R3).
