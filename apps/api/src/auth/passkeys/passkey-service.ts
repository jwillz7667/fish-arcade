import { randomUUID } from 'node:crypto';

import { AuthError, ConflictError, ErrorCode } from '@reef/errors';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import type { Redis } from 'ioredis';
import type { Pool } from 'pg';

import type { AuditWriter } from '../../audit/audit-writer.js';
import { isUniqueViolationOn, withTransaction } from '../../db/transaction.js';
import { AUTH_POLICY } from '../auth-policy.js';
import type { Clock } from '../clock.js';
import {
  passkeyRepository,
  PASSKEY_UNIQUE_CONSTRAINTS,
  type NewPasskey,
} from './passkey-repository.js';

/** Relying-party settings from WEBAUTHN_* env. */
export interface WebAuthnConfig {
  readonly rpId: string;
  readonly rpName: string;
  readonly origins: readonly string[];
}

/** Collaborators for {@link PasskeyService}. */
export interface PasskeyServiceDeps {
  readonly pool: Pool;
  readonly redis: Redis;
  readonly audit: AuditWriter;
  readonly clock: Clock;
  readonly config: WebAuthnConfig;
}

const TTL = AUTH_POLICY.webauthnChallengeTtlSeconds;
const registrationKey = (userId: string): string => `auth:v1:webauthn-reg:${userId}`;
const loginKey = (challengeId: string): string => `auth:v1:webauthn-login:${challengeId}`;

/**
 * Passkeys (playbook Step 6) with @simplewebauthn/server. User verification is required, so a
 * passkey login counts as multi-factor. Challenges live in Redis for 5 minutes and are spent on
 * first use.
 */
export class PasskeyService {
  constructor(private readonly deps: PasskeyServiceDeps) {}

  /**
   * @param input Account ID (as the WebAuthn user handle), a label for the passkey picker, and
   *   credentials to exclude so one authenticator is not registered twice.
   * @returns Options for `navigator.credentials.create()`.
   */
  async buildRegistrationOptions(input: {
    userId: string;
    userName: string;
    excludeCredentialIds?: readonly string[];
  }): Promise<PublicKeyCredentialCreationOptionsJSON> {
    return generateRegistrationOptions({
      rpName: this.deps.config.rpName,
      rpID: this.deps.config.rpId,
      userName: input.userName,
      userID: new TextEncoder().encode(input.userId),
      attestationType: 'none',
      timeout: TTL * 1000,
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      excludeCredentials: (input.excludeCredentialIds ?? []).map((id) => ({ id })),
    });
  }

  /**
   * @param response Browser response to the registration options.
   * @param expectedChallenge Challenge from those options.
   * @returns The credential to store.
   * @throws AuthError INVALID_CREDENTIALS when verification fails.
   */
  async verifyRegistration(
    response: RegistrationResponseJSON,
    expectedChallenge: string,
  ): Promise<NewPasskey> {
    let verification: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
    try {
      verification = await verifyRegistrationResponse({
        response,
        expectedChallenge,
        expectedOrigin: [...this.deps.config.origins],
        expectedRPID: this.deps.config.rpId,
        requireUserVerification: true,
      });
    } catch (error) {
      throw new AuthError({ code: ErrorCode.INVALID_CREDENTIALS, cause: error });
    }
    if (!verification.verified) throw new AuthError({ code: ErrorCode.INVALID_CREDENTIALS });
    const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
    return {
      credentialId: credential.id,
      publicKey: credential.publicKey,
      signCount: credential.counter,
      transports: credential.transports ?? [],
      deviceType: credentialDeviceType,
      isBackedUp: credentialBackedUp,
    };
  }

  /**
   * Starts adding a passkey to a signed-in account.
   *
   * @param userId Account to add it to.
   * @returns Options for `navigator.credentials.create()`.
   */
  async startRegistration(userId: string): Promise<PublicKeyCredentialCreationOptionsJSON> {
    const existing = await passkeyRepository.listCredentialIds(this.deps.pool, userId);
    const options = await this.buildRegistrationOptions({
      userId,
      userName: 'Reef account',
      excludeCredentialIds: existing,
    });
    await this.deps.redis.set(registrationKey(userId), options.challenge, 'EX', TTL);
    return options;
  }

