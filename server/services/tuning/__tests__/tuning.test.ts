/**
 * PID Auto-Tuning tests
 * ADR-0013 [13.4] — Issue #215
 *
 * The maths (envelopes, FOPDT physics, Åström-Hägglund relay identification,
 * Ziegler-Nichols, the Q-learning tuner) is exercised directly. The approval
 * gate is exercised against a real Drizzle-backed audit store on a temporary
 * SQLite file — no fake persistence — so "the record is durable" is a property
 * these tests actually observe.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FOPDTModel, TuningAuditRecord, TuningProposal } from '@shared/types/tuning';
import {
  DEFAULT_ENVELOPE,
  clampToEnvelope,
  describeEnvelopeViolations,
  isWithinEnvelope,
  limitStepTowards,
  validateEnvelope,
} from '../envelope';
import {
  FOPDTPlant,
  relayIdentify,
  runClosedLoopEpisode,
  zieglerNicholsFromUltimate,
} from '../process-sim';
import { runRLTuning } from '../rl-tuner';
import { TuningService, type TuningPrincipal } from '../index';
import {
  DEFAULT_PROPOSAL_TTL_MS,
  EnvelopeViolationError,
  LoopAlreadyRegisteredError,
  TuningAuditUnavailableError,
  TuningConfigurationError,
  type TuningApprovalPolicy,
} from '../approval-policy';
import {
  DrizzleTuningAuditStore,
  type TuningAuditFilter,
  type TuningAuditStore,
} from '../audit-store';
import { PIDAutoTuner } from '../../optimization/pid-autotuner';
import { PIDController } from '../../optimization/pid-controller';

const MODEL: FOPDTModel = { gain: 2, timeConstantS: 10, deadTimeS: 1 };

// ── Envelope ──────────────────────────────────────────────────────────────

describe('gain envelope (ADR-0009)', () => {
  it('validates ranges', () => {
    expect(validateEnvelope(DEFAULT_ENVELOPE)).toBeNull();
    expect(
      validateEnvelope({ ...DEFAULT_ENVELOPE, kpRange: { min: 5, max: 1 } })
    ).toMatch(/exceeds/);
    expect(
      validateEnvelope({ ...DEFAULT_ENVELOPE, kiRange: { min: -1, max: 1 } })
    ).toMatch(/negative/);
  });

  it('clamps gains to the envelope and reports it', () => {
    const envelope = {
      kpRange: { min: 0.1, max: 5 },
      kiRange: { min: 0, max: 2 },
      kdRange: { min: 0, max: 1 },
    };
    const { gains, clamped } = clampToEnvelope({ kp: 50, ki: 1, kd: 3 }, envelope);
    expect(gains).toEqual({ kp: 5, ki: 1, kd: 1 });
    expect(clamped).toBe(true);
    expect(isWithinEnvelope(gains, envelope)).toBe(true);
    expect(clampToEnvelope({ kp: 1, ki: 1, kd: 0.5 }, envelope).clamped).toBe(false);
  });

  it('names every bound a set of gains violates', () => {
    const envelope = {
      kpRange: { min: 0, max: 2 },
      kiRange: { min: 0, max: 1 },
      kdRange: { min: 0, max: 1 },
    };
    expect(describeEnvelopeViolations({ kp: 1, ki: 0.5, kd: 0.5 }, envelope)).toEqual([]);
    const violations = describeEnvelopeViolations({ kp: 9, ki: 0.5, kd: 4 }, envelope);
    expect(violations).toHaveLength(2);
    expect(violations[0]).toContain('kp=9');
    expect(violations[1]).toContain('kd=4');
  });

  it('limits a step to the rate-limit fraction so applyGains always accepts', () => {
    const current = { kp: 1, ki: 0.5, kd: 0.1 };
    const target = { kp: 10, ki: 0.55, kd: 0.1 };
    const { gains, complete } = limitStepTowards(current, target, 0.25);
    expect(gains.kp).toBeCloseTo(1.25); // truncated to +25%
    expect(gains.ki).toBeCloseTo(0.55); // within limit — reaches target
    expect(complete).toBe(false);

    const controller = new PIDController({
      id: 'c', name: 'c', gains: current, setpoint: 50, outputMin: 0, outputMax: 100,
    });
    expect(controller.applyGains(gains)).toBe(true);
  });

  it('produces steps applyGains accepts for fractions that round badly', () => {
    // A step sized at exactly |from| * fraction can re-derive one ULP above
    // the limit: from=1, fraction=0.1 gives (1.1 - 1) / 1 === 0.10000000000000009.
    for (const fraction of [0.05, 0.1, 0.15, 0.2, 0.3, 0.33, 0.7]) {
      const current = { kp: 1, ki: 0.7, kd: 0.3 };
      const { gains } = limitStepTowards(current, { kp: 99, ki: 99, kd: 99 }, fraction);
      const controller = new PIDController({
        id: `c-${fraction}`, name: 'c', gains: current, setpoint: 50,
        outputMin: 0, outputMax: 100, maxGainChangeFraction: fraction,
      });
      expect(controller.applyGains(gains)).toBe(true);
    }
  });
});

// ── FOPDT simulation ──────────────────────────────────────────────────────

describe('FOPDT plant and closed-loop episodes', () => {
  it('settles to gain × input in open loop', () => {
    const plant = new FOPDTPlant(MODEL, 0.5);
    for (let i = 0; i < 400; i++) plant.step(10, 0.5);
    expect(plant.output).toBeCloseTo(20, 1); // K=2 × u=10
  });

  it('reasonable gains regulate to setpoint; zero gains do not', () => {
    const good = runClosedLoopEpisode({ kp: 2, ki: 0.4, kd: 0.5 }, MODEL, {
      setpoint: 50, ticks: 1200, dtS: 0.5,
    });
    expect(good.settlingTimeS).not.toBeNull();
    expect(good.iae).toBeGreaterThan(0);

    const dead = runClosedLoopEpisode({ kp: 0, ki: 0, kd: 0 }, MODEL, {
      setpoint: 50, ticks: 1200, dtS: 0.5,
    });
    expect(dead.settlingTimeS).toBeNull();
    expect(dead.iae).toBeGreaterThan(good.iae * 5);
  });

  it('relay identification recovers a usable ultimate gain and period', () => {
    const identification = relayIdentify(MODEL, {
      setpoint: 50,
      relayAmplitude: 5,
      hysteresis: 0.2,
      minCycles: 4,
      dtS: 0.1,
    })!;
    expect(identification).not.toBeNull();
    expect(identification.ku).toBeGreaterThan(0);
    expect(identification.tu).toBeGreaterThan(0);

    // The derived Ziegler-Nichols gains must actually stabilize the loop
    const gains = zieglerNicholsFromUltimate(identification.ku, identification.tu);
    const metrics = runClosedLoopEpisode(gains, MODEL, { setpoint: 50, ticks: 2000, dtS: 0.5 });
    expect(metrics.settlingTimeS).not.toBeNull();
  });
});

// ── RL tuner ──────────────────────────────────────────────────────────────

describe('RL tuner', () => {
  it('improves reward over deliberately detuned initial gains', () => {
    const outcome = runRLTuning(
      { kp: 0.05, ki: 0.005, kd: 0 }, // sluggish start
      MODEL,
      DEFAULT_ENVELOPE,
      50,
      { episodes: 40, episodeTicks: 400, dtS: 0.5, seed: 7 }
    );
    expect(outcome.improvedOverInitial).toBe(true);
    expect(outcome.bestReward).toBeGreaterThan(outcome.initialReward);
    expect(outcome.episodes).toHaveLength(40);
    expect(isWithinEnvelope(outcome.bestGains, DEFAULT_ENVELOPE)).toBe(true);
  });

  it('is deterministic for a fixed seed', () => {
    const run = () =>
      runRLTuning({ kp: 0.5, ki: 0.05, kd: 0 }, MODEL, DEFAULT_ENVELOPE, 50, {
        episodes: 15, episodeTicks: 200, dtS: 0.5, seed: 11,
      });
    expect(run().bestGains).toEqual(run().bestGains);
  });

  it('never proposes gains outside the envelope', () => {
    const tight = {
      kpRange: { min: 0, max: 0.8 },
      kiRange: { min: 0, max: 0.1 },
      kdRange: { min: 0, max: 0.1 },
    };
    const outcome = runRLTuning({ kp: 0.5, ki: 0.05, kd: 0 }, MODEL, tight, 50, {
      episodes: 30, episodeTicks: 200, dtS: 0.5, seed: 3,
    });
    for (const episode of outcome.episodes) {
      expect(isWithinEnvelope(episode.gains, tight)).toBe(true);
    }
  });
});

// ── Approval gate ─────────────────────────────────────────────────────────

const PROPOSER: TuningPrincipal = { name: 'tuning-engineer' };
const APPROVER: TuningPrincipal = { name: 'control-room-lead' };
const OUTSIDER: TuningPrincipal = { name: 'contractor-laptop' };

function policy(overrides: Partial<TuningApprovalPolicy> = {}): TuningApprovalPolicy {
  return {
    approvers: [APPROVER.name, PROPOSER.name],
    applyEnabled: true,
    proposalTtlMs: DEFAULT_PROPOSAL_TTL_MS,
    ...overrides,
  };
}

/**
 * Fault injection, not a behavioural mock: a real TuningAuditStore whose
 * append always fails, used to prove the apply path is abandoned when the
 * durable record cannot be written.
 */
