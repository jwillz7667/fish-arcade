import { describe, expect, it } from 'vitest';

import { decideDeposit, decidePayoutAddress } from './policy.js';
import type { RiskLevel } from './risk.js';
import type { ScreeningOutcome } from './verdict.js';

const screened = (riskLevel: RiskLevel, sanctioned = false): ScreeningOutcome => ({
  status: 'screened',
  verdict: { riskLevel, sanctioned, categories: [], provider: 'trm_labs' },
});

const unavailable = (sanctionsChecked: boolean): ScreeningOutcome => ({
  status: 'unavailable',
  reason: 'vendor down',
  sanctionsChecked,
});

describe('decideDeposit (spec §22.2, playbook Step 12)', () => {
  it.each<[string, ScreeningOutcome, ReturnType<typeof decideDeposit>]>([
    ['a low-risk source', screened('low'), { action: 'credit' }],
    ['a medium-risk source', screened('medium'), { action: 'credit' }],
    [
      'a high-risk source: GC now, SC bonus held for review',
      screened('high'),
      {
        action: 'hold_sc_bonus',
        review: true,
        alert: { rule: 'chain_screening.deposit_high_risk', severity: 'high' },
      },
    ],
    [
      'a severe-risk source: freeze, credit nothing',
      screened('severe'),
      {
        action: 'freeze',
        alert: { rule: 'chain_screening.deposit_severe_risk', severity: 'critical' },
      },
    ],
    [
      'a sanctioned source: freeze, credit nothing',
      screened('low', true),
      {
        action: 'freeze',
        alert: { rule: 'chain_screening.deposit_sanctioned', severity: 'critical' },
      },
    ],
    [
      'the vendor down but sanctions clean: GC now, SC bonus held until screened',
      unavailable(true),
      { action: 'hold_sc_bonus', review: false },
    ],
    ['no sanctions check possible: credit nothing yet', unavailable(false), { action: 'wait' }],
  ])('%s', (_label, outcome, expected) => {
    expect(decideDeposit(outcome)).toEqual(expected);
  });
});

describe('decidePayoutAddress (spec §22.3, playbook Step 12)', () => {
  it.each<[string, ScreeningOutcome, ReturnType<typeof decidePayoutAddress>]>([
    ['a low-risk address', screened('low'), { action: 'allow' }],
    [
      'a medium-risk address: manual review',
      screened('medium'),
      {
        action: 'review',
        alert: { rule: 'chain_screening.payout_address_risk', severity: 'medium' },
      },
    ],
    [
      'a high-risk address: manual review',
      screened('high'),
      {
        action: 'review',
        alert: { rule: 'chain_screening.payout_address_risk', severity: 'medium' },
      },
    ],
    [
      'a severe-risk address: rejected',
      screened('severe'),
      {
        action: 'reject',
        alert: { rule: 'chain_screening.payout_address_severe_risk', severity: 'high' },
      },
    ],
    [
      'a sanctioned address: rejected and the account frozen',
      screened('severe', true),
      {
        action: 'reject_and_freeze',
        alert: { rule: 'chain_screening.payout_address_sanctioned', severity: 'critical' },
      },
    ],
    ['screening down, even with sanctions clean: wait', unavailable(true), { action: 'wait' }],
    ['screening fully down: wait', unavailable(false), { action: 'wait' }],
  ])('%s', (_label, outcome, expected) => {
    expect(decidePayoutAddress(outcome)).toEqual(expected);
  });
});
