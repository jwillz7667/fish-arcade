import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Loads the repository's root .env when present. Real environment variables still win. */
export function loadRootEnv(): void {
  const file = fileURLToPath(new URL('../../../.env', import.meta.url));
  if (existsSync(file)) process.loadEnvFile(file);
}
