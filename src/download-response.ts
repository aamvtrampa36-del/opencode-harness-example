/** Small shared HTTP boundary for project and GitHub downloads.
 * Forward bytes as a stream and never mark an upstream error as a successful archive.
 */
export type ArchiveFormat = "tar.gz" | "zip";
const HEADERS = { "Cache-Control": "no-store, private", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };

export function archiveError(status: number, message: string): Response {
  return Response.json({ error: message }, {
    status,
    headers: HEADERS
  });
}

export async function archiveDownloadResponse(
  project: string, upstream: Response, format: ArchiveFormat
): Promise<Response> {
  const filename = project + (format === "tar.gz" ? ".tar.gz" : "-github.zip");
  const type = format === "tar.gz" ? "application/gzip" : "application/zip";
  if (!upstream.ok) {
    await upstream.body?.cancel().catch(() => undefined);
    if (upstream.status === 404) {
      return archiveError(404, "No hay archivos locales descargables para este proyecto. Si es un repositorio GitHub, selecciónalo desde Proyectos y usa Descargar.");
    }
    return archiveError(502, "La fuente no pudo generar el archivo (HTTP " + upstream.status + "). No se descargó ningún archivo incompleto.");
  }
  if (!upstream.body) {
    return archiveError(502, "La fuente devolvió una respuesta sin archivo.");
  }
  // Do not forward Transfer-Encoding, Content-Encoding, Connection or
  // upstream Content-Disposition. Keep only safe, explicit attachment headers.
  const headers = new Headers(HEADERS);
  headers.set("Content-Type", type);
  headers.set("Content-Disposition", 'attachment; filename="' + filename + '"');
  const length = upstream.headers.get("Content-Length");
  if (length && /^[1-9][0-9]*$/.test(length)) headers.set("Content-Length", length);
  return new Response(upstream.body, { status: 200, headers });
}
