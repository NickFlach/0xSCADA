/**
 * Pins two safety properties of `GhostOSOrchestrator` that mutation testing on
 * the review of #625 found unpinned — every existing test still passed with
 * each one removed.
 *
 * 1. The fail-closed authorizer default (`orchestrator.ts:78`)
 *
 *      this.authorizer = options.capabilityAuthorizer ?? denyAllCapabilities;
 *
 *    This is what makes an *unconfigured* deployment safe, which is the state a
 *    partially-provisioned system is actually in. Every existing test passes an
 *    explicit authorizer, so swapping the default for allow-all changed nothing.
 *
 * 2. The post-await envelope re-check (`orchestrator.ts:405`)
 *
 *      // Authorization may be remote and slow. Re-read every dynamic safety
 *      // input after the await, immediately before dispatch.
 *      const dispatchAt = this.clock.now();
 *      const recentExecutionHistory = this.assertExecutionEnvelope(decision, dispatchAt);
 *
 *    Reverting `dispatchAt` to the pre-await `authorizationRequestedAt` — i.e.
 *    reintroducing the check-then-use race the comment exists to prevent — also
 *    changed nothing. The guarded window is a *remote* authorization call, so a
 *    decision aging out during it is a realistic scenario, not a theoretical
 *    one. A comment is not a test.
 */
import { describe, expect, it, vi } from "vitest";

import {
  GhostOSBridge,
  GhostOSOrchestrator,
  InMemoryCapabilityAuthorizer,
  type Clock,
  type OperationalEnvelope,
} from "..";

class MutableClock implements Clock {
  constructor(public value: number) {}
  now(): number {
    return this.value;
  }
}

const ENVELOPE: OperationalEnvelope = {
  allowedActionKinds: ["control", "notify"],
  allowedTargets: ["asset:pump-*"],
  forbiddenTargets: ["asset:pump-locked"],
  minConfidence: 0.8,
  minCoherence: 0.9,
  maxSetpointDeltaPercent: 5,
  maxDecisionAgeMs: 10_000,
  maxExecutionsPerMinute: 1,
  requiredApprovals: 1,
  allowAutonomousNotifications: false,
};

const ACTION = {
  kind: "control" as const,
  target: "asset:pump-7",
  summary: "Reduce pump setpoint after pressure/flow resonance",
  setpointDeltaPercent: -3,
};

/**
 * Builds a coordinated orchestrator with a detected pattern, matching the
 * arrangement the main suite uses. `capabilityAuthorizer` and `executor` are
 * passed through verbatim so a caller can omit either.
 */
function arrange(options: {
  clock: MutableClock;
  capabilityAuthorizer?: ConstructorParameters<typeof GhostOSOrchestrator>[0] extends
    | infer O
    | undefined
    ? O extends { capabilityAuthorizer?: infer A }
      ? A
      : never
    : never;
  executor?: { execute: (decision: unknown) => Promise<unknown> };
}) {
  const { clock } = options;
  const orchestrator = new GhostOSOrchestrator({
    clock,
    bridge: new GhostOSBridge({
      clock,
      alignmentMs: 100,
      minAlignedSamples: 3,
      correlationThreshold: 0.9,
    }),
    ...(options.capabilityAuthorizer
      ? { capabilityAuthorizer: options.capabilityAuthorizer }
      : {}),
    ...(options.executor ? { executor: options.executor } : {}),
  });

  for (const agentId of ["agent-a", "agent-b"]) {
    orchestrator.registerAgent({
      agentId,
      naturalFrequency: 1,
      initialPhase: 0,
      envelope: ENVELOPE,
    });
  }
  orchestrator.stepCoordination();
  for (let index = 0; index < 3; index += 1) {
    orchestrator.ingestSignal({
      id: `a-${index}`,
      source: "pressure",
      type: "sensor",
      value: index + 1,
      timestamp: 9_000 + index * 100,
    });
    orchestrator.ingestSignal({
      id: `b-${index}`,
      source: "flow",
      type: "sensor",
      value: (index + 1) * 2,
      timestamp: 9_000 + index * 100,
    });
  }
  const pattern = orchestrator.bridge.getPatterns()[0];
  expect(pattern).toBeDefined();
  return { orchestrator, pattern };
}

