/** Operating mode per state (spec §4.1): S social, P promotional sweepstakes, X blocked. */
export type JurisdictionMode = 'S' | 'P' | 'X';

/** Actions gated by location (playbook Step 7). Matches the `GeoContext` enum subset. */
export type GatedContext = 'signup' | 'purchase' | 'play_sc' | 'redeem';

/** The gated contexts, for request validation. */
export const GATED_CONTEXTS = ['signup', 'purchase', 'play_sc', 'redeem'] as const;

/** The rule in force for one state, from the `jurisdictions` table. */
export interface JurisdictionRule {
  readonly stateCode: string;
  readonly mode: JurisdictionMode;
  readonly minAge: number;
  readonly scRedemptionEnabled: boolean;
  readonly fishGamesEnabled: boolean;
  readonly effectiveFrom: Date;
}

/** Why an action was refused. Shown to clients so they can explain the block. */
export type BlockReason =
  | 'unknown_state'
  | 'state_blocked'
  | 'mode_not_permitted'
  | 'redemption_disabled'
  | 'vpn_detected'
  | 'location_unavailable'
  | 'low_confidence';

/** Outcome of applying a jurisdiction rule to an action. */
export type JurisdictionDecision =
  { readonly isAllowed: true } | { readonly isAllowed: false; readonly reason: BlockReason };

const ALLOW: JurisdictionDecision = { isAllowed: true };
const block = (reason: BlockReason): JurisdictionDecision => ({ isAllowed: false, reason });

/**
 * Applies spec §4.1 to one action. A state with no rule is blocked: the table is an allowlist.
 *
 * - X: nothing is allowed.
 * - S: signup and Gold Coin purchases only.
 * - P: everything; redemption also needs `sc_redemption_enabled`.
 *
 * @param context The action being attempted.
 * @param rule The state's rule in force, or undefined when the state has none.
 * @returns Whether the action is allowed, and why not.
 */
export function decideJurisdiction(
  context: GatedContext,
  rule: JurisdictionRule | undefined,
): JurisdictionDecision {
  if (rule === undefined) return block('unknown_state');
  if (rule.mode === 'X') return block('state_blocked');
  switch (context) {
    case 'signup':
    case 'purchase':
      return ALLOW;
    case 'play_sc':
      return rule.mode === 'P' ? ALLOW : block('mode_not_permitted');
    case 'redeem':
      if (rule.mode !== 'P') return block('mode_not_permitted');
      return rule.scRedemptionEnabled ? ALLOW : block('redemption_disabled');
  }
}
