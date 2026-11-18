// Prueba E2E de la app estática "Tareas del día" (public/tareas/index.html).
// Sirve public/ (raíz web en producción) con un servidor estático interno y ejercita
// la app en Chromium real. Sigue la convención de scripts/test-staging-mobile.mjs:
// viewport móvil 393x852 (isMobile, hasTouch), interfaz en español y
// selectores por rol accesibles. No depende de vite ni de wrangler.
// Uso: node scripts/test-tareas-app.mjs
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const raizProyecto = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// En producción Vite copia public/ a dist/client y Workers la sirve como raíz
// web; aquí se hace lo mismo con public/ para reproducir la ruta /tareas/index.html.
const raiz = join(raizProyecto, "public");
const MIMES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".ico": "image/x-icon"
};

const servidor = createServer(async (req, res) => {
  try {
    const ruta = normalize(decodeURIComponent(new URL(req.url, "http://local").pathname));
    const archivo = join(raiz, ruta);
    if (!(archivo === raiz || archivo.startsWith(raiz + "/")))
      throw new Error("ruta fuera de la raíz web");
    const contenido = await readFile(archivo);
    res.writeHead(200, { "Content-Type": MIMES[extname(archivo).toLowerCase()] ?? "application/octet-stream" });
    res.end(contenido);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("No encontrado");
  }
});
await new Promise((ok) => servidor.listen(0, "127.0.0.1", ok));
const puerto = servidor.address().port;
const url = `http://127.0.0.1:${puerto}/tareas/index.html`;

const navegador = await chromium.launch({ headless: true });
const contexto = await navegador.newContext({
  viewport: { width: 393, height: 852 },
  deviceScaleFactor: 1,
  isMobile: true,
  hasTouch: true
});
const pagina = await contexto.newPage();
const errores = [];
pagina.on("pageerror", (error) => errores.push(error.message));

let fallos = 0;
const paso = async (nombre, fn) => {
  try {
    await fn();
    console.log(`  ok  ${nombre}`);
  } catch (error) {
    fallos++;
    console.error(`  FALLO  ${nombre}: ${error.message}`);
  }
};

const lista = pagina.getByRole("list", { name: "Lista de tareas" });
const contador = pagina.getByRole("status");
const entrada = pagina.getByLabel("Nueva tarea");
const filas = (texto) => lista.locator("li").filter({ hasText: texto });

