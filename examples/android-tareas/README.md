# Tareas Nube (Android)

Aplicación Android Java sin conexión a internet para añadir, completar y eliminar tareas.

- No requiere cuentas ni servicios externos.
- Usa SharedPreferences + JSON en el dispositivo.
- Pruebas unitarias con JUnit 4.
- `applicationId`: `com.example.tareasnube`.
- Android 6.0+ (minSdk 23).

Para compilar, ejecuta el workflow **Build Android test APK** de GitHub Actions o usa Android SDK y Gradle 8.13 localmente:

```sh
gradle testDebugUnitTest assembleDebug
```

La versión de prueba se firma automáticamente con la clave de depuración de Android. No es una versión de Play Store.

> Nota de procedencia: este prototipo inicial fue preparado de forma independiente mientras se investigaba la ejecución real del agente OpenCode. Un APK compilado por GitHub Actions NO demuestra por sí mismo que el agente OpenCode haya creado el código. Esa comprobación se informa por separado.
