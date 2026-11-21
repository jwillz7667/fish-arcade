import { DependencyUnavailableError } from '@reef/errors';
import { z } from 'zod';

const TIMEOUT_MS = 30_000;

const responseSchema = z.object({
  result: z.unknown(),
  error: z.object({ code: z.number(), message: z.string() }).nullable(),
});

/** bitcoind returned a JSON-RPC error, such as "Wallet file not found". */
export class BitcoindRpcError extends Error {
  /** bitcoind's RPC error code, for example -18 for an unknown wallet. */
  readonly code: number;

  /** @param code bitcoind's error code. @param message Its message. */
  constructor(code: number, message: string) {
    super(message);
    this.name = 'BitcoindRpcError';
    this.code = code;
  }
}

/**
 * A minimal bitcoind JSON-RPC client for the regtest tooling and Bitcoin integration tests.
 * The platform itself never talks to bitcoind: BTCPay watches the chain and the signer builds
 * payouts.
 */
export class BitcoindRpc {
  constructor(
    private readonly config: {
      readonly url: string;
      readonly user: string;
      readonly password: string;
    },
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  /**
   * @param schema What the result must look like.
   * @param method RPC method.
   * @param params Positional parameters.
   * @param wallet Wallet to call it on, for wallet RPCs.
   * @returns The validated result.
   * @throws BitcoindRpcError when bitcoind rejects the call.
   * @throws DependencyUnavailableError when bitcoind is unreachable or answers oddly.
   */
  async call<T>(
    schema: z.ZodType<T>,
    method: string,
    params: readonly unknown[] = [],
    wallet?: string,
  ): Promise<T> {
    const path = wallet === undefined ? '/' : `/wallet/${encodeURIComponent(wallet)}`;
    let body: unknown;
    try {
      const response = await this.fetchFn(new URL(path, this.config.url), {
        method: 'POST',
        headers: {
          authorization: `Basic ${Buffer.from(`${this.config.user}:${this.config.password}`).toString('base64')}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ jsonrpc: '1.0', id: method, method, params }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      // bitcoind answers RPC errors with 404 or 500 and a JSON body, so the body decides.
      body = await response.json();
    } catch (error) {
      throw new DependencyUnavailableError({
        dependency: 'bitcoind',
        message: `${method} failed`,
        cause: error,
      });
    }
    const envelope = responseSchema.safeParse(body);
    if (!envelope.success) {
      throw new DependencyUnavailableError({
        dependency: 'bitcoind',
        message: `${method} returned an unexpected body`,
      });
    }
    if (envelope.data.error !== null) {
      throw new BitcoindRpcError(envelope.data.error.code, envelope.data.error.message);
    }
    const result = schema.safeParse(envelope.data.result);
    if (!result.success) {
      throw new DependencyUnavailableError({
        dependency: 'bitcoind',
        message: `${method} returned an unexpected result`,
      });
    }
    return result.data;
  }
}