describe("GhostOS fails closed when no capability authorizer is configured", () => {
  it("blocks a recommendation that a granted authorizer would permit", async () => {
    const clock = new MutableClock(10_000);
    // No capabilityAuthorizer — the deployment has not wired one up yet.
    const { orchestrator, pattern } = arrange({ clock });

    const decision = await orchestrator.proposeDecision({
      patternId: pattern.id,
      agentId: "agent-a",
      confidence: 0.95,
      action: ACTION,
    });

    // denyAllCapabilities must refuse; anything else means an unprovisioned
    // deployment silently permits autonomous recommendations.
    expect(decision.status).toBe("blocked");
    expect(decision.envelopeCheck.permitted).toBe(false);
    expect(decision.envelopeCheck.reasons.join(" ")).toMatch(/capability|denied/i);
  });
});

describe("GhostOS re-reads the envelope after the authorization await", () => {
  it("refuses to dispatch a decision that aged out during a slow authorization", async () => {
    const clock = new MutableClock(10_000);

    const authorizer = new InMemoryCapabilityAuthorizer();
    for (const [id, subjectId, capabilities] of [
      ["recommend-grant", "agent-a", ["recommend:control"]],
      ["actuate-grant", "agent-a", ["actuate:control"]],
      ["approval-grant", "operator-1", ["approve:control"]],
    ] as const) {
      authorizer.addGrant({
        id,
        subjectId,
        capabilities: [...capabilities],
        scopes: ["asset:pump-*"],
        issuedAt: 0,
        expiresAt: 100_000,
      });
    }

    // A remote authorizer that takes longer than the decision's max age.
    // Everything it returns is valid — the decision simply went stale while
    // waiting, which only the post-await re-check can notice.
    let slow = false;
    const slowAuthorizer = {
      authorize: async (request: Parameters<typeof authorizer.authorize>[0]) => {
        const result = await authorizer.authorize(request);
        if (slow) clock.value += ENVELOPE.maxDecisionAgeMs + 1_000;
        return result;
      },
    };

    const executor = vi.fn(async () => ({ commandId: "cmd-1" }));
    const { orchestrator, pattern } = arrange({
      clock,
      capabilityAuthorizer: slowAuthorizer as never,
      executor: { execute: executor },
    });

    const proposal = await orchestrator.proposeDecision({
      patternId: pattern.id,
      agentId: "agent-a",
      confidence: 0.95,
      action: ACTION,
    });
    const approved = await orchestrator.approveDecision(
      proposal.id,
      { id: "operator-1", authenticated: true },
      "Validated against current operating procedure",
    );
    expect(approved.status).toBe("approved");

    // From here the authorization call burns more than maxDecisionAgeMs.
    slow = true;

    await expect(orchestrator.executeDecision(proposal.id)).rejects.toThrow();
    // The whole point: nothing reached the plant.
    expect(executor).not.toHaveBeenCalled();
  });

  it("still dispatches when authorization is fast enough", async () => {
    // Control case, so the test above cannot pass by refusing everything.
    const clock = new MutableClock(10_000);
    const authorizer = new InMemoryCapabilityAuthorizer();
    for (const [id, subjectId, capabilities] of [
      ["recommend-grant", "agent-a", ["recommend:control"]],
      ["actuate-grant", "agent-a", ["actuate:control"]],
      ["approval-grant", "operator-1", ["approve:control"]],
    ] as const) {
      authorizer.addGrant({
        id,
        subjectId,
        capabilities: [...capabilities],
        scopes: ["asset:pump-*"],
        issuedAt: 0,
        expiresAt: 100_000,
      });
    }

    const executor = vi.fn(async () => ({ commandId: "cmd-1" }));
    const { orchestrator, pattern } = arrange({
      clock,
      capabilityAuthorizer: authorizer as never,
      executor: { execute: executor },
    });

    const proposal = await orchestrator.proposeDecision({
      patternId: pattern.id,
      agentId: "agent-a",
      confidence: 0.95,
      action: ACTION,
    });
    await orchestrator.approveDecision(
      proposal.id,
      { id: "operator-1", authenticated: true },
      "Validated against current operating procedure",
    );

    const executed = await orchestrator.executeDecision(proposal.id);
    expect(executed.status).toBe("executed");
    expect(executor).toHaveBeenCalledTimes(1);
  });
});
