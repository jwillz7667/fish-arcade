import {
  decideJurisdiction,
  type BlockReason,
  type GatedContext,
  type JurisdictionDecision,
  type JurisdictionRule,
} from '../jurisdictions/jurisdiction-policy.js';
import type { GeoLocation } from './geo-provider.js';

/**
 * Checks that a reported location can be trusted before any state rule applies (spec §15: IP
 * alone is not enough; VPNs and proxies block).
 *
 * @param location What the provider reported.
 * @param minConfidence GEO_MIN_CONFIDENCE.
 * @returns Why the location is unusable, or undefined when it can be used.
 */
export function locationProblem(
  location: GeoLocation,
  minConfidence: number,
): BlockReason | undefined {
  if (location.vpnDetected) return 'vpn_detected';
  if (location.confidence < minConfidence) return 'low_confidence';
  if (location.stateCode === null) return 'location_unavailable';
  return undefined;
}

/**
 * Full decision for one check: location trust first, then the state's rule.
 *
 * @param input Context, location, the located state's rule, and the confidence threshold.
 * @returns Allowed, or blocked with a reason.
 */
export function decideLocation(input: {
  context: GatedContext;
  location: GeoLocation;
  rule: JurisdictionRule | undefined;
  minConfidence: number;
}): JurisdictionDecision {
  const problem = locationProblem(input.location, input.minConfidence);
  if (problem !== undefined) return { isAllowed: false, reason: problem };
  return decideJurisdiction(input.context, input.rule);
}
