/**
 * Tool results can carry OpenCode file parts (`{ type: "file", uri, mime,
 * name? }`). Only a genuine file part with a URI the browser can download
 * safely becomes an attachment. Plain text that happens to contain a
 * container path such as `/bundle/...` or `/tmp/...` is never turned into a
 * link: it is not a file part and the app cannot serve those internal paths.
 */
export type ToolFilePart = {
  readonly type: "file";
  readonly uri: string;
  readonly mime: string;
  readonly name?: string;
};

export type ToolFileView =
  | { readonly kind: "image"; readonly src: string; readonly alt: string }
  | {
      readonly kind: "attachment";
      readonly href: string;
      readonly name: string;
      /** Cross-origin links cannot force a download; open them in a new tab. */
      readonly external: boolean;
    };

/** Schemes a tool result may use for a real attachment. */
const DOWNLOADABLE_SCHEMES = new Set(["data:", "https:", "blob:"]);

/**
 * Data URIs are inline bytes, so their declared type must be inert. Active
 * content such as text/html or image/svg+xml is rejected; the list is an
 * allowlist so an unknown type stays closed instead of becoming executable.
 */
const SAFE_DATA_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/bmp",
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
  "application/pdf",
  "application/zip",
  "application/gzip",
  "application/octet-stream"
]);

const MIME_EXTENSIONS: Readonly<Record<string, string>> = {
  "text/plain": ".txt",
  "text/markdown": ".md",
  "text/csv": ".csv",
  "text/html": ".html",
  "application/json": ".json",
  "application/pdf": ".pdf",
  "application/zip": ".zip",
  "application/gzip": ".gz"
};

function normalizeMime(mime: string): string {
  return mime.split(";")[0]?.trim().toLowerCase() ?? "";
}

/** Declared media type of a data URI, defaulting to text/plain per the spec. */
function dataUriMime(uri: string): string | null {
  if (!/^data:/i.test(uri)) return null;
  const comma = uri.indexOf(",");
  if (comma < 0) return null;
  return normalizeMime(uri.slice(5, comma)) || "text/plain";
}

function extensionForMime(mime: string): string {
  return MIME_EXTENSIONS[normalizeMime(mime)] ?? "";
}

function truncate(name: string, max: number): string {
  if (name.length <= max) return name;
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 && name.length - dot <= 12 ? name.slice(dot) : "";
  return name.slice(0, max - extension.length) + extension;
}

/**
 * A name safe for the `download` attribute: no path components, control
 * characters, or characters browsers and filesystems reject.
 */
export function safeAttachmentName(name: string | undefined, mime: string): string {
  const basename = (name ?? "").split(/[\\/]/).pop() ?? "";
  const cleaned = basename
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[<>:"|?*]/g, "")
    .trim()
    .replace(/[. ]+$/, "");
  if (!cleaned || cleaned === "." || cleaned === "..") {
    return truncate("archivo" + extensionForMime(mime), 120);
  }
  return truncate(cleaned, 120);
}

/**
 * The URI as-is when it is an absolute URL with a scheme the browser can
 * download from this page. `file:`, `http:`, `javascript:`, relative paths
 * and container paths are rejected so the link stays closed.
 */
export function safeDownloadHref(uri: string): string | null {
  const value = uri.trim();
  if (!value) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (!DOWNLOADABLE_SCHEMES.has(parsed.protocol)) return null;
  if (parsed.protocol === "data:") {
    const declared = dataUriMime(value);
    if (!declared || !SAFE_DATA_MIMES.has(declared)) return null;
  }
  return value;
}

/** One completed tool file part as the UI should render it, or null. */
export function toolFileView(file: ToolFilePart): ToolFileView | null {
  const href = safeDownloadHref(file.uri);
  if (!href) return null;
  const mime = normalizeMime(file.mime);
  // Inline bytes must declare the same inert type as the file part.
  if (href.toLowerCase().startsWith("data:") && dataUriMime(href) !== mime) {
    return null;
  }
  // Preview inline images without contacting a remote host automatically.
  if (mime.startsWith("image/") && !href.startsWith("https:")) {
    return { kind: "image", src: href, alt: file.name?.trim() || "Imagen generada" };
  }
  return {
    kind: "attachment",
    href,
    name: safeAttachmentName(file.name, mime),
    external: !href.startsWith("data:") && !href.startsWith("blob:")
  };
}

/**
 * Views for a completed tool result's content. Only `type: "file"` entries
 * are considered; text parts are ignored even when they mention a path.
 */
export function toolFileViews(content: readonly unknown[] | undefined): ToolFileView[] {
  if (!content) return [];
  const views: ToolFileView[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const part = item as Partial<ToolFilePart>;
    if (part.type !== "file" || typeof part.uri !== "string" || typeof part.mime !== "string") continue;
    const view = toolFileView({ type: "file", uri: part.uri, mime: part.mime, name: part.name });
    if (view) views.push(view);
  }
  return views;
}
