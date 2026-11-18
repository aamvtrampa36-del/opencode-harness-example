# Inventario de capacidades reales observadas

Fecha: 2026-11-18 (UTC). Proyecto Linux: `supervised-a74e19c0df6832ab`.
Base importada: `staging/opencode-g1-20261118` @ `1a5a3aaf3f46824798f7f54f688b3ccc1f3e0041`.
Rama de entrega: `opencode/staging-a74e19c0df6832ab`.

| Capacidad | Estado observado | Evidencia |
|---|---|---|
| Shell real (bash) | Sí | `uname -a`, `date`, `sha256sum`, exitCode 0 |
| Escritura de archivos | Sí, dentro del proyecto | `persistence-probe.txt` creado y releído |
| Persistencia entre operaciones | Sí | mismo SHA-256 en 2 llamadas separadas |
| Ejecución JS (Node) | Sí | `node v24.22.1`; salida JSON real |
| Ejecución de tests (Bun) | Sí | `bun 1.4.4`; 13 pass / 0 fail |
| `git` en Container | **No** | `fatal: not a git repository` (sin `.git`) |
| `python3` | **No** | `command not found` |
| `node_modules` | **No** instalado | `ls node_modules` vacío; solo tests autocontenidos corren |
| Backend `codemode` de workspace | **No disponible** en sesión de proyecto | el servidor fuerza `dynamic-mcp`; error `no such path: /dynamic` |
| Sesiones hijas (subagente) | Sí, sesión derivada de solo lectura | `start_subagent` devolvió `ses_e1255326cffct1hjizaUBRwmxI` |
| Procesos de agente independientes | **No demostrado** | no hay API para lanzar procesos/agentes del SO; el subagente es una sesión hija del mismo runtime |
| Concurrencia real entre roles | **No demostrada** | no se observó ejecución simultánea de dos roles ni relojes solapados |

## Lectura honesta

- Hay **coordinación real de herramientas** (shell, archivos, tests, GitHub) y
  **una sesión hija real** para revisión con contexto limpio.
- No hay evidencia de **agentes como procesos independientes** ni de
  **concurrencia física**. Los roles PLANIFICADOR e IMPLEMENTADOR son artefactos
  secuenciales escritos por el coordinador; el REVISOR se ejecutó en sesión hija
  separada; el VERIFICADOR son comandos reales ejecutados por el coordinador.
- El resultado del experimento no depende de que los roles sean procesos
  distintos: depende de artefactos separados y de tests ejecutados.

## Comandos y salidas clave

```
$ bun --version
1.4.4
$ node --version
v24.22.1
$ python3 --version
bash: python3: command not found
$ git status
fatal: not a git repository (or any of the parent directories): .git
```

Persistencia (2 operaciones separadas, ~4 s):

```
escritura 07:59:24Z  sha256 b24555a9bdc4669b651b232b6f2bb21654bd964a4a97528a647f20b1ffe0b3c0
lectura   07:59:28Z  sha256 b24555a9bdc4669b651b232b6f2bb21654bd964a4a97528a647f20b1ffe0b3c0  -> OK
```

`codemode` (intento de lectura del workspace desde el backend compartido):

```
result: {"ok":false,"error":"Error: no such path: /dynamic"}
```
