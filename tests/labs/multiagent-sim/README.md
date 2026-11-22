# Laboratorio: simulación multiagente y prueba de capacidades

Ámbito: **solo staging**, carpeta aislada `tests/labs/multiagent-sim/`.
No toca módulos productivos, secretos, configuración externa ni despliegues.

- Proyecto Linux: `supervised-a74e19c0df6832ab`
- Base importada: `staging/opencode-g1-20261118` @ `1a5a3aaf3f46824798f7f54f688b3ccc1f3e0041`
- Rama de entrega: `opencode/staging-a74e19c0df6832ab`
- Container sin `.git`; entrega vía herramienta GitHub, no `git push`.

## Resultado

| Elemento | Resultado |
|---|---|
| Tests del experimento (versión final) | **16 pass / 0 fail**, exit 0 |
| Tests antes de la corrección | 13 pass / 0 fail |
| Defecto detectado por el revisor | **Real** (Proxy con `length` inconsistente) |
| Rojo→verde del defecto | `total: 2`, suma 3, `consistent: false` → corregido |
| Persistencia entre 2 operaciones | **Sí**, SHA-256 idéntico, `CHECK_EXIT=0` |
| Agentes independientes reales | **No demostrado** (solo una sesión hija) |
| Concurrencia física de roles | **No demostrada** |

## Qué es real y qué es simulado

| Rol | Ejecución | Evidencia |
|---|---|---|
| PLANIFICADOR | Artefacto secuencial escrito por el coordinador | `roles/01-planner.md` |
| IMPLEMENTADOR | Artefacto secuencial escrito por el coordinador | `roles/02-implementer.md`, `src/classify-numbers.mjs` |
| REVISOR | **Sesión hija real** de solo lectura, contexto limpio | `roles/03-reviewer.md`, sesión `ses_e1255326cffct1hjizaUBRwmxI` |
| VERIFICADOR | Comandos reales en el Container | `roles/04-verifier.md`, `evidence/*.log` |

El revisor **no** es un proceso del sistema operativo: es una sesión derivada del
mismo runtime, sin historial compartido, que leyó los archivos por su cuenta y
razonó de forma estática. No ejecutó tests. Por tanto hay **coordinación real de
herramientas y una revisión separada**, pero **no** independencia de proceso ni
concurrencia demostrada. Los roles 1, 2 y 4 son división de trabajo simulada de
forma honesta, no agentes autónomos.

## Función y contrato

`classifyNumbers(values)` devuelve:

```js
{
  positives: number[],
  negatives: number[],
  zeros: number[],
  counts: { positives, negatives, zeros, total }
}
```

- Orden de entrada conservado dentro de cada grupo.
- `-0` y `0` cuentan como ceros.
- Rechazo atómico con `TypeError` (índice en el mensaje) para `NaN`, `±Infinity`,
  cadenas, `null`, `undefined`, huecos, `BigInt` y objetos `Number`.
- `length` se lee una sola vez: un Proxy con `get` inconsistente no rompe
  `total === suma de conteos`.

## Reproducir

```bash
cd tests/labs/multiagent-sim
bun test ./tests/classify-numbers.test.mjs      # 16 pass / 0 fail
node evidence/red-before-fix.mjs                # demuestra el fallo original
```

## Artefactos

```
roles/01-planner.md          especificación y casos límite
roles/02-implementer.md      decisiones de implementación
roles/03-reviewer.md         crítica independiente + caso adversarial
roles/04-verifier.md         comandos, salidas y límites
src/classify-numbers.mjs     implementación
tests/classify-numbers.test.mjs  16 tests
evidence/capability-inventory.md inventario real de capacidades
evidence/verifier-baseline.log   13 pass / 0 fail (antes)
evidence/verifier-final.log      16 pass / 0 fail (después)
evidence/red-before-fix.mjs/.log fallo real del Proxy
evidence/persistence-probe.txt   prueba de persistencia
evidence/repo-suite-sample.log   test autocontenido del repo
```

## Límites

- No se ejecutó la suite completa del repositorio: no hay `node_modules` y no se
  instalaron dependencias.
- El Container no contiene repositorio Git (sin `.git`, `git status` falla), aunque
  el binario `git` sí está disponible (`git hash-object` funcionó). Tampoco hay
  `python3` ni backend `codemode` de workspace en esta sesión.
- El experimento no mide calidad de modelos ni paralelismo; mide coordinación y
  trazabilidad de artefactos con pruebas ejecutables.

## Próximos pasos mínimos

1. Revisar el diff de la PR borrador; no fusionar sin aprobación.
2. Si se quiere medir concurrencia real, ejecutar dos sesiones hijas en paralelo y
   registrar marcas de tiempo solapadas; este laboratorio no lo hizo.
3. Si se desea, promover `classify-numbers` fuera del laboratorio solo con una
   decisión explícita y tests de integración del proyecto.