  /**
   * Finishes adding a passkey to a signed-in account.
   *
   * @param input Account, browser response, and client IP.
   * @throws AuthError INVALID_CREDENTIALS when no registration is pending or it fails.
   * @throws ConflictError when the credential is already registered.
   */
  async finishRegistration(input: {
    userId: string;
    response: RegistrationResponseJSON;
    ip: string | null;
  }): Promise<void> {
    const challenge = await this.deps.redis.getdel(registrationKey(input.userId));
    if (challenge === null) throw new AuthError({ code: ErrorCode.INVALID_CREDENTIALS });
    const passkey = await this.verifyRegistration(input.response, challenge);
    await withTransaction(this.deps.pool, (client) =>
      this.savePasskey(client, input.userId, passkey, input.ip),
    );
  }

  /**
   * Stores a verified passkey and audits it. Runs inside the caller's transaction.
   *
   * @param client Transaction client.
   * @param userId Owner.
   * @param passkey Verified credential.
   * @param ip Client IP.
   * @throws ConflictError when the credential is already registered.
   */
  async savePasskey(
    client: Parameters<typeof passkeyRepository.insert>[0],
    userId: string,
    passkey: NewPasskey,
    ip: string | null,
  ): Promise<void> {
    let passkeyId: string;
    try {
      passkeyId = await passkeyRepository.insert(client, userId, passkey);
    } catch (error) {
      if (isUniqueViolationOn(error, PASSKEY_UNIQUE_CONSTRAINTS)) {
        throw new ConflictError({ message: 'Passkey already registered', cause: error });
      }
      throw error;
    }
    await this.deps.audit.record(
      {
        actorType: 'player',
        actorId: userId,
        action: 'auth.passkey.registered',
        targetType: 'passkey',
        targetId: passkeyId,
        ip,
      },
      client,
    );
  }

  /**
   * Starts a passkey login. No account is named, so the response reveals nothing about which
   * accounts exist (discoverable credentials).
   *
   * @returns A challenge ID and options for `navigator.credentials.get()`.
   */
  async startLogin(): Promise<{
    challengeId: string;
    options: PublicKeyCredentialRequestOptionsJSON;
  }> {
    const options = await generateAuthenticationOptions({
      rpID: this.deps.config.rpId,
      userVerification: 'required',
      timeout: TTL * 1000,
    });
    const challengeId = randomUUID();
    await this.deps.redis.set(loginKey(challengeId), options.challenge, 'EX', TTL);
    return { challengeId, options };
  }

  /**
   * Finishes a passkey login.
   *
   * @param input Challenge ID from {@link startLogin} and the browser response.
   * @returns The account the passkey belongs to.
   * @throws AuthError INVALID_CREDENTIALS when the challenge is unknown or spent, the
   *   credential is unknown, the signature fails, or the counter went backwards.
   */
  async finishLogin(input: {
    challengeId: string;
    response: AuthenticationResponseJSON;
  }): Promise<{ userId: string }> {
    const challenge = await this.deps.redis.getdel(loginKey(input.challengeId));
    const passkey =
      challenge === null
        ? undefined
        : await passkeyRepository.findByCredentialId(this.deps.pool, input.response.id);
    if (challenge === null || passkey === undefined) {
      throw new AuthError({ code: ErrorCode.INVALID_CREDENTIALS });
    }
    let newCounter: number;
    try {
      const verification = await verifyAuthenticationResponse({
        response: input.response,
        expectedChallenge: challenge,
        expectedOrigin: [...this.deps.config.origins],
        expectedRPID: this.deps.config.rpId,
        requireUserVerification: true,
        credential: {
          id: passkey.credentialId,
          publicKey: new Uint8Array(passkey.publicKey),
          counter: passkey.signCount,
          transports: [...passkey.transports],
        },
      });
      if (!verification.verified) throw new Error('Assertion not verified');
      newCounter = verification.authenticationInfo.newCounter;
    } catch (error) {
      throw new AuthError({ code: ErrorCode.INVALID_CREDENTIALS, cause: error });
    }
    const isAccepted = await passkeyRepository.recordUse(this.deps.pool, {
      id: passkey.id,
      signCount: newCounter,
      at: this.deps.clock.now(),
    });
    if (!isAccepted) throw new AuthError({ code: ErrorCode.INVALID_CREDENTIALS });
    return { userId: passkey.userId };
  }
}
