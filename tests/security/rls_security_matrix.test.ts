// ==============================================================================
// Security Test Suite: Multi-Tenant RLS Policy Evaluation & Threat Matrix
// ==============================================================================

import { describe, it, expect } from 'vitest';

export type AppRole = 'owner' | 'admin' | 'member' | 'auditor' | 'readonly';

export interface SecurityUserContext {
  userId: string;
  role: 'anon' | 'authenticated' | 'service_role';
  memberships: { orgId: string; role: AppRole; isActive: boolean }[];
}

export interface SecurityRow {
  id: string;
  orgId: string;
  vaultId?: string;
  createdBy?: string;
  deletedAt?: string | null;
}

/**
 * Functional reference implementation of PostgreSQL RLS Evaluation Engine.
 * Evaluates the exact SQL predicate logic from 20261027000003_hardened_rls_policies.sql.
 */
export class RlsPolicyEvaluationEngine {
  /**
   * Helper: public.user_has_org_role(target_org_id, required_roles)
   */
  public static userHasOrgRole(ctx: SecurityUserContext, targetOrgId: string, requiredRoles: AppRole[]): boolean {
    if (ctx.role === 'service_role') return true;
    if (ctx.role !== 'authenticated') return false;

    return ctx.memberships.some(
      (m) => m.orgId === targetOrgId && m.isActive && requiredRoles.includes(m.role)
    );
  }

  /**
   * Helper: public.get_user_org_ids()
   */
  public static getUserOrgIds(ctx: SecurityUserContext): string[] {
    if (ctx.role === 'service_role') return ['*'];
    if (ctx.role !== 'authenticated') return [];
    return ctx.memberships.filter((m) => m.isActive).map((m) => m.orgId);
  }

  /**
   * Policy: vault_objects_select_policy
   * USING: org_id IN (SELECT org_id FROM get_user_org_ids())
   *   AND (deleted_at IS NULL OR user_has_org_role(org_id, ARRAY['owner', 'admin', 'auditor']))
   */
  public static canSelectVaultObject(ctx: SecurityUserContext, row: SecurityRow): boolean {
    if (ctx.role === 'service_role') return true;
    if (ctx.role !== 'authenticated') return false;

    const allowedOrgs = this.getUserOrgIds(ctx);
    if (!allowedOrgs.includes(row.orgId)) return false;

    if (row.deletedAt) {
      return this.userHasOrgRole(ctx, row.orgId, ['owner', 'admin', 'auditor']);
    }
    return true;
  }

  /**
   * Policy: vault_objects_insert_policy
   * WITH CHECK: user_has_org_role(org_id, ARRAY['owner', 'admin', 'member'])
   *   AND created_by = current_user_id() (no null bypass!)
   */
  public static canInsertVaultObject(ctx: SecurityUserContext, row: SecurityRow): boolean {
    if (ctx.role === 'service_role') return true;
    if (ctx.role !== 'authenticated') return false;

    const hasRole = this.userHasOrgRole(ctx, row.orgId, ['owner', 'admin', 'member']);
    const validAttribution = Boolean(row.createdBy && row.createdBy === ctx.userId);

    return hasRole && validAttribution;
  }

  /**
   * Policy: vault_objects_delete_policy
   * USING: user_has_org_role(org_id, ARRAY['owner', 'admin'])
   */
  public static canDeleteVaultObject(ctx: SecurityUserContext, row: SecurityRow): boolean {
    if (ctx.role === 'service_role') return true;
    if (ctx.role !== 'authenticated') return false;

    return this.userHasOrgRole(ctx, row.orgId, ['owner', 'admin']);
  }
}

describe('Multi-Tenant RLS Security Matrix', () => {
  const alice: SecurityUserContext = {
    userId: 'd0000000-0000-0000-0000-000000000001',
    role: 'authenticated',
    memberships: [
      { orgId: 'org_acme', role: 'owner', isActive: true },
      { orgId: 'org_healthwave', role: 'admin', isActive: true },
    ],
  };

  const bob: SecurityUserContext = {
    userId: 'd0000000-0000-0000-0000-000000000002',
    role: 'authenticated',
    memberships: [{ orgId: 'org_acme', role: 'member', isActive: true }],
  };

  const mallory: SecurityUserContext = {
    userId: 'd0000000-0000-0000-0000-000000000004',
    role: 'authenticated',
    memberships: [{ orgId: 'org_apex', role: 'member', isActive: true }],
  };

  const anonUser: SecurityUserContext = {
    userId: '',
    role: 'anon',
    memberships: [],
  };

  const acmeObject: SecurityRow = {
    id: 'obj_acme_1',
    orgId: 'org_acme',
    vaultId: 'vault_prod',
    createdBy: alice.userId,
    deletedAt: null,
  };

  it('blocks anonymous access completely from reading vault objects', () => {
    expect(RlsPolicyEvaluationEngine.canSelectVaultObject(anonUser, acmeObject)).toBe(false);
  });

  it('allows authenticated tenant member (Bob) to read Acme objects', () => {
    expect(RlsPolicyEvaluationEngine.canSelectVaultObject(bob, acmeObject)).toBe(true);
  });

  it('strictly blocks cross-tenant read from external attacker (Mallory -> Acme)', () => {
    expect(RlsPolicyEvaluationEngine.canSelectVaultObject(mallory, acmeObject)).toBe(false);
  });

  it('blocks cross-tenant write injection from external attacker (Mallory -> Acme)', () => {
    const maliciousInsert: SecurityRow = {
      id: 'obj_malicious',
      orgId: 'org_acme',
      createdBy: mallory.userId,
    };
    expect(RlsPolicyEvaluationEngine.canInsertVaultObject(mallory, maliciousInsert)).toBe(false);
  });

  it('blocks insert with spoofed attribution or null created_by', () => {
    const nullAttributionInsert: SecurityRow = {
      id: 'obj_spoof',
      orgId: 'org_acme',
      createdBy: undefined, // null / missing
    };
    expect(RlsPolicyEvaluationEngine.canInsertVaultObject(bob, nullAttributionInsert)).toBe(false);

    const spoofedInsert: SecurityRow = {
      id: 'obj_spoof_2',
      orgId: 'org_acme',
      createdBy: alice.userId, // Bob claiming to be Alice!
    };
    expect(RlsPolicyEvaluationEngine.canInsertVaultObject(bob, spoofedInsert)).toBe(false);
  });

  it('enforces role boundaries on delete (members cannot delete; owners/admins can)', () => {
    // Bob is only a 'member' of Acme -> delete forbidden
    expect(RlsPolicyEvaluationEngine.canDeleteVaultObject(bob, acmeObject)).toBe(false);

    // Alice is 'owner' of Acme -> delete allowed
    expect(RlsPolicyEvaluationEngine.canDeleteVaultObject(alice, acmeObject)).toBe(true);
  });

  it('hides soft-deleted objects from regular members but exposes them to compliance auditors/admins', () => {
    const deletedObject: SecurityRow = {
      ...acmeObject,
      deletedAt: new Date().toISOString(),
    };

    // Bob (regular member) cannot see soft-deleted objects
    expect(RlsPolicyEvaluationEngine.canSelectVaultObject(bob, deletedObject)).toBe(false);

    // Alice (owner/admin) can inspect soft-deleted objects for audit trails
    expect(RlsPolicyEvaluationEngine.canSelectVaultObject(alice, deletedObject)).toBe(true);
  });
});
