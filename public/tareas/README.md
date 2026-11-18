# Tareas del día

App estática autocontenida (un solo `index.html`, sin dependencias ni pasos de
build) para organizar las tareas de hoy: crear, completar, eliminar y filtrar
por todas / pendientes / completadas, con persistencia en `localStorage`
(clave `tareas-del-dia:v1`).

- **URL**: `/tareas/index.html` (y `/tareas/`). Vite copia `public/` tal cual a
  `dist/client/` y el servidor de assets de Workers la sirve; no toca el resto
  de la app (`OpenCodeHarness`) ni la configuración.
- **Prueba E2E**: `node scripts/test-tareas-app.mjs` (Chromium, viewport móvil
  393x852; requiere `playwright`, ya presente en `devDependencies`).
- **Accesibilidad**: etiqueta visible, `aria-pressed` en filtros, `role=status`
  para el contador, `aria-label` en casillas y botones de eliminar, objetivos
  táctiles de 44 px y foco visible.
