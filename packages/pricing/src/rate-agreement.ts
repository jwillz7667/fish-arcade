import { DependencyUnavailableError } from '@reef/errors';
import type { CentsPerBtc } from '@reef/money';

import { MAX_SPREAD_BPS } from './aggregate.js';

/**
 * Checks that BTCPay priced an invoice at a rate within 1% of the oracle's (playbook Step 11:
 * the store's rate source matches the oracle). BTCPay converts USD invoices with its own rate
 * source, so a stuck or bad feed there must not set what players pay.
 *
 * @param invoiceRate The rate BTCPay used for the invoice.
 * @param oracleRate The oracle's rate at the same moment.
 * @throws DependencyUnavailableError (dependency `price_oracle`) when they differ by more than 1%.
 */
export function assertRatesAgree(invoiceRate: CentsPerBtc, oracleRate: CentsPerBtc): void {
  const difference = invoiceRate > oracleRate ? invoiceRate - oracleRate : oracleRate - invoiceRate;
  if (difference * 10_000n > oracleRate * MAX_SPREAD_BPS) {
    throw new DependencyUnavailableError({
      dependency: 'price_oracle',
      message: `BTCPay rate ${invoiceRate.toString()} differs from the oracle rate ${oracleRate.toString()} by more than 1%`,
    });
  }
}
