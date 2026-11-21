import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import { z } from 'zod';

// exactOptional: absent keys stay absent, matching the library types under
// exactOptionalPropertyTypes.
const base64url = z
  .string()
  .regex(/^[A-Za-z0-9_-]+$/)
  .max(16_384);

const credentialFields = {
  id: base64url.max(1_024),
  rawId: base64url.max(1_024),
  type: z.literal('public-key'),
  authenticatorAttachment: z.enum(['platform', 'cross-platform']).exactOptional(),
  // Reef requests no extensions, so their outputs are dropped rather than trusted.
  clientExtensionResults: z
    .object({})
    .loose()
    .transform(() => ({})),
};

/** Body schema for a WebAuthn registration response (`credential.toJSON()` in the browser). */
export const registrationResponseSchema: z.ZodType<RegistrationResponseJSON> = z.object({
  ...credentialFields,
  response: z.object({
    clientDataJSON: base64url,
    attestationObject: base64url,
    authenticatorData: base64url.exactOptional(),
    transports: z.array(z.string().max(32)).max(8).exactOptional(),
    publicKeyAlgorithm: z.number().int().exactOptional(),
    publicKey: base64url.exactOptional(),
  }),
});

/** Body schema for a WebAuthn authentication response. */
export const authenticationResponseSchema: z.ZodType<AuthenticationResponseJSON> = z.object({
  ...credentialFields,
  response: z.object({
    clientDataJSON: base64url,
    authenticatorData: base64url,
    signature: base64url,
    userHandle: base64url.exactOptional(),
  }),
});
