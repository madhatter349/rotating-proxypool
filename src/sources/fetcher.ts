export class SourceFetchError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "SourceFetchError";
  }
}

export interface FetchResult {
  text: string;
  httpStatus: number;
}

/**
 * Fetch a source URL with a strict timeout and byte cap.
 * Rejects with SourceFetchError on non-2xx, timeout, or oversize bodies.
 */
export async function fetchSource(
  url: string,
  opts: { timeoutMs: number; maxBytes: number }
): Promise<FetchResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);

  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "user-agent": "rotating-proxypool/1.0 (+https://github.com/madhatter349/rotating-proxypool)",
        accept: "text/plain,application/json,text/*",
      },
    });
    if (!res.ok) {
      throw new SourceFetchError(`HTTP ${res.status} for ${url}`, res.status);
    }
    if (!res.body) return { text: "", httpStatus: res.status };

    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > opts.maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new SourceFetchError(`body exceeds ${opts.maxBytes} bytes`);
      }
      chunks.push(value);
    }
    const text = Buffer.concat(chunks).toString("utf8");
    return { text, httpStatus: res.status };
  } catch (err) {
    if (err instanceof SourceFetchError) throw err;
    if ((err as Error).name === "AbortError") {
      throw new SourceFetchError(`timeout after ${opts.timeoutMs}ms`);
    }
    throw new SourceFetchError((err as Error).message);
  } finally {
    clearTimeout(timer);
  }
}