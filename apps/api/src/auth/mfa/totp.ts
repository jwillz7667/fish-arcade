import { generateSecret, generateURI, verify } from 'otplib';

/** RFC 6238 defaults that every authenticator app supports: SHA-1, 6 digits, 30 seconds. */
const PERIOD_SECONDS = 30;
// Accept the previous step too, for slow typing and clock drift; never future codes.
const TOLERANCE_SECONDS: [number, number] = [PERIOD_SECONDS, 0];

/** @returns A new base32 TOTP secret (160 bits, from otplib's crypto plugin). */
export function generateTotpSecret(): string {
  return generateSecret();
}

/**
 * @param secret Base32 secret.
 * @param accountLabel Label shown in the authenticator app.
 * @returns `otpauth://` URI for a QR code.
 */
export function totpUri(secret: string, accountLabel: string): string {
  return generateURI({ issuer: 'Reef', label: accountLabel, secret, period: PERIOD_SECONDS });
}

/**
 * Checks a TOTP code and refuses replays.
 *
 * @param input Secret, code, the highest time step accepted before (or null), and the time.
 * @returns The time step the code belongs to, or undefined when it is wrong or replayed.
 */
export async function verifyTotp(input: {
  secret: string;
  code: string;
  lastTimeStep: number | null;
  now: Date;
}): Promise<number | undefined> {
  const result = await verify({
    secret: input.secret,
    token: input.code,
    period: PERIOD_SECONDS,
    epoch: Math.floor(input.now.getTime() / 1000),
    epochTolerance: TOLERANCE_SECONDS,
    ...(input.lastTimeStep === null ? {} : { afterTimeStep: input.lastTimeStep }),
  });
  // TOTP results carry the matched time step; HOTP results (never produced here) do not.
  return result.valid && 'timeStep' in result ? result.timeStep : undefined;
}
