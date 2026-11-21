import { z } from 'zod';

/**
 * Comma-separated CORS origins. Playbook Step 5: an explicit allowlist, never a wildcard.
 */
export const corsOriginsSchema = z
  .string()
  .transform((value) =>
    value
      .split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0),
  )
  .pipe(
    z
      .array(
        z.url({ protocol: /^https?$/ }).refine(
          // Zod runs refinements even after the URL check fails, so guard the parse.
          (origin) => URL.canParse(origin) && new URL(origin).origin === origin,
          'must be a bare origin',
        ),
      )
      .min(1),
  );
