import type {
  CapabilityAuthorization,
  CapabilityAuthorizer,
  CapabilityGrant,
  CapabilityRequest,
} from "./types";

/**
 * Small deterministic authorizer suitable for local orchestration and tests.
 * Production deployments can inject an adapter backed by signed, durable
 * capability tokens without changing the orchestrator.
 */
export class InMemoryCapabilityAuthorizer implements CapabilityAuthorizer {
  private readonly grants = new Map<string, Readonly<CapabilityGrant>>();

  addGrant(grant: CapabilityGrant): void {
    if (!grant.id || !grant.subjectId) {
      throw new Error("Capability grant id and subject are required");
    }
    if (
      !Number.isFinite(grant.issuedAt) ||
      !Number.isFinite(grant.expiresAt) ||
      grant.expiresAt <= grant.issuedAt
    ) {
      throw new Error(`Capability grant ${grant.id} has an invalid lifetime`);
    }
    if (this.grants.has(grant.id)) {
      throw new Error(`Capability grant ${grant.id} already exists`);
    }
    this.grants.set(
      grant.id,
      Object.freeze({
        ...grant,
        capabilities: Object.freeze([...grant.capabilities]),
        scopes: Object.freeze([...grant.scopes]),
      }),
    );
  }

  revokeGrant(grantId: string): boolean {
    const grant = this.grants.get(grantId);
    if (!grant || grant.revoked) return false;
    this.grants.set(grantId, Object.freeze({ ...grant, revoked: true }));
    return true;
  }

  authorize(request: CapabilityRequest): CapabilityAuthorization {
    const candidates = [...this.grants.values()]
      .filter((grant) => grant.subjectId === request.subjectId)
      .sort((left, right) => left.id.localeCompare(right.id));

    for (const grant of candidates) {
      if (grant.revoked) continue;
      if (request.at < grant.issuedAt || request.at >= grant.expiresAt) continue;
      if (
        !grant.capabilities.includes("*") &&
        !grant.capabilities.includes(request.capability)
      ) {
        continue;
      }
      if (!grant.scopes.some((scope) => targetMatches(scope, request.target))) {
        continue;
      }
      return { authorized: true, grantId: grant.id };
    }

    return {
      authorized: false,
      reason: `No active ${request.capability} grant for ${request.subjectId} on ${request.target}`,
    };
  }
}

/** The safe default when no capability service is configured. */
export const denyAllCapabilities: CapabilityAuthorizer = Object.freeze({
  authorize: (request: CapabilityRequest): CapabilityAuthorization => ({
    authorized: false,
    reason: `Capability service not configured (${request.capability} denied)`,
  }),
});

function targetMatches(scope: string, target: string): boolean {
  if (scope === "*") return true;
  if (scope.endsWith("*")) return target.startsWith(scope.slice(0, -1));
  return scope === target;
}
