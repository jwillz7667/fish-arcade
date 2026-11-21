import { DependencyUnavailableError, NotFoundError } from '@reef/errors';
import { CENTS_PER_DOLLAR, parseBtc, sats, type Cents, type Sats } from '@reef/money';
import { z } from 'zod';

const TIMEOUT_MS = 10_000;
/** Spec §22.1: BTCPay's on-chain bitcoin payment method. Lightning is out of scope for v1. */
export const ON_CHAIN_BTC = 'BTC-CHAIN';

/**
 * How requests authenticate: a Greenfield API key; the admin's password (regtest bootstrap
 * only); or nothing, for the public health check and the very first admin registration.
 */
export type GreenfieldAuth =
  | { readonly kind: 'apiKey'; readonly apiKey: string }
  | { readonly kind: 'basic'; readonly email: string; readonly password: string }
  | { readonly kind: 'none' };

/** BTCPay invoice statuses. Only `Settled` means paid at the store's confirmation policy. */
export type InvoiceStatus = 'New' | 'Processing' | 'Expired' | 'Invalid' | 'Settled';

/** Confirmations required before BTCPay settles an invoice. Spec §22.2: never 0-conf. */
export type SpeedPolicy = 'MediumSpeed' | 'LowMediumSpeed' | 'LowSpeed';

const invoiceSchema = z.object({
  id: z.string().min(1),
  storeId: z.string().min(1),
  status: z.enum(['New', 'Processing', 'Expired', 'Invalid', 'Settled']),
  additionalStatus: z.string(),
  amount: z.string(),
  currency: z.string(),
  checkoutLink: z.url(),
  expirationTime: z.number().int(),
});

/** An invoice, as BTCPay reports it. */
export type Invoice = z.infer<typeof invoiceSchema>;

function btcAmount(isSigned: boolean) {
  return z.string().transform((text, ctx): bigint => {
    const isNegative = isSigned && text.startsWith('-');
    try {
      const amount: bigint = parseBtc(isNegative ? text.slice(1) : text);
      return isNegative ? -amount : amount;
    } catch {
      ctx.addIssue({ code: 'custom', message: 'is not a bitcoin amount' });
      return z.NEVER;
    }
  });
}

const paymentMethodSchema = z.object({
  paymentMethodId: z.string(),
  destination: z.string(),
  amount: btcAmount(false),
  paymentMethodPaid: btcAmount(false),
  due: btcAmount(true),
});

/** What the player must send for an invoice, in satoshis. */
export interface OnChainPayment {
  readonly destination: string;
  readonly amount: Sats;
  readonly paid: Sats;
  /** Negative when overpaid (spec §22.2: credit the package, record the overage). */
  readonly due: bigint;
}

const storeSchema = z.object({ id: z.string().min(1), name: z.string() });
const webhookSchema = z.object({ id: z.string().min(1), url: z.string() });
const createdWebhookSchema = webhookSchema.extend({ secret: z.string().min(1) });
const apiKeySchema = z.object({ apiKey: z.string().min(1) });
const previewSchema = z.object({
  addresses: z.array(z.object({ keyPath: z.string(), address: z.string() })),
});
const healthSchema = z.object({ synchronized: z.boolean() });

function dollars(amount: Cents): string {
  const fraction = (amount % CENTS_PER_DOLLAR).toString().padStart(2, '0');
  return `${(amount / CENTS_PER_DOLLAR).toString()}.${fraction}`;
}

/**
 * A minimal BTCPay Greenfield API client (playbook Step 10). Every response is validated with
 * zod; failures surface as DependencyUnavailableError so money actions fail closed.
 */
