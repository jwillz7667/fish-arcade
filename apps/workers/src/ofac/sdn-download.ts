import { createHash } from 'node:crypto';

/** The downloaded list and its fingerprint. */
export interface SdnDownload {
  readonly xml: string;
  readonly sha256: string;
}

/** SDN.XML is about 30 MB; anything far larger is not the list. */
export const MAX_SDN_BYTES = 100 * 1024 * 1024;
const TIMEOUT_MS = 120_000;

/**
 * Downloads OFAC's SDN list. The Sanctions List Service redirects to a signed S3 URL, which
 * fetch follows.
 *
 * @param url `OFAC_SDN_URL`.
 * @param fetchFn Transport, replaced in tests.
 * @returns The file as text and its SHA-256.
 * @throws Error on a non-2xx status, a timeout, or a body over {@link MAX_SDN_BYTES}.
 */
export async function downloadSdnList(
  url: string,
  fetchFn: typeof fetch = fetch,
): Promise<SdnDownload> {
  const response = await fetchFn(url, {
    headers: { accept: 'application/xml, text/xml', 'user-agent': 'reef-ofac-import' },
    redirect: 'follow',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok || response.body === null) {
    throw new Error(`OFAC download returned ${String(response.status)}`);
  }
  const hash = createHash('sha256');
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body.getReader();
  for (let read = await reader.read(); !read.done; read = await reader.read()) {
    // Node types the body's chunks as any; a fetch body only ever yields bytes.
    const chunk: unknown = read.value;
    if (!(chunk instanceof Uint8Array)) throw new Error('OFAC download yielded a non-byte chunk');
    size += chunk.byteLength;
    if (size > MAX_SDN_BYTES) {
      await reader.cancel();
      throw new Error('OFAC download exceeded the size limit');
    }
    hash.update(chunk);
    chunks.push(chunk);
  }
  return { xml: Buffer.concat(chunks).toString('utf8'), sha256: hash.digest('hex') };
}
