/**
 * Staging preview HTML: embed small local CSS and JS assets directly.
 * CSP sandbox gives the generated page an opaque origin. In browsers with
 * Cloudflare Access, subresource requests from that origin may not carry
 * the owner's authentication cookies. Inline resources avoid those separate
 * requests WITHOUT giving generated scripts access to the authenticated
 * origin or relaxing the sandbox.
 */
const MAX_ASSETS = 16;
const MAX_ASSET_BYTES = 1_500_000;
const MAX_TOTAL_BYTES = 3_000_000;
const MAX_HTML_BYTES = 1_000_000;

export type PreviewAssetLoader = (path: string) => Promise<Response>;

function localAssetPath(pagePath: string, href: string, extension: "css" | "js"): string | null {
  if (!href || href.includes("\\") || href.includes("%") || href.includes("?") || href.includes("#")
    || href.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(href)) return null;
  // Page paths are already restricted by the preview server to dist/.
  if (!pagePath.startsWith("dist/")) return null;
  try {
    const base = new URL("https://preview.invalid/" + pagePath);
    const pathname = new URL(href, base).pathname;
    const resolved = href.startsWith("/") ? "/dist" + pathname : pathname;
    if (!resolved.startsWith("/dist/")) return null;
    const segments = resolved.slice(1).split("/");
    if (segments.some(segment => !segment || segment === "." || segment === ".."
      || !/^[a-zA-Z0-9_.@~-]+$/.test(segment))) return null;
    if (!resolved.toLowerCase().endsWith("." + extension)) return null;
    return resolved.slice(1);
  } catch {
    return null;
  }
}

function attribute(tag: string, name: string): string | null {
  const expression = new RegExp("\\b" + name + "\\s*=\\s*(?:\\\"([^\\\"]*)\\\"|'([^']*)')", "i");
  const match = tag.match(expression);
  return match ? (match[1] ?? match[2] ?? null) : null;
}

function safeInline(text: string, type: "script" | "style"): string {
  return text.replace(new RegExp("</" + type, "gi"), "<\\/" + type);
}

export async function inlinePreviewAssets(
  html: string,
  pagePath: string,
  load: PreviewAssetLoader
): Promise<string> {
  if (new TextEncoder().encode(html).byteLength > MAX_HTML_BYTES) return html;
  let count = 0;
  let total = 0;
  const loadLocal = async (reference: string | null, extension: "css" | "js") => {
    if (!reference || count >= MAX_ASSETS) return null;
    const path = localAssetPath(pagePath, reference, extension);
    if (!path) return null;
    count++;
    try {
      const response = await load(path);
      const type = response.headers.get("content-type")?.toLowerCase() ?? "";
      if (!response.ok ||
        !(extension === "css" ? type.startsWith("text/css") :
          type.startsWith("text/javascript") || type.startsWith("application/javascript"))) return null;
      const size = Number(response.headers.get("content-length"));
      if (Number.isFinite(size) && size > MAX_ASSET_BYTES) return null;
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > MAX_ASSET_BYTES || total + bytes.byteLength > MAX_TOTAL_BYTES) return null;
      total += bytes.byteLength;
      return new TextDecoder().decode(bytes);
    } catch {
      return null;
    }
  };

  // Replace only stylesheet links for local files in this project's dist/.
  // External stylesheet URLs and script URLs are never fetched by the Worker.
  const links = [...html.matchAll(/<link\\b[^>]*>/gi)];
  for (const match of links) {
    const tag = match[0];
    const rel = attribute(tag, "rel")?.toLowerCase().split(/\\s+/) ?? [];
    if (!rel.includes("stylesheet")) continue;
    const css = await loadLocal(attribute(tag, "href"), "css");
    if (css === null) continue;
    const media = attribute(tag, "media");
    const safeMedia = media && /^[a-zA-Z0-9 (),.:\\-/]+$/.test(media)
      ? ' media="' + media + '"' : "";
    html = html.replace(tag, "<style" + safeMedia + ">" + safeInline(css, "style") + "</style>");
  }

  // Only empty external script elements: do not rewrite inline content,
  // inject remote URLs, or change module/async/defer attributes.
  const scripts = [...html.matchAll(/<script\\b[^>]*>\\s*<\\/script\\s*>/gi)];
  for (const match of scripts) {
    const tag = match[0];
    const open = tag.match(/^<script\\b[^>]*>/i)?.[0];
    if (!open) continue;
    const js = await loadLocal(attribute(open, "src"), "js");
    if (js === null) continue;
    const rewritten = open.replace(/\\s+src\\s*=\\s*(?:"[^"]*"|'[^']*')/i, "");
    html = html.replace(tag, rewritten + safeInline(js, "script") + "</script>");
  }
  return html;
}
