/**
 * Decoherence Scheduler — Sensor Drift Modeling
 * 
 * Issue #352: Implement Decoherence Scheduler for sensor drift modeling
 * 
 * Models sensor calibration drift as "decoherence" — sensors lose accuracy
 * over time, influenced by environmental factors. Predicts when sensors will
 * exceed tolerance and schedules calibration maintenance.
 */

import { EventEmitter } from 'events';

// ─── Types ──────────────────────────────────────────────────────────────

export interface SensorCoherenceModel {
  sensorId: string;
  name: string;
  /** Current coherence score: 1.0 = perfectly calibrated, 0.0 = fully drifted */
  coherence: number;
  /** Base decoherence rate per hour (fraction of coherence lost) */
  baseDecoherenceRate: number;
  /** Minimum acceptable coherence before calibration is required */
  coherenceThreshold: number;
  /** Last calibration timestamp (ms) */
  lastCalibration: number;
  /** Predicted next calibration date (ms) */
  predictedCalibrationDate: number | null;
  /** Environmental factor multipliers */
  environmentalFactors: EnvironmentalFactors;
  /** Historical decoherence observations for rate estimation */
  history: CoherenceObservation[];
  /** Sensor age in days */
  ageDays: number;
  /** Whether calibration is overdue */
  overdue: boolean;
}

export interface EnvironmentalFactors {
  /** Temperature deviation from nominal (°C) — higher = faster decoherence */
  temperatureDeviation: number;
  /** Vibration level (g-force RMS) — higher = faster decoherence */
  vibrationLevel: number;
  /** Humidity deviation from nominal (%) */
  humidityDeviation: number;
}

export interface CoherenceObservation {
  timestamp: number;
  coherence: number;
  environmentalFactors?: Partial<EnvironmentalFactors>;
}

export interface CalibrationScheduleEntry {
  sensorId: string;
  sensorName: string;
  currentCoherence: number;
  predictedDate: number;
  urgency: 'low' | 'medium' | 'high' | 'critical';
  overdue: boolean;
}

export interface DecoherenceDashboardStatus {
  totalSensors: number;
  healthySensors: number;
  warningSensors: number;
  criticalSensors: number;
  overdueSensors: number;
  schedule: CalibrationScheduleEntry[];
  averageCoherence: number;
}

// ─── Constants ──────────────────────────────────────────────────────────

const AGE_FACTOR_BASE = 0.001;        // Additional decoherence per day of age
const TEMP_FACTOR = 0.02;             // Per °C deviation
const VIBRATION_FACTOR = 0.15;        // Per g-force RMS
const HUMIDITY_FACTOR = 0.005;        // Per % deviation
const MIN_HISTORY_FOR_ESTIMATION = 3;
const MAX_HISTORY = 500;

// ─── Scheduler ──────────────────────────────────────────────────────────

export class DecoherenceScheduler extends EventEmitter {
  private sensors: Map<string, SensorCoherenceModel> = new Map();

  getSensorCount(): number { return this.sensors.size; }

  // ─── Sensor management ─────────────────────────────────────────

  registerSensor(config: {
    sensorId: string;
    name: string;
    baseDecoherenceRate?: number;
    coherenceThreshold?: number;
    ageDays?: number;
  }): SensorCoherenceModel {
    const model: SensorCoherenceModel = {
      sensorId: config.sensorId,
      name: config.name,
      coherence: 1.0,
      baseDecoherenceRate: config.baseDecoherenceRate ?? 0.001,
      coherenceThreshold: config.coherenceThreshold ?? 0.7,
      lastCalibration: Date.now(),
      predictedCalibrationDate: null,
      environmentalFactors: { temperatureDeviation: 0, vibrationLevel: 0, humidityDeviation: 0 },
      history: [{ timestamp: Date.now(), coherence: 1.0 }],
      ageDays: config.ageDays ?? 0,
      overdue: false,
    };
    this.updatePrediction(model);
    this.sensors.set(config.sensorId, model);
    return model;
  }

  removeSensor(sensorId: string): boolean {
    return this.sensors.delete(sensorId);
  }

  getSensor(sensorId: string): SensorCoherenceModel | undefined {
    return this.sensors.get(sensorId);
  }

  getAllSensors(): SensorCoherenceModel[] {
    return Array.from(this.sensors.values());
  }

  // ─── Coherence updates ─────────────────────────────────────────

  /**
   * Record a coherence observation for a sensor.
   * Call this periodically with measured calibration accuracy.
   */
  recordObservation(
    sensorId: string,
    coherence: number,
    envFactors?: Partial<EnvironmentalFactors>,
  ): void {
    const sensor = this.sensors.get(sensorId);
    if (!sensor) return;

    sensor.coherence = Math.max(0, Math.min(1, coherence));
    if (envFactors) {
      Object.assign(sensor.environmentalFactors, envFactors);
    }

    sensor.history.push({
      timestamp: Date.now(),
      coherence: sensor.coherence,
      environmentalFactors: envFactors,
    });
    if (sensor.history.length > MAX_HISTORY) sensor.history.shift();

    // Re-estimate decoherence rate from history
    this.estimateDecoherenceRate(sensor);
    this.updatePrediction(sensor);

    // Check if calibration is due
    sensor.overdue = sensor.coherence <= sensor.coherenceThreshold;
    if (sensor.overdue) {
      this.emit('calibration-due', sensorId, sensor.coherence);
    }
  }

