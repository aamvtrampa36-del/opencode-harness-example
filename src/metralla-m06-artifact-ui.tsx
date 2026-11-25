import { useState } from "react";
import { artifactClientViews, artifactDownloadError, verifiedClientArtifactBytes, type ArtifactFetch } from "./metralla-m06-artifact-client";
import type { ArtifactView } from "./task-output-artifacts";

/** Transport may be injected by an already authorized caller; normal browser cookies are not a supervisor bearer. */
export function VerifiedTaskArtifacts({ content, authorizedFetch }: { content?: readonly unknown[]; authorizedFetch?: ArtifactFetch }) {
  const views = artifactClientViews(content);
  if (!views.length) return null;
  return <div className="space-y-2">{views.map(v =>
    <VerifiedArtifact key={v.requestId + ":" + v.artifactId} artifact={v} authorizedFetch={authorizedFetch} />)}</div>;
}
function VerifiedArtifact({artifact, authorizedFetch}: {artifact:ArtifactView;authorizedFetch?:ArtifactFetch}) {
  const [status,setStatus]=useState<string>("");
  const [busy,setBusy]=useState(false);
  async function download() {
    setBusy(true); setStatus("");
    try {
      // Same-origin GET only; backend still rejects absent/invalid bearer.
      const bytes=await verifiedClientArtifactBytes(artifact,authorizedFetch ?? ((path,init)=>fetch(path,init)));
      const url=URL.createObjectURL(new Blob([new Uint8Array(bytes)],{type:"application/octet-stream"}));
      try {
        const a=document.createElement("a"); a.href=url; a.download=artifact.name;
        document.body.append(a); a.click(); a.remove();
        setStatus("SHA-256 comprobado; descarga preparada.");
      } finally {setTimeout(()=>URL.revokeObjectURL(url),30000);}
    } catch(error) {setStatus(artifactDownloadError(error));}
    finally {setBusy(false);}
  }
  return <section className="rounded-xl border border-kumo-line bg-kumo-base px-3 py-2 text-xs space-y-1">
    <p className="font-medium break-words">{artifact.name}</p>
    <p>{artifact.mime} · {artifact.byteSize} bytes</p>
    <p className="break-all">SHA-256 esperado: {artifact.sha256}</p>
    <button type="button" className="min-h-11 underline" disabled={busy} onClick={()=>void download()}>
      {busy ? "Comprobando archivo…" : "Descargar archivo protegido"}
    </button>
    <p className="break-all text-kumo-subtle">Ruta autenticada: {artifact.delivery.path}</p>
    {status ? <p role="status">{status}</p> : null}
  </section>;
}
