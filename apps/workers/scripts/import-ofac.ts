// Runs one OFAC import now, outside the daily schedule. With --accept-shrink it imports a list
// that lost over half its Bitcoin addresses, which the job refuses on its own. Use it only after
// confirming the delisting on OFAC's recent actions page.
import { formatConfigError, loadEnv, workersEnvSchema } from '@reef/config';
import { ConfigError } from '@reef/errors';
import { parseSdnBitcoinAddresses } from '@reef/screening';
import pg from 'pg';

import { downloadSdnList, OfacImporter } from '../src/ofac/index.js';

try {
  const env = loadEnv(workersEnvSchema);
  const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 1 });
  try {
    const { xml, sha256 } = await downloadSdnList(env.OFAC_SDN_URL);
    const list = parseSdnBitcoinAddresses(xml);
    const result = await new OfacImporter(pool).apply(list, sha256, {
      acceptShrink: process.argv.includes('--accept-shrink'),
    });
    process.stdout.write(
      `${result.status} ${result.listVersion}: ${String(list.addresses.length)} addresses, ` +
        `${String(list.rejected.length)} entries rejected\n`,
    );
  } finally {
    await pool.end();
  }
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  process.stderr.write(formatConfigError(error));
  process.exitCode = 1;
}
