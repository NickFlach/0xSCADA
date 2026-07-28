import { EventEmitter } from "events";
import { describe, expect, it, vi } from "vitest";
import {
  GhostOSBridge,
  GhostOSOrchestrator,
  InMemoryCapabilityAuthorizer,
  computeOrderParameter,
  kuramotoStep,
  type AgentOscillator,
  type Clock,
  type OperationalEnvelope,
} from "..";

class MutableClock implements Clock {
  constructor(public value: number) {}
  now(): number {
    return this.value;
  }
}

const CONTROL_ENVELOPE: OperationalEnvelope = {
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

describe("Kuramoto coordination", () => {
  it("uses simultaneous deterministic steps and converges coupled agents", () => {
    let oscillators: AgentOscillator[] = [
      {
        agentId: "agent-a",
        naturalFrequency: 1,
        phase: 0,
        amplitude: 1,
        couplingStrength: 1,
        lastUpdate: 0,
      },
      {
        agentId: "agent-b",
        naturalFrequency: 1,
        phase: 2.5,
        amplitude: 1,
        couplingStrength: 1,
        lastUpdate: 0,
      },
    ];

    for (let step = 1; step <= 200; step += 1) {
      oscillators = kuramotoStep(oscillators, 2, 0.05, step * 50);
    }

    expect(computeOrderParameter(oscillators).r).toBeGreaterThan(0.999);
    expect(oscillators.map((oscillator) => oscillator.lastUpdate)).toEqual([
      10_000, 10_000,
    ]);
  });

  it("derives reproducible initial phases instead of using randomness", () => {
    const clock = new MutableClock(1_000);
    const left = new GhostOSBridge({ clock });
    const right = new GhostOSBridge({ clock });

    left.registerAgent({ agentId: "stable-id", naturalFrequency: 1 });
    right.registerAgent({ agentId: "stable-id", naturalFrequency: 1 });

    expect(left.getOscillators()).toEqual(right.getOscillators());
  });
});

describe("Signal -> Resonance bridge", () => {
  it("aligns historical samples by time bucket and de-duplicates detections", () => {
    const clock = new MutableClock(10_000);
    const bridge = new GhostOSBridge({
      clock,
      alignmentMs: 1_000,
      minAlignedSamples: 4,
      correlationThreshold: 0.9,
    });

    for (let index = 1; index <= 5; index += 1) {
      bridge.ingestSignal({
        id: `pressure-${index}`,
        source: "pressure",
        type: "sensor",
        value: index * 2,
        timestamp: index * 1_000,
      });
      bridge.ingestSignal({
        id: `flow-${index}`,
        source: "flow",
        type: "sensor",
        value: index * 4 + 1,
        timestamp: index * 1_000 + 50,
      });
    }

    const patterns = bridge.detectResonance(10_000);
    expect(patterns).toHaveLength(1);
    expect(patterns[0]).toMatchObject({
      sourceIds: ["flow", "pressure"],
      strength: 1,
      sampleCount: 5,
      detectedAt: 10_000,
    });
    expect(bridge.detectResonance(10_000)).toEqual([]);
    expect(
      bridge.ingestSignal({
        id: "flow-1",
        source: "flow",
        type: "sensor",
        value: 999,
        timestamp: 1_050,
      }),
    ).toBe(false);
    expect(bridge.getSignals("flow")).toHaveLength(5);
  });

  it("consumes only successful canonical pipeline events and can detach", () => {
    const clock = new MutableClock(2_000);
    const orchestrator = new GhostOSOrchestrator({
      clock,
      bridge: new GhostOSBridge({
        clock,
        alignmentMs: 100,
        minAlignedSamples: 2,
      }),
    });
    const pipeline = new EventEmitter();
    const detach = orchestrator.attachPipeline(pipeline);

    pipeline.emit("event:processed", {
      timestamp: "1970-01-01T00:00:01.000Z",
      source_id: "tank.level",
      event_type: "tag_update",
      sequence_number: 1,
      payload: { value: 42 },
    });
    pipeline.emit("event:processed", {
      timestamp: "1970-01-01T00:00:01.100Z",
      source_id: "tank.level",
      event_type: "tag_update",
      sequence_number: 2,
      payload: { value: "not-a-number" },
    });
    detach();
    pipeline.emit("event:processed", {
      timestamp: "1970-01-01T00:00:01.200Z",
      source_id: "tank.level",
      event_type: "tag_update",
      sequence_number: 3,
      payload: { value: 44 },
    });

    expect(orchestrator.bridge.getSignals()).toHaveLength(1);
    expect(
      orchestrator
        .getAuditTrail()
        .map((event) => [event.sequence, event.type]),
    ).toEqual([
      [1, "signal.accepted"],
      [2, "signal.rejected"],
    ]);
  });
});

describe("Emergence safety gates", () => {
  function setup(options: { withExecutor?: boolean; executionGrant?: boolean } = {}) {
    const clock = new MutableClock(10_000);
    const authorizer = new InMemoryCapabilityAuthorizer();
    const addGrant = (
      id: string,
      subjectId: string,
      capabilities: string[],
      scopes = ["asset:pump-*"],
    ) =>
      authorizer.addGrant({
        id,
        subjectId,
        capabilities,
        scopes,
        issuedAt: 0,
        expiresAt: 100_000,
      });
    addGrant("recommend-grant", "agent-a", ["recommend:control"]);
    if (options.executionGrant !== false) {
      addGrant("actuate-grant", "agent-a", ["actuate:control"]);
    }
    addGrant("approval-grant", "operator-1", ["approve:control"]);
    addGrant("agent-approval-grant", "agent-a", ["approve:control"]);
    const executor = vi.fn(async () => ({ commandId: "cmd-1" }));
    const bridge = new GhostOSBridge({
      clock,
      alignmentMs: 100,
      minAlignedSamples: 3,
      correlationThreshold: 0.9,
    });
    const orchestrator = new GhostOSOrchestrator({
      clock,
      bridge,
      capabilityAuthorizer: authorizer,
      ...(options.withExecutor === false ? {} : { executor: { execute: executor } }),
    });
    orchestrator.registerAgent({
      agentId: "agent-a",
      naturalFrequency: 1,
      initialPhase: 0,
      envelope: CONTROL_ENVELOPE,
    });
    orchestrator.registerAgent({
      agentId: "agent-b",
      naturalFrequency: 1,
      initialPhase: 0,
      envelope: CONTROL_ENVELOPE,
    });
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
    return { clock, authorizer, orchestrator, executor, pattern };
  }

  it("requires distinct recommend, human approve, and actuate capabilities", async () => {
    const { orchestrator, executor, pattern } = setup();
    const proposal = await orchestrator.proposeDecision({
      patternId: pattern.id,
      agentId: "agent-a",
      confidence: 0.95,
      action: {
        kind: "control",
        target: "asset:pump-7",
        summary: "Reduce pump setpoint after pressure/flow resonance",
        setpointDeltaPercent: -3,
      },
    });

    expect(proposal.status).toBe("pending-approval");
    await expect(
      orchestrator.approveDecision(proposal.id, {
        id: "agent-a",
        authenticated: true,
      }),
    ).rejects.toThrow("may not approve its own");

    const approved = await orchestrator.approveDecision(
      proposal.id,
      { id: "operator-1", authenticated: true },
      "Validated against current operating procedure",
    );
    expect(approved.status).toBe("approved");
    expect(approved.approvals[0]).toMatchObject({
      principalId: "operator-1",
      capabilityGrantId: "approval-grant",
    });

    const executed = await orchestrator.executeDecision(proposal.id);
    expect(executed).toMatchObject({
      status: "executed",
      recommendationGrantId: "recommend-grant",
      executionGrantId: "actuate-grant",
      result: { commandId: "cmd-1" },
    });
    expect(executor).toHaveBeenCalledTimes(1);
    expect(orchestrator.getStatus()).toMatchObject({
      coherence: 1,
      executionConfigured: true,
      decisions: { executed: 1 },
    });
  });

  it("blocks out-of-envelope recommendations before approval or execution", async () => {
    const { orchestrator, executor, pattern } = setup();
    const decision = await orchestrator.proposeDecision({
      patternId: pattern.id,
      agentId: "agent-a",
      confidence: 0.95,
      action: {
        kind: "control",
        target: "asset:pump-7",
        summary: "Unsafe large movement",
        setpointDeltaPercent: 12,
      },
    });

    expect(decision.status).toBe("blocked");
    expect(decision.envelopeCheck.reasons).toContain(
      "Setpoint delta 12% exceeds 5%",
    );
    await expect(orchestrator.executeDecision(decision.id)).rejects.toThrow(
      "is not approved",
    );
    expect(executor).not.toHaveBeenCalled();
  });

  it("fails closed when no physical executor is configured", async () => {
    const { orchestrator, pattern } = setup({ withExecutor: false });
    const decision = await orchestrator.proposeDecision({
      patternId: pattern.id,
      agentId: "agent-a",
      confidence: 0.95,
      action: {
        kind: "control",
        target: "asset:pump-7",
        summary: "Small safe movement",
        setpointDeltaPercent: 1,
      },
    });
    await orchestrator.approveDecision(decision.id, {
      id: "operator-1",
      authenticated: true,
    });

    await expect(orchestrator.executeDecision(decision.id)).rejects.toThrow(
      "executor not configured",
    );
    expect(orchestrator.getDecision(decision.id)?.status).toBe("failed");
  });

  it("re-checks execution capability instead of treating coherence as authority", async () => {
    const { orchestrator, executor, pattern } = setup({ executionGrant: false });
    const decision = await orchestrator.proposeDecision({
      patternId: pattern.id,
      agentId: "agent-a",
      confidence: 0.95,
      action: {
        kind: "control",
        target: "asset:pump-7",
        summary: "Small safe movement",
        setpointDeltaPercent: 1,
      },
    });
    await orchestrator.approveDecision(decision.id, {
      id: "operator-1",
      authenticated: true,
    });

    await expect(orchestrator.executeDecision(decision.id)).rejects.toThrow(
      "No active actuate:control grant",
    );
    expect(executor).not.toHaveBeenCalled();
    expect(orchestrator.getDecision(decision.id)?.status).toBe("failed");
  });

  it("serializes approvals so one principal cannot satisfy a two-person threshold", async () => {
    const { orchestrator, pattern } = setup();
    orchestrator.updateEnvelope("agent-a", {
      ...CONTROL_ENVELOPE,
      requiredApprovals: 2,
    });
    const decision = await orchestrator.proposeDecision({
      patternId: pattern.id,
      agentId: "agent-a",
      confidence: 0.95,
      action: {
        kind: "control",
        target: "asset:pump-7",
        summary: "Small safe movement",
        setpointDeltaPercent: 1,
      },
    });
    const principal = { id: "operator-1", authenticated: true as const };

    const results = await Promise.allSettled([
      orchestrator.approveDecision(decision.id, principal),
      orchestrator.approveDecision(decision.id, principal),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(orchestrator.getDecision(decision.id)).toMatchObject({
      status: "pending-approval",
      approvals: [{ principalId: "operator-1" }],
    });
  });

  it("allows at most one physical execution of the same approved decision", async () => {
    const { orchestrator, executor, pattern } = setup();
    const decision = await orchestrator.proposeDecision({
      patternId: pattern.id,
      agentId: "agent-a",
      confidence: 0.95,
      action: {
        kind: "control",
        target: "asset:pump-7",
        summary: "Small safe movement",
        setpointDeltaPercent: 1,
      },
    });
    await orchestrator.approveDecision(decision.id, {
      id: "operator-1",
      authenticated: true,
    });

    const results = await Promise.allSettled([
      orchestrator.executeDecision(decision.id),
      orchestrator.executeDecision(decision.id),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(executor).toHaveBeenCalledTimes(1);
    expect(orchestrator.getDecision(decision.id)?.status).toBe("executed");
  });

  it("serializes an agent's decisions so the execution-rate envelope cannot race", async () => {
    const { orchestrator, executor, pattern } = setup();
    const propose = (target: string) =>
      orchestrator.proposeDecision({
        patternId: pattern.id,
        agentId: "agent-a",
        confidence: 0.95,
        action: {
          kind: "control" as const,
          target,
          summary: "Small safe movement",
          setpointDeltaPercent: 1,
        },
      });
    const [first, second] = await Promise.all([
      propose("asset:pump-7"),
      propose("asset:pump-8"),
    ]);
    for (const decision of [first, second]) {
      await orchestrator.approveDecision(decision.id, {
        id: "operator-1",
        authenticated: true,
      });
    }

    const results = await Promise.allSettled([
      orchestrator.executeDecision(first.id),
      orchestrator.executeDecision(second.id),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(executor).toHaveBeenCalledTimes(1);
    expect(
      [first.id, second.id]
        .map((id) => orchestrator.getDecision(id)?.status)
        .sort(),
    ).toEqual(["executed", "failed"]);
  });

  it("deep-clones action payloads at the orchestration boundary", async () => {
    const { orchestrator, pattern } = setup();
    const payload = { limits: { delta: 1 } };
    const decision = await orchestrator.proposeDecision({
      patternId: pattern.id,
      agentId: "agent-a",
      confidence: 0.95,
      action: {
        kind: "control",
        target: "asset:pump-7",
        summary: "Small safe movement",
        setpointDeltaPercent: 1,
        payload,
      },
    });
    payload.limits.delta = 99;
    const firstRead = orchestrator.getDecision(decision.id)!;
    (firstRead.action.payload as { limits: { delta: number } }).limits.delta = 77;

    expect(orchestrator.getDecision(decision.id)?.action.payload).toEqual({
      limits: { delta: 1 },
    });
  });
});