class FailingAuditStore implements TuningAuditStore {
  appendAttempts = 0;
  async ready(): Promise<void> {}
  async append(): Promise<TuningAuditRecord> {
    this.appendAttempts += 1;
    throw new Error('audit backend offline');
  }
  async list(): Promise<TuningAuditRecord[]> {
    return [];
  }
  backend(): 'postgres' | 'sqlite' | 'unopened' {
    return 'unopened';
  }
  async close(): Promise<void> {}
}

describe('TuningService approval gate (ADR-0013 human-in-the-loop)', () => {
  let directory: string;
  let auditPath: string;
  let store: DrizzleTuningAuditStore;
  let currentPolicy: TuningApprovalPolicy;
  let service: TuningService;
  let loopCounter = 0;

  const nextLoopId = (): string => `gate-loop-${++loopCounter}`;

  const registerLoop = (id: string, gains = { kp: 1, ki: 0.1, kd: 0.05 }) =>
    service.registerLoop({
      id, name: id, gains, setpoint: 50, outputMin: 0, outputMax: 100,
    });

  const auditFor = (proposalId: string, filter: TuningAuditFilter = {}) =>
    store.list({ proposalId, ...filter });

  beforeAll(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'tuning-gate-'));
    auditPath = path.join(directory, 'audit.sqlite');
    store = new DrizzleTuningAuditStore({ sqlitePath: auditPath });
    currentPolicy = policy();
    service = new TuningService({
      auditStore: store,
      loadPolicy: () => currentPolicy,
    });
  });

  afterAll(async () => {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  });

  it('proposals stay pending until a human decides; approval applies gains', async () => {
    const id = nextLoopId();
    const { controller } = registerLoop(id);
    const applied = vi.fn();
    service.on('proposal-applied', applied);

    const proposal = await service.propose(id, 'ziegler-nichols',
      { kp: 1.2, ki: 0.12, kd: 0.06 }, PROPOSER, { reason: 'test', confidence: 0.8 });
    expect(proposal.status).toBe('pending');
    expect(proposal.proposedBy).toBe(PROPOSER.name);
    expect(controller.getGains()).toEqual({ kp: 1, ki: 0.1, kd: 0.05 }); // unchanged

    const decided = await service.decide(proposal.id, APPROVER, 'approve');
    expect(decided.status).toBe('applied');
    expect(decided.fullyApplied).toBe(true);
    expect(decided.decidedBy).toBe(APPROVER.name);
    expect(controller.getGains()).toEqual({ kp: 1.2, ki: 0.12, kd: 0.06 });
    expect(applied).toHaveBeenCalledTimes(1);
    service.off('proposal-applied', applied);
  });

  it('records who proposed, who approved, both gain sets and the envelope decision', async () => {
    const id = nextLoopId();
    registerLoop(id);
    const proposal = await service.propose(id, 'cohen-coon',
      { kp: 1.1, ki: 0.11, kd: 0.05 }, PROPOSER, { reason: 'audited', confidence: 0.6 });
    await service.decide(proposal.id, APPROVER, 'approve', 'looks safe');

    const records = await auditFor(proposal.id);
    const decisions = records.map((record) => record.decision);
    expect(decisions).toContain('proposed');
    expect(decisions).toContain('approved');
    expect(decisions).toContain('applied');

    const approved = records.find((record) => record.decision === 'approved')!;
    expect(approved.proposedBy).toBe(PROPOSER.name);
    expect(approved.decidedBy).toBe(APPROVER.name);
    expect(approved.currentGains).toEqual({ kp: 1, ki: 0.1, kd: 0.05 });
    expect(approved.proposedGains).toEqual({ kp: 1.1, ki: 0.11, kd: 0.05 });
    expect(approved.appliedGains).toEqual({ kp: 1.1, ki: 0.11, kd: 0.05 });
    expect(approved.envelopeDecision).toBe('within-envelope');
    expect(approved.envelope).toEqual(DEFAULT_ENVELOPE);
    expect(approved.detail).toBe('looks safe');
    expect(approved.recordedAt).toBeInstanceOf(Date);
  });

  it('survives a restart: a new store on the same file still has the record', async () => {
    const id = nextLoopId();
    registerLoop(id);
    const proposal = await service.propose(id, 'rl',
      { kp: 1.05, ki: 0.1, kd: 0.05 }, PROPOSER, { reason: 'durable', confidence: 0.5 });
    await service.decide(proposal.id, APPROVER, 'approve');

    const reopened = new DrizzleTuningAuditStore({ sqlitePath: auditPath });
    try {
      const records = await reopened.list({ proposalId: proposal.id });
      expect(records.map((record) => record.decision)).toEqual(
        expect.arrayContaining(['proposed', 'approved', 'applied']),
      );
    } finally {
      await reopened.close();
    }
  });

  it('four-eyes: the proposer cannot approve their own change', async () => {
    const id = nextLoopId();
    const { controller } = registerLoop(id);
    const before = controller.getGains();
    const proposal = await service.propose(id, 'rl',
      { kp: 1.1, ki: 0.1, kd: 0.05 }, PROPOSER, { reason: 'self-approve', confidence: 0.5 });

    await expect(service.decide(proposal.id, PROPOSER, 'approve'))
      .rejects.toMatchObject({ reason: 'separation-of-duties' });
    expect(controller.getGains()).toEqual(before);
    expect(service.getProposal(proposal.id)?.status).toBe('pending');

    const denials = (await auditFor(proposal.id))
      .filter((record) => record.decision === 'denied');
    expect(denials).toHaveLength(1);
    expect(denials[0].reasonCode).toBe('separation-of-duties');
    expect(denials[0].decidedBy).toBe(PROPOSER.name);

    // ...but a different allowlisted principal still can.
    const decided = await service.decide(proposal.id, APPROVER, 'approve');
    expect(decided.status).toBe('applied');
  });

  it('refuses a principal that is not on the server-side allowlist', async () => {
    const id = nextLoopId();
    const { controller } = registerLoop(id);
    const before = controller.getGains();
    const proposal = await service.propose(id, 'rl',
      { kp: 1.1, ki: 0.1, kd: 0.05 }, PROPOSER, { reason: 'outsider', confidence: 0.5 });

    await expect(service.decide(proposal.id, OUTSIDER, 'approve'))
      .rejects.toMatchObject({ reason: 'approver-not-allowlisted' });
    expect(controller.getGains()).toEqual(before);
  });

  it('an empty allowlist fails closed: nothing proposed, nothing approved', async () => {
    const id = nextLoopId();
    const { controller } = registerLoop(id);
    const before = controller.getGains();
    const proposal = await service.propose(id, 'rl',
      { kp: 1.1, ki: 0.1, kd: 0.05 }, PROPOSER, { reason: 'pre-existing', confidence: 0.5 });

    currentPolicy = policy({ approvers: [] });
    try {
      // Existing proposals become undecidable rather than freely approvable.
      await expect(service.decide(proposal.id, APPROVER, 'approve'))
        .rejects.toMatchObject({ reason: 'approver-allowlist-empty' });
      expect(controller.getGains()).toEqual(before);

      // And no new proposal can be created against an ungated deployment.
      await expect(
        service.propose(id, 'rl', { kp: 1.2, ki: 0.1, kd: 0.05 }, PROPOSER,
          { reason: 'ungated', confidence: 0.5 })
      ).rejects.toBeInstanceOf(TuningConfigurationError);
    } finally {
      currentPolicy = policy();
    }
  });

  it('requires the explicit gain-write opt-in', async () => {
    const id = nextLoopId();
    const { controller } = registerLoop(id);
    const before = controller.getGains();
    const proposal = await service.propose(id, 'rl',
      { kp: 1.1, ki: 0.1, kd: 0.05 }, PROPOSER, { reason: 'opt-in', confidence: 0.5 });

    currentPolicy = policy({ applyEnabled: false });
    try {
      await expect(service.decide(proposal.id, APPROVER, 'approve'))
        .rejects.toMatchObject({ reason: 'gain-apply-disabled' });
      expect(controller.getGains()).toEqual(before);
      expect(service.getProposal(proposal.id)?.status).toBe('pending');
    } finally {
      currentPolicy = policy();
    }
  });

  it('expired proposals can never be approved', async () => {
    const id = nextLoopId();
    const { controller } = registerLoop(id);
    const before = controller.getGains();

    currentPolicy = policy({ proposalTtlMs: 1 });
    let proposal: TuningProposal;
    try {
      proposal = await service.propose(id, 'rl',
        { kp: 1.1, ki: 0.1, kd: 0.05 }, PROPOSER, { reason: 'ttl', confidence: 0.5 });
    } finally {
      currentPolicy = policy();
    }
    await new Promise((resolve) => setTimeout(resolve, 10));

    await expect(service.decide(proposal.id, APPROVER, 'approve'))
      .rejects.toMatchObject({ reason: 'proposal-expired' });
    expect(service.getProposal(proposal.id)?.status).toBe('expired');
    expect(controller.getGains()).toEqual(before);
  });

  it('rejection leaves gains untouched and closes the proposal', async () => {
    const id = nextLoopId();
    const { controller } = registerLoop(id);
    const proposal = await service.propose(id, 'rl',
      { kp: 2, ki: 0.2, kd: 0.1 }, PROPOSER, { reason: 'test', confidence: 0.5 });
    const decided = await service.decide(proposal.id, APPROVER, 'reject', 'too aggressive');
    expect(decided.status).toBe('rejected');
    expect(controller.getGains()).toEqual({ kp: 1, ki: 0.1, kd: 0.05 });
    await expect(service.decide(proposal.id, APPROVER, 'approve')).rejects.toThrow(/already/);

    const rejections = (await auditFor(proposal.id))
      .filter((record) => record.decision === 'rejected');
    expect(rejections).toHaveLength(1);
    expect(rejections[0].decidedBy).toBe(APPROVER.name);
  });

  it('refuses out-of-envelope recommendations at proposal time, not apply time', async () => {
    const id = nextLoopId();
    service.registerLoop({
      id, name: id, gains: { kp: 1, ki: 0.1, kd: 0.05 },
      setpoint: 50, outputMin: 0, outputMax: 100,
      envelope: {
        kpRange: { min: 0, max: 1.2 },
        kiRange: { min: 0, max: 1 },
        kdRange: { min: 0, max: 1 },
      },
    });

    await expect(
      service.propose(id, 'cohen-coon', { kp: 99, ki: 0.11, kd: 0.05 }, PROPOSER,
        { reason: 'too hot', confidence: 0.7 })
    ).rejects.toBeInstanceOf(EnvelopeViolationError);

    // Nothing pending was created, and the refusal is on the durable record.
    expect(service.getProposals({ controllerId: id })).toHaveLength(0);
    const refusals = await store.list({ controllerId: id, decision: 'envelope-rejected' });
    expect(refusals).toHaveLength(1);
    expect(refusals[0].envelopeDecision).toBe('outside-envelope');
    expect(refusals[0].detail).toContain('kp=99');
  });

  it('re-checks the envelope at approval time when it was tightened afterwards', async () => {
    const id = nextLoopId();
    const { controller } = registerLoop(id);
    const before = controller.getGains();
    const proposal = await service.propose(id, 'rl',
      { kp: 1.2, ki: 0.1, kd: 0.05 }, PROPOSER, { reason: 'race', confidence: 0.5 });

    service.setEnvelope(id, {
      kpRange: { min: 0, max: 1.05 },
      kiRange: { min: 0, max: 1 },
      kdRange: { min: 0, max: 1 },
    });

    const decided = await service.decide(proposal.id, APPROVER, 'approve');
    expect(decided.status).toBe('failed');
    expect(controller.getGains()).toEqual(before);
    const failures = (await auditFor(proposal.id))
      .filter((record) => record.decision === 'failed');
    expect(failures[0].reasonCode).toBe('envelope-violation');
  });

  it("truncates large approved moves to the loop's own rate limit", async () => {
    const id = nextLoopId();
    const { controller } = service.registerLoop({
      id, name: id, gains: { kp: 1, ki: 0.1, kd: 0.05 },
      setpoint: 50, outputMin: 0, outputMax: 100,
      maxGainChangeFraction: 0.1,
    });
    const proposal = await service.propose(id, 'rl',
      { kp: 10, ki: 0.1, kd: 0.05 }, PROPOSER, { reason: 'big jump', confidence: 0.6 });
    const decided = await service.decide(proposal.id, APPROVER, 'approve');
    expect(decided.status).toBe('applied');
    expect(decided.fullyApplied).toBe(false);
    // One 10% step (the loop's configured limit), not the default 25%.
    expect(controller.getGains().kp).toBeCloseTo(1.1);

    const applied = (await auditFor(proposal.id))
      .find((record) => record.decision === 'applied')!;
    expect(applied.reasonCode).toBe('rate-limited-partial');
  });

  it('refuses to register a loop whose initial gains are outside its envelope', () => {
    expect(() => service.registerLoop({
      id: nextLoopId(), name: 'bad', gains: { kp: 5, ki: 0.1, kd: 0.05 },
      setpoint: 50, outputMin: 0, outputMax: 100,
      envelope: {
        kpRange: { min: 0, max: 1 },
        kiRange: { min: 0, max: 1 },
        kdRange: { min: 0, max: 1 },
      },
    })).toThrow(EnvelopeViolationError);
  });

  it('end-to-end: relay and RL tuning produce pending proposals, never direct changes', async () => {
    const id = nextLoopId();
    const { controller } = registerLoop(id, { kp: 0.5, ki: 0.05, kd: 0 });
    const before = controller.getGains();

    const relayProposal = await service.tuneRelay(id, MODEL, PROPOSER, { dtS: 0.1 });
    const { proposal: rlProposal } = await service.tuneRL(id, MODEL, PROPOSER, {
      episodes: 10, episodeTicks: 200, dtS: 0.5, seed: 5,
    });

    expect(relayProposal.status).toBe('pending');
    expect(rlProposal.status).toBe('pending');
    expect(controller.getGains()).toEqual(before);
    expect(service.getProposals({ controllerId: id })).toHaveLength(2);
  });
});

