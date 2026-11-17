const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_TEXT_CHARS = 12_000;
const MAX_REDIRECTS = 3;
const READ_TIMEOUT_MS = 12_000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export type PublicWebPage = {
  url: string;
  title: string;
  contentType: string;
  text: string;
  truncated: boolean;
};

function validatePublicUrl(input: string | URL): URL {
  let url: URL;
  try {
    url = input instanceof URL ? new URL(input.toString()) : new URL(input);
  } catch {
    throw new Error("Indica una URL HTTPS válida.");
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  const labels = hostname.split(".");
  const isIpLiteral = hostname.includes(":") || /^\d+(?:\.\d+){3}$/.test(hostname);
  const hostnameLooksPublic = labels.length >= 2 && labels.every(label =>
    label.length > 0 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label));
  const blockedSuffix = [".localhost", ".local", ".internal", ".test", ".invalid", ".example", ".home.arpa"]
    .some(suffix => hostname.endsWith(suffix));
  const hasCredentialQuery = [...url.searchParams.keys()].some(key =>
    /^(?:token|access[_-]?token|refresh[_-]?token|id[_-]?token|secret|password|passwd|api[_-]?key|authorization|code|key)$/i.test(key));
  if (url.protocol !== "https:" || !hostnameLooksPublic || isIpLiteral || blockedSuffix ||
      url.username || url.password || hasCredentialQuery || (url.port && url.port !== "443")) {
    throw new Error("Solo se permiten páginas públicas HTTPS con nombre de dominio.");
  }
  url.hash = "";
  return url;
}

function decodeEntities(text: string): string {
  return text.replace(/&(#(?:x[0-9a-f]+|\d+)|amp|lt|gt|quot|apos|nbsp);/gi, (entity, code: string) => {
    if (code[0] === "#") {
      const numeric = code[1]?.toLowerCase() === "x"
        ? Number.parseInt(code.slice(2), 16)
        : Number.parseInt(code.slice(1), 10);
      return Number.isFinite(numeric) && numeric > 0 && numeric <= 0x10ffff
        ? String.fromCodePoint(numeric) : entity;
    }
    return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " } as Record<string, string>)[code.toLowerCase()] ?? entity;
  });
}

function htmlToText(html: string): { title: string; text: string } {
  const titleMatch = html.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i);
  const title = titleMatch
    ? decodeEntities(titleMatch[1].replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim())
    : "";
  const text = decodeEntities(html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<(br|hr)\b[^>]*>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|blockquote)\s*>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/[\t\r ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim());
  return { title, text };
}

function safeDisplayUrl(url: URL): string {
  const result = new URL(url.toString());
  for (const key of [...result.searchParams.keys()]) {
    if (/(?:token|secret|password|passwd|api[_-]?key|authorization|auth|^code$|^key$)/i.test(key)) {
      result.searchParams.set(key, "[redacted]");
    }
  }
  return result.toString();
}

async function readBoundedBody(response: Response): Promise<{ text: string; truncated: boolean }> {
  const advertisedLength = Number(response.headers.get("content-length"));
  let truncated = Number.isFinite(advertisedLength) && advertisedLength > MAX_RESPONSE_BYTES;
  const reader = response.body?.getReader();
  if (!reader) return { text: "", truncated };
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let total = 0;
  try {
    while (total < MAX_RESPONSE_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = MAX_RESPONSE_BYTES - total;
      const chunk = value.byteLength > remaining ? value.subarray(0, remaining) : value;
      total += chunk.byteLength;
      parts.push(decoder.decode(chunk, { stream: true }));
      if (chunk.byteLength < value.byteLength) {
        truncated = true;
        await reader.cancel();
        break;
      }
    }
    if (total === MAX_RESPONSE_BYTES) {
      truncated = true;
      await reader.cancel();
    }
    parts.push(decoder.decode());
  } finally {
    reader.releaseLock();
  }
  return { text: parts.join(""), truncated };
}

/** Read a small, public text page without forwarding cookies or credentials. */
export async function readPublicWebPage(
  input: string,
  fetcher: typeof fetch = fetch
): Promise<PublicWebPage> {
  if (typeof input !== "string" || input.length > 2_000) throw new Error("La URL no puede superar 2000 caracteres.");
  let current = validatePublicUrl(input.trim());
  let response: Response | undefined;
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect++) {
    response = await fetcher(current, {
      method: "GET",
      redirect: "manual",
      headers: { Accept: "text/html,application/xhtml+xml,text/plain,application/json,application/xml,text/xml;q=0.9" },
      signal: AbortSignal.timeout(READ_TIMEOUT_MS)
    });
    if (!REDIRECT_STATUSES.has(response.status)) break;
    const location = response.headers.get("location");
    await response.body?.cancel();
    if (!location || redirect === MAX_REDIRECTS) throw new Error("La página redirigió demasiadas veces o sin destino.");
    current = validatePublicUrl(new URL(location, current));
  }
  if (!response) throw new Error("No se recibió respuesta de la página.");
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`La página respondió con HTTP ${response.status}.`);
  }
  const rawContentType = response.headers.get("content-type") ?? "";
  const contentType = rawContentType.split(";", 1)[0].trim().toLowerCase();
  const isHtml = contentType === "text/html" || contentType === "application/xhtml+xml";
  const isText = isHtml || contentType === "text/plain" || contentType === "application/json" ||
    contentType === "application/xml" || contentType === "text/xml";
  if (!isText) {
    await response.body?.cancel();
    throw new Error(`El tipo de contenido ${contentType || "desconocido"} no es texto legible.`);
  }
  const body = await readBoundedBody(response);
  const parsed = isHtml ? htmlToText(body.text) : { title: "", text: body.text.trim() };
  return {
    url: safeDisplayUrl(current),
    title: parsed.title.slice(0, 300),
    contentType,
    text: parsed.text.slice(0, MAX_TEXT_CHARS),
    truncated: body.truncated || parsed.text.length > MAX_TEXT_CHARS
  };
}
