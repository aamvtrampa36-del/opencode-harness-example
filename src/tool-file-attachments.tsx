import { DownloadSimpleIcon, FileTextIcon, LinkIcon } from "@phosphor-icons/react";
import { toolFileViews } from "./tool-file-attachment";

export function ToolFileAttachments({
  content
}: {
  content?: readonly unknown[];
}) {
  const views = toolFileViews(content);
  if (views.length === 0) return null;

  return (
    <div className="space-y-2">
      {views.map((view, index) => view.kind === "image" ? (
        <img key={index} src={view.src} alt={view.alt} referrerPolicy="no-referrer"
          className="mt-2 max-h-[65dvh] max-w-full rounded-xl border border-kumo-line object-contain" />
      ) : (
        <a key={index} href={view.href}
          {...(view.external
            ? { target: "_blank", rel: "noopener noreferrer" }
            : { download: view.name })}
          aria-label={`${view.external ? "Abrir" : "Descargar"} ${view.name}`}
          className="mt-2 flex min-h-11 items-center gap-2 rounded-xl border border-kumo-line bg-kumo-base px-3 py-2 text-xs">
          <FileTextIcon size={18} className="shrink-0 text-kumo-subtle" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate font-medium">{view.name}</span>
          {view.external ? (
            <LinkIcon size={16} className="shrink-0 text-kumo-subtle" aria-hidden="true" />
          ) : (
            <DownloadSimpleIcon size={16} className="shrink-0 text-kumo-subtle" aria-hidden="true" />
          )}
        </a>
      ))}
    </div>
  );
}
