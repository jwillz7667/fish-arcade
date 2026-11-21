import { createHash } from 'node:crypto';

import { AuthError, DependencyUnavailableError } from '@reef/errors';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { z } from 'zod';

import { randomToken } from '../../auth/crypto/secrets.js';

/** OIDC client settings from ADMIN_OIDC_* env. */
export interface OidcConfig {
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
}

/** What the callback must check, kept server-side between start and callback. */
export interface OidcPending {
  readonly state: string;
  readonly nonce: string;
  readonly codeVerifier: string;
}

const TIMEOUT_MS = 5_000;

const discoverySchema = z.object({
  issuer: z.string().min(1),
  authorization_endpoint: z.url(),
  token_endpoint: z.url(),
  jwks_uri: z.url(),
});

const tokenSchema = z.object({ id_token: z.string().min(1) });

const claimsSchema = z.object({
  email: z.email(),
  email_verified: z.literal(true),
  nonce: z.string().min(1),
});

type Discovery = z.infer<typeof discoverySchema>;

/**
 * OIDC authorization code flow with PKCE for the back office (playbook Step 9). Built on `jose`
 * and fetch: discovery, a PKCE authorization URL, code exchange with the client secret, and ID
 * token verification against the issuer's JWKS (issuer, audience, expiry, nonce, verified
 * email). Fails closed: any IdP error refuses the login.
 */
export class OidcClient {
  #discovery: Promise<{ document: Discovery; keys: JWTVerifyGetKey }> | undefined;

  constructor(
    private readonly config: OidcConfig,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  /**
   * @returns The IdP URL to send the browser to, and the values the callback must check.
   * @throws DependencyUnavailableError when discovery fails.
   */
  async start(): Promise<{ authorizationUrl: string; pending: OidcPending }> {
    const { document } = await this.#discover();
    const pending: OidcPending = {
      state: randomToken(),
      nonce: randomToken(),
      codeVerifier: randomToken(),
    };
    const url = new URL(document.authorization_endpoint);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      scope: 'openid email',
      state: pending.state,
      nonce: pending.nonce,
      code_challenge: createHash('sha256').update(pending.codeVerifier).digest('base64url'),
      code_challenge_method: 'S256',
    }).toString();
    return { authorizationUrl: url.toString(), pending };
  }

  /**
   * Exchanges the code and verifies the ID token.
   *
   * @param code Authorization code from the callback.
   * @param pending What `start` issued for this login.
   * @returns The verified staff email, lowercased.
   * @throws AuthError when the ID token is invalid, unverified, or for another login.
   * @throws DependencyUnavailableError when the IdP cannot be reached.
   */
  async finish(code: string, pending: OidcPending): Promise<string> {
    const { document, keys } = await this.#discover();
    const idToken = await this.#exchange(document.token_endpoint, code, pending.codeVerifier);
    let payload: unknown;
    try {
      ({ payload } = await jwtVerify(idToken, keys, {
        issuer: document.issuer,
        audience: this.config.clientId,
        algorithms: ['RS256', 'ES256', 'EdDSA'],
        requiredClaims: ['exp', 'iat', 'sub'],
      }));
    } catch (error) {
      throw new AuthError({ message: 'OIDC ID token rejected', cause: error });
    }
    const claims = claimsSchema.safeParse(payload);
    if (!claims.success || claims.data.nonce !== pending.nonce) {
      throw new AuthError({ message: 'OIDC ID token claims rejected' });
    }
    return claims.data.email.toLowerCase();
  }

  async #exchange(tokenEndpoint: string, code: string, codeVerifier: string): Promise<string> {
    let body: unknown;
    try {
      const response = await this.fetchFn(tokenEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: this.config.redirectUri,
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
          code_verifier: codeVerifier,
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (response.status >= 500)
        throw new Error(`token endpoint returned ${String(response.status)}`);
      if (!response.ok)
        throw new AuthError({ message: `OIDC code rejected (${String(response.status)})` });
      body = await response.json();
    } catch (error) {
      if (error instanceof AuthError) throw error;
      throw new DependencyUnavailableError({ dependency: 'oidc', cause: error });
    }
    const parsed = tokenSchema.safeParse(body);
    if (!parsed.success) throw new AuthError({ message: 'OIDC token response has no ID token' });
    return parsed.data.id_token;
  }

  #discover(): Promise<{ document: Discovery; keys: JWTVerifyGetKey }> {
    this.#discovery ??= this.#load().catch((error: unknown) => {
      // Retry discovery on the next login rather than caching the failure.
      this.#discovery = undefined;
      throw error;
    });
    return this.#discovery;
  }

  async #load(): Promise<{ document: Discovery; keys: JWTVerifyGetKey }> {
    const url = new URL(
      '.well-known/openid-configuration',
      `${this.config.issuer.replace(/\/$/, '')}/`,
    );
    let parsed: Discovery;
    try {
      const response = await this.fetchFn(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!response.ok) throw new Error(`discovery returned ${String(response.status)}`);
      parsed = discoverySchema.parse(await response.json());
    } catch (error) {
      throw new DependencyUnavailableError({ dependency: 'oidc', cause: error });
    }
    if (parsed.issuer.replace(/\/$/, '') !== this.config.issuer.replace(/\/$/, '')) {
      throw new DependencyUnavailableError({ dependency: 'oidc', message: 'OIDC issuer mismatch' });
    }
    return { document: parsed, keys: createRemoteJWKSet(new URL(parsed.jwks_uri)) };
  }
}
