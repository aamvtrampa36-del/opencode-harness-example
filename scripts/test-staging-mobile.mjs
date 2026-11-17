import assert from "node:assert/strict";
import { join } from "node:path";
import { chromium } from "playwright";

const STAGING_URL = "https://opencode-g1-staging.cdf-cloud-mvp-20261019.workers.dev";
const targetUrl = new URL(process.env.OPENCODE_E2E_URL || STAGING_URL);
const localHost = ["localhost", "127.0.0.1"].includes(targetUrl.hostname);
const accessId = process.env.CF_ACCESS_CLIENT_ID;
const accessSecret = process.env.CF_ACCESS_CLIENT_SECRET;
const sendLiveMessage = process.env.OPENCODE_STAGING_SEND_MESSAGE === "true";
const developThreeProjects = process.env.OPENCODE_STAGING_DEVELOP_THREE_PROJECTS === "true";
const projectModel = process.env.OPENCODE_STAGING_PROJECT_MODEL === "cloudflare" ? "cloudflare" : "openrouter-free";
const diagnoseProject = process.env.OPENCODE_STAGING_DIAGNOSE_PROJECT?.trim() ?? "";
const verifyCdfWorkbench = process.env.OPENCODE_STAGING_VERIFY_CDF_WORKBENCH === "true";
const verifyTokenEconomizer = process.env.OPENCODE_STAGING_VERIFY_TOKEN_ECONOMIZER === "true";
const SMALL_FREE_MODEL = "liquid/lfm-3-1.7b:free";

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
const waitForActiveConversation = async session => page.waitForFunction(selected => {
  const download = document.querySelector('a[download^="opencode-conversacion-"]');
  return Boolean(download && new URL(download.href).searchParams.get("session") === selected);
}, session, { timeout: 20_000 });
let disableTokenEconomizerAfterTest = false;
let tokenEconomizerSessionsVerified = 0;
let learnedContextCharacters = 0;
page.on("pageerror", error => pageErrors.push(error.message));

