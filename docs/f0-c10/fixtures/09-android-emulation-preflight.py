"""R3-T09: Chromium desktop with Android-like mobile emulation, IN-PAGE FAKE ONLY.

This does not contact Cloudflare, run Android, prove Access authentication, or test the
real OpenCode UI. Required: Python Playwright + a local Chromium executable.
Usage: OUTPUT_DIR=/tmp/r3t09 python docs/f0-c10/fixtures/09-android-emulation-preflight.py
"""
import hashlib
import json
import os
from pathlib import Path
from shutil import which
from playwright.sync_api import sync_playwright

OUTPUT = Path(os.environ.get("OUTPUT_DIR", "/tmp/f0-c10-r3-t09-android"))
OUTPUT.mkdir(parents=True, exist_ok=True)
TASK = "0000000000000001"
ARTIFACT = "a" * 32
FILENAME = "Relatório – São Paulo.md"
PAYLOAD = "# Relatório São Paulo\nConteúdo autêntico de fixture.\n".encode("utf-8")
TEST_BEARER = "synthetic-only-no-real-credential"
PATH = f"/api/supervisor/v1/tasks/{TASK}/artifacts/{ARTIFACT}"
PAGE = """<!doctype html><html lang="pt-BR"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Simulador T09; NO ES LA APLICACIÓN</title>
<main style="font:16px system-ui;max-width:420px;padding:16px">
<h1>Artefacto de tarea simulada</h1>
<button id="download" style="min-height:52px;width:100%">Descargar informe</button>
<p id="status" role="status">Simulación local</p></main>
<script>
const target=__TARGET__, token=__TOKEN__, filename=__FILENAME__;
document.getElementById('download').addEventListener('click', async () => {
  const r=await fetch(target,{headers:{Authorization:'Bearer '+token},redirect:'manual'});
  if(!r.ok){document.getElementById('status').textContent='Acceso denegado';return;}
  const bytes=await r.arrayBuffer();
  const url=URL.createObjectURL(new Blob([bytes],{type:'text/markdown'}));
  const a=document.createElement('a');a.download=filename;a.href=url;
  document.body.appendChild(a);a.click();a.remove();
  document.getElementById('status').textContent='Descarga solicitada';
  setTimeout(()=>URL.revokeObjectURL(url),1000);
});</script></html>""".replace("__TARGET__", json.dumps(PATH)).replace("__TOKEN__", json.dumps(TEST_BEARER)).replace("__FILENAME__", json.dumps(FILENAME))

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(
        headless=True, executable_path=os.environ.get("CHROMIUM", which("chromium") or which("google-chrome")),
        args=["--no-sandbox"])
    context = browser.new_context(**playwright.devices["Pixel 7"], accept_downloads=True)
    page = context.new_page()
    # No actual network: CI sandbox may deny even 127.0.0.1 navigation.
    page.set_content(PAGE)
    page.evaluate("""({data,task,token}) => {
      window.fetch = async (url, options={}) => {
        if(options.headers?.Authorization !== 'Bearer '+token)
          return new Response(null, {status:401});
        if(url !== '/api/supervisor/v1/tasks/'+task+'/artifacts/'+'a'.repeat(32))
          return new Response(null, {status:404});
        return new Response(Uint8Array.from(data),{status:200,headers:{'Content-Type':'text/markdown'}});
      };
    }""", {"data": list(PAYLOAD), "task": TASK, "token": TEST_BEARER})
    assert page.viewport_size["width"] <= 500
    page.screenshot(path=str(OUTPUT / "android-preflight.png"))
    with page.expect_download() as captured:
        page.get_by_role("button", name="Descargar informe").click()
    download = captured.value
    assert download.suggested_filename == FILENAME
    saved = OUTPUT / "android-preflight-downloaded.md"
    download.save_as(saved)
    actual = saved.read_bytes()
    assert actual == PAYLOAD
    sha = hashlib.sha256(actual).hexdigest()
    wrong_auth = page.evaluate("""async path =>
      (await fetch(path,{headers:{Authorization:'Bearer expired-fixture'}})).status""", PATH)
    wrong_task = page.evaluate("""async path =>
      (await fetch(path,{headers:{Authorization:'Bearer synthetic-only-no-real-credential'}})).status""", PATH.replace(TASK,"0000000000000002"))
    assert wrong_auth == 401 and wrong_task == 404
    result = {
        "status":"PASS", "scope":"Chromium desktop mobile-emulation / in-page fake fetch only",
        "profile":"Pixel 7", "browserVersion":browser.version,
        "sourceSha256":hashlib.sha256(PAYLOAD).hexdigest(), "downloadSha256":sha,
        "byteSize":len(actual), "downloadName":download.suggested_filename,
        "negativeSimulatedWrongBearer":wrong_auth,
        "negativeSimulatedWrongTask":wrong_task,
        "realHttp":False,"realCloudflareAccess":False,"realOpenCodeUi":False,"realAndroid":False
    }
    (OUTPUT / "android-preflight-result.json").write_text(json.dumps(result,indent=2,ensure_ascii=False)+"\n",encoding="utf-8")
    print(json.dumps(result,ensure_ascii=False))
    context.close()
    browser.close()
