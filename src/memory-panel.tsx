import { useEffect, useState } from "react";
import { MAX_PERSONAL_MEMORY_NOTE_LENGTH, type PersonalMemoryNote } from "./personal-memory";

const fieldStyle = "w-full rounded-md border border-kumo-line bg-kumo-base px-3 py-2 text-sm text-kumo-default";
const buttonStyle = "min-h-10 rounded-xl border border-kumo-line px-3 py-2 text-sm font-medium hover:bg-kumo-elevated disabled:opacity-50";

export function MemoryPanel() {
  const [notes, setNotes] = useState<PersonalMemoryNote[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [newNote, setNewNote] = useState("");
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");

  async function load() {
    const response = await fetch("/api/settings/memory", { cache: "no-store" });
    const body = await response.json() as { notes?: PersonalMemoryNote[]; error?: string };
    if (!response.ok) throw new Error(body.error ?? "No se pudo cargar la memoria.");
    const saved = body.notes ?? [];
    setNotes(saved);
    setDrafts(Object.fromEntries(saved.map(note => [note.id, note.content])));
  }

  useEffect(() => {
    void load().catch(error => setNotice(error instanceof Error ? error.message : "No se pudo cargar la memoria."));
  }, []);

  async function save(content: string, id?: string) {
    const key = id ?? "new";
    if (busy || !content.trim()) return;
    setBusy(key);
    setNotice("");
    try {
      const response = await fetch("/api/settings/memory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content, ...(id ? { id } : {}) })
      });
      const body = await response.json() as { note?: PersonalMemoryNote; error?: string };
      if (!response.ok) throw new Error(body.error ?? "No se pudo guardar la nota.");
      if (!body.note) throw new Error("El servidor no devolvió la nota guardada.");
      setNewNote("");
      await load();
      setNotice(id ? "Nota actualizada." : "Nota guardada para tus próximas sesiones.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "No se pudo guardar la nota.");
    } finally {
      setBusy("");
    }
  }

  async function remove(id: string) {
    if (busy) return;
    setBusy(id);
    setNotice("");
    try {
      const response = await fetch("/api/settings/memory", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id })
      });
      const body = await response.json() as { removed?: boolean; error?: string };
      if (!response.ok) throw new Error(body.error ?? "No se pudo eliminar la nota.");
      await load();
      setNotice(body.removed ? "Nota eliminada." : "La nota ya no existía.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "No se pudo eliminar la nota.");
    } finally {
      setBusy("");
    }
  }

  return <div className="space-y-4">
    <div className="rounded-2xl border border-kumo-line p-4">
      <h3 className="text-sm font-semibold">Memoria personal</h3>
      <p className="mt-1 text-xs text-kumo-subtle">
        Estas notas se comparten entre tus sesiones. OpenCode solo las guarda cuando se lo pides;
        puedes editarlas o borrarlas aquí. No guardes contraseñas ni claves.
      </p>
      <label htmlFor="memory-new-note" className="mt-3 block text-sm font-medium">Añadir una nota</label>
      <textarea id="memory-new-note" className={fieldStyle + " mt-1 min-h-24 resize-y"}
        value={newNote} maxLength={MAX_PERSONAL_MEMORY_NOTE_LENGTH}
        placeholder="Por ejemplo: prefiero respuestas en español y cambios pequeños."
        onChange={event => setNewNote(event.target.value)} />
      <div className="mt-2 flex items-center justify-between gap-3">
        <span className="text-xs text-kumo-subtle">{newNote.length}/{MAX_PERSONAL_MEMORY_NOTE_LENGTH}</span>
        <button type="button" className={buttonStyle} disabled={Boolean(busy) || !newNote.trim()}
          onClick={() => void save(newNote)}>Guardar nota</button>
      </div>
    </div>

    {notes.length === 0 ? <p className="rounded-2xl border border-dashed border-kumo-line p-4 text-sm text-kumo-subtle">
      No hay notas guardadas.
    </p> : notes.map(note => {
      const content = drafts[note.id] ?? note.content;
      const changed = content !== note.content;
      return <article key={note.id} className="rounded-2xl border border-kumo-line p-4">
        <label htmlFor={`memory-${note.id}`} className="block text-sm font-medium">
          Nota · actualizada {new Date(note.updatedAt).toLocaleDateString()}
        </label>
        <textarea id={`memory-${note.id}`} className={fieldStyle + " mt-2 min-h-24 resize-y"}
          value={content} maxLength={MAX_PERSONAL_MEMORY_NOTE_LENGTH}
          onChange={event => setDrafts(current => ({ ...current, [note.id]: event.target.value }))} />
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs text-kumo-subtle">{content.length}/{MAX_PERSONAL_MEMORY_NOTE_LENGTH}</span>
          <div className="flex gap-2">
            <button type="button" className={buttonStyle} disabled={Boolean(busy) || !changed || !content.trim()}
              onClick={() => void save(content, note.id)}>Guardar cambios</button>
            <button type="button" className={buttonStyle} disabled={Boolean(busy)}
              onClick={() => void remove(note.id)}>Eliminar</button>
          </div>
        </div>
      </article>;
    })}
    {notice ? <p role="status" className="text-sm text-kumo-subtle">{notice}</p> : null}
  </div>;
}