try {
  await page.goto(targetUrl.toString(), { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.getByRole("heading", { name: "OpenCode Cloud" }).waitFor({ timeout: 60_000 });
  await page.getByRole("status").filter({ hasText: "En línea" }).waitFor({ timeout: 60_000 });

  // A fresh browser uses the app's root session without persisting the
  // selection until the user changes conversations.
  const initialSession = await page.evaluate(
    () => localStorage.getItem("opencode-harness-session") ?? "ses_root"
  );
  const initialModelPreset = await page.evaluate(
    session => localStorage.getItem("opencode-model-preset:" + session), initialSession
  );

  const conversationsButton = page.getByRole("button", { name: "Conversaciones", exact: true });
  await conversationsButton.click();
  const conversations = page.getByRole("navigation", { name: "Lista de conversaciones" });
  await conversations.waitFor({ state: "visible" });
  assert.equal(await conversations.locator('button[aria-current="page"]').count(), 1);
  await page.getByRole("button", { name: "Cerrar lista de conversaciones" }).click();
  await conversations.waitFor({ state: "hidden" });
  await conversationsButton.click();
  await conversations.waitFor({ state: "visible" });
  await page.getByRole("button", { name: "Nueva conversación" }).click();
  await page.waitForFunction(
    previous => {
      const selected = localStorage.getItem("opencode-harness-session");
      return Boolean(selected && selected !== previous);
    },
    initialSession,
    { timeout: 20_000 }
  );
  const newSession = await page.evaluate(() => localStorage.getItem("opencode-harness-session"));
  assert.ok(newSession && newSession !== initialSession, "Crear conversación debe seleccionar una sesión nueva.");
  await waitForActiveConversation(newSession);
  await conversations.waitFor({ state: "hidden" });

  // A single offline/online cycle checks the app's existing socket recovery
  // without interrupting a task or changing the owner's active conversation.
  await context.setOffline(true);
  await page.getByRole("status").filter({ hasText: "Reconectando" }).waitFor({ timeout: 20_000 });
  await context.setOffline(false);
  await page.getByRole("status").filter({ hasText: "En línea" }).waitFor({ timeout: 60_000 });
  assert.equal(await page.evaluate(() => localStorage.getItem("opencode-harness-session")), newSession,
    "La sesión de prueba debe seguir seleccionada tras la reconexión.");

  const modelButton = page.getByRole("button", { name: /Elegir modelo:/ });
  await modelButton.click();
  const modelDialog = page.getByRole("dialog", { name: "Seleccionar modelo" });
  await modelDialog.waitFor({ state: "visible" });
  const selectOpenRouterModel = async modelId => {
    await modelButton.click();
    await modelDialog.getByRole("button", { name: "OpenRouter", exact: true }).click();
    await modelDialog.getByRole("checkbox", { name: "Solo modelos gratuitos" }).check();
    const search = modelDialog.getByRole("searchbox", { name: "Buscar modelos con soporte de herramientas" });
    await search.fill(modelId);
    await modelDialog.getByRole("listbox", { name: "Modelos OpenRouter" })
      .getByRole("option").filter({ hasText: modelId }).click();
  };
  await modelDialog.getByRole("button", { name: "Simple", exact: true }).click();
  const profiles = modelDialog.getByRole("listbox", { name: "Perfiles sencillos" });
  assert.equal(await profiles.getByRole("option").count(), 5, "Deben seguir disponibles los cinco perfiles simples.");
  await profiles.getByRole("option", { name: /Cloudflare/ }).click();

  const selectedSession = newSession;
  const selectedProfile = await page.evaluate(
    session => localStorage.getItem("opencode-model-preset:" + session), selectedSession
  );
  assert.equal(selectedProfile, "cloudflare", "El perfil elegido debe guardarse en la conversación actual.");
  await page.screenshot({
    path: join(process.env.RUNNER_TEMP ?? "/tmp", "opencode-staging-mobile-393x852.png")
  });

  if (diagnoseProject) {
    assert.match(diagnoseProject, /^app-[a-z0-9]+$/, "El diagnóstico acepta solo IDs de apps Staging.");
    const diagnostic = await page.evaluate(async project => {
      const command = `printf 'cwd='; pwd; ` +
        `printf 'workspace='; readlink -f /workspace/projects/${project}; ` +
        `printf 'bundle='; readlink -f /bundle/projects/${project}; ` +
        `for path in /workspace/projects/${project}/dist/index.html /bundle/projects/${project}/dist/index.html; ` +
        `do if test -f "$path"; then stat -Lc '%n %s bytes' "$path"; else echo "MISSING $path"; fi; done; ` +
        `env | grep '^PREVIEW_ROOT=' || true`;
      try {
        const response = await fetch("/api/dev/run", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ project, command }), cache: "no-store",
          signal: AbortSignal.timeout(90_000)
        });
        const container = { status: response.status, body: await response.text() };
        const previewResponse = await fetch(`/api/dev/preview/${project}/dist/index.html`, { cache: "no-store" });
        const preview = { status: previewResponse.status, body: (await previewResponse.text()).slice(0, 500) };
        return { container, preview };
      } catch (error) { return { containerError: String(error).slice(0, 500) }; }
    }, diagnoseProject);
    console.log(`Existing project path diagnostic: ${JSON.stringify({ project: diagnoseProject, ...diagnostic })}`);
  }

  // The general chat is the default; templates remain optional and selectable.
  const optionsButton = page.getByRole("button", { name: "Mostrar opciones de OpenCode" });
  await optionsButton.click();
  const templatePicker = page.getByRole("combobox", { name: "Plantilla de trabajo" });
  await templatePicker.waitFor({ state: "visible" });
  assert.ok((await templatePicker.locator("option").allTextContents()).includes("Flujo CDF"),
    "La plantilla CDF opcional debe estar disponible.");
  assert.equal(await templatePicker.inputValue(), "", "Una conversación nueva debe empezar en General.");
  await templatePicker.selectOption("cdf-workflow");
  assert.equal(await templatePicker.inputValue(), "cdf-workflow", "La plantilla opcional debe poder seleccionarse.");
  await templatePicker.selectOption("");
  assert.equal(await templatePicker.inputValue(), "", "Se debe poder volver al chat General.");
  await optionsButton.click();

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
    await modelDialog.getByRole("button", { name: /OpenRouter Free/ }).click();
    assert.equal(await page.evaluate(
      session => localStorage.getItem("opencode-model-preset:" + session), selectedSession
    ), "openrouter:openrouter/free", "La opción OpenRouter Free debe guardar la ruta gratuita por conversación.");

    await modelButton.click();
    const freeOnly = modelDialog.getByRole("checkbox", { name: "Solo modelos gratuitos" });
    await freeOnly.check();
    const modelOptions = modelDialog.getByRole("listbox", { name: "Modelos OpenRouter" }).getByRole("option");
    await modelDialog.getByRole("searchbox", { name: "Buscar modelos con soporte de herramientas" }).fill(SMALL_FREE_MODEL);
    const smallFreeOption = modelOptions.filter({ hasText: SMALL_FREE_MODEL });
    await smallFreeOption.waitFor({ state: "visible", timeout: 30_000 });
    const smallFreeDetails = await smallFreeOption.innerText();
    assert.match(smallFreeDetails, /Gratis/);
    assert.match(smallFreeDetails, /\$0\.0000/);
    await smallFreeOption.click();
    assert.equal(await page.evaluate(
      session => localStorage.getItem("opencode-model-preset:" + session), selectedSession
    ), "openrouter:" + SMALL_FREE_MODEL, "El filtro debe permitir elegir un modelo específico con coste cero.");

    await modelButton.click();
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
  await conversations.locator(`[data-session-id="${initialSession}"]`).click();
  await page.waitForFunction(
    selected => localStorage.getItem("opencode-harness-session") === selected,
    initialSession,
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
  assert.equal(await page.evaluate(
    session => localStorage.getItem("opencode-model-preset:" + session), initialSession
  ), initialModelPreset, "La prueba no debe cambiar el modelo de la conversación preexistente.");

  if (sendLiveMessage) {
    assert.ok(routerReady, "OpenRouter debe estar configurado para ejecutar el mensaje real.");
    const readUsage = async () => page.evaluate(async () => {
      const response = await fetch("/api/settings/openrouter/usage", { cache: "no-store" });
      if (!response.ok) return null;
      const body = await response.json();
      return typeof body.usage?.usage === "number" ? body.usage.usage : null;
    });
    const usageBeforeSmallModel = await readUsage();
    assert.equal(typeof usageBeforeSmallModel, "number", "No se consultó el consumo base; se omite la llamada al modelo.");

    await modelButton.click();
    await modelDialog.getByRole("button", { name: "OpenRouter", exact: true }).click();
    await modelDialog.getByRole("checkbox", { name: "Solo modelos gratuitos" }).check();
    await modelDialog.getByRole("searchbox", { name: "Buscar modelos con soporte de herramientas" }).fill(SMALL_FREE_MODEL);
    const smallModelOptions = modelDialog.getByRole("listbox", { name: "Modelos OpenRouter" }).getByRole("option");
    await smallModelOptions.filter({ hasText: SMALL_FREE_MODEL }).click();
    await page.getByRole("textbox", { name: "Escribir a OpenCode" })
      .fill("Responde exactamente con el texto PING-PRUEBA y nada más. No uses herramientas.");
    await page.getByRole("button", { name: "Enviar mensaje" }).click();
    await page.getByRole("status").filter({ hasText: "Tarea en curso" }).waitFor({ timeout: 30_000 });
    await page.getByRole("status").filter({ hasText: "En línea" }).waitFor({ timeout: 120_000 });
    const pingMessage = page.locator("main .sd-theme").last();
    try {
      await pingMessage.waitFor({ state: "visible", timeout: 60_000 });
    } catch (error) {
      const evidence = await page.evaluate(() => ({
        mainText: document.querySelector("main")?.innerText.slice(-2000),
        messageNodes: document.querySelectorAll("main .sd-theme").length
      }));
      console.log(`El modelo terminó la tarea sin una burbuja visible: ${JSON.stringify({ evidence, pageErrors, usage: await readUsage() })}`);
      throw error;
    }
    assert.match(await pingMessage.innerText(), /PING-PRUEBA/i,
      "El modelo gratuito concreto debe producir una respuesta real.");
    const usageAfterSmallModel = await readUsage();
    assert.equal(typeof usageAfterSmallModel, "number", "No se pudo consultar el consumo tras el modelo gratuito concreto.");
    const smallModelSpend = usageAfterSmallModel - usageBeforeSmallModel;
    assert.ok(smallModelSpend >= 0 && smallModelSpend <= 0.10,
      `El modelo gratuito concreto excedió el límite de US$0,10: $${smallModelSpend.toFixed(4)}.`);
    console.log(`Modelo concreto gratuito aprobado (${SMALL_FREE_MODEL}); variación de cuenta: $${smallModelSpend.toFixed(4)}.`);

    const usageBeforeLongModel = await readUsage();
    assert.equal(typeof usageBeforeLongModel, "number", "No se consultó el consumo antes de la prueba de segundo plano.");
    const previousBackgroundSession = await page.evaluate(() => localStorage.getItem("opencode-harness-session"));
    await optionsButton.click();
    await page.getByRole("button", { name: "Crear nueva aplicación" }).click();
    await page.waitForFunction(
      previous => {
        const selected = localStorage.getItem("opencode-harness-session");
        return Boolean(selected && selected !== previous && localStorage.getItem("opencode-active-project:" + selected));
      }, previousBackgroundSession, { timeout: 20_000 }
    );
    const backgroundSession = await page.evaluate(() => localStorage.getItem("opencode-harness-session"));
    const backgroundProject = await page.evaluate(
      selected => localStorage.getItem("opencode-active-project:" + selected), backgroundSession
    );
    assert.match(backgroundProject ?? "", /^app-[a-z0-9]+$/, "La tarea de segundo plano necesita un proyecto temporal aislado.");
    await selectOpenRouterModel(SMALL_FREE_MODEL);
    const previousToolCount = await page.locator("main details.bg-kumo-base").count();
    await page.getByRole("textbox", { name: "Escribir a OpenCode" })
      .fill(`Usa una única llamada a la herramienta Linux para el proyecto ${backgroundProject}. Ejecuta exactamente: sleep 20; printf 'OPEN-CODE-BACKGROUND-OK\\n'. No edites archivos ni uses otras herramientas. Después informa brevemente el resultado.`);
    await page.getByRole("button", { name: "Enviar mensaje" }).click();
    await page.getByRole("status").filter({ hasText: "Tarea en curso" }).waitFor({ timeout: 30_000 });

    const conversationPanel = page.locator("main");
    await conversationPanel.evaluate(element => { element.scrollTop = 0; });
    const headerBox = await page.getByRole("heading", { name: "OpenCode Cloud" })
      .locator("xpath=ancestor::header").boundingBox();
    const composerBox = await page.getByRole("textbox", { name: "Escribir a OpenCode" }).boundingBox();
    assert.ok(headerBox && headerBox.y >= 0 && headerBox.y + headerBox.height <= 852,
      "La barra superior debe seguir visible al leer arriba durante una tarea.");
    assert.ok(composerBox && composerBox.y >= 0 && composerBox.y + composerBox.height <= 852,
      "El compositor debe seguir visible durante una tarea.");
    assert.ok((await conversationPanel.evaluate(element => element.scrollTop)) <= 2,
      "El seguimiento automático debe permanecer pausado cuando se lee arriba.");

    await conversationsButton.click();
    await conversations.waitFor({ state: "visible" });
    const backgroundTask = conversations.locator(`[data-session-id="${backgroundSession}"]`);
    await backgroundTask.waitFor({ state: "visible" });
    assert.match(await backgroundTask.getAttribute("aria-label") ?? "", /tarea en curso/i,
      "La lista debe marcar la conversación que sigue trabajando.");
    await conversations.locator(`[data-session-id="${initialSession}"]`).click();
    await page.waitForFunction(
      selected => localStorage.getItem("opencode-harness-session") === selected,
      initialSession,
      { timeout: 10_000 }
    );
    await page.getByRole("textbox", { name: "Escribir a OpenCode" }).waitFor({ state: "visible" });

    await conversationsButton.click();
    await conversations.waitFor({ state: "visible" });
    await page.waitForFunction(selected => {
      const row = document.querySelector(`[data-session-id="${selected}"]`);
      return Boolean(row && !row.getAttribute("aria-label")?.includes("tarea en curso"));
    }, backgroundSession, { timeout: 90_000 });
    await conversations.locator(`[data-session-id="${backgroundSession}"]`).click();
    await page.waitForFunction(
      selected => localStorage.getItem("opencode-harness-session") === selected,
      backgroundSession,
      { timeout: 10_000 }
    );
    await page.getByRole("status").filter({ hasText: "En línea" }).waitFor({ timeout: 90_000 });
    await page.waitForFunction(count => document.querySelectorAll("main details.bg-kumo-base").length > count,
      previousToolCount, { timeout: 30_000 });
    const backgroundToolCard = conversationPanel.locator("details.bg-kumo-base").last();
    await backgroundToolCard.getByText("Terminado", { exact: true }).waitFor({ timeout: 30_000 });
    await backgroundToolCard.locator("summary").click();
    assert.match(await backgroundToolCard.locator("pre").last().innerText(), /OPEN-CODE-BACKGROUND-OK/,
      "La tarea en segundo plano debe conservar el resultado real del comando Linux.");
    const reply = await conversationPanel.locator(".sd-theme").last().innerText();
    assert.ok(reply.trim().length > 0, "El agente debe mostrar una respuesta real.");

    const usageAfter = await readUsage();
    assert.equal(typeof usageAfter, "number", "No se pudo comprobar el consumo después de la prueba de segundo plano.");
    const delta = usageAfter - usageBeforeLongModel;
    assert.ok(delta >= 0 && delta <= 0.10, `La variación de cuenta excedió US$0.10: $${delta.toFixed(4)}.`);
    console.log(`Modelo gratis concreto respondió una tarea extensa; variación aproximada de cuenta: $${delta.toFixed(4)}.`);

  }

  await page.getByRole("button", { name: "Cambiar proyecto" }).click();
  await page.getByRole("dialog", { name: "Mis proyectos" }).waitFor({ state: "visible" });
  await page.keyboard.press("Escape");
  await page.getByRole("dialog", { name: "Mis proyectos" }).waitFor({ state: "hidden" });

  await page.getByRole("button", { name: "Mostrar opciones de OpenCode" }).click();
  await page.getByRole("button", { name: "Configurar conexiones y modelos" }).click();
  const settingsDialog = page.getByRole("dialog", { name: "Configuración de OpenCode" });
  await settingsDialog.waitFor({ state: "visible" });
  const flowRow = settingsDialog.getByText("Flujo CDF", { exact: true }).locator("xpath=../..");
  await flowRow.getByRole("button", { name: "Editar", exact: true }).click();
  await settingsDialog.getByRole("textbox", { name: "Nombre de etapa 1" }).waitFor({ state: "visible" });
  assert.equal(await settingsDialog.getByLabel("Acceso de etapa").nth(0).inputValue(), "plan");
  assert.equal(await settingsDialog.getByLabel("Acceso de etapa").nth(1).inputValue(), "build");
  await settingsDialog.getByRole("tab", { name: "Herramientas" }).click();
  if (verifyCdfWorkbench) {
    const mcpSection = settingsDialog.locator('section[aria-label="Servidores MCP"]');
    await mcpSection.getByText(/cdf-workbench-staging/).waitFor({ state: "visible", timeout: 20_000 });
    const mcpSettings = await mcpSection.innerText();
    assert.match(mcpSettings.replace(/\s+/g, " "), /cdf-workbench-staging.*OAuth conectado.*solo lectura.*habilitado/i,
      "OpenCode debe mostrar CDF WorkBench Staging conectado y limitado a herramientas de lectura.");
  }
  await settingsDialog.getByRole("button", { name: "Preparar CDF WorkBench Staging" }).click();
  assert.equal(await settingsDialog.locator("#mcp-name").inputValue(), "cdf-workbench-staging");
  assert.equal(await settingsDialog.locator("#mcp-scope").inputValue(), "workbench:read offline_access");
  await settingsDialog.getByRole("button", { name: /Preparar CDF CLOUD Producción/ }).click();
  assert.equal(await settingsDialog.locator("#mcp-name").inputValue(), "cdf-cloud-production");
  assert.equal(await settingsDialog.locator("#mcp-scope").inputValue(), "cdf:access");
  await settingsDialog.getByRole("button", { name: "Cerrar", exact: true }).click();
  await settingsDialog.waitFor({ state: "hidden" });

  if (verifyTokenEconomizer) {
    if (projectModel === "openrouter-free") {
      assert.ok(routerReady, "OpenRouter debe estar disponible para probar TokenEconomizer con inferencia gratuita.");
    }
    const readConnectorState = async () => page.evaluate(async () => {
      const response = await fetch("/api/settings/connectors", { cache: "no-store" });
      if (!response.ok) return null;
      return await response.json();
    });
    const initialConnectorState = await readConnectorState();
    assert.ok(initialConnectorState, "No se pudo leer el estado real del conector.");
    if (!initialConnectorState.tokenEconomizerEnabled) {
      const workspace = await page.evaluate(() => localStorage.getItem("opencode-harness-session"));
      const installed = await page.evaluate(async workspaceID => {
        const response = await fetch("/api/settings/connectors/token-economizer", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "install", workspace: workspaceID })
        });
        return { status: response.status, body: await response.json() };
      }, workspace);
      assert.equal(installed.status, 200, `No se pudo instalar TokenEconomizer en Staging: ${installed.body.error ?? installed.status}`);
      disableTokenEconomizerAfterTest = true;
    }

    const previous = await page.evaluate(() => localStorage.getItem("opencode-harness-session"));
    await page.getByRole("button", { name: "Mostrar opciones de OpenCode" }).click();
    await page.getByRole("button", { name: "Crear nueva aplicación" }).click();
    await page.waitForFunction(
      old => {
        const session = localStorage.getItem("opencode-harness-session");
        return Boolean(session && session !== old && localStorage.getItem("opencode-active-project:" + session));
      }, previous, { timeout: 20_000 }
    );
    const tokenEconomizerProject = await page.evaluate(() => {
      const session = localStorage.getItem("opencode-harness-session");
      return session ? localStorage.getItem("opencode-active-project:" + session) : null;
    });
    await waitForActiveConversation(await page.evaluate(() => localStorage.getItem("opencode-harness-session")));
    assert.match(tokenEconomizerProject ?? "", /^app-[a-z0-9]+$/, "TokenEconomizer necesita su propio proyecto de prueba.");
    // Use Cloudflare's free daily allocation when selected; otherwise use one
    // concrete lightweight OpenRouter model to avoid routing variability.
    if (projectModel === "cloudflare") {
      await modelButton.click();
      await modelDialog.getByRole("button", { name: "Simple", exact: true }).click();
      await modelDialog.getByRole("listbox", { name: "Perfiles sencillos" })
        .getByRole("option", { name: /Cloudflare/ }).click();
    } else {
      await selectOpenRouterModel(SMALL_FREE_MODEL);
    }

    const readConnectorStateAfter = async () => page.evaluate(async () => {
      const response = await fetch("/api/settings/connectors", { cache: "no-store" });
      if (!response.ok) return null;
      return await response.json();
    });
    const waitForFoldHook = async beforeAt => page.waitForFunction(async previousAt => {
      const response = await fetch("/api/settings/connectors", { cache: "no-store" });
      if (!response.ok) return false;
      const state = await response.json();
      return state.tokenEconomizerLastHook?.name === "SessionEnd" &&
        state.tokenEconomizerLastHook?.succeeded === true &&
        state.tokenEconomizerLastHook?.at > previousAt;
    }, beforeAt, { timeout: 60_000, polling: 500 });
    const usageBeforeTokenEconomizer = projectModel === "openrouter-free" ? await page.evaluate(async () => {
      const response = await fetch("/api/settings/openrouter/usage", { cache: "no-store" });
      if (!response.ok) return null;
      const body = await response.json();
      return typeof body.usage?.usage === "number" ? body.usage.usage : null;
    }) : null;
    if (projectModel === "openrouter-free") {
      assert.equal(typeof usageBeforeTokenEconomizer, "number", "No se pudo consultar el consumo antes de TokenEconomizer.");
    }

    for (let index = 0; index < 4; index++) {
      const connectorBefore = await readConnectorStateAfter();
      const previousHookAt = connectorBefore?.tokenEconomizerLastHook?.at ?? 0;
      const previousToolCount = await page.locator("main details.bg-kumo-base").count();
      const taskMarker = "TOKEN_ECONOMIZER_TRIAL_" + (index + 1);
      const fixture = "cat > test_envfacts.test.mjs <<'JS'\nimport test from 'node:test';\ntest('Node runtime works', () => {\n  if (1 + 1 !== 2) throw new Error('arithmetic check failed');\n});\nJS\n";
      const command = (index === 0 ? fixture : "") +
        "pytest; pytest_status=$?; node --test test_envfacts.test.mjs; node_status=$?; " +
        "printf '\\n" + taskMarker + "\\n'; " +
        'if [ "$pytest_status" -ne 0 ]; then exit "$pytest_status"; else exit "$node_status"; fi';
      const task = `Usa solo la herramienta Linux autorizada para el proyecto ${tokenEconomizerProject}. ` +
        `Este turno exige una ejecución nueva y una salida con la marca ${taskMarker}; ` +
        "ignora los resultados de turnos anteriores y no afirmes haber ejecutado nada sin usar Linux. " +
        `Ejecuta exactamente este comando en una llamada Linux: ${command}. ` +
        "En la primera tarea crea solo el fixture Node integrado; después no cambies archivos. " +
        "No instales paquetes. Resume la ausencia real de pytest y el resultado de node --test.";
      await page.getByRole("textbox", { name: "Escribir a OpenCode" }).fill(task);
      await page.getByRole("button", { name: "Enviar mensaje" }).click();
      await page.getByRole("status").filter({ hasText: "Tarea en curso" }).waitFor({ timeout: 30_000 });
      try {
        await page.getByRole("status").filter({ hasText: "En línea" }).waitFor({ timeout: 180_000 });
      } catch (error) {
        await page.getByRole("button", { name: "Detener" }).click().catch(() => undefined);
        throw error;
      }
      try {
        await page.waitForFunction(count => document.querySelectorAll("main details.bg-kumo-base").length > count,
          previousToolCount, { timeout: 30_000 });
      } catch (error) {
        const evidence = await page.evaluate(() => ({
          recentMessages: [...document.querySelectorAll("main .sd-theme")].slice(-3)
            .map(element => element.innerText.slice(0, 1000)),
          toolCards: document.querySelectorAll("main details.bg-kumo-base").length
        }));
        const connectorState = await readConnectorStateAfter();
        console.log(`TokenEconomizer task ${index + 1} produced no Linux tool card: ${JSON.stringify({ evidence, hook: connectorState?.tokenEconomizerLastHook })}`);
        throw error;
      }
      const cards = page.locator("main details.bg-kumo-base");
      const outputs = [];
      for (let cardIndex = previousToolCount; cardIndex < await cards.count(); cardIndex++) {
        const card = cards.nth(cardIndex);
        // The shell deliberately returns pytest's real 127 exit code after the
        // built-in Node test passes; inspect the command result, not tool-call status.
        await card.getByText(/^(Terminado|Error)$/, { exact: true }).waitFor({ timeout: 30_000 });
        await card.locator("summary").click();
        const output = card.locator("pre").last();
        if (await output.count()) {
          const status = await card.getByText(/^(Terminado|Error)$/, { exact: true }).innerText();
          outputs.push(`${status}\n${await output.innerText()}`);
        }
      }
      const observedOutput = outputs.join("\n");
      assert.ok(outputs.length >= 1,
        `TokenEconomizer prueba ${index + 1}: debe verse la ejecución Linux; ` +
        `estados de herramientas: ${outputs.map(value => value.split("\n", 1)[0]).join(", ") || "ninguno"}.`);
      assert.match(observedOutput, /pytest/i, `TokenEconomizer prueba ${index + 1}: faltó la prueba real de pytest.`);
      assert.match(observedOutput, /command not found/i,
        `TokenEconomizer prueba ${index + 1}: pytest debería reportar su ausencia real en esta imagen.`);
      assert.match(observedOutput, /# pass 1|pass 1/i,
        `TokenEconomizer prueba ${index + 1}: el runner Node integrado debe pasar.`);
      assert.match(observedOutput, /exitCode":127/,
        `TokenEconomizer prueba ${index + 1}: el comando debe conservar el código 127 de pytest ausente.`);
      assert.match(observedOutput, new RegExp(tokenEconomizerProject),
        `TokenEconomizer prueba ${index + 1}: la salida no confirma el proyecto Linux autorizado.`);
      assert.match(observedOutput, new RegExp(taskMarker),
        `TokenEconomizer prueba ${index + 1}: faltó la marca única de esta ejecución Linux.`);
      await waitForFoldHook(previousHookAt);
      tokenEconomizerSessionsVerified++;
      console.log(`TokenEconomizer SessionEnd ${tokenEconomizerSessionsVerified}/4 pasó en ${tokenEconomizerProject}.`);
    }

    // Envfacts promotes after three confirmations and injects after four exercised sessions.
    // Leave time for the upstream fold worker to persist the fourth result before the next turn.
    await page.waitForTimeout(5_000);
    const beforeLearnedPrompt = await readConnectorStateAfter();
    assert.ok(beforeLearnedPrompt, "No se pudo leer la evidencia de TokenEconomizer antes de comprobar su reutilización.");
    const previousContextAt = beforeLearnedPrompt?.tokenEconomizerLastContext?.at ?? 0;
    await page.getByRole("textbox", { name: "Escribir a OpenCode" })
      .fill(`Sin usar herramientas, explica brevemente el comando de pruebas apropiado para el proyecto ${tokenEconomizerProject}.`);
    await page.getByRole("button", { name: "Enviar mensaje" }).click();
    await page.getByRole("status").filter({ hasText: "Tarea en curso" }).waitFor({ timeout: 30_000 });
    let learnedContext;
    let latestConnectorState;
    const learnDeadline = Date.now() + 45_000;
    while (Date.now() < learnDeadline) {
      latestConnectorState = await readConnectorStateAfter();
      const context = latestConnectorState?.tokenEconomizerLastContext;
      if (Number(context?.characters) > 0 && context?.at > previousContextAt) {
        learnedContext = context;
        break;
      }
      await page.waitForTimeout(500);
    }
    console.log(`TokenEconomizer learned-context evidence: ${JSON.stringify({
      previousContextAt,
      lastHook: latestConnectorState?.tokenEconomizerLastHook,
      lastContext: latestConnectorState?.tokenEconomizerLastContext
    })}`);
    assert.ok(learnedContext && learnedContext.characters > 0,
      "TokenEconomizer debe devolver contexto reutilizable tras aprender del proyecto Linux.");
    learnedContextCharacters = learnedContext.characters;
    await page.getByRole("status").filter({ hasText: "En línea" }).waitFor({ timeout: 180_000 });
    if (projectModel === "openrouter-free") {
      const usageAfterTokenEconomizer = await page.evaluate(async () => {
        const response = await fetch("/api/settings/openrouter/usage", { cache: "no-store" });
        if (!response.ok) return null;
        const body = await response.json();
        return typeof body.usage?.usage === "number" ? body.usage.usage : null;
      });
      assert.equal(typeof usageAfterTokenEconomizer, "number", "No se pudo consultar el consumo después de TokenEconomizer.");
      const tokenEconomizerSpend = usageAfterTokenEconomizer - usageBeforeTokenEconomizer;
      assert.ok(tokenEconomizerSpend >= 0 && tokenEconomizerSpend <= 0.10,
        `La prueba gratuita de TokenEconomizer excedió US$0,10: $${tokenEconomizerSpend.toFixed(4)}.`);
      console.log(`TokenEconomizer: 4 sesiones reales cerradas; siguiente turno recibió ${learnedContextCharacters} caracteres aprendidos; coste reportado $${tokenEconomizerSpend.toFixed(4)}.`);
    } else {
      console.log(`TokenEconomizer: 4 sesiones reales cerradas con Cloudflare; siguiente turno recibió ${learnedContextCharacters} caracteres aprendidos.`);
    }
  }

  let cdfWorkbenchToolsVerified = 0;
  if (verifyCdfWorkbench) {
    await conversationsButton.click();
    await conversations.waitFor({ state: "visible" });
    const beforeCdfSession = await page.evaluate(() => localStorage.getItem("opencode-harness-session"));
    await page.getByRole("button", { name: "Nueva conversación" }).click();
    await page.waitForFunction(
      old => {
        const selected = localStorage.getItem("opencode-harness-session");
        return Boolean(selected && selected !== old);
      }, beforeCdfSession, { timeout: 20_000 }
    );
    const cdfSession = await page.evaluate(() => localStorage.getItem("opencode-harness-session"));
    await waitForActiveConversation(cdfSession);
    await conversations.waitFor({ state: "hidden" });

    await modelButton.click();
    if (routerReady) {
      await modelDialog.getByRole("button", { name: "OpenRouter", exact: true }).click();
      await modelDialog.getByRole("button", { name: /OpenRouter Free/ }).click();
    } else {
      await modelDialog.getByRole("button", { name: "Simple", exact: true }).click();
      await modelDialog.getByRole("option", { name: /Cloudflare/ }).click();
    }
    const cdfModel = routerReady ? "openrouter:openrouter/free" : "cloudflare";
    const cdfSelection = await page.evaluate(session => ({
      active: localStorage.getItem("opencode-harness-session"),
      saved: localStorage.getItem("opencode-model-preset:" + session),
      global: localStorage.getItem("opencode-model-preset"),
      button: document.querySelector('button[aria-label^="Elegir modelo:"]')?.getAttribute("aria-label")
    }), cdfSession);
    if (cdfSelection.saved !== cdfModel) console.log(`CDF model selection evidence: ${JSON.stringify({ session: cdfSession, ...cdfSelection })}`);
    assert.equal(cdfSelection.saved, cdfModel);

    const cdfTask = "Solo lectura en CDF WorkBench Staging. Usa exactamente las herramientas " +
      "personal-cdf-workbench-staging_workbench_status y personal-cdf-workbench-staging_workbench_catalog. " +
      "Consulta el estado y el catálogo; después elige del catálogo un único archivo de documentación o Skill " +
      "(no un script ejecutable) y léelo con personal-cdf-workbench-staging_workbench_read usando su ruta exacta. " +
      "No llames otras herramientas ni servicios, no escribas ni ejecutes scripts. Resume el estado, el nombre de " +
      "la herramienta del catálogo y la ruta leída, basándote en los resultados reales.";
    const cdfUsageBefore = routerReady ? await page.evaluate(async () => {
      const response = await fetch("/api/settings/openrouter/usage", { cache: "no-store" });
      if (!response.ok) return null;
      const body = await response.json();
      return typeof body.usage?.usage === "number" ? body.usage.usage : null;
    }) : null;
    if (routerReady) assert.equal(typeof cdfUsageBefore, "number", "No se pudo consultar el consumo antes de probar CDF.");
    await page.getByRole("textbox", { name: "Escribir a OpenCode" }).fill(cdfTask);
    await page.getByRole("button", { name: "Enviar mensaje" }).click();
    await page.getByRole("status").filter({ hasText: "Tarea en curso" }).waitFor({ timeout: 30_000 });
    try {
      await page.getByRole("status").filter({ hasText: "En línea" }).waitFor({ timeout: 180_000 });
    } catch (error) {
      await page.getByRole("button", { name: "Detener" }).click().catch(() => undefined);
      throw error;
    }

    for (const toolName of [
      "personal-cdf-workbench-staging_workbench_status",
      "personal-cdf-workbench-staging_workbench_catalog",
      "personal-cdf-workbench-staging_workbench_read"
    ]) {
      const matchingCards = page.locator("main details.bg-kumo-base").filter({ hasText: toolName });
      const callCount = await matchingCards.count();
      assert.ok(callCount > 0, `${toolName} debe aparecer como una llamada real.`);
      if (callCount > 1) console.log(`CDF WorkBench ${toolName}: ${callCount} llamadas; se comprueba la última.`);
      if (callCount > 1) {
        const statuses = await matchingCards.evaluateAll(cards => cards.map(card => {
          const summary = card.querySelector("summary")?.innerText ?? "";
          return summary.includes("Terminado") ? "Terminado" : summary.includes("Error") ? "Error" : "En curso";
        }));
        console.log(`CDF WorkBench ${toolName} estados: ${statuses.join(", ")}.`);
      }
      const card = matchingCards.last();
      await card.waitFor({ state: "visible", timeout: 10_000 });
      await card.getByText("Terminado", { exact: true }).waitFor({ state: "visible", timeout: 10_000 });
      await card.locator("summary").click();
      assert.ok((await card.locator("pre").last().innerText()).trim().length > 0,
        `${toolName} debe devolver contenido real.`);
      cdfWorkbenchToolsVerified++;
    }

    if (routerReady) {
      const usageAfterCdf = await page.evaluate(async () => {
        const response = await fetch("/api/settings/openrouter/usage", { cache: "no-store" });
        if (!response.ok) return null;
        const body = await response.json();
        return typeof body.usage?.usage === "number" ? body.usage.usage : null;
      });
      assert.equal(typeof usageAfterCdf, "number", "No se pudo consultar el consumo después de probar CDF.");
      const cdfSpend = usageAfterCdf - cdfUsageBefore;
      assert.ok(cdfSpend >= 0 && cdfSpend <= 0.10,
        `La prueba de CDF debe quedar bajo US$0,10; consumo observado: $${cdfSpend.toFixed(4)}.`);
      console.log(`OpenCode MCP CDF WorkBench: estado, catálogo y lectura completados. Consumo reportado: $${cdfSpend.toFixed(4)}.`);
    } else {
      console.log("OpenCode MCP CDF WorkBench: estado, catálogo y lectura completados con Cloudflare.");
    }
  }

  let completedProjectTrials = 0;
  if (developThreeProjects) {
    if (projectModel === "openrouter-free") {
      assert.ok(routerReady, "OpenRouter debe estar configurado para probar tres proyectos con el enrutador gratuito.");
    }
    const readUsage = async () => page.evaluate(async () => {
      const response = await fetch("/api/settings/openrouter/usage", { cache: "no-store" });
      if (!response.ok) return null;
      const body = await response.json();
      return typeof body.usage?.usage === "number" ? body.usage.usage : null;
    });
    const usageBeforeProjects = projectModel === "openrouter-free" ? await readUsage() : null;
    if (projectModel === "openrouter-free") {
      assert.equal(typeof usageBeforeProjects, "number", "No se pudo consultar el consumo antes de crear proyectos.");
    }
    const trials = [
      { name: "Lista de compras", marker: "Proyecto QA: Lista de compras" },
      { name: "Calculadora de propina", marker: "Proyecto QA: Calculadora de propina" },
      { name: "Planificador de estudio", marker: "Proyecto QA: Planificador de estudio" }
    ];

    for (const trial of trials) {
      const previous = await page.evaluate(() => localStorage.getItem("opencode-harness-session"));
      await page.getByRole("button", { name: "Mostrar opciones de OpenCode" }).click();
      await page.getByRole("button", { name: "Crear nueva aplicación" }).click();
      await page.waitForFunction(
        old => {
          const session = localStorage.getItem("opencode-harness-session");
          return Boolean(session && session !== old && localStorage.getItem("opencode-active-project:" + session));
        }, previous, { timeout: 20_000 }
      );
      await waitForActiveConversation(await page.evaluate(() => localStorage.getItem("opencode-harness-session")));
      const project = await page.evaluate(() => {
        const session = localStorage.getItem("opencode-harness-session");
        return session ? localStorage.getItem("opencode-active-project:" + session) : null;
      });
      assert.match(project ?? "", /^app-[a-z0-9]+$/, "Crear app debe asignar un proyecto Linux nuevo.");

      if (projectModel === "openrouter-free") {
        await selectOpenRouterModel(SMALL_FREE_MODEL);
      } else {
        await modelButton.click();
        await modelDialog.getByRole("button", { name: "Simple", exact: true }).click();
        await modelDialog.getByRole("listbox", { name: "Perfiles sencillos" })
          .getByRole("option", { name: /Cloudflare/ }).click();
      }
      const selectedProjectModel = await page.evaluate(
        session => localStorage.getItem("opencode-model-preset:" + session),
        await page.evaluate(() => localStorage.getItem("opencode-harness-session"))
      );
      assert.equal(selectedProjectModel, projectModel === "cloudflare" ? "cloudflare" : "openrouter:" + SMALL_FREE_MODEL);

      const task = `Crea una aplicación web estática mínima llamada "${trial.name}" en el proyecto ya seleccionado. Usa la herramienta linux sin campo project; ya inicia en la carpeta del proyecto. Crea el archivo con la ruta relativa dist/index.html; no uses /bundle ni rutas absolutas. Incluye HTML, CSS y JavaScript. La página debe mostrar exactamente el título "${trial.marker}" y una interacción pequeña útil para la aplicación. No instales dependencias, no uses internet ni edites otros proyectos. Verifica con una llamada Linux que dist/index.html existe y contiene ese título. Responde brevemente solo después de recibir resultados reales de la herramienta.`;
      const previousProjectToolCount = await page.locator("main details.bg-kumo-base").count();
      const projectSession = await page.evaluate(() => localStorage.getItem("opencode-harness-session"));
      console.log(`Iniciando ${trial.name}: project=${project}, session=${projectSession}, model=${selectedProjectModel}.`);
      await page.getByRole("textbox", { name: "Escribir a OpenCode" }).fill(task);
      await page.getByRole("button", { name: "Enviar mensaje" }).click();
      await page.getByRole("status").filter({ hasText: "Tarea en curso" }).waitFor({ timeout: 30_000 });
      try {
        await page.getByRole("status").filter({ hasText: "En línea" }).waitFor({ timeout: 150_000 });
      } catch (error) {
        const evidence = await page.evaluate(async previousCount => {
          const session = localStorage.getItem("opencode-harness-session") ?? "";
          const object = localStorage.getItem("opencode-harness-object") ?? "";
          let transcriptStatus = 0;
          let transcript = "";
          try {
            const response = await fetch("/api/session/export?" + new URLSearchParams({ object, session }), {
              cache: "no-store", signal: AbortSignal.timeout(8_000)
            });
            transcriptStatus = response.status;
            transcript = response.ok ? (await response.text()).slice(-8_000) : "";
          } catch (exportError) {
            transcript = `Export failed: ${String(exportError).slice(0, 300)}`;
          }
          return {
            session,
            statuses: [...document.querySelectorAll('[role="status"]')].map(element => element.innerText),
            messages: [...document.querySelectorAll("main .sd-theme")].slice(-6)
              .map(element => element.innerText.slice(0, 1_200)),
            tools: [...document.querySelectorAll("main details.bg-kumo-base")].slice(previousCount)
              .map(card => ({
                summary: (card.querySelector("summary")?.innerText ?? "").slice(0, 500),
                outputs: [...card.querySelectorAll("pre")].map(output => output.innerText.slice(0, 1_200))
              })),
            transcriptStatus,
            transcript
          };
        }, previousProjectToolCount).catch(evidenceError => ({ captureError: String(evidenceError).slice(0, 500) }));
        console.log(`Project task timeout evidence: ${JSON.stringify({ name: trial.name, project, ...evidence })}`);
        await page.getByRole("button", { name: "Detener" }).click().catch(() => undefined);
        throw error;
      }

      const preview = await page.evaluate(async path => {
        const response = await fetch(path, { cache: "no-store" });
        return { status: response.status, html: await response.text() };
      }, `/api/dev/preview/${project}/dist/index.html`);
      if (preview.status !== 200) {
        const containerEvidence = await page.evaluate(async project => {
          const command = `printf 'cwd='; pwd; ` +
            `printf 'workspace='; readlink -f /workspace/projects/${project}; ` +
            `printf 'bundle='; readlink -f /bundle/projects/${project}; ` +
            `for path in /workspace/projects/${project}/dist/index.html /bundle/projects/${project}/dist/index.html; ` +
            `do if test -f "$path"; then stat -Lc '%n %s bytes' "$path"; else echo "MISSING $path"; fi; done; ` +
            `env | grep '^PREVIEW_ROOT=' || true`;
          try {
            const response = await fetch("/api/dev/run", {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ project, command }), cache: "no-store",
              signal: AbortSignal.timeout(90_000)
            });
            return { status: response.status, body: await response.text() };
          } catch (error) { return { error: String(error).slice(0, 300) }; }
        }, project);
        const evidence = await page.evaluate(async previousCount => {
          const session = localStorage.getItem("opencode-harness-session") ?? "";
          const object = localStorage.getItem("opencode-harness-object") ?? "";
          const exported = await fetch("/api/session/export?" + new URLSearchParams({ object, session }), { cache: "no-store" });
          return {
            messages: [...document.querySelectorAll("main .sd-theme")].slice(-5)
              .map(element => element.innerText.slice(0, 900)),
            mainText: (document.querySelector("main")?.innerText ?? "").slice(-5000),
            statuses: [...document.querySelectorAll('[role="status"]')].map(element => element.innerText),
            tools: [...document.querySelectorAll("main details.bg-kumo-base")].slice(previousCount)
              .map(card => ({
                summary: (card.querySelector("summary")?.innerText ?? "").slice(0, 500),
                outputs: [...card.querySelectorAll("pre")].map(output => output.innerText.slice(0, 1200))
              })),
            transcriptStatus: exported.status,
            transcript: exported.ok ? (await exported.text()).slice(-4000) : ""
          };
        }, previousProjectToolCount);
        console.log(`Project preview failure evidence: ${JSON.stringify({ project, status: preview.status,
          body: preview.html.slice(0, 800), containerEvidence, ...evidence })}`);
      }
      assert.equal(preview.status, 200, `${trial.name}: la vista previa debe responder HTTP 200.`);
      assert.ok(preview.html.includes(trial.marker), `${trial.name}: falta el título comprobable en dist/index.html.`);

      let projectSpend = null;
      if (projectModel === "openrouter-free") {
        const usageAfterProject = await readUsage();
        assert.equal(typeof usageAfterProject, "number", "No se pudo consultar el consumo después de crear el proyecto.");
        projectSpend = usageAfterProject - usageBeforeProjects;
        assert.ok(projectSpend >= 0 && projectSpend <= 0.10,
          `Las tres pruebas deben quedar bajo US$0,10; consumo observado: $${projectSpend.toFixed(4)}.`);
      }
      completedProjectTrials++;
      console.log(projectSpend === null
        ? `Proyecto Staging aprobado: ${project} (${trial.name}); modelo Cloudflare; vista previa HTTP 200.`
        : `Proyecto Staging aprobado: ${project} (${trial.name}); vista previa HTTP 200; consumo OpenRouter acumulado $${projectSpend.toFixed(4)}.`);
    }
  }

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

  // Restore the conversation the owner had selected before this run.
  await conversationsButton.click();
  await conversations.waitFor({ state: "visible" });
  await conversations.locator(`[data-session-id="${initialSession}"]`).click();
  await page.waitForFunction(
    selected => localStorage.getItem("opencode-harness-session") === selected,
    initialSession,
    { timeout: 10_000 }
  );
  assert.equal(await page.evaluate(
    session => localStorage.getItem("opencode-model-preset:" + session), initialSession
  ), initialModelPreset, "La prueba debe conservar el modelo original de la sesión del propietario.");

  console.log(`${localHost ? "Local" : "Staging"} mobile smoke aprobado: 393 × 852, reconexión, sesión aislada, perfiles, OpenRouter, proyectos (${completedProjectTrials}/3 creados; ${projectModel}), CDF WorkBench (${cdfWorkbenchToolsVerified}/3 herramientas), TokenEconomizer (${tokenEconomizerSessionsVerified}/4 sesiones; ${learnedContextCharacters} caracteres reutilizables), y ajustes.`);
} finally {
  if (disableTokenEconomizerAfterTest) {
    await page.evaluate(async () => fetch("/api/settings/connectors/token-economizer", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "disable" })
    })).catch(() => undefined);
  }
  await browser.close();
}
