import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { downloadSdnList, MAX_SDN_BYTES } from './sdn-download.js';

const URL_ = 'https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.XML';

function streaming(chunks: Uint8Array[], status = 200) {
  return vi.fn<typeof fetch>(() =>
    Promise.resolve(
      new Response(
        new ReadableStream({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(chunk);
            controller.close();
          },
        }),
        { status },
      ),
    ),
  );
}

describe('downloadSdnList', () => {
  it('returns the file and its SHA-256', async () => {
    const body = '<sdnList></sdnList>';
    const fetchFn = streaming([new TextEncoder().encode(body)]);

    const download = await downloadSdnList(URL_, fetchFn);

    expect(download).toEqual({
      xml: body,
      sha256: createHash('sha256').update(body).digest('hex'),
    });
    expect(fetchFn.mock.calls[0]?.[1]?.redirect).toBe('follow');
  });

  it('fails on an error status', async () => {
    await expect(downloadSdnList(URL_, streaming([], 503))).rejects.toThrow(
      'OFAC download returned 503',
    );
  });

  it('stops reading past the size limit', async () => {
    const chunk = new Uint8Array(MAX_SDN_BYTES / 2 + 1);

    await expect(downloadSdnList(URL_, streaming([chunk, chunk]))).rejects.toThrow('size limit');
  });
});
