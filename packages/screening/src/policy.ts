import { isAtLeast } from './risk.js';
import type { ScreeningOutcome } from './verdict.js';

/** Severity of the AML alert an outcome opens. Matches the `AmlSeverity` database enum. */
export type AlertSeverity = 'low' | 'medium' | 'high' | 'critical';

/** An AML alert to open, named by the rule that fired. */
export interface ScreeningAlert {
  readonly rule: string;
  readonly severity: AlertSeverity;
}

/**
 * What to do with a confirmed deposit (spec §22.2, playbook Step 12).
 *
 * - `credit`: Gold Coins now, the SC bonus on its normal schedule.
 * - `hold_sc_bonus`: Gold Coins now; the SC bonus stays pending. `review` puts the deposit in
 *   the compliance queue; without it, the deposit is screened again until a verdict exists.
 * - `wait`: credit nothing yet and screen again. No sanctions list could be consulted.
 * - `freeze`: credit nothing, freeze the account.
 */
export type DepositDecision =
  | { readonly action: 'credit' }
  | { readonly action: 'hold_sc_bonus'; readonly review: boolean; readonly alert?: ScreeningAlert }
  | { readonly action: 'wait' }
  | { readonly action: 'freeze'; readonly alert: ScreeningAlert };

/**
 * What to do with a payout address before it is used (spec §22.3, playbook Step 12).
 *
 * - `allow`: usable once its other conditions (cooldown, verification) are met.
 * - `review`: unusable until Compliance approves it.
 * - `wait`: unusable for now; screen again. Payouts to it wait.
 * - `reject`: never usable. The player may add a different address.
 * - `reject_and_freeze`: never usable, and the account is frozen.
 */
export type PayoutAddressDecision =
  | { readonly action: 'allow' }
  | { readonly action: 'review'; readonly alert: ScreeningAlert }
  | { readonly action: 'wait' }
  | { readonly action: 'reject'; readonly alert: ScreeningAlert }
  | { readonly action: 'reject_and_freeze'; readonly alert: ScreeningAlert };

/**
 * Decides a deposit from its source screening.
 *
 * @param outcome Screening of the addresses that funded the deposit.
 * @returns The action. Fails closed: without a verdict nothing redeemable is released.
 */
export function decideDeposit(outcome: ScreeningOutcome): DepositDecision {
  if (outcome.status === 'unavailable') {
    // Gold Coins have no cash value, so a clean sanctions check is enough to credit them.
    return outcome.sanctionsChecked
      ? { action: 'hold_sc_bonus', review: false }
      : { action: 'wait' };
  }
  const { verdict } = outcome;
  if (verdict.sanctioned) {
    return {
      action: 'freeze',
      alert: { rule: 'chain_screening.deposit_sanctioned', severity: 'critical' },
    };
  }
  if (verdict.riskLevel === 'severe') {
    return {
      action: 'freeze',
      alert: { rule: 'chain_screening.deposit_severe_risk', severity: 'critical' },
    };
  }
  if (verdict.riskLevel === 'high') {
    return {
      action: 'hold_sc_bonus',
      review: true,
      alert: { rule: 'chain_screening.deposit_high_risk', severity: 'high' },
    };
  }
  return { action: 'credit' };
}

/**
 * Decides a payout address from its screening.
 *
 * @param outcome Screening of the address.
 * @returns The action. Fails closed: without a verdict the address is not used.
 */
export function decidePayoutAddress(outcome: ScreeningOutcome): PayoutAddressDecision {
  if (outcome.status === 'unavailable') return { action: 'wait' };
  const { verdict } = outcome;
  if (verdict.sanctioned) {
    return {
      action: 'reject_and_freeze',
      alert: { rule: 'chain_screening.payout_address_sanctioned', severity: 'critical' },
    };
  }
  // ADR 0007: severe goes further than the playbook's manual review. No reviewer should be
  // able to approve paying a darknet market or a ransomware wallet.
  if (verdict.riskLevel === 'severe') {
    return {
      action: 'reject',
      alert: { rule: 'chain_screening.payout_address_severe_risk', severity: 'high' },
    };
  }
  if (isAtLeast(verdict.riskLevel, 'medium')) {
    return {
      action: 'review',
      alert: { rule: 'chain_screening.payout_address_risk', severity: 'medium' },
    };
  }
  return { action: 'allow' };
}
