import { describe, expect, test } from "bun:test";
import {
  safeAttachmentName,
  safeDownloadHref,
  toolFileView,
  toolFileViews,
  type ToolFilePart
} from "./tool-file-attachment";

const textFile: ToolFilePart = {
  type: "file",
  uri: "data:text/plain;base64,aG9sYQ==",
  mime: "text/plain",
  name: "notas.txt"
};

describe("tool file attachments", () => {
  test("a genuine text file part becomes a named download", () => {
    const view = toolFileView(textFile);
    expect(view).toEqual({
      kind: "attachment",
      href: "data:text/plain;base64,aG9sYQ==",
      name: "notas.txt",
      external: false
    });
  });

  test("an image file part keeps its preview", () => {
    const view = toolFileView({
      type: "file",
      uri: "data:image/png;base64,iVBORw0KGgo=",
      mime: "image/png",
      name: "grafico.png"
    });
    expect(view).toEqual({
      kind: "image",
      src: "data:image/png;base64,iVBORw0KGgo=",
      alt: "grafico.png"
    });
  });

  test("external https attachments open in a new tab", () => {
    const view = toolFileView({
      type: "file",
      uri: "https://example.com/informe.pdf",
      mime: "application/pdf",
      name: "informe.pdf"
    });
    expect(view?.kind).toBe("attachment");
    if (view?.kind !== "attachment") throw new Error("expected attachment");
    expect(view.href).toBe("https://example.com/informe.pdf");
    expect(view.external).toBe(true);
  });

  test("external image files stay links until the user opens them", () => {
    expect(
      toolFileView({
        type: "file",
        uri: "https://example.com/grafico.png",
        mime: "image/png",
        name: "grafico.png"
      })
    ).toEqual({
      kind: "attachment",
      href: "https://example.com/grafico.png",
      name: "grafico.png",
      external: true
    });
  });

  test("download names drop path components and unsafe characters", () => {
    expect(safeAttachmentName("../../etc/passwd", "text/plain")).toBe("passwd");
    expect(safeAttachmentName('C:\\tmp\\a<b>:"c".txt', "text/plain")).toBe("abc.txt");
    expect(safeAttachmentName("   ", "text/plain")).toBe("archivo.txt");
    expect(safeAttachmentName(undefined, "application/json")).toBe("archivo.json");
  });

  test("internal, relative and script URIs stay closed", () => {
    for (const uri of [
      "file:///bundle/src/client.tsx",
      "/bundle/src/client.tsx",
      "../secrets.txt",
      "javascript:alert(1)",
      "http://example.com/a.txt",
      "data:not-a-payload"
    ]) {
      expect(safeDownloadHref(uri)).toBeNull();
    }
  });

  test("plain text mentioning container paths is never linked", () => {
    const content = [
      { type: "text", text: "El archivo está en /bundle/dist/index.html" },
      { type: "text", text: "También en /tmp/opencode/tmp/out.txt" },
      textFile
    ];
    const views = toolFileViews(content);
    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({ kind: "attachment", name: "notas.txt" });
  });

  test("active data MIME types are rejected", () => {
    expect(
      toolFileView({
        type: "file",
        uri: "data:text/html;base64,PGgxPg==",
        mime: "text/html"
      })
    ).toBeNull();
    expect(
      toolFileView({
        type: "file",
        uri: "data:image/svg+xml;base64,PHN2Zz4=",
        mime: "image/svg+xml"
      })
    ).toBeNull();
    expect(safeDownloadHref("data:text/html;base64,PGgxPg==")).toBeNull();
    expect(safeDownloadHref("data:image/svg+xml;base64,PHN2Zz4=")).toBeNull();
  });

  test("a data URI must match the file part MIME", () => {
    expect(
      toolFileView({
        type: "file",
        uri: "data:image/png;base64,iVBORw0KGgo=",
        mime: "text/plain"
      })
    ).toBeNull();
  });

  test("malformed file parts are ignored", () => {
    expect(toolFileViews(undefined)).toEqual([]);
    expect(
      toolFileViews([
        { type: "file", uri: 42, mime: "text/plain" },
        { type: "file", uri: "data:text/plain;base64,aG9sYQ==" },
        null,
        "texto"
      ])
    ).toEqual([]);
  });
});