console.log(`Abriendo ${url}`);
try {
  await pagina.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });

  await paso("la página carga con título e h1 en español", async () => {
    assert.equal(await pagina.title(), "Tareas del día");
    await pagina.getByRole("heading", { name: "Tareas del día" }).waitFor({ timeout: 10_000 });
  });

  await paso("declara viewport móvil", async () => {
    assert.ok(
      await pagina.evaluate(() => Boolean(document.querySelector('meta[name="viewport"]'))),
      "falta meta viewport"
    );
  });

  await paso("estado vacío inicial y contador en cero", async () => {
    assert.equal(await contador.textContent(), "Sin tareas");
    await pagina.getByText("Aún no hay tareas. Añade la primera para empezar.").waitFor();
  });

  await paso("crea tareas con botón y con Enter", async () => {
    await entrada.fill("Comprar pan");
    await pagina.getByRole("button", { name: "Añadir", exact: true }).click();
    await entrada.fill("Regar las plantas");
    await entrada.press("Enter");
    await entrada.fill("Llamar a Ana");
    await pagina.getByRole("button", { name: "Añadir", exact: true }).click();
    assert.equal(await lista.locator("li").count(), 3, "deben existir 3 tareas");
  });

  await paso("contador de pendientes refleja el estado", async () => {
    assert.equal(await contador.textContent(), "3 de 3 pendientes");
  });

  await paso("marcar una tarea como completada", async () => {
    const caja = pagina.getByRole("checkbox", { name: "Completar tarea: Comprar pan" });
    await caja.check();
    assert.ok(await caja.isChecked(), "la casilla debe quedar marcada");
    const fila = filas("Comprar pan");
    assert.match((await fila.getAttribute("class")) ?? "", /hecha/, "la fila debe marcarse como hecha");
    assert.equal(await contador.textContent(), "2 de 3 pendientes");
  });

  await paso("filtra por pendientes", async () => {
    await pagina.getByRole("button", { name: "Pendientes", exact: true }).click();
    assert.equal(await lista.locator("li").count(), 2, "solo deben verse las 2 pendientes");
    assert.equal(await filas("Comprar pan").count(), 0, "la completada debe ocultarse");
  });

  await paso("filtra por completadas y marca aria-pressed", async () => {
    await pagina.getByRole("button", { name: "Completadas", exact: true }).click();
    assert.equal(await lista.locator("li").count(), 1, "solo debe verse la completada");
    await filas("Comprar pan").waitFor();
    assert.equal(
      await pagina.getByRole("button", { name: "Completadas", exact: true }).getAttribute("aria-pressed"),
      "true",
      "el filtro activo debe marcar aria-pressed"
    );
    assert.equal(
      await pagina.getByRole("button", { name: "Todas", exact: true }).getAttribute("aria-pressed"),
      "false",
      "los filtros inactivos deben marcar aria-pressed=false"
    );
  });

  await paso("añadir en Completadas vuelve a Todas y muestra la tarea nueva", async () => {
    await entrada.fill("Recoger el paquete");
    await pagina.getByRole("button", { name: "Añadir", exact: true }).click();
    assert.equal(await lista.locator("li").count(), 4, "deben verse las 4 tareas en Todas");
    assert.equal(await contador.textContent(), "3 de 4 pendientes");
  });

  await paso("conserva las tareas al recargar (localStorage)", async () => {
    await pagina.reload({ waitUntil: "domcontentloaded" });
    assert.equal(await lista.locator("li").count(), 4, "las 4 tareas deben sobrevivir a la recarga");
    assert.equal(await contador.textContent(), "3 de 4 pendientes");
    assert.ok(
      await pagina
        .getByRole("checkbox", { name: "Completar tarea: Comprar pan" })
        .isChecked(),
      "el estado completado debe persistir"
    );
    const bruto = await pagina.evaluate(() => localStorage.getItem("tareas-del-dia:v1"));
    const datos = JSON.parse(bruto ?? "null");
    assert.ok(Array.isArray(datos) && datos.length === 4, "localStorage debe guardar las 4 tareas");
  });

  await paso("elimina una tarea", async () => {
    await pagina.getByRole("button", { name: "Eliminar tarea: Llamar a Ana" }).click();
    assert.equal(await lista.locator("li").count(), 3);
    assert.equal(await contador.textContent(), "2 de 3 pendientes");
    assert.equal(await filas("Llamar a Ana").count(), 0);
  });

  await paso("desmarcar deja el filtro Completadas vacío", async () => {
    await pagina.getByRole("checkbox", { name: "Completar tarea: Comprar pan" }).uncheck();
    assert.equal(await contador.textContent(), "3 de 3 pendientes");
    await pagina.getByRole("button", { name: "Completadas", exact: true }).click();
    await pagina.getByText("Todavía no has completado ninguna tarea.").waitFor();
    assert.equal(await lista.locator("li").count(), 0);
  });

  await paso("vaciar la lista muestra el estado vacío general", async () => {
    await pagina.getByRole("button", { name: "Todas", exact: true }).click();
    for (const texto of ["Recoger el paquete", "Regar las plantas", "Comprar pan"]) {
      await pagina.getByRole("button", { name: "Eliminar tarea: " + texto }).click();
    }
    await pagina.getByText("Aún no hay tareas. Añade la primera para empezar.").waitFor();
    assert.equal(await contador.textContent(), "Sin tareas");
    assert.equal(await pagina.evaluate(() => localStorage.getItem("tareas-del-dia:v1")), "[]");
  });

  await paso("sin errores de página durante toda la prueba", async () => {
    assert.deepEqual(errores, [], "no deben producirse errores en la página");
  });

  await paso("evidencia visual en viewport móvil", async () => {
    await entrada.fill("Preparar la mochila");
    await pagina.getByRole("button", { name: "Añadir", exact: true }).click();
    await pagina.screenshot({
      path: join(process.env.RUNNER_TEMP ?? "/tmp", "tareas-del-dia-393x852.png")
    });
    console.log(`  captura: ${join(process.env.RUNNER_TEMP ?? "/tmp", "tareas-del-dia-393x852.png")}`);
  });
} finally {
  await navegador.close().catch(() => undefined);
  await new Promise((ok) => servidor.close(ok));
}
console.log(fallos === 0 ? "Prueba de Tareas del día: TODO OK" : `Prueba de Tareas del día: ${fallos} fallo(s)`);
process.exitCode = fallos === 0 && errores.length === 0 ? 0 : 1;