describe('the gate is unbypassable', () => {
  it('abandons the change when the durable record cannot be appended', async () => {
    const failing = new FailingAuditStore();
    const service = new TuningService({
      auditStore: failing,
      loadPolicy: () => policy(),
    });
    const { controller } = service.registerLoop({
      id: 'unbypassable-1', name: 'u1', gains: { kp: 1, ki: 0.1, kd: 0.05 },
      setpoint: 50, outputMin: 0, outputMax: 100,
    });

    // Even raising a proposal requires the durable trail.
    await expect(
      service.propose('unbypassable-1', 'rl', { kp: 1.1, ki: 0.1, kd: 0.05 },
        PROPOSER, { reason: 'no audit', confidence: 0.5 })
    ).rejects.toBeInstanceOf(TuningAuditUnavailableError);
    expect(failing.appendAttempts).toBeGreaterThan(0);
    expect(controller.getGains()).toEqual({ kp: 1, ki: 0.1, kd: 0.05 });
    expect(service.getProposals({ controllerId: 'unbypassable-1' })).toHaveLength(0);
  });

  it('no public entry point other than decide() can move a live gain', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'tuning-bypass-'));
    const store = new DrizzleTuningAuditStore({
      sqlitePath: path.join(directory, 'audit.sqlite'),
    });
    const service = new TuningService({ auditStore: store, loadPolicy: () => policy() });
    try {
      const id = 'unbypassable-2';
      const { controller } = service.registerLoop({
        id, name: 'u2', gains: { kp: 1, ki: 0.1, kd: 0.05 },
        setpoint: 50, outputMin: 0, outputMax: 100,
      });
      const before = controller.getGains();

      // Every public mutating entry point on the service, exercised for real.
      const proposal = await service.propose(id, 'monitor', { kp: 1.2, ki: 0.12, kd: 0.06 },
        PROPOSER, { reason: 'bypass probe', confidence: 0.5 });
      await service.tuneRelay(id, MODEL, PROPOSER, { dtS: 0.1 });
      await service.tuneCohenCoon(id, MODEL, PROPOSER);
      await service.tuneRL(id, MODEL, PROPOSER, { episodes: 5, episodeTicks: 100, dtS: 0.5, seed: 2 });
      service.setEnvelope(id, DEFAULT_ENVELOPE);
      service.getEnvelope(id);
      service.getProposals();
      await service.getAuditTrail({ controllerId: id });
      await service.healthCheck();

      // Re-registering an existing id would otherwise REPLACE the live
      // controller and install arbitrary gains with nothing but tuning.write:
      // no proposal, no approver, no apply opt-in, no rate limit, no audit
      // row. Registration is create-only precisely to close that path.
      expect(() => service.registerLoop({
        id, name: 'u2 overwrite', gains: { kp: 500, ki: 400, kd: 300 },
        setpoint: 50, outputMin: 0, outputMax: 100,
        envelope: {
          kpRange: { min: 0, max: 100_000 },
          kiRange: { min: 0, max: 100_000 },
          kdRange: { min: 0, max: 100_000 },
        },
      })).toThrow(LoopAlreadyRegisteredError);

      expect(controller.getGains()).toEqual(before);

      // Only a decision moves the gains.
      await service.decide(proposal.id, APPROVER, 'approve');
      expect(controller.getGains()).not.toEqual(before);
    } finally {
      await store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

// ── Regression: autotuner no longer self-applies (ADR-0013) ───────────────

describe('PIDAutoTuner', () => {
  it('emits recommendations but never applies gains itself', () => {
    const controller = new PIDController({
      id: 'auto', name: 'auto', gains: { kp: 1, ki: 0.1, kd: 0.05 },
      setpoint: 50, outputMin: 0, outputMax: 100,
    });
    const before = controller.getGains();
    const tuner = new PIDAutoTuner(controller);
    const applied = vi.fn();
    tuner.on('gains-applied', applied);

    // Degrade performance: large persistent error accumulates IAE
    for (let i = 0; i < 200; i++) controller.update(0, 1);
    const rec = tuner.evaluatePerformance();

    expect(rec).not.toBeNull();
    expect(controller.getGains()).toEqual(before);
    expect(applied).not.toHaveBeenCalled();
  });

  it('offers no mode that could re-enable self-apply', () => {
    const controller = new PIDController({
      id: 'auto-mode', name: 'auto', gains: { kp: 1, ki: 0.1, kd: 0.05 },
      setpoint: 50, outputMin: 0, outputMax: 100,
    });
    const tuner = new PIDAutoTuner(controller);
    // #215 removed AutoTuneMode outright; an inert 'automatic' setting would
    // only invite the self-apply branch back.
    expect('setMode' in tuner).toBe(false);
    expect('getMode' in tuner).toBe(false);
  });

  it('runs a relay experiment to completion without touching the gains', () => {
    const controller = new PIDController({
      id: 'auto-relay', name: 'auto', gains: { kp: 1, ki: 0.1, kd: 0.05 },
      setpoint: 50, outputMin: 0, outputMax: 100,
    });
    const before = controller.getGains();
    const tuner = new PIDAutoTuner(controller);
    const complete = vi.fn();
    tuner.on('relay-complete', complete);
    tuner.on('relay-failed', () => { /* insufficient data is acceptable here */ });

    tuner.startRelayTest();
    // Drive an oscillation around the setpoint until the test completes.
    for (let i = 0; i < 4000; i++) {
      if (tuner.relayStep(50 + 10 * Math.sin(i / 20)) === null) break;
    }

    expect(controller.getGains()).toEqual(before);
    for (const call of complete.mock.calls) {
      expect(call[0].gains).toBeDefined();
    }
  });
});
