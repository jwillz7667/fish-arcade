import type { GatedContext } from '../jurisdictions/jurisdiction-policy.js';

/** What the client sent for a location check. */
export interface GeoCheckInput {
  readonly context: GatedContext;
  /** Opaque payload from the vendor's device SDK. */
  readonly devicePayload: string;
  /** Client IP as seen by the API. */
  readonly ip: string;
  /** Request headers, for providers that read device hints from them. */
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
}

/** Where the provider places the device. */
export interface GeoLocation {
  /** Two-letter US state code, or null when the device is outside the US or unplaceable. */
  readonly stateCode: string | null;
  /** 0 to 1: how sure the provider is. */
  readonly confidence: number;
  /** VPN, proxy, or other location masking detected. */
  readonly vpnDetected: boolean;
  readonly lat: number | null;
  readonly lng: number | null;
}

/**
 * A geolocation vendor (spec §15: GeoComply, Radar, or MaxMind + IPQS). Implementations throw
 * on any failure; the caller treats a throw or a timeout as "location unknown" and blocks.
 */
export interface GeoProvider {
  /**
   * @param input Device payload, context, IP, and headers.
   * @returns The device's location.
   */
  check(input: GeoCheckInput): Promise<GeoLocation>;
}
