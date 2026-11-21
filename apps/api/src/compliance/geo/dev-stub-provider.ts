import { setTimeout as delay } from 'node:timers/promises';

import type { GeoCheckInput, GeoLocation, GeoProvider } from './geo-provider.js';

const STATE = /^[A-Z]{2}$/;
const CONFIDENCE_FLAG = 'confidence=';
const CONFIDENCE_VALUE = /^[0-9.]{1,8}$/;
// Long enough to trip any configured provider timeout.
const HANG_MS = 30_000;

function parseConfidence(flag: string): number | undefined {
  if (!flag.startsWith(CONFIDENCE_FLAG)) return undefined;
  const value = flag.slice(CONFIDENCE_FLAG.length);
  if (!CONFIDENCE_VALUE.test(value)) return undefined;
  const confidence = Number(value);
  return Number.isFinite(confidence) && confidence >= 0 && confidence <= 1 ? confidence : undefined;
}

/**
 * Development geolocation (playbook Step 7). The `X-Reef-Dev-Geo` header says where the device
 * is, with optional flags separated by `;`:
 *
 * - `NV` places the device in Nevada with full confidence.
 * - `NV;vpn` reports a VPN.
 * - `NV;confidence=0.5` reports low confidence.
 * - `abroad` places the device outside the US.
 * - `error` fails like a vendor outage; `timeout` never answers.
 *
 * No header, or anything else, is an error, so a forgotten header fails closed. Config rejects
 * this provider in production.
 */
export class DevStubGeoProvider implements GeoProvider {
  /**
   * @param input The check; only the header is read.
   * @returns The location the header describes.
   * @throws Error for `error`, a missing header, or a malformed one.
   */
  async check(input: GeoCheckInput): Promise<GeoLocation> {
    const header = input.headers['x-reef-dev-geo'];
    const [place = '', ...flags] = (typeof header === 'string' ? header : '').split(';');
    // Unref'd, so a hung check never keeps the process alive.
    if (place === 'timeout') await delay(HANG_MS, undefined, { ref: false });
    if (place !== 'abroad' && !STATE.test(place)) {
      throw new Error('Dev geo stub: no usable X-Reef-Dev-Geo header');
    }
    let confidence = 1;
    let vpnDetected = false;
    for (const flag of flags) {
      const parsed = parseConfidence(flag);
      if (flag === 'vpn') vpnDetected = true;
      else if (parsed !== undefined) confidence = parsed;
      else throw new Error('Dev geo stub: unknown flag');
    }
    return {
      stateCode: place === 'abroad' ? null : place,
      confidence,
      vpnDetected,
      lat: null,
      lng: null,
    };
  }
}
