/** Source of the current time. Injected so expiry rules can be tested without waiting. */
export interface Clock {
  /** @returns The current time. */
  now(): Date;
}

/** The real clock. */
export const systemClock: Clock = { now: () => new Date() };

/**
 * @param from Start time.
 * @param ms Milliseconds to add.
 * @returns A new Date `ms` after `from`.
 */
export function addMs(from: Date, ms: number): Date {
  return new Date(from.getTime() + ms);
}
