import { describe, expect, test } from "bun:test";
import { inlinePreviewAssets } from "./preview-inline";

const index = '<!doctype html><head><link rel="stylesheet" href="./styles.css"></head>' +
  '<body><button>Funciona</button><script src="./app.js"></script></body>';
const responses: Record<string, [string, string]> = {
  "dist/styles.css": ["text/css; charset=utf-8", "body { background: #0f172a; }"],
  "dist/app.js": ["text/javascript; charset=utf-8",
    'document.querySelector("button").onclick = () => { document.body.dataset.done = "Prueba completada"; };']
};
function mockLoader(calls: string[]) {
  return async (path: string): Promise<Response> => {
    calls.push(path);
    const match = responses[path];
    return match ? new Response(match[1], { headers: { "Content-Type": match[0] } })
      : new Response("Not found", { status: 404 });
  };
}

describe("isolated HTML preview resource delivery", () => {
  test("embeds local stylesheet and script, avoiding authenticated subresource fetches", async () => {
    const calls: string[] = [];
    const html = await inlinePreviewAssets(index, "dist/", mockLoader(calls));
    expect(calls).toEqual(["dist/styles.css", "dist/app.js"]);
    expect(html).toContain("<style>body { background: #0f172a; }</style>");
    expect(html).toContain("<script>document.querySelector");
    expect(html).toContain("Prueba completada");
    expect(html).not.toContain('href="./styles.css"');
    expect(html).not.toContain('src="./app.js"');
  });

  test("supports single quotes, module scripts and paths under dist/assets", async () => {
    const calls: string[] = [];
    const html = await inlinePreviewAssets(
      "<link href='/assets/site.css' rel='stylesheet'><script type='module' src='/assets/site.js'></script>",
      "dist/", async path => {
        calls.push(path);
        return new Response(path.endsWith(".css") ? "h1{color:red}" : "console.log(1)",
          { headers: { "Content-Type": path.endsWith(".css") ? "text/css" : "text/javascript" } });
      }
    );
    expect(calls).toEqual(["dist/assets/site.css", "dist/assets/site.js"]);
    expect(html).toContain("<style>h1{color:red}</style>");
    expect(html).toContain("<script type='module'>console.log(1)</script>");
  });

  test("never fetches remote or parent-directory assets", async () => {
    const calls: string[] = [];
    const html = '<link rel="stylesheet" href="https://evil.invalid/x.css">' +
      '<script src="../outside.js"></script><script src="//evil.invalid/other.js"></script>';
    const result = await inlinePreviewAssets(html, "dist/", mockLoader(calls));
    expect(result).toBe(html);
    expect(calls).toEqual([]);
  });

  test("does not replace asset tags when files are missing or have unexpected content types", async () => {
    const html = await inlinePreviewAssets(index, "dist/", async () => new Response("<html>Login</html>",
      { headers: { "Content-Type": "text/html" } }));
    expect(html).toBe(index);
  });

  test("keeps the CSP sandbox compatible by never inlining a closing script tag", async () => {
    const html = await inlinePreviewAssets('<script src="./app.js"></script>', "dist/",
      async () => new Response('console.log("</script>")', { headers: { "Content-Type": "text/javascript" } }));
    expect(html).toContain('<\\/script>');
    expect(html.match(/<\\/script>/g)?.length).toBe(1);
  });
});
