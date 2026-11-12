# OpenCode Cloud — Control remoto supervisado en Staging (11/12 noviembre 2026)

## Fuente rectora y estado

Se recuperó el **Informe_Integral_OpenCode_Cloud_V1.pdf** completo (21 páginas, corte histórico 8–9 noviembre), el `docs/V1_EXECUTION_PLAN.md` vigente y los informes G1–G9. G9 consta cerrado en Staging sobre evidencias posteriores, incluida PR de autodesarrollo del agente; ese cierre **no autoriza** publicar el código en producción. El circuito de exportación Markdown de ambas conversaciones fue aceptado en Android y sigue en la PR #38; no son pruebas adversariales de la seguridad global.

**Producción actual:** Worker `opencode-harness-example` versión `1d70eb77-316e-408d-bd14-5f19b171dedf`, del 8 de noviembre. **Staging antes del cambio:** `opencode-g1-staging` versión `787978c3-964d-4f84-819e-de4ccdf53f59`. Ambos están protegidos por aplicaciones de Cloudflare Access de tipo `self_hosted`, con política de acceso del propietario. Containers separados `opencode-harness-example-devcontainer` y `opencode-g1-staging-devcontainer` ya existen.

El control remoto de esta PR es una **función de Staging**, no un permiso de promoción de sí mismo. Se ha añadido sin alterar la implementación de OpenCode, la exportación ni las PR previas. Rama basada en `feat/staging-conversation-markdown-export-20261111`; no hay merge automático.

## Funcionalidad implementada

`/api/supervisor/v1` en el Worker existente:

| Método y ruta | Función | Garantía |
|---|---|---|
| `GET /status` | Capacidades publicadas | Requiere Access y token |
| `POST /tasks` | Crear tarea en proyecto y rama aislados | Repositorio aprobado, ID idempotente, rama `opencode/supervised-<id>` |
| `GET /tasks/<id>` | Estado y cantidad de llamadas de herramientas | No acepta un PASS narrativo como verificación |
| `POST /tasks/<id>/cancel` | Cancelar modelo y registrar estado | Idempotente; nunca promueve |
| `GET /tasks/<id>/review` | Resumen GitHub de la rama fijada | Revisión pendiente de aprobación externa |
| `GET /tasks/<id>/transcript` | Markdown basado en historial persistido | Omite razonamiento interno, redacción básica; revisar antes de compartir |

La ruta está registrada en `assets.run_worker_first` de ambos Wrangler. El control remoto **solo se habilita por configuración en Staging**; en Producción la bandera está en `false`. Incluso en Staging la API no admite tareas si falta el secreto `OPENCODE_SUPERVISOR_TOKEN` (mínimo 32 caracteres) y el cliente debe superar **también** Cloudflare Access.

No se crea credencial ni política Access adicional automáticamente. Para conectar un cliente MCP/API externo hará falta una forma autorizada de atravesar Access —por ejemplo, una política apropiada de servicio— y la instalación o conexión explícita del cliente. No publicar secretos en commits ni en conversaciones.

### Inicio de una tarea

El cliente autorizado envía una solicitud JSON, por ejemplo:

```json
{
  "requestId": "a1234567890bcdef",
  "repository": "aamvtrampa36-del/opencode-harness-example",
  "prompt": "Localiza una regresión menor del proyecto, corrígela solo en la rama aislada, ejecuta pruebas y prepara una PR borrador con evidencias."
}
```

El servidor elige `supervised-a1234567890bcdef` como **único proyecto Linux**, precrea `opencode/supervised-a1234567890bcdef` en GitHub, crea una sesión OpenCode nueva y vincula repositorio/proyecto de manera inmutable en Durable Object. La IA no recibe tokens GitHub, no obtiene el checkout `.git` en Linux y no puede crear una segunda rama ni escribir o abrir PR fuera de su rama. Una repetición con el mismo `requestId` reutiliza el registro y no inicia otra inferencia; reutilizarlo con otro encargo se rechaza.

El endpoint **no expone rutas para fusionar, modificar secretos, desplegar producción, cambiar permisos ni promocionar una versión**. La supervisión externa mantiene la responsabilidad de revisar pruebas y PR, decidir aceptación y ejecutar una promoción mediante sus propias credenciales autorizadas.

## Seguridad, limitaciones y criterios de salida

- Preservar separación de Container, sesión, repositorio y branch; las herramientas del workspace compartido siguen bloqueadas para sesiones de proyecto.
- Access existente + bearer exclusivo de la API; no CORS público; respuestas `no-store`; tamaño y campos de solicitud acotados.
- Los errores, resultados de herramientas y conteos son evidencia, pero **una tarea terminada no equivale a un cambio aprobado**.
- La API no es un servidor MCP conectado automáticamente a ChatGPT. Es un contrato HTTP para conectar después, con permisos y autorización explícita; no afirmar control remoto de ChatGPT hasta verificar invocaciones reales desde la conexión.
- No existen todavía demostraciones de este nuevo endpoint con modelo real, de reversión conjunta Worker+Container o de un ciclo autopromocionado. No mezclar esas garantías con G9 histórico.
- La rama generada parte del `main` por limitación actual del puente GitHub; para preparar una candidata que incorpore cambios de una rama de Staging deberá revisarse el diff y la base antes de integrarlo. Evitar cualquier merge automático.
- Comprobar la misma petición autenticada desde el cliente remoto, negación sin token, idempotencia, aislamiento entre dos tareas, cancelación, revisión independiente, backup/restauración y costes antes de activar Producción.

**Cierre del circuito futuro:** OpenCode Producción prepara una PR borrador; un supervisor independiente verifica artefactos, pruebas y permisos; Staging valida con datos aislados; solo una operación autorizada promueve la versión y después comprueba su reversión. Ningún agente aprueba su propia promoción.


## Puente directo Cloudflare Workflows (sin token HTTP nuevo)

Staging incluye además la clase `OpenCodeSupervisorWorkflow`, publicada únicamente mediante `wrangler.g1.jsonc`, nombre **`opencode-supervisor-stage`**. Esta vía usa los permisos existentes de la cuenta Cloudflare conectada a ChatGPT, no abre otra URL al público, y no requiere enviar una credencial al modelo ni a la conversación.

Una invocación autorizada a la API de Workflows acepta `params` como cadena JSON, con operaciones:

- `{"action":"start","requestId":"<16hex>","repository":"aamvtrampa36-del/opencode-harness-example","prompt":"..."}` — reserva tarea aislada en el DO supervisor y solicita ejecución al agente.
- `{"action":"status","id":"<16hex>"}` — devuelve estado y herramientas realmente observadas; nunca aprueba el diff automáticamente.
- `{"action":"review","id":"<16hex>"}` — consulta la comparación GitHub contra la rama por defecto de ese repositorio.
- `{"action":"cancel","id":"<16hex>"}` — envía cancelación y persiste el estado.

Cada llamada Workflows es una operación limitada, con registro propio y sin creación automática de despliegues. El procesamiento prolongado del agente ocurre en su sesión DO; para inspeccionarlo se invoca `status` explícitamente. **ChatGPT no está supervisando por sí solo cuando no hay una invocación activa o una automatización autorizada.** La publicación a producción queda fuera de la API del agente.

**Seguridad de ambos canales:** la API HTTP conserva la obligación de superar Cloudflare Access y un bearer separado; mientras ese secreto no exista, está desactivada de hecho. La alternativa Workflows solo es accesible con permisos Cloudflare autorizados y debe comprobarse con una invocación real antes de afirmar que el control remoto está operativo.
