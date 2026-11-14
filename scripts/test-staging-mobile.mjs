import assert from "node:assert/strict";
import { chromium } from "playwright";

const STAGING_URL = "https://opencode-g1-staging.cdf-cloud-mvp-20261019.workers.dev";
const targetUrl = new URL(process.env.OPENCODE_E2E_URL || STAGING_URL);
const localHost = ["localhost", "127.0.0.1"].includes(targetUrl.hostname);
const accessId = process.env.CF_ACCESS_CLIENT_ID;
const accessSecret = process.env.CF_ACCESS_CLIENT_SECRET;
const sendLiveMessage = process.env.OPENCODE_STAGING_SEND_MESSAGE === "true";

if (targetUrl.origin !== STAGING_URL && !localHost) {
  throw new Error("La prueba solo permite Staging o un servidor local; Producción queda excluida.");
}
if (!localHost && (!accessId || !accessSecret)) {
  throw new Error("Configura CF_ACCESS_CLIENT_ID y CF_ACCESS_CLIENT_SECRET en GitHub Actions Secrets.");
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 393, height: 852 },
  deviceScaleFactor: 1,
  isMobile: true,
  hasTouch: true,
  extraHTTPHeaders: localHost ? {} : {
    "CF-Access-Client-Id": accessId,
    "CF-Access-Client-Secret": accessSecret
  }
});
const page = await context.newPage();
const pageErrors = [];
page.on("pageerror", error => pageErrors.push(error.message));

