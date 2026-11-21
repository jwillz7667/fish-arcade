import { isTurnstileTestSecret, type ApiEnv } from '@reef/config';
import { createFieldEncryption, type FieldEncryption } from '@reef/crypto-fields';

import { TurnstileVerifier, type BotVerifier } from './bot/turnstile-verifier.js';
import { systemClock, type Clock } from '../shared/clock.js';
import { loadAuthKeys, type AuthKeys } from './crypto/auth-keys.js';
import { MailpitEmailSender, MailpitSmsSender } from './messaging/mailpit-sender.js';
import type { MessageSenders } from './messaging/message-sender.js';
import {
  DisabledBreachedPasswordChecker,
  HibpBreachedPasswordChecker,
  type BreachedPasswordChecker,
} from './password/breached-password-checker.js';

/**
 * Keys and external providers player auth is built from. Production builds them from env with
 * {@link createAuthDependencies}; tests pass doubles for the third-party providers.
 */
export interface AuthDependencies {
  readonly keys: AuthKeys;
  readonly encryption: FieldEncryption;
  readonly senders: MessageSenders;
  readonly botVerifier: BotVerifier;
  readonly breachChecker: BreachedPasswordChecker;
  readonly clock: Clock;
}

/**
 * @param env Parsed API env.
 * @returns Auth dependencies backed by the configured providers.
 * @throws ConfigError when a key is missing or malformed.
 */
export async function createAuthDependencies(env: ApiEnv): Promise<AuthDependencies> {
  const [keys, encryption] = await Promise.all([loadAuthKeys(env), createFieldEncryption(env)]);
  // EMAIL_PROVIDER and SMS_PROVIDER only accept `mailpit` so far, which config rejects in
  // production; vendor adapters slot in here.
  const mailpit = { baseUrl: env.MAILPIT_URL, from: env.EMAIL_FROM };
  return {
    keys,
    encryption,
    senders: { email: new MailpitEmailSender(mailpit), sms: new MailpitSmsSender(mailpit) },
    botVerifier: new TurnstileVerifier(env.TURNSTILE_SECRET_KEY, {
      // The signup widget runs on the player web app, the same origins passkeys are bound to.
      expectedHostnames: env.WEBAUTHN_ORIGINS.map((origin) => new URL(origin).hostname),
      isTestSecret: isTurnstileTestSecret(env.TURNSTILE_SECRET_KEY),
    }),
    breachChecker: env.HIBP_ENABLED
      ? new HibpBreachedPasswordChecker()
      : new DisabledBreachedPasswordChecker(),
    clock: systemClock,
  };
}
