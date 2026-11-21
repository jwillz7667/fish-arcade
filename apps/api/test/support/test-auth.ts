import { createPublicKey, generateKeyPairSync, randomBytes } from 'node:crypto';

import { BlindIndexer, FieldCipher, LocalKeyFileProvider } from '@reef/crypto-fields';
import { ErrorCode, ForbiddenError } from '@reef/errors';

import type { AuthDependencies } from '../../src/auth/auth-dependencies.js';
import type { BotVerifier } from '../../src/auth/bot/turnstile-verifier.js';
import type { Clock } from '../../src/shared/clock.js';
import type { MessageSender, OutboundMessage } from '../../src/auth/messaging/message-sender.js';
import type { BreachedPasswordChecker } from '../../src/auth/password/breached-password-checker.js';

/** A clock tests can move forward to cross expiry boundaries. */
export class TestClock implements Clock {
  #offsetMs = 0;

  now(): Date {
    return new Date(Date.now() + this.#offsetMs);
  }

  advance(ms: number): void {
    this.#offsetMs += ms;
  }
}

/** A message the API tried to send. */
export interface SentMessage extends OutboundMessage {
  readonly channel: 'email' | 'sms';
}

/** Captures email and SMS instead of delivering them. */
export class Outbox {
  readonly sent: SentMessage[] = [];

  sender(channel: 'email' | 'sms'): MessageSender {
    return {
      send: (message) => {
        this.sent.push({ ...message, channel });
        return Promise.resolve();
      },
    };
  }

  /** All messages to one address, oldest first. */
  to(address: string): SentMessage[] {
    return this.sent.filter((message) => message.to === address);
  }

  /** The code in the latest message to `address`. */
  latestCode(address: string): string {
    const code = /code is (\d{6})/.exec(this.to(address).at(-1)?.text ?? '')?.[1];
    if (code === undefined) throw new Error(`No code sent to ${address}`);
    return code;
  }
}

/** Turnstile double: the token `pass` passes, anything else fails. */
export const TEST_BOT_VERIFIER: BotVerifier = {
  verify: (token) =>
    token === 'pass'
      ? Promise.resolve()
      : Promise.reject(new ForbiddenError({ code: ErrorCode.BOT_CHECK_FAILED })),
};

/** HIBP double: only the listed passwords are breached. */
export class TestBreachChecker implements BreachedPasswordChecker {
  readonly breached = new Set<string>(['password1234', 'correct horse battery staple']);

  isBreached(password: string): Promise<boolean> {
    return Promise.resolve(this.breached.has(password));
  }
}

/** Auth dependencies with real keys and crypto, and doubles for the third-party providers. */
export interface TestAuth {
  readonly deps: AuthDependencies;
  readonly clock: TestClock;
  readonly outbox: Outbox;
}

/** @returns Fresh keys and doubles. Each app gets its own, so tests never share secrets. */
export function createTestAuth(): TestAuth {
  const { privateKey } = generateKeyPairSync('ed25519');
  const clock = new TestClock();
  const outbox = new Outbox();
  return {
    clock,
    outbox,
    deps: {
      keys: {
        signingKey: privateKey,
        verifyKey: createPublicKey(privateKey),
        keyId: 'test-1',
        hmacKey: randomBytes(32),
      },
      encryption: {
        cipher: new FieldCipher({ provider: new LocalKeyFileProvider(randomBytes(32)) }),
        blindIndexer: new BlindIndexer(randomBytes(32)),
      },
      senders: { email: outbox.sender('email'), sms: outbox.sender('sms') },
      botVerifier: TEST_BOT_VERIFIER,
      breachChecker: new TestBreachChecker(),
      clock,
    },
  };
}
