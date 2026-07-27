/**
 * Server-side PID tuning approval policy
 * ADR-0013 [13.4] — Issue #215
 *
 * The approver allowlist and the gain-write opt-in are server configuration,
 * never request input. Both fail CLOSED:
 *
 *   - An empty or unset allowlist makes approval impossible. It does NOT mean
 *     "anybody may approve" — that inversion is exactly the defect that made
 *     the first attempt at this feature unmergeable.
 *   - Writing gains to a live controller additionally requires an explicit
 *     `PID_TUNING_APPLY_ENABLED=true`, in the spirit of the other plant-
 *     affecting write paths on main.
 *
 * Allowlist entries are control-plane principal names, i.e. the `name` field of
 * an API key record (`API_KEYS=key:name:scope+scope`), so an approver identity
 * is always something the server issued.
 */

export interface TuningApprovalPolicy {
  /** Principal names permitted to decide a proposal. Empty ⇒ nothing may be approved. */
  approvers: readonly string[];
  /** Explicit opt-in required before approved gains reach a live controller. */
  applyEnabled: boolean;
  /** Proposals older than this can no longer be approved. */
  proposalTtlMs: number;
}

/** Reasons an approval attempt is refused. All of them are fail-closed. */
export type ApprovalDenialReason =
  | "approver-allowlist-empty"
  | "approver-not-allowlisted"
  | "separation-of-duties"
  | "gain-apply-disabled"
  | "proposal-expired";

export const DEFAULT_PROPOSAL_TTL_MS = 24 * 60 * 60 * 1000;
const MIN_PROPOSAL_TTL_MS = 60 * 1000;
const MAX_PROPOSAL_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export const APPROVERS_ENV = "PID_TUNING_APPROVERS";
export const APPLY_ENABLED_ENV = "PID_TUNING_APPLY_ENABLED";
export const PROPOSAL_TTL_ENV = "PID_TUNING_PROPOSAL_TTL_MS";

function parseApprovers(raw: string | undefined): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  for (const entry of raw.split(",")) {
    const name = entry.trim();
    if (name.length > 0) seen.add(name);
  }
  return [...seen];
}

function parseTtl(raw: string | undefined): number {
  if (!raw) return DEFAULT_PROPOSAL_TTL_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_PROPOSAL_TTL_MS;
  return Math.min(Math.max(Math.trunc(parsed), MIN_PROPOSAL_TTL_MS), MAX_PROPOSAL_TTL_MS);
}

/** Read the policy from the environment. Re-read per decision so an operator
 *  can revoke an approver without restarting the server. */
export function loadTuningApprovalPolicy(
  env: NodeJS.ProcessEnv = process.env,
): TuningApprovalPolicy {
  return {
    approvers: Object.freeze(parseApprovers(env[APPROVERS_ENV])),
    // Anything other than the exact string "true" leaves gain writes disabled.
    applyEnabled: env[APPLY_ENABLED_ENV] === "true",
    proposalTtlMs: parseTtl(env[PROPOSAL_TTL_ENV]),
  };
}

/** Thrown when the deployment cannot support a gated gain change at all. */
export class TuningConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TuningConfigurationError";
  }
}

/** Thrown when an authenticated principal is not permitted to make this decision. */
export class TuningApprovalDeniedError extends Error {
  constructor(readonly reason: ApprovalDenialReason, message: string) {
    super(message);
    this.name = "TuningApprovalDeniedError";
  }
}

/**
 * Thrown when the durable audit trail cannot accept a record that must exist
 * before a gain reaches the plant. Always fail-closed: the write is abandoned.
 */
export class TuningAuditUnavailableError extends Error {
  constructor(message: string, readonly cause: unknown) {
    super(message);
    this.name = "TuningAuditUnavailableError";
  }
}

/** Thrown when a recommendation falls outside the configured safety envelope. */
export class EnvelopeViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvelopeViolationError";
  }
}

/**
 * Thrown when a loop id is registered twice. Loop registration is create-only:
 * re-registering an id would replace the live controller and install new gains
 * without an approval, which is exactly what the gate exists to prevent.
 */
export class LoopAlreadyRegisteredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LoopAlreadyRegisteredError";
  }
}

/**
 * Decide whether `approver` may approve a proposal raised by `proposedBy`.
 * Returns the denial reason, or null when the approval may proceed.
 *
 * Order matters only for the quality of the error; every branch denies.
 */
export function denyApprovalReason(
  policy: TuningApprovalPolicy,
  approver: string,
  proposedBy: string,
): ApprovalDenialReason | null {
  if (policy.approvers.length === 0) return "approver-allowlist-empty";
  if (!policy.approvers.includes(approver)) return "approver-not-allowlisted";
  // Four-eyes: proposing and approving the same plant change alone is refused
  // even for an allowlisted approver.
  if (approver === proposedBy) return "separation-of-duties";
  if (!policy.applyEnabled) return "gain-apply-disabled";
  return null;
}

/**
 * Rejection is not plant-affecting, so a proposer may withdraw their own
 * proposal — but only an allowlisted principal may decide at all.
 */
export function denyRejectionReason(
  policy: TuningApprovalPolicy,
  approver: string,
): ApprovalDenialReason | null {
  if (policy.approvers.length === 0) return "approver-allowlist-empty";
  if (!policy.approvers.includes(approver)) return "approver-not-allowlisted";
  return null;
}

export function denialMessage(reason: ApprovalDenialReason): string {
  switch (reason) {
    case "approver-allowlist-empty":
      return `No PID tuning approver is configured (${APPROVERS_ENV} is empty); `
        + "approval is refused.";
    case "approver-not-allowlisted":
      return `Principal is not on the ${APPROVERS_ENV} allowlist.`;
    case "separation-of-duties":
      return "Separation of duties: the principal that proposed this change "
        + "cannot approve it.";
    case "gain-apply-disabled":
      return `Writing PID gains is disabled (${APPLY_ENABLED_ENV} is not "true").`;
    case "proposal-expired":
      return "Proposal has expired and can no longer be approved.";
  }
}
