import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "bun:test";
import { ToolFileAttachments } from "./tool-file-attachments";

describe("tool file attachment rendering", () => {
  test("renders a real text file part as a named download link", () => {
    const html = renderToStaticMarkup(
      createElement(ToolFileAttachments, {
        content: [{
          type: "file",
          uri: "data:text/plain;base64,aG9sYQ==",
          mime: "text/plain",
          name: "diagnostico.txt"
        }]
      })
    );

    expect(html).toContain('href="data:text/plain;base64,aG9sYQ=="');
    expect(html).toContain('download="diagnostico.txt"');
    expect(html).toContain('aria-label="Descargar diagnostico.txt"');
  });

  test("treats external files as open links without promising a download", () => {
    const html = renderToStaticMarkup(
      createElement(ToolFileAttachments, {
        content: [{
          type: "file",
          uri: "https://files.example.test/informe.pdf",
          mime: "application/pdf",
          name: "informe.pdf"
        }]
      })
    );

    expect(html).toContain('aria-label="Abrir informe.pdf"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).not.toContain('download="informe.pdf"');
  });

  test("does not fetch external image files until the user opens them", () => {
    const html = renderToStaticMarkup(
      createElement(ToolFileAttachments, {
        content: [{
          type: "file",
          uri: "https://images.example.test/grafico.png",
          mime: "image/png",
          name: "grafico.png"
        }]
      })
    );

    expect(html).toContain('href="https://images.example.test/grafico.png"');
    expect(html).toContain('aria-label="Abrir grafico.png"');
    expect(html).toContain('target="_blank"');
    expect(html).not.toContain("<img");
  });

  test("does not turn a text-only container path into a link", () => {
    const html = renderToStaticMarkup(
      createElement(ToolFileAttachments, {
        content: [{ type: "text", text: "Creado en /bundle/informe.txt" }]
      })
    );

    expect(html).toBe("");
  });
});