export class GreenfieldClient {
  constructor(
    private readonly config: { readonly baseUrl: string; readonly auth: GreenfieldAuth },
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  /**
   * @returns Whether BTCPay is up and its node is synchronized.
   * @throws DependencyUnavailableError when BTCPay is unreachable.
   */
  async health(): Promise<{ synchronized: boolean }> {
    return this.#call(healthSchema, 'GET', '/api/v1/health');
  }

  /**
   * Registers the server's first user as its administrator. BTCPay allows this without
   * credentials only while it has no users.
   *
   * @param email Admin login.
   * @param password Admin password.
   * @throws DependencyUnavailableError when BTCPay refuses, for example because users exist.
   */
  async createFirstAdmin(email: string, password: string): Promise<void> {
    await this.#request('POST', '/api/v1/users', { email, password, isAdministrator: true });
  }

  /**
   * Creates a store for USD-priced packages (spec §22.2).
   *
   * @param input Name, confirmation policy, and invoice expiry (spec §22.2: 15 minutes).
   * @returns The new store's ID.
   * @throws DependencyUnavailableError on any failure.
   */
  async createStore(input: {
    name: string;
    speedPolicy: SpeedPolicy;
    invoiceExpirationSeconds: number;
  }): Promise<{ id: string }> {
    return this.#call(storeSchema, 'POST', '/api/v1/stores', {
      name: input.name,
      defaultCurrency: 'USD',
      speedPolicy: input.speedPolicy,
      invoiceExpiration: input.invoiceExpirationSeconds,
      // Spec §22.2: partial payments get no credit, so no tolerance for underpayment.
      paymentTolerance: 0,
    });
  }

  /**
   * @param storeId Store.
   * @returns The store, or undefined when it does not exist.
   * @throws DependencyUnavailableError on any other failure.
   */
  async findStore(storeId: string): Promise<{ id: string } | undefined> {
    try {
      return await this.#call(storeSchema, 'GET', `/api/v1/stores/${encodeURIComponent(storeId)}`);
    } catch (error) {
      if (error instanceof NotFoundError) return undefined;
      throw error;
    }
  }

  /**
   * Sets the store's exchange-rate script (a fixed rate on regtest, where no exchange exists).
   *
   * @param storeId Store.
   * @param script A BTCPay rate script, such as `BTC_USD = 50000;`.
   * @throws DependencyUnavailableError on any failure.
   */
  async setRateScript(storeId: string, script: string): Promise<void> {
    await this.#request(
      'PUT',
      `/api/v1/stores/${encodeURIComponent(storeId)}/rates/configuration/primary`,
      {
        isCustomScript: true,
        effectiveScript: script,
        spread: '0',
      },
    );
  }

  /**
   * Attaches the watch-only cold wallet. Only public keys ever reach BTCPay (spec §22.1).
   *
   * @param storeId Store.
   * @param derivationScheme The multisig in NBXplorer's format.
   * @param label Shown in BTCPay's UI.
   * @throws DependencyUnavailableError on any failure.
   */
  async setOnChainWallet(storeId: string, derivationScheme: string, label: string): Promise<void> {
    await this.#request(
      'PUT',
      `/api/v1/stores/${encodeURIComponent(storeId)}/payment-methods/${ON_CHAIN_BTC}`,
      { enabled: true, config: { derivationScheme, label } },
    );
  }

  /**
   * @param storeId Store.
   * @param count How many receive addresses, from index 0.
   * @returns The addresses BTCPay derives, in index order.
   * @throws DependencyUnavailableError on any failure.
   */
  async previewReceiveAddresses(storeId: string, count: number): Promise<string[]> {
    const preview = await this.#call(
      previewSchema,
      'GET',
      `/api/v1/stores/${encodeURIComponent(storeId)}/payment-methods/${ON_CHAIN_BTC}/wallet/preview?offset=0&count=${String(count)}`,
    );
    return preview.addresses.map((item) => item.address);
  }

  /**
   * @param label Shown in BTCPay's UI.
   * @param permissions Greenfield permission strings, store-scoped as `permission:storeId`.
   * @returns The new key.
   * @throws DependencyUnavailableError on any failure.
   */
  async createApiKey(label: string, permissions: readonly string[]): Promise<string> {
    return (await this.#call(apiKeySchema, 'POST', '/api/v1/api-keys', { label, permissions }))
      .apiKey;
  }

  /**
   * @param storeId Store.
   * @returns Its webhooks.
   * @throws DependencyUnavailableError on any failure.
   */
  async listWebhooks(storeId: string): Promise<{ id: string; url: string }[]> {
    return this.#call(
      z.array(webhookSchema),
      'GET',
      `/api/v1/stores/${encodeURIComponent(storeId)}/webhooks`,
    );
  }

  /**
   * Registers a webhook for every store event, redelivered automatically on failure.
   *
   * @param storeId Store.
   * @param input Endpoint and signing secret.
   * @returns The webhook's ID.
   * @throws DependencyUnavailableError on any failure.
   */
  async createWebhook(
    storeId: string,
    input: { url: string; secret: string },
  ): Promise<{ id: string }> {
    return this.#call(
      createdWebhookSchema,
      'POST',
      `/api/v1/stores/${encodeURIComponent(storeId)}/webhooks`,
      {
        enabled: true,
        automaticRedelivery: true,
        url: input.url,
        secret: input.secret,
        authorizedEvents: { everything: true },
      },
    );
  }

  /**
   * @param webhookId Webhook to remove.
   * @throws DependencyUnavailableError on any failure.
   */
  async deleteWebhook(webhookId: string): Promise<void> {
    await this.#request('DELETE', `/api/v1/webhooks/${encodeURIComponent(webhookId)}`);
  }

  /**
   * Creates a USD-priced invoice. BTCPay converts it to BTC and holds that amount until the
   * invoice expires (spec §22.2).
   *
   * @param storeId Store.
   * @param input Price in cents and the platform's order reference.
   * @returns The invoice.
   * @throws DependencyUnavailableError on any failure.
   */
  async createInvoice(
    storeId: string,
    input: { amount: Cents; orderId: string },
  ): Promise<Invoice> {
    return this.#call(
      invoiceSchema,
      'POST',
      `/api/v1/stores/${encodeURIComponent(storeId)}/invoices`,
      {
        amount: dollars(input.amount),
        currency: 'USD',
        metadata: { orderId: input.orderId },
        checkout: { paymentMethods: [ON_CHAIN_BTC] },
      },
    );
  }

  /**
   * @param invoiceId Invoice.
   * @returns The invoice as BTCPay reports it now.
   * @throws NotFoundError when BTCPay has no such invoice.
   * @throws DependencyUnavailableError on any other failure.
   */
  async getInvoice(invoiceId: string): Promise<Invoice> {
    return this.#call(invoiceSchema, 'GET', `/api/v1/invoices/${encodeURIComponent(invoiceId)}`);
  }

  /**
   * @param invoiceId Invoice.
   * @returns Where to pay and how much, in satoshis.
   * @throws NotFoundError when BTCPay has no such invoice or it has no on-chain method.
   * @throws DependencyUnavailableError on any other failure.
   */
  async getOnChainPayment(invoiceId: string): Promise<OnChainPayment> {
    const methods = await this.#call(
      z.array(paymentMethodSchema),
      'GET',
      `/api/v1/invoices/${encodeURIComponent(invoiceId)}/payment-methods`,
    );
    const method = methods.find((candidate) => candidate.paymentMethodId === ON_CHAIN_BTC);
    if (method === undefined)
      throw new NotFoundError({ message: 'Invoice has no on-chain payment method' });
    return {
      destination: method.destination,
      amount: sats(method.amount),
      paid: sats(method.paymentMethodPaid),
      due: method.due,
    };
  }

  async #call<T>(schema: z.ZodType<T>, method: string, path: string, body?: unknown): Promise<T> {
    const parsed = schema.safeParse(await this.#request(method, path, body));
    if (!parsed.success) {
      throw new DependencyUnavailableError({
        dependency: 'btcpay',
        message: `BTCPay ${method} returned an unexpected body`,
        cause: parsed.error,
      });
    }
    return parsed.data;
  }

  async #request(method: string, path: string, body?: unknown): Promise<unknown> {
    const { auth } = this.config;
    const authorization =
      auth.kind === 'apiKey'
        ? `token ${auth.apiKey}`
        : auth.kind === 'basic'
          ? `Basic ${Buffer.from(`${auth.email}:${auth.password}`).toString('base64')}`
          : undefined;
    let response: Response;
    try {
      response = await this.fetchFn(new URL(path, this.config.baseUrl), {
        method,
        headers: {
          ...(authorization === undefined ? {} : { authorization }),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      throw new DependencyUnavailableError({
        dependency: 'btcpay',
        message: `BTCPay ${method} failed`,
        cause: error,
      });
    }
    if (response.status === 404)
      throw new NotFoundError({ message: `BTCPay ${method} returned 404` });
    if (!response.ok) {
      throw new DependencyUnavailableError({
        dependency: 'btcpay',
        message: `BTCPay ${method} returned ${String(response.status)}`,
      });
    }
    if (response.status === 204 || response.headers.get('content-length') === '0') return undefined;
    try {
      return await response.json();
    } catch (error) {
      throw new DependencyUnavailableError({
        dependency: 'btcpay',
        message: 'BTCPay returned invalid JSON',
        cause: error,
      });
    }
  }
}
