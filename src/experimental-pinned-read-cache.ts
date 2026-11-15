/**
 * EXPERIMENT 4: bounded, in-memory reuse of GitHub contents GET responses
 * ONLY when ref is an exact immutable 40-char Git commit SHA.
 *
 * The caller must validate repository authorization and path BEFORE calling.
 * Does not cache mutable refs (branch/tag/default), errors, credentials,
 * and does not persist data to Durable Object storage.
 */
export type PinnedFile = {
  readonly repo: string;
  readonly path: string;
  readonly sha: string;
  readonly ref: string;
  readonly content: string;
};
type Entry = { file: PinnedFile; bytes: number; deadline: number };

const MAX_ENTRIES = 32;
const MAX_BYTES = 1_000_000;
const FRESH_FOR_MS = 15_000;
const SHA40 = /^[a-fA-F0-9]{40}$/;

export class ExperimentalPinnedReadCache {
  #token: string | undefined;
  #generation = 0;
  #entries = new Map<string, Entry>();
  #pending = new Map<string, Promise<PinnedFile>>();
  #size = 0;

  /**
   * Identity rotation invalidates cached contents, including in-flight
   * responses that may complete after a new token is configured.
   */
  #scope(token: string): number {
    if (this.#token !== token) {
      this.#token = token;
      this.#generation++;
      this.#entries.clear();
      this.#pending.clear();
      this.#size = 0;
    }
    return this.#generation;
  }

  static supports(ref: string | undefined): ref is string {
    return typeof ref === "string" && SHA40.test(ref);
  }

  async read(
    token: string,
    repo: string,
    path: string,
    ref: string,
    load: () => Promise<PinnedFile>
  ): Promise<PinnedFile> {
    const generation = this.#scope(token);
    const key = repo.toLowerCase() + "\n" + ref.toLowerCase() + "\n" + path;
    const cached = this.#entries.get(key);
    if (cached) {
      if (cached.deadline > Date.now()) {
        this.#entries.delete(key);
        this.#entries.set(key, cached);
        return { ...cached.file };
      }
      this.#entries.delete(key);
      this.#size -= cached.bytes;
    }

    const pending = this.#pending.get(key);
    if (pending) return { ...(await pending) };

    const task = load().then(value => {
      if (this.#generation !== generation) return value;
      const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
      if (bytes <= MAX_BYTES) {
        while (this.#entries.size >= MAX_ENTRIES || this.#size + bytes > MAX_BYTES) {
          const oldest = this.#entries.keys().next().value;
          if (oldest === undefined) break;
          this.#size -= this.#entries.get(oldest)!.bytes;
          this.#entries.delete(oldest);
        }
        this.#entries.set(key, { file: { ...value }, bytes, deadline: Date.now() + FRESH_FOR_MS });
        this.#size += bytes;
      }
      return value;
    });
    this.#pending.set(key, task);
    try {
      return { ...(await task) };
    } finally {
      if (this.#generation === generation && this.#pending.get(key) === task) {
        this.#pending.delete(key);
      }
    }
  }
}