try {
  await page.goto(targetUrl.toString(), { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.getByRole("heading", { name: "OpenCode Cloud" }).waitFor({ timeout: 60_000 });
  await page.getByRole("status").filter({ hasText: "En línea" }).waitFor({ timeout: 60_000 });

  const initialSession = await page.evaluate(() => localStorage.getItem("opencode-harness-session"));
  assert.ok(initialSession, "La aplicación debe crear una sesión de conversación.");

  const conversationsButton = page.getByRole("button", { name: "Conversaciones", exact: true });
  await conversationsButton.click();
  const conversations = page.getByRole("navigation", { name: "Conversaciones" });
  await conversations.waitFor({ state: "visible" });
  assert.equal(await conversations.locator('button[aria-current="page"]').count(), 1);
  await page.getByRole("button", { name: "Cerrar lista de conversaciones" }).click();
  await conversations.waitFor({ state: "hidden" });
  await conversationsButton.click();
  await conversations.waitFor({ state: "visible" });
  await page.getByRole("button", { name: "Nueva conversación" }).click();
  await page.waitForFunction(
    previous => localStorage.getItem("opencode-harness-session") !== previous,
    initialSession,
    { timeout: 20_000 }
  );
  const newSession = await page.evaluate(() => localStorage.getItem("opencode-harness-session"));
  assert.ok(newSession && newSession !== initialSession, "Crear conversación debe seleccionar una sesión nueva.");
  await conversations.waitFor({ state: "hidden" });

  await conversationsButton.click();
  await conversations.waitFor({ state: "visible" });
  const otherConversation = conversations.locator('button:not([aria-current="page"])').first();
  await otherConversation.waitFor({ state: "visible" });
  await otherConversation.click();
  await page.waitForFunction(
    selected => localStorage.getItem("opencode-harness-session") !== selected,
    newSession,
    { timeout: 10_000 }
  );
  await conversations.waitFor({ state: "hidden" });

  const modelButton = page.getByRole("button", { name: /Elegir modelo de IA/ });
  await modelButton.click();
  const modelDialog = page.getByRole("dialog", { name: "Seleccionar modelo" });
  await modelDialog.waitFor({ state: "visible" });
  await modelDialog.getByRole("button", { name: "Simple", exact: true }).click();
  const profiles = modelDialog.getByRole("listbox", { name: "Perfiles sencillos" });
  assert.equal(await profiles.getByRole("option").count(), 5, "Deben seguir disponibles los cinco perfiles simples.");
  await profiles.getByRole("option", { name: /Cloudflare/ }).click();

  const selectedSession = await page.evaluate(() => localStorage.getItem("opencode-harness-session"));
  const selectedProfile = await page.evaluate(
    session => localStorage.getItem("opencode-model-preset:" + session), selectedSession
  );
  assert.equal(selectedProfile, "cloudflare", "El perfil elegido debe guardarse en la conversación actual.");

  await modelButton.click();
  await modelDialog.getByRole("button", { name: "OpenRouter", exact: true }).click();
  const providerNotConfigured = await modelDialog.getByText(/Conecta tu clave de OpenRouter/).count();
  const routerReady = providerNotConfigured === 0;
  if (routerReady) {
    await modelDialog.getByRole("button", { name: /Auto Router/ }).click();
    assert.equal(await page.evaluate(
      session => localStorage.getItem("opencode-model-preset:" + session), selectedSession
    ), "openrouter:openrouter/auto");

    await modelButton.click();
    await modelDialog.getByRole("button", { name: /Auto Code/ }).click();
    assert.equal(await page.evaluate(
      session => localStorage.getItem("opencode-model-preset:" + session), selectedSession
    ), "openrouter:openrouter/auto-code");

    await modelButton.click();
    const modelOptions = modelDialog.getByRole("listbox", { name: "Modelos OpenRouter" }).getByRole("option");
    await modelOptions.first().waitFor({ timeout: 30_000 });
    const firstModelId = await modelOptions.first().locator("span").nth(1).innerText();
    await modelDialog.getByRole("searchbox", { name: "Buscar modelos con soporte de herramientas" }).fill(firstModelId);
    await modelOptions.first().click();
    const concreteSelection = await page.evaluate(
      session => localStorage.getItem("opencode-model-preset:" + session), selectedSession
    );
    assert.equal(concreteSelection, "openrouter:" + firstModelId, "El catálogo debe permitir buscar y elegir un modelo concreto.");
    assert.ok(!["openrouter:openrouter/auto", "openrouter:openrouter/auto-code"].includes(concreteSelection));

    await modelButton.click();
    await modelDialog.getByRole("button", { name: "Simple", exact: true }).click();
    await modelDialog.getByRole("option", { name: /Cloudflare/ }).click();
    assert.equal(await page.evaluate(
      session => localStorage.getItem("opencode-model-preset:" + session), selectedSession
    ), "cloudflare", "Debe poder volver a un perfil sencillo.");
  } else {
    console.log("OpenRouter no está configurado en Staging; se verificó la selección simple y se omitió el catálogo.");
    await modelDialog.getByRole("button", { name: "Simple", exact: true }).click();
    await modelDialog.getByRole("option", { name: /Cloudflare/ }).click();
  }

  await conversationsButton.click();
  await conversations.waitFor({ state: "visible" });
  await conversations.locator(`[data-session-id="${newSession}"]`).click();
  await page.waitForFunction(
    selected => localStorage.getItem("opencode-harness-session") === selected,
    newSession,
    { timeout: 10_000 }
  );
  await conversationsButton.click();
  await conversations.waitFor({ state: "visible" });
  await conversations.locator(`[data-session-id="${selectedSession}"]`).click();
  await page.waitForFunction(
    selected => localStorage.getItem("opencode-harness-session") === selected,
    selectedSession,
    { timeout: 10_000 }
  );
  assert.equal(await page.evaluate(
    session => localStorage.getItem("opencode-model-preset:" + session), selectedSession
  ), "cloudflare", "Al volver, debe conservarse el modelo elegido en esa conversación.");

  if (sendLiveMessage) {
    assert.ok(routerReady, "OpenRouter debe estar configurado para ejecutar el mensaje real.");
    const usageBefore = await page.evaluate(async () => {
      const response = await fetch("/api/settings/openrouter/usage", { cache: "no-store" });
      if (!response.ok) return null;
      const body = await response.json();
      return typeof body.usage?.usage === "number" ? body.usage.usage : null;
    });
    assert.equal(typeof usageBefore, "number", "No se consultó el consumo base; se omite la llamada pagada.");

    await modelButton.click();
    await modelDialog.getByRole("button", { name: "Simple", exact: true }).click();
    await modelDialog.getByRole("option", { name: /Económico/ }).click();
    await page.getByRole("textbox", { name: "Escribir a OpenCode" })
      .fill("Escribe 60 líneas numeradas con una palabra por línea. Sin introducción y sin usar herramientas.");
    await page.getByRole("button", { name: "Enviar mensaje" }).click();
    await page.getByRole("status").filter({ hasText: "Tarea en curso" }).waitFor({ timeout: 30_000 });

    const conversationPanel = page.locator("main");
    await page.waitForFunction(() => {
      const panel = document.querySelector("main");
      return Boolean(panel && panel.scrollHeight > panel.clientHeight + 24);
    }, undefined, { timeout: 90_000 });
    await conversationPanel.evaluate(element => { element.scrollTop = 0; });
    const headerBox = await page.getByRole("banner").boundingBox();
    const composerBox = await page.getByRole("textbox", { name: "Escribir a OpenCode" }).boundingBox();
    assert.ok(headerBox && headerBox.y >= 0 && headerBox.y + headerBox.height <= 852,
      "La barra superior debe seguir visible al leer arriba durante una tarea.");
    assert.ok(composerBox && composerBox.y >= 0 && composerBox.y + composerBox.height <= 852,
      "El compositor debe seguir visible durante una tarea.");
    assert.ok((await conversationPanel.evaluate(element => element.scrollTop)) <= 2,
      "El seguimiento automático debe permanecer pausado cuando se lee arriba.");

    await conversationsButton.click();
    await conversations.waitFor({ state: "visible" });
    const backgroundTask = conversations.locator(`[data-session-id="${selectedSession}"]`);
    await backgroundTask.waitFor({ state: "visible" });
    assert.match(await backgroundTask.getAttribute("aria-label") ?? "", /tarea en curso/i,
      "La lista debe marcar la conversación que sigue trabajando.");
    await conversations.locator(`[data-session-id="${newSession}"]`).click();
    await page.waitForFunction(
      selected => localStorage.getItem("opencode-harness-session") === selected,
      newSession,
      { timeout: 10_000 }
    );
    await page.getByRole("textbox", { name: "Escribir a OpenCode" }).waitFor({ state: "visible" });

    await conversationsButton.click();
    await conversations.waitFor({ state: "visible" });
    await page.waitForFunction(selected => {
      const row = document.querySelector(`[data-session-id="${selected}"]`);
      return Boolean(row && !row.getAttribute("aria-label")?.includes("tarea en curso"));
    }, selectedSession, { timeout: 90_000 });
    await conversations.locator(`[data-session-id="${selectedSession}"]`).click();
    await page.waitForFunction(
      selected => localStorage.getItem("opencode-harness-session") === selected,
      selectedSession,
      { timeout: 10_000 }
    );
    await page.getByRole("status").filter({ hasText: "En línea" }).waitFor({ timeout: 90_000 });
    const reply = await conversationPanel.locator(".sd-theme").last().innerText();
    assert.ok(reply.trim().length > 0, "El agente debe mostrar una respuesta real.");

    const usageAfter = await page.evaluate(async () => {
      const response = await fetch("/api/settings/openrouter/usage", { cache: "no-store" });
      if (!response.ok) return null;
      const body = await response.json();
      return typeof body.usage?.usage === "number" ? body.usage.usage : null;
    });
    assert.equal(typeof usageAfter, "number", "No se pudo comprobar el consumo después de la llamada.");
    const delta = usageAfter - usageBefore;
    assert.ok(delta >= 0 && delta <= 0.10, `La variación de cuenta excedió US$0.10: $${delta.toFixed(4)}.`);
    console.log(`Mensaje real de OpenRouter aprobado; variación aproximada de cuenta: $${delta.toFixed(4)}.`);

    await conversationsButton.click();
    await conversations.waitFor({ state: "visible" });
    await conversations.locator(`[data-session-id="${newSession}"]`).click();
    await page.waitForFunction(
      selected => localStorage.getItem("opencode-harness-session") === selected,
      newSession,
      { timeout: 10_000 }
    );
    await page.getByRole("textbox", { name: "Escribir a OpenCode" }).waitFor({ state: "visible" });
  }

  await page.getByRole("button", { name: "Cambiar proyecto" }).click();
  await page.getByRole("dialog", { name: "Mis proyectos" }).waitFor({ state: "visible" });
  await page.keyboard.press("Escape");
  await page.getByRole("dialog", { name: "Mis proyectos" }).waitFor({ state: "hidden" });

  await page.getByRole("button", { name: "Mostrar opciones de OpenCode" }).click();
  await page.getByRole("button", { name: "Configurar conexiones y modelos" }).click();
  await page.getByRole("dialog", { name: "Configuración de proveedores" }).waitFor({ state: "visible" });
  await page.keyboard.press("Escape");
  await page.getByRole("dialog", { name: "Configuración de proveedores" }).waitFor({ state: "hidden" });

  const dimensions = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
    main: document.querySelector("main")?.scrollWidth,
    mainClient: document.querySelector("main")?.clientWidth
  }));
  assert.ok(dimensions.document <= dimensions.viewport + 1, `Desbordamiento horizontal del documento: ${JSON.stringify(dimensions)}`);
  assert.ok(dimensions.body <= dimensions.viewport + 1, `Desbordamiento horizontal del body: ${JSON.stringify(dimensions)}`);
  assert.ok((dimensions.main ?? 0) <= (dimensions.mainClient ?? 0) + 1, `Desbordamiento horizontal del chat: ${JSON.stringify(dimensions)}`);
  assert.deepEqual(pageErrors, [], `Errores de JavaScript en la página: ${pageErrors.join("; ")}`);

  console.log(`${localHost ? "Local" : "Staging"} mobile smoke aprobado: 393 × 852, navegación, conversaciones, perfiles, OpenRouter, proyectos y ajustes.`);
} finally {
  await browser.close();
}
