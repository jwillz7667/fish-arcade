/** KYC check levels (spec §5.1): light at signup, full before first redemption. */
export type KycLevel = 'light' | 'full';

/** KYC check statuses. Matches the `KycStatus` enum. */
export type KycStatus = 'pending' | 'passed' | 'failed' | 'review' | 'sanctions_hit';

/**
 * Allowed status changes. `passed → sanctions_hit` covers ongoing list screening (spec §15:
 * sanctions and PEP at KYC and on list updates). `failed` and `sanctions_hit` are final here;
 * clearing them is an admin decision (Step 9). The player starts a new check after `failed`.
 */
function allowedFrom(status: KycStatus): readonly KycStatus[] {
  switch (status) {
    case 'pending':
      return ['passed', 'failed', 'review', 'sanctions_hit'];
    case 'review':
      return ['passed', 'failed', 'sanctions_hit'];
    case 'passed':
      return ['sanctions_hit'];
    case 'failed':
    case 'sanctions_hit':
      return [];
  }
}

/** What to do with a status the provider reports. */
export type KycTransition =
  | { readonly kind: 'apply'; readonly to: KycStatus }
  | { readonly kind: 'unchanged' }
  | { readonly kind: 'rejected' };

/**
 * @param current Status stored for the check.
 * @param reported Status the provider reports now.
 * @returns Apply, ignore (same status), or reject (not an allowed change).
 */
export function kycTransition(current: KycStatus, reported: KycStatus): KycTransition {
  if (current === reported) return { kind: 'unchanged' };
  return allowedFrom(current).includes(reported)
    ? { kind: 'apply', to: reported }
    : { kind: 'rejected' };
}

/**
 * @param required Level the action needs.
 * @returns Levels that satisfy it: a full check also satisfies a light requirement.
 */
export function levelsSatisfying(required: KycLevel): readonly KycLevel[] {
  return required === 'light' ? ['light', 'full'] : ['full'];
}
