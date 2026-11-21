import { z } from 'zod';

import {
  authenticationResponseSchema,
  registrationResponseSchema,
} from '../passkeys/webauthn-schemas.js';
import { newPasswordSchema } from '../password/password-policy.js';
import { signupProfileSchema } from '../signup/signup-profile.js';
import { contactSchema } from '../users/contact.js';

/** An opaque 256-bit ticket or refresh token: 43 base64url characters. */
const opaqueToken = z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'malformed token');
const otpCode = z.string().regex(/^\d{6}$/, 'must be 6 digits');
/** A TOTP code or a recovery code (with or without its dash). */
const secondFactorCode = z.string().regex(/^(\d{6}|[A-Za-z0-9-]{10,11})$/, 'malformed code');

/** `POST /auth/signup` */
export const signupStartBody = z.object({
  contact: contactSchema,
  turnstileToken: z.string().min(1).max(2_048),
});

/** `POST /auth/otp/verify` and `POST /auth/contact/verify` */
export const otpVerifyBody = z.object({ challengeId: z.uuid(), code: otpCode });

/** `POST /auth/otp/resend` and `POST /auth/contact/resend` */
export const otpResendBody = z.object({ challengeId: z.uuid() });

/** `POST /auth/signup/passkey-options` */
export const signupPasskeyOptionsBody = z.object({
  signupTicket: opaqueToken,
  displayName: signupProfileSchema.shape.displayName,
});

/** `POST /auth/signup/complete` */
export const signupCompleteBody = z.object({
  signupTicket: opaqueToken,
  profile: signupProfileSchema,
  // Spec §5.1: the IDs from GET /legal/current that the player saw and accepted.
  acceptedDocumentIds: z.array(z.uuid()).min(1).max(10),
  credential: z.discriminatedUnion('type', [
    z.object({ type: z.literal('password'), password: newPasswordSchema }),
    z.object({ type: z.literal('passkey'), response: registrationResponseSchema }),
  ]),
});

/** `POST /auth/login`. The password is not policy-checked here: that would leak policy changes. */
export const loginBody = z.object({
  identifier: z.string().min(1).max(254),
  password: z.string().min(1).max(1_024),
});

/** `POST /auth/login/mfa` */
export const loginMfaBody = z.object({ mfaTicket: opaqueToken, code: secondFactorCode });

/** `POST /auth/passkey/login` */
export const passkeyLoginBody = z.object({
  challengeId: z.uuid(),
  response: authenticationResponseSchema,
});

/** `POST /auth/refresh` and `POST /auth/logout`. Native apps send the token; browsers use the cookie. */
export const refreshBody = z.object({ refreshToken: opaqueToken.optional() }).optional();

/** `POST /auth/2fa/totp/confirm` */
export const totpConfirmBody = z.object({ code: otpCode });

/** `POST /auth/passkeys` */
export const passkeyRegisterBody = z.object({ response: registrationResponseSchema });

/** `POST /auth/contact` */
export const contactChangeBody = z.object({ contact: contactSchema });
