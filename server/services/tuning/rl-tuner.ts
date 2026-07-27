/**
 * RL-Based PID Tuner
 * ADR-0013 [13.4] — Issue #215
 *
 * Tabular Q-learning over multiplicative gain adjustments, evaluated in
 * closed-loop episodes against a FOPDT process model. Exploration happens
 * strictly in simulation (ADR-0009); the outcome is a recommendation that
 * still requires human approval before touching a controller.
 *
 * State  — discretized episode performance (overshoot bucket × settling
 *          bucket × oscillation flag) of the current gains.
 * Action — one of nine gain nudges (±20% per term, ±10% all, no-op),
 *          always clamped to the safety envelope.
 * Reward — −normalized ITAE − overshoot penalty − oscillation penalty.
 */

import type {
  EpisodeMetrics,
  FOPDTModel,
  GainEnvelope,
  RLEpisode,
  RLTunerConfig,
  RLTuningOutcome,
} from '@shared/types/tuning';
import type { PIDGains } from '../optimization/pid-controller';
import { clampToEnvelope } from './envelope';
import { makeRng, runClosedLoopEpisode } from './process-sim';

export const DEFAULT_RL_CONFIG: RLTunerConfig = {
  episodes: 60,
  episodeTicks: 600,
  dtS: 0.5,
  epsilon: 0.4,
  epsilonDecay: 0.95,
  learningRate: 0.3,
  discount: 0.8,
  overshootPenalty: 50,
  oscillationPenalty: 20,
  seed: 42,
};

interface Action {
  name: string;
  apply: (g: PIDGains) => PIDGains;
}

const ACTIONS: Action[] = [
  { name: 'kp+20%', apply: (g) => ({ ...g, kp: g.kp * 1.2 }) },
  { name: 'kp-20%', apply: (g) => ({ ...g, kp: g.kp * 0.8 }) },
  { name: 'ki+20%', apply: (g) => ({ ...g, ki: g.ki * 1.2 }) },
  { name: 'ki-20%', apply: (g) => ({ ...g, ki: g.ki * 0.8 }) },
  { name: 'kd+20%', apply: (g) => ({ ...g, kd: g.kd * 1.2 }) },
  { name: 'kd-20%', apply: (g) => ({ ...g, kd: g.kd * 0.8 }) },
  { name: 'all+10%', apply: (g) => ({ kp: g.kp * 1.1, ki: g.ki * 1.1, kd: g.kd * 1.1 }) },
  { name: 'all-10%', apply: (g) => ({ kp: g.kp * 0.9, ki: g.ki * 0.9, kd: g.kd * 0.9 }) },
  { name: 'hold', apply: (g) => ({ ...g }) },
];

function discretizeState(metrics: EpisodeMetrics, episodeSeconds: number): string {
  const overshootBucket =
    metrics.overshoot < 0.05 ? 0 : metrics.overshoot < 0.15 ? 1 : metrics.overshoot < 0.3 ? 2 : 3;
  const settle = metrics.settlingTimeS;
  const settleBucket =
    settle === null
      ? 3
      : settle < episodeSeconds * 0.25
        ? 0
        : settle < episodeSeconds * 0.5
          ? 1
          : 2;
  return `${overshootBucket}:${settleBucket}:${metrics.oscillating ? 1 : 0}`;
}

function computeReward(metrics: EpisodeMetrics, config: RLTunerConfig, setpoint: number): number {
  const episodeSeconds = config.episodeTicks * config.dtS;
  // Normalize ITAE by the worst case of holding max error the whole episode
  const worstItae = (Math.abs(setpoint) || 1) * episodeSeconds * episodeSeconds * 0.5;
  const itaeNorm = worstItae > 0 ? metrics.itae / worstItae : metrics.itae;
  return (
    -itaeNorm * 100 -
    config.overshootPenalty * metrics.overshoot -
    (metrics.oscillating ? config.oscillationPenalty : 0)
  );
}

export function runRLTuning(
  initialGains: PIDGains,
  model: FOPDTModel,
  envelope: GainEnvelope,
  setpoint: number,
  configOverrides: Partial<RLTunerConfig> = {}
): RLTuningOutcome {
  const config: RLTunerConfig = { ...DEFAULT_RL_CONFIG, ...configOverrides };
  const rng = makeRng(config.seed ?? 42);
  const episodeSeconds = config.episodeTicks * config.dtS;
  const q = new Map<string, number[]>();
  const qFor = (state: string): number[] => {
    let row = q.get(state);
    if (!row) {
      row = new Array(ACTIONS.length).fill(0);
      q.set(state, row);
    }
    return row;
  };

  const evaluate = (gains: PIDGains): { metrics: EpisodeMetrics; reward: number } => {
    const metrics = runClosedLoopEpisode(gains, model, {
      setpoint,
      ticks: config.episodeTicks,
      dtS: config.dtS,
      seed: config.seed,
    });
    return { metrics, reward: computeReward(metrics, config, setpoint) };
  };

  let currentGains = clampToEnvelope(initialGains, envelope).gains;
  let { metrics: currentMetrics, reward: currentReward } = evaluate(currentGains);
  const initialReward = currentReward;
  let bestGains = currentGains;
  let bestReward = currentReward;
  let epsilon = config.epsilon;

  const episodes: RLEpisode[] = [];

  for (let episode = 0; episode < config.episodes; episode++) {
    const state = discretizeState(currentMetrics, episodeSeconds);
    const row = qFor(state);

    const explored = rng() < epsilon;
    const actionIndex = explored
      ? Math.floor(rng() * ACTIONS.length)
      : row.indexOf(Math.max(...row));
    const action = ACTIONS[actionIndex];

    const candidate = clampToEnvelope(action.apply(currentGains), envelope).gains;
    const { metrics: candidateMetrics, reward: candidateReward } = evaluate(candidate);
    const nextState = discretizeState(candidateMetrics, episodeSeconds);
    const nextRow = qFor(nextState);

    // Q-learning update: reward for taking `action` in `state`
    row[actionIndex] +=
      config.learningRate *
      (candidateReward + config.discount * Math.max(...nextRow) - row[actionIndex]);

    // Greedy hill-climb over the accepted point: only move when better —
    // the Q-table still learns from every attempt.
    if (candidateReward >= currentReward) {
      currentGains = candidate;
      currentMetrics = candidateMetrics;
      currentReward = candidateReward;
    }
    if (candidateReward > bestReward) {
      bestGains = candidate;
      bestReward = candidateReward;
    }

    episodes.push({
      episode,
      gains: candidate,
      reward: candidateReward,
      metrics: candidateMetrics,
      action: action.name,
      explored,
    });

    epsilon *= config.epsilonDecay;
  }

  return {
    bestGains,
    bestReward,
    initialReward,
    improvedOverInitial: bestReward > initialReward,
    episodes,
  };
}
