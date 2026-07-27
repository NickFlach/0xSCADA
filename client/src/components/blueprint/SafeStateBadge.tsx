/**
 * SafeStateBadge (#459)
 *
 * Prominent operator-facing indicator that a blueprint's watchdog has tripped
 * and the blueprint is running in a pre-declared SAFE STATE (hold-last /
 * force-zero / safe recipe). Exit from safe state is NEVER automatic — the
 * badge surfaces an explicit "Resume" action that the operator must confirm.
 *
 * The badge is intentionally high-contrast and persistent: a safe state means
 * the control loop is halted, so it must not be easy to overlook.
 *
 * Shape mirrors the server's `SafeStateStatus` (see server/blueprint/safe-state.ts),
 * delivered to the client as JSON over the API.
 *
 * SCOPE: this is a presentational component only. There is no blueprint
 * operator page in this repository yet, so nothing mounts it; it is exported and
 * unit-tested so the page that adds one does not have to re-derive the status
 * shape or the confirm-before-resume rule.
 */

import React from "react";
import type { SafeStateAction } from "@shared/schema";

/** Run state of a watched blueprint, as reported by the server. */
export type BlueprintRunState =
  | "RUNNING"
  | "SAFE_STATE"
  | "RESUMING"
  | "RECOVERING"
  | "RECOVERY_FAILED";

/** Serialisable safe-state status delivered to the client over the API. */
export interface SafeStateStatus {
  blueprintId: string;
  siteId?: string;
  runState: BlueprintRunState;
  safeState: SafeStateAction;
  enteredAt?: string;
  reason?: string;
  consecutiveMisses?: number;
  anchorHash?: string;
  entryAuditStatus?: "pending" | "durable";
  recoveryErrors?: string[];
}

export interface SafeStateBadgeProps {
  status: SafeStateStatus;
  /**
   * Invoked when the operator confirms a resume. The parent is responsible for
   * calling the resume API and refreshing status. Receives the blueprint id.
   * If omitted, the resume control is hidden (read-only view).
   */
  onResume?: (blueprintId: string) => void;
  /** Disables the resume control while a resume request is in flight. */
  resuming?: boolean;
  className?: string;
}

/** Human-readable description of the applied safe state. */
function describeSafeState(action: SafeStateAction): string {
  if (action === "hold-last") return "Holding last outputs";
  if (action === "force-zero") return "Outputs forced to zero";
  return `Safe recipe: ${action.recipe}`;
}

/**
 * Renders nothing when the blueprint is RUNNING; renders a prominent banner
 * when it is in SAFE_STATE. Keeping the "running" case empty lets callers mount
 * the badge unconditionally next to a blueprint without layout churn.
 */
export const SafeStateBadge: React.FC<SafeStateBadgeProps> = ({
  status,
  onResume,
  resuming = false,
  className,
}) => {
  if (status.runState === "RUNNING") {
    return null;
  }

  const canResume = status.runState === "SAFE_STATE";
  const transitionPending =
    status.runState === "RESUMING" || status.runState === "RECOVERING";
  const title = status.runState === "SAFE_STATE"
    ? "SAFE STATE ACTIVE"
    : status.runState === "RESUMING"
      ? "RESUME AUDIT PENDING"
      : status.runState === "RECOVERING"
        ? "RE-APPLYING SAFE STATE"
        : "SAFETY RECOVERY FAILED";
  const borderColor = transitionPending ? "#b45309" : "#b91c1c";
  const background = transitionPending ? "#fffbeb" : "#fef2f2";
  const foreground = transitionPending ? "#78350f" : "#7f1d1d";

  const handleResume = () => {
    if (resuming || !onResume || !canResume) return;
    const ok = window.confirm(
      `Resume blueprint "${status.blueprintId}" from SAFE STATE?\n\n` +
        `The control loop was halted because: ${status.reason ?? "watchdog trip"}.\n` +
        `Confirm only after the underlying condition has been resolved.`,
    );
    if (ok) onResume(status.blueprintId);
  };

  return (
    <div
      className={`safe-state-badge safe-state-badge-critical ${className ?? ""}`}
      role="alert"
      aria-live="assertive"
      data-blueprint-id={status.blueprintId}
      data-run-state={status.runState}
      // Inline fallback styling guarantees prominence even without a stylesheet;
      // the class names above remain the theming hook for design-system CSS.
      style={{
        border: `2px solid ${borderColor}`,
        background,
        color: foreground,
        borderRadius: 6,
        padding: "12px 16px",
        margin: "8px 0",
        fontWeight: 500,
      }}
    >
      <div
        className="safe-state-badge-header"
        style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 16, fontWeight: 700 }}
      >
        <span className="safe-state-badge-icon" aria-hidden="true">
          {"⚠"}
        </span>
        <span className="safe-state-badge-title">{title}</span>
      </div>

      <dl className="safe-state-badge-details">
        <div>
          <dt>Blueprint</dt>
          <dd>{status.blueprintId}</dd>
        </div>
        <div>
          <dt>Safe state</dt>
          <dd>{describeSafeState(status.safeState)}</dd>
        </div>
        {status.reason ? (
          <div>
            <dt>Reason</dt>
            <dd>{status.reason}</dd>
          </div>
        ) : null}
        {typeof status.consecutiveMisses === "number" ? (
          <div>
            <dt>Consecutive misses</dt>
            <dd>{status.consecutiveMisses}</dd>
          </div>
        ) : null}
        {status.enteredAt ? (
          <div>
            <dt>Entered</dt>
            <dd>
              <time dateTime={status.enteredAt}>
                {new Date(status.enteredAt).toLocaleString()}
              </time>
            </dd>
          </div>
        ) : null}
        {status.anchorHash ? (
          <div>
            <dt>Anchor</dt>
            <dd>
              <code className="safe-state-badge-anchor" title={status.anchorHash}>
                {status.anchorHash.slice(0, 16)}
                {"…"}
              </code>
            </dd>
          </div>
        ) : null}
        {status.recoveryErrors?.length ? (
          <div>
            <dt>Recovery errors</dt>
            <dd>{status.recoveryErrors.join("; ")}</dd>
          </div>
        ) : null}
      </dl>

      {onResume && canResume ? (
        <button
          type="button"
          className="safe-state-badge-resume"
          onClick={handleResume}
          disabled={resuming}
          style={{
            marginTop: 8,
            padding: "6px 14px",
            border: "1px solid #b91c1c",
            borderRadius: 4,
            background: resuming ? "#fca5a5" : "#dc2626",
            color: "#fff",
            fontWeight: 600,
            cursor: resuming ? "not-allowed" : "pointer",
          }}
        >
          {resuming ? "Resuming…" : "Resume blueprint"}
        </button>
      ) : null}
    </div>
  );
};

SafeStateBadge.displayName = "SafeStateBadge";

export default SafeStateBadge;
