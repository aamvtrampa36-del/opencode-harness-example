# ROL 4 — VERIFICADOR (ejecución real)

Ejecutado por el coordinador en el Container Linux. Todos los comandos son reales;
los `exitCode` son los devueltos por el entorno.

## 1. Tests del experimento

```
$ cd tests/labs/multiagent-sim
$ bun test ./tests/classify-numbers.test.mjs
bun test v1.4.4 (38afee6c8)
...
 13 pass
 0 fail
 21 expect() calls
Ran 13 tests across 1 file. [6.00ms]
EXIT=0
```

Tras la corrección por el hallazgo del revisor:

```
 16 pass
 0 fail
 26 expect() calls
Ran 16 tests across 1 file. [8.00ms]
EXIT=0
```

Artefactos: `evidence/verifier-baseline.log`, `evidence/verifier-final.log`.

## 2. Rojo→verde del defecto señalado por el revisor

```
$ node evidence/red-before-fix.mjs
{"counts":{"positives":3,"negatives":0,"zeros":0,"total":2},"sum":3,"consistent":false}
EXIT=0
```

La versión anterior violaba la invariante de partición. La versión corregida pasa
R3 (16/16).

## 3. Ejecución JS y módulo ESM

```
$ node --input-type=module -e "import('./tests/labs/multiagent-sim/src/classify-numbers.mjs')..."
{"positives":[1],"negatives":[-1],"zeros":[0,0],"counts":{...}}
NODE_EXIT=0
```

Nota: JSON serializa `-0` como `0`; el test usa `Object.is` para distinguirlo.

## 4. Persistencia entre dos operaciones separadas

```
escritura 07:59:24Z  sha256 b24555a9bdc4669b651b232b6f2bb21654bd964a4a97528a647f20b1ffe0b3c0
lectura   07:59:28Z  sha256 b24555a9bdc4669b651b232b6f2bb21654bd964a4a97528a647f20b1ffe0b3c0
sha256sum -c ... -> OK, CHECK_EXIT=0
```

## 5. Test autocontenido del repositorio (sin `node_modules`)

```
$ bun test src/agent-check.test.ts
... 12 pass visibles en el extracto
EXIT=0
```

No se ejecutó la suite completa del repositorio: no hay `node_modules` y no se
instalaron dependencias (fuera del alcance y del coste de este laboratorio).

## 6. Límites técnicos observados

- `git` no existe en el Container (`fatal: not a git repository`): la entrega se
  hace con la herramienta GitHub, no con push local.
- Backend `codemode` de workspace no disponible: el host fuerza `dynamic-mcp` y la
  lectura devolvió `Error: no such path: /dynamic`.
- `python3` no instalado.
- No hay agentes como procesos independientes ni concurrencia física demostrada.
