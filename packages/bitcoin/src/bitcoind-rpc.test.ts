import { ErrorCode } from '@reef/errors';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { BitcoindRpc, BitcoindRpcError } from './bitcoind-rpc.js';

const urlOf = (input: unknown): string =>
  input instanceof URL ? input.href : typeof input === 'string' ? input : '';
const bodyOf = (init: RequestInit | undefined): unknown =>
  typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;

function reply(body: unknown, status = 200) {
  return vi.fn<typeof fetch>(() => Promise.resolve(new Response(JSON.stringify(body), { status })));
}

const rpc = (fetchFn: typeof fetch) =>
  new BitcoindRpc({ url: 'http://bitcoind.test:43782', user: 'u', password: 'p' }, fetchFn);

describe('BitcoindRpc', () => {
  it('posts a JSON-RPC call, on the wallet path when given one, and validates the result', async () => {
    const fetchFn = reply({ result: 'bcrt1qaddress', error: null });

    const address = await rpc(fetchFn).call(z.string(), 'getnewaddress', [], 'reef-dev');

    const [url, init] = fetchFn.mock.calls[0] ?? [];
    expect(urlOf(url)).toBe('http://bitcoind.test:43782/wallet/reef-dev');
    expect(bodyOf(init)).toMatchObject({ method: 'getnewaddress', params: [] });
    expect(new Headers(init?.headers).get('authorization')).toBe(
      `Basic ${Buffer.from('u:p').toString('base64')}`,
    );
    expect(address).toBe('bcrt1qaddress');
  });

  it('raises bitcoind errors with their code, even on an HTTP error status', async () => {
    const call = rpc(
      reply(
        { result: null, error: { code: -18, message: 'Requested wallet does not exist' } },
        500,
      ),
    ).call(z.unknown(), 'getwalletinfo');

    await expect(call).rejects.toBeInstanceOf(BitcoindRpcError);
    await expect(call).rejects.toMatchObject({ code: -18 });
  });

  it.each([
    ['an unreachable node', vi.fn<typeof fetch>(() => Promise.reject(new Error('ECONNREFUSED')))],
    ['a body that is not JSON-RPC', reply({ hello: 'world' })],
    ['a result of the wrong shape', reply({ result: 42, error: null })],
  ])('fails closed on %s', async (_label, fetchFn) => {
    await expect(rpc(fetchFn).call(z.string(), 'getblockchaininfo')).rejects.toMatchObject({
      code: ErrorCode.DEPENDENCY_UNAVAILABLE,
    });
  });
});
