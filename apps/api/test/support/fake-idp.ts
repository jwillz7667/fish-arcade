import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { exportJWK, SignJWT } from 'jose';

/** What the fake IdP asserts about the user who "logs in". */
export interface FakeIdentity {
  readonly email: string;
  /** IdP user ID. Defaults to one derived from the email: the same person every time. */
  readonly subject?: string;
  readonly isEmailVerified?: boolean;
  /** Override claims to test rejection paths. */
  readonly audience?: string;
  readonly nonce?: string;
}

interface IssuedCode {
  readonly identity: FakeIdentity;
  readonly nonce: string;
  readonly challenge: string;
  readonly clientId: string;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

/**
 * A minimal OIDC provider for integration tests: discovery, JWKS, and a token endpoint that
 * checks the PKCE verifier and client secret, then returns an ES256 ID token. Third-party APIs
 * are the one place test doubles stand in for real services.
 */
export class FakeIdp {
  readonly #codes = new Map<string, IssuedCode>();
  readonly #keys = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  #server: Server | undefined;
  issuer = '';

  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
  ) {}

  /** Starts listening on a random local port. */
  async start(): Promise<void> {
    const jwk = {
      ...(await exportJWK(this.#keys.publicKey)),
      kid: 'idp-1',
      alg: 'ES256',
      use: 'sig',
    };
    this.#server = createServer((request, response) => {
      void this.#handle(request, response, jwk);
    });
    await new Promise<void>((resolve) => this.#server?.listen(0, '127.0.0.1', resolve));
    const { port } = this.#server.address() as AddressInfo;
    this.issuer = `http://127.0.0.1:${String(port)}`;
  }

  /** Stops the server. */
  async stop(): Promise<void> {
    await new Promise<void>((resolve) =>
      this.#server?.close(() => {
        resolve();
      }),
    );
  }

  /**
   * Plays the user approving the login at the IdP: reads the authorization URL the API built
   * and issues a code for it.
   *
   * @returns The callback query the IdP would redirect with.
   */
  authorize(authorizationUrl: string, identity: FakeIdentity): { code: string; state: string } {
    const url = new URL(authorizationUrl);
    const code = randomUUID();
    this.#codes.set(code, {
      identity,
      nonce: url.searchParams.get('nonce') ?? '',
      challenge: url.searchParams.get('code_challenge') ?? '',
      clientId: url.searchParams.get('client_id') ?? '',
    });
    return { code, state: url.searchParams.get('state') ?? '' };
  }

  async #handle(request: IncomingMessage, response: ServerResponse, jwk: object): Promise<void> {
    const path = new URL(request.url ?? '/', this.issuer).pathname;
    if (path === '/.well-known/openid-configuration') {
      json(response, 200, {
        issuer: this.issuer,
        authorization_endpoint: `${this.issuer}/authorize`,
        token_endpoint: `${this.issuer}/token`,
        jwks_uri: `${this.issuer}/jwks`,
      });
      return;
    }
    if (path === '/jwks') {
      json(response, 200, { keys: [jwk] });
      return;
    }
    if (path === '/token' && request.method === 'POST') {
      const form = new URLSearchParams(await readBody(request));
      const issued = this.#codes.get(form.get('code') ?? '');
      const verifier = form.get('code_verifier') ?? '';
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      if (
        issued === undefined ||
        challenge !== issued.challenge ||
        form.get('client_id') !== this.clientId ||
        form.get('client_secret') !== this.clientSecret
      ) {
        json(response, 400, { error: 'invalid_grant' });
        return;
      }
      this.#codes.delete(form.get('code') ?? '');
      const idToken = await new SignJWT({
        email: issued.identity.email,
        email_verified: issued.identity.isEmailVerified ?? true,
        nonce: issued.identity.nonce ?? issued.nonce,
      })
        .setProtectedHeader({ alg: 'ES256', kid: 'idp-1' })
        .setIssuer(this.issuer)
        .setSubject(
          issued.identity.subject ??
            createHash('sha256').update(issued.identity.email).digest('hex').slice(0, 32),
        )
        .setAudience(issued.identity.audience ?? issued.clientId)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(this.#keys.privateKey);
      json(response, 200, { id_token: idToken, token_type: 'Bearer' });
      return;
    }
    json(response, 404, { error: 'not_found' });
  }
}
