/** Risk levels, lowest first. Matches the `RiskLevel` database enum. */
export const RISK_LEVELS = ['low', 'medium', 'high', 'severe'] as const;

/** How risky an address or its funds are (spec §15). */
export type RiskLevel = (typeof RISK_LEVELS)[number];

/**
 * @param level A level.
 * @param floor The level to compare against.
 * @returns True when `level` is `floor` or riskier.
 */
export function isAtLeast(level: RiskLevel, floor: RiskLevel): boolean {
  return RISK_LEVELS.indexOf(level) >= RISK_LEVELS.indexOf(floor);
}

/**
 * @param levels Any number of levels.
 * @returns The riskiest of them, or `low` when there are none.
 */
export function highestRisk(levels: Iterable<RiskLevel>): RiskLevel {
  let highest: RiskLevel = 'low';
  for (const level of levels) if (isAtLeast(level, highest)) highest = level;
  return highest;
}
