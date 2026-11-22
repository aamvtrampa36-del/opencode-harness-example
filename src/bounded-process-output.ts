/**
 * Bounded capture for process pipes. Drain the stream as it runs, keeping a
 * small prefix and suffix rather than buffering potentially unbounded output.
 * Design reference: DeepSeek Harness dsh-bash-local's bounded collectors
 * (MIT), and Cloudflare Containers' concurrent pipe draining guidance.
 * No upstream code is copied verbatim.
 */
export type BoundedOutput = {
  text: string;
  truncated: boolean;
  totalBytes: number;
  omittedBytes: number;
};

export async function captureBoundedOutput(
  stream: ReadableStream<Uint8Array> | null | undefined,
  maxBytes: number,
): Promise<BoundedOutput> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new RangeError("maxBytes must be a positive safe integer");
  }
  if (!stream) return { text: "", truncated: false, totalBytes: 0, omittedBytes: 0 };

  const headCap = Math.ceil(maxBytes / 2);
  const tailCap = Math.floor(maxBytes / 2);
  const head = new Uint8Array(headCap);
  const tail = new Uint8Array(tailCap);
  let headSize = 0;
  let tailSize = 0;
  let totalBytes = 0;
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      totalBytes += value.byteLength;
      const prefixSize = Math.min(value.byteLength, headCap - headSize);
      if (prefixSize) {
        head.set(value.subarray(0, prefixSize), headSize);
        headSize += prefixSize;
      }
      if (tailCap === 0) continue;
      if (value.byteLength >= tailCap) {
        tail.set(value.subarray(value.byteLength - tailCap));
        tailSize = tailCap;
      } else {
        const overflow = Math.max(0, tailSize + value.byteLength - tailCap);
        if (overflow) {
          tail.copyWithin(0, overflow, tailSize);
          tailSize -= overflow;
        }
        tail.set(value, tailSize);
        tailSize += value.byteLength;
      }
    }
  } finally {
    reader.releaseLock();
  }

  const decoder = new TextDecoder();
  if (totalBytes <= maxBytes) {
    // Prefix and suffix overlap for short streams. Reassemble exactly once.
    const overlap = Math.max(0, headSize + tailSize - totalBytes);
    const whole = new Uint8Array(totalBytes);
    whole.set(head.subarray(0, headSize));
    whole.set(tail.subarray(overlap, tailSize), headSize);
    return { text: decoder.decode(whole), truncated: false, totalBytes, omittedBytes: 0 };
  }
  const omittedBytes = totalBytes - headSize - tailSize;
  const text = decoder.decode(head.subarray(0, headSize)) +
    "\n[... " + omittedBytes + " bytes omitted from process output ...]\n" +
    decoder.decode(tail.subarray(0, tailSize));
  return { text, truncated: true, totalBytes, omittedBytes };
}