  /**
   * Simulate time passing — decay coherence for all sensors.
   * Call this on a timer (e.g., every minute or hour).
   */
  tick(elapsedHours: number): void {
    for (const sensor of this.sensors.values()) {
      const effectiveRate = this.computeEffectiveRate(sensor);
      // Exponential decay: C(t) = C₀ · e^(-λt)
      sensor.coherence *= Math.exp(-effectiveRate * elapsedHours);
      sensor.coherence = Math.max(0, sensor.coherence);

      sensor.history.push({ timestamp: Date.now(), coherence: sensor.coherence });
      if (sensor.history.length > MAX_HISTORY) sensor.history.shift();

      this.updatePrediction(sensor);

      const wasOverdue = sensor.overdue;
      sensor.overdue = sensor.coherence <= sensor.coherenceThreshold;
      if (sensor.overdue && !wasOverdue) {
        this.emit('calibration-due', sensor.sensorId, sensor.coherence);
      }
    }
  }

  /** Record that a sensor was calibrated — resets coherence to 1.0 */
  recordCalibration(sensorId: string): void {
    const sensor = this.sensors.get(sensorId);
    if (!sensor) return;
    sensor.coherence = 1.0;
    sensor.lastCalibration = Date.now();
    sensor.overdue = false;
    sensor.history.push({ timestamp: Date.now(), coherence: 1.0 });
    this.updatePrediction(sensor);
    this.emit('calibration-complete', sensorId);
  }

  /** Update environmental factors for a sensor */
  updateEnvironment(sensorId: string, factors: Partial<EnvironmentalFactors>): void {
    const sensor = this.sensors.get(sensorId);
    if (!sensor) return;
    Object.assign(sensor.environmentalFactors, factors);
    this.updatePrediction(sensor);
  }

  // ─── Rate estimation ───────────────────────────────────────────

  private estimateDecoherenceRate(sensor: SensorCoherenceModel): void {
    if (sensor.history.length < MIN_HISTORY_FOR_ESTIMATION) return;

    // Linear regression on ln(coherence) vs time to estimate decay rate
    const recent = sensor.history.slice(-50);
    const t0 = recent[0].timestamp;

    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
    let n = 0;

    for (const obs of recent) {
      if (obs.coherence <= 0) continue;
      const x = (obs.timestamp - t0) / 3_600_000; // hours
      const y = Math.log(obs.coherence);
      sumX += x;
      sumY += y;
      sumXY += x * y;
      sumX2 += x * x;
      n++;
    }

    if (n < MIN_HISTORY_FOR_ESTIMATION || sumX2 * n - sumX * sumX === 0) return;

    const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
    // slope should be negative (decay); rate = -slope
    if (slope < 0) {
      sensor.baseDecoherenceRate = Math.min(1, -slope);
    }
  }

  private computeEffectiveRate(sensor: SensorCoherenceModel): number {
    const env = sensor.environmentalFactors;
    const ageFactor = AGE_FACTOR_BASE * Math.sqrt(sensor.ageDays);
    const tempFactor = TEMP_FACTOR * Math.abs(env.temperatureDeviation);
    const vibFactor = VIBRATION_FACTOR * env.vibrationLevel;
    const humFactor = HUMIDITY_FACTOR * Math.abs(env.humidityDeviation);

    return sensor.baseDecoherenceRate * (1 + tempFactor + vibFactor + humFactor + ageFactor);
  }

  private updatePrediction(sensor: SensorCoherenceModel): void {
    if (sensor.coherence <= sensor.coherenceThreshold) {
      sensor.predictedCalibrationDate = Date.now(); // Already due
      return;
    }

    const rate = this.computeEffectiveRate(sensor);
    if (rate <= 0) {
      sensor.predictedCalibrationDate = null;
      return;
    }

    // Time to reach threshold: C·e^(-λt) = threshold → t = -ln(threshold/C) / λ
    const hoursUntilDue = -Math.log(sensor.coherenceThreshold / sensor.coherence) / rate;
    sensor.predictedCalibrationDate = Date.now() + hoursUntilDue * 3_600_000;
  }

  // ─── Dashboard ─────────────────────────────────────────────────

  getDashboardStatus(): DecoherenceDashboardStatus {
    const sensors = Array.from(this.sensors.values());
    let totalCoherence = 0;
    let healthy = 0, warning = 0, critical = 0, overdue = 0;
    const schedule: CalibrationScheduleEntry[] = [];

    for (const s of sensors) {
      totalCoherence += s.coherence;

      if (s.overdue) overdue++;
      if (s.coherence > 0.85) healthy++;
      else if (s.coherence > s.coherenceThreshold) warning++;
      else critical++;

      const urgency = s.overdue ? 'critical' as const
        : s.coherence < s.coherenceThreshold + 0.1 ? 'high' as const
        : s.coherence < 0.85 ? 'medium' as const
        : 'low' as const;

      schedule.push({
        sensorId: s.sensorId,
        sensorName: s.name,
        currentCoherence: s.coherence,
        predictedDate: s.predictedCalibrationDate ?? 0,
        urgency,
        overdue: s.overdue,
      });
    }

    // Sort by urgency (critical first, then by predicted date)
    const urgencyOrder = { critical: 0, high: 1, medium: 2, low: 3 };
    schedule.sort((a, b) => urgencyOrder[a.urgency] - urgencyOrder[b.urgency] || a.predictedDate - b.predictedDate);

    return {
      totalSensors: sensors.length,
      healthySensors: healthy,
      warningSensors: warning,
      criticalSensors: critical,
      overdueSensors: overdue,
      schedule,
      averageCoherence: sensors.length > 0 ? totalCoherence / sensors.length : 1.0,
    };
  }
}
