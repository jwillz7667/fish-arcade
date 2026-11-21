/** Back office roles (spec §13.1). Names match the seeded `roles` rows. */
export type AdminRole =
  | 'super_admin'
  | 'ops_manager'
  | 'support_agent'
  | 'compliance_officer'
  | 'finance'
  | 'game_ops'
  | 'affiliate_manager'
  | 'analyst';

/** Every permission an admin route can require. */
export const PERMISSIONS = [
  'players.read',
  'players.read_pii',
  'players.write',
  'balances.adjust_gc',
  'balances.adjust_sc',
  'kyc.review',
  'aml.read',
  'aml.write',
  'holds.release',
  'jurisdictions.read',
  'jurisdictions.write',
  'exclusions.write',
  'redemptions.approve',
  'reconciliation.read',
  'reports.read',
  'games.write',
  'promotions.write',
  'cms.write',
  'tickets.write',
  'round_logs.read',
  'affiliates.write',
  'commissions.approve',
  'approvals.read',
  'audit.read',
  'roles.manage',
] as const;

/** One permission. */
export type Permission = (typeof PERMISSIONS)[number];

/** Super Admin may hold the role only this many times (spec §13.1: two people max). */
export const MAX_SUPER_ADMINS = 2;

/**
 * What each role can do (spec §13.1). Super Admin holds everything, including role management.
 * The `.read` permissions for a role's own queues are listed explicitly; nothing is implied.
 */
function permissionsOf(role: AdminRole): readonly Permission[] {
  switch (role) {
    case 'super_admin':
      return PERMISSIONS;
    case 'ops_manager':
      return [
        'players.read',
        'players.read_pii',
        'players.write',
        'promotions.write',
        'cms.write',
        'reports.read',
        'approvals.read',
        'audit.read',
      ];
    case 'support_agent':
      // Spec §13.1: view players with PII masked, tickets, round logs, small GC goodwill credits.
      return ['players.read', 'tickets.write', 'round_logs.read', 'balances.adjust_gc'];
    case 'compliance_officer':
      return [
        'players.read',
        'players.read_pii',
        'kyc.review',
        'aml.read',
        'aml.write',
        'holds.release',
        'jurisdictions.read',
        'jurisdictions.write',
        'exclusions.write',
        'balances.adjust_sc',
        'approvals.read',
        'audit.read',
      ];
    case 'finance':
      return [
        'players.read',
        'redemptions.approve',
        'reconciliation.read',
        'reports.read',
        'balances.adjust_sc',
        'approvals.read',
      ];
    case 'game_ops':
      return ['games.write', 'reports.read'];
    case 'affiliate_manager':
      return ['affiliates.write', 'commissions.approve', 'reports.read'];
    case 'analyst':
      return ['reports.read'];
  }
}

const ROLES: readonly AdminRole[] = [
  'super_admin',
  'ops_manager',
  'support_agent',
  'compliance_officer',
  'finance',
  'game_ops',
  'affiliate_manager',
  'analyst',
];

/**
 * @param value A role name from the database or a request.
 * @returns Whether it names a known role.
 */
export function isAdminRole(value: string): value is AdminRole {
  return (ROLES as readonly string[]).includes(value);
}

/**
 * @param roles The admin's roles. Unknown names grant nothing.
 * @returns The union of their permissions.
 */
export function permissionsFor(roles: readonly string[]): ReadonlySet<Permission> {
  return new Set(roles.filter(isAdminRole).flatMap((role) => permissionsOf(role)));
}
