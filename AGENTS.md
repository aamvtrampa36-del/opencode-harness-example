# OpenCode Cloud — instrucciones generales de ingeniería

Este repositorio ejecuta un **OpenCode Workerd embebido y experimental**, no la aplicación nativa OpenCode CLI. El Container Linux es un ejecutor separado. No afirmes que un agente ejecutó herramientas si únicamente generó texto ni confundas una compilación con una prueba integral.

## Objetivos

1. Seguridad y preservación del trabajo del propietario.
2. Desarrollo autónomo verificable con herramientas reales.
3. Arquitectura mínima, mantenible y reversible; usar capacidades nativas antes de crear adaptadores.
4. Menor costo total de infraestructura, modelos y operaciones.
5. Autorizaciones explícitas solo para credenciales, producción, gastos relevantes y operaciones irreversibles.

## Desarrollo

- Trabaja en una rama separada; no modifiques directamente ramas productivas ni servicios ajenos.
- Sigue: error reproducido → causa raíz → corrección mínima → prueba específica → regresión e integración.
- Usa la versión fijada de dependencias y el archivo `bun.lock`; no actualices paquetes por inercia.
- Distingue tipos de validación: estática, unitaria, integración, ejecución real de herramientas y recuperación.
- Examina `wrangler.jsonc` antes de ejecutar comandos o cambiar recursos. La presencia de una vinculación no demuestra disponibilidad real de un servicio.
- El Container expone Linux/npm/Git mediante un puente: no lo confundas con herramientas CLI nativas de OpenCode.
- No borres módulos, respaldos o estados persistentes sin restauración verificada.
- Si una capacidad nueva ya existe en OpenCode, estudia sustituir el puente existente antes de crear otro.

## Dominio y contenido del usuario

- El motor y las instrucciones obligatorias son generalistas: programación, pruebas, documentación y trabajo creativo.
- Las instrucciones especiales de CDF, Android, escritura u otros proyectos corresponden a **configuración específica del proyecto**, no a este núcleo.
- Puedes preparar borradores, propuestas y cambios reversibles; no canonices contenido, sobrescribas fuentes oficiales, publiques ni integres definitivamente sin aprobación expresa del propietario.
- No inventes contenido de archivos, estado de integraciones ni resultados de consultas.

## Permisos y costos

- Usa el mínimo privilegio; conserva Cloudflare Access y las restricciones de ramas GitHub.
- Nunca muestres secretos en código, mensajes, registros ni pruebas. No envíes claves de producción al modelo ni al Container.
- No despliegues producción, cambies credenciales, actives recursos costosos o revoques permisos sin autorización.
- Prefiere modelos económicos para pruebas repetibles y fija límites de gasto en el proveedor.
- No crees pruebas Cron persistentes para ensayos puntuales.

## Informe de cada intervención

Explica qué observaste, qué cambiaste, cuáles verificaciones ejecutaste realmente y qué quedó sin demostrar. La reducción de complejidad debe conservar capacidades y recuperación; no basta con contar menos archivos.
