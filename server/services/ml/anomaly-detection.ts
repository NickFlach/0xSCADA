/**
 * Predictive Maintenance Anomaly Detection Engine
 *
 * Issue #84: AI/ML Predictive Maintenance
 *
 * This module implements statistical anomaly detection for SCADA sensor data
 * to enable predictive maintenance capabilities. It uses real statistical
 * algorithms without external ML dependencies.
 *
 * Features:
 * - Z-Score based anomaly detection
 * - Interquartile Range (IQR) outlier detection
 * - Modified Z-Score (MAD-based) for robust detection
 * - Exponential Moving Average (EMA) trend analysis
 * - Simple Moving Average (SMA) with standard deviation bands
 * - Rate of change detection
 * - Configurable thresholds and sensitivity
 * - Anomaly history storage and querying
 * - Alert generation with severity levels
 */

import { EventEmitter } from "events";
import {
  getEventService,
  EventType,
  OriginType,
  type SignedEvent,
} from "../../events";

// =============================================================================
// TYPES
// =============================================================================

export type AnomalySeverity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO";
export type AnomalyType =
  | "ZSCORE"
  | "IQR"
  | "MODIFIED_ZSCORE"
  | "TREND"
  | "RATE_OF_CHANGE"
  | "THRESHOLD"
  | "PATTERN";
export type AlertStatus = "ACTIVE" | "ACKNOWLEDGED" | "RESOLVED" | "SUPPRESSED";

/**
 * Configuration for a monitored sensor/tag
 */
export interface SensorConfig {
  tagName: string;
  assetId: string;
  siteId: string;
  enabled: boolean;
  // Detection methods to use
  methods: {
    zscore?: ZScoreConfig;
    iqr?: IQRConfig;
    modifiedZscore?: ModifiedZScoreConfig;
    trend?: TrendConfig;
    rateOfChange?: RateOfChangeConfig;
    threshold?: ThresholdConfig;
  };
  // General settings
  windowSize: number; // Number of samples to keep in rolling window
  minSamples: number; // Minimum samples before detection starts
  cooldownPeriod: number; // Milliseconds between alerts for same anomaly type
}

export interface ZScoreConfig {
  enabled: boolean;
  threshold: number; // Standard deviations from mean (e.g., 3.0)
  severity: AnomalySeverity;
}

export interface IQRConfig {
  enabled: boolean;
  multiplier: number; // IQR multiplier for outlier detection (e.g., 1.5)
  severity: AnomalySeverity;
}

export interface ModifiedZScoreConfig {
  enabled: boolean;
  threshold: number; // Threshold for modified z-score (e.g., 3.5)
  severity: AnomalySeverity;
}

export interface TrendConfig {
  enabled: boolean;
  windowSize: number; // Samples for trend calculation
  slopeThreshold: number; // Rate of change threshold per sample
  severity: AnomalySeverity;
}

export interface RateOfChangeConfig {
  enabled: boolean;
  maxChangePercent: number; // Maximum % change between consecutive samples
  minAbsoluteChange: number; // Minimum absolute change to trigger (filters noise)
  severity: AnomalySeverity;
}

export interface ThresholdConfig {
  enabled: boolean;
  highHigh?: number;
  high?: number;
  low?: number;
  lowLow?: number;
  deadband?: number;
}

/**
 * A detected anomaly
 */
export interface Anomaly {
  id: string;
  tagName: string;
  assetId: string;
  siteId: string;
  type: AnomalyType;
  severity: AnomalySeverity;
  value: number;
  expectedValue: number;
  deviation: number;
  timestamp: Date;
  message: string;
  metadata: Record<string, unknown>;
}

/**
 * An alert generated from an anomaly
 */
export interface AnomalyAlert {
  id: string;
  anomalyId: string;
  tagName: string;
  assetId: string;
  siteId: string;
  type: AnomalyType;
  severity: AnomalySeverity;
  status: AlertStatus;
  message: string;
  createdAt: Date;
  acknowledgedAt?: Date;
  acknowledgedBy?: string;
  resolvedAt?: Date;
  eventHash?: string;
}

/**
 * Statistics for a sensor's data window
 */
export interface SensorStatistics {
  tagName: string;
  sampleCount: number;
  mean: number;
  standardDeviation: number;
  variance: number;
  median: number;
  q1: number;
  q3: number;
  iqr: number;
  min: number;
  max: number;
  mad: number; // Median Absolute Deviation
  ema: number; // Exponential Moving Average
  sma: number; // Simple Moving Average
  slope: number; // Current trend slope
  lastValue: number;
  lastTimestamp: Date;
}

/**
 * Health score for predictive maintenance
 */
export interface HealthScore {
  tagName: string;
  assetId: string;
  score: number; // 0-100, where 100 is healthy
  trend: "IMPROVING" | "STABLE" | "DEGRADING";
  anomalyCount24h: number;
  lastAnomaly?: Date;
  factors: {
    stability: number;
    trendHealth: number;
    outlierFrequency: number;
  };
}

// =============================================================================
// STATISTICAL FUNCTIONS
// =============================================================================

/**
 * Calculate the mean of an array of numbers
 */
export function calculateMean(values: number[]): number {
  if (values.length === 0) return 0;
  const sum = values.reduce((acc, val) => acc + val, 0);
  return sum / values.length;
}

/**
 * Calculate the variance of an array of numbers
 */
export function calculateVariance(values: number[], mean?: number): number {
  if (values.length < 2) return 0;
  const m = mean ?? calculateMean(values);
  const squaredDiffs = values.map((v) => Math.pow(v - m, 2));
  return squaredDiffs.reduce((acc, val) => acc + val, 0) / (values.length - 1);
}

/**
 * Calculate the standard deviation of an array of numbers
 */
export function calculateStandardDeviation(
  values: number[],
  mean?: number
): number {
  return Math.sqrt(calculateVariance(values, mean));
}

/**
 * Calculate the median of an array of numbers
 */
export function calculateMedian(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Calculate quartiles (Q1, Q2/Median, Q3)
 */
export function calculateQuartiles(values: number[]): {
  q1: number;
  q2: number;
  q3: number;
} {
  if (values.length === 0) return { q1: 0, q2: 0, q3: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;

  const q2 = calculateMedian(sorted);

  const lowerHalf = sorted.slice(0, Math.floor(n / 2));
  const upperHalf = sorted.slice(Math.ceil(n / 2));

  const q1 = calculateMedian(lowerHalf);
  const q3 = calculateMedian(upperHalf);

  return { q1, q2, q3 };
}

/**
 * Calculate the Interquartile Range (IQR)
 */
export function calculateIQR(values: number[]): number {
  const { q1, q3 } = calculateQuartiles(values);
  return q3 - q1;
}

/**
 * Calculate the Median Absolute Deviation (MAD)
 */
export function calculateMAD(values: number[]): number {
  if (values.length === 0) return 0;
  const median = calculateMedian(values);
  const absoluteDeviations = values.map((v) => Math.abs(v - median));
  return calculateMedian(absoluteDeviations);
}

/**
 * Calculate Z-Score for a value given mean and standard deviation
 */
export function calculateZScore(
  value: number,
  mean: number,
  stdDev: number
): number {
  if (stdDev === 0) return 0;
  return (value - mean) / stdDev;
}

/**
 * Calculate Modified Z-Score using MAD (more robust to outliers)
 * Uses the constant 0.6745 which is the approximate value of the
 * inverse of the cumulative distribution function of the standard
 * normal distribution at 0.75
 */
export function calculateModifiedZScore(
  value: number,
  median: number,
  mad: number
): number {
  if (mad === 0) return 0;
  const k = 0.6745; // Consistency constant for normal distribution
  return (k * (value - median)) / mad;
}

/**
 * Calculate Simple Moving Average (SMA)
 */
export function calculateSMA(values: number[], windowSize: number): number {
  if (values.length === 0) return 0;
  const window = values.slice(-windowSize);
  return calculateMean(window);
}

/**
 * Calculate Exponential Moving Average (EMA)
 */
export function calculateEMA(
  values: number[],
  alpha: number = 0.2
): number {
  if (values.length === 0) return 0;
  if (values.length === 1) return values[0];

  let ema = values[0];
  for (let i = 1; i < values.length; i++) {
    ema = alpha * values[i] + (1 - alpha) * ema;
  }
  return ema;
}

/**
 * Calculate linear regression slope using least squares method
 */
export function calculateSlope(values: number[]): number {
  const n = values.length;
  if (n < 2) return 0;

  // X values are indices 0, 1, 2, ...
  // Using simplified formula for sequential x values
  const sumY = values.reduce((acc, val) => acc + val, 0);
  const sumX = (n * (n - 1)) / 2; // Sum of 0 to n-1
  const sumXX = (n * (n - 1) * (2 * n - 1)) / 6; // Sum of squares of 0 to n-1
  const sumXY = values.reduce((acc, val, i) => acc + i * val, 0);

  const denominator = n * sumXX - sumX * sumX;
  if (denominator === 0) return 0;

  return (n * sumXY - sumX * sumY) / denominator;
}

/**
 * Detect if a value is an outlier using IQR method
 */
export function isIQROutlier(
  value: number,
  q1: number,
  q3: number,
  multiplier: number = 1.5
): { isOutlier: boolean; bound: "upper" | "lower" | null } {
  const iqr = q3 - q1;
  const lowerBound = q1 - multiplier * iqr;
  const upperBound = q3 + multiplier * iqr;

  if (value < lowerBound) {
    return { isOutlier: true, bound: "lower" };
  }
  if (value > upperBound) {
    return { isOutlier: true, bound: "upper" };
  }
  return { isOutlier: false, bound: null };
}

// =============================================================================
// ROLLING WINDOW DATA STORE
// =============================================================================

/**
 * Circular buffer for efficient rolling window storage
 */
export class RollingWindow {
  private buffer: number[];
  private timestamps: Date[];
  private maxSize: number;
  private head: number = 0;
  private count: number = 0;

  constructor(maxSize: number) {
    this.maxSize = maxSize;
    this.buffer = new Array(maxSize);
    this.timestamps = new Array(maxSize);
  }

  push(value: number, timestamp: Date = new Date()): void {
    this.buffer[this.head] = value;
    this.timestamps[this.head] = timestamp;
    this.head = (this.head + 1) % this.maxSize;
    if (this.count < this.maxSize) {
      this.count++;
    }
  }

  getValues(): number[] {
    if (this.count < this.maxSize) {
      return this.buffer.slice(0, this.count);
    }
    // Reconstruct in order from oldest to newest
    const result: number[] = new Array(this.maxSize);
    for (let i = 0; i < this.maxSize; i++) {
      const idx = (this.head + i) % this.maxSize;
      result[i] = this.buffer[idx];
    }
    return result;
  }

  getTimestamps(): Date[] {
    if (this.count < this.maxSize) {
      return this.timestamps.slice(0, this.count);
    }
    const result: Date[] = new Array(this.maxSize);
    for (let i = 0; i < this.maxSize; i++) {
      const idx = (this.head + i) % this.maxSize;
      result[i] = this.timestamps[idx];
    }
    return result;
  }

  getLastValue(): number | undefined {
    if (this.count === 0) return undefined;
    const lastIdx = (this.head - 1 + this.maxSize) % this.maxSize;
    return this.buffer[lastIdx];
  }

  getLastTimestamp(): Date | undefined {
    if (this.count === 0) return undefined;
    const lastIdx = (this.head - 1 + this.maxSize) % this.maxSize;
    return this.timestamps[lastIdx];
  }

  size(): number {
    return this.count;
  }

  clear(): void {
    this.head = 0;
    this.count = 0;
  }
}

// =============================================================================
// ANOMALY DETECTION ENGINE
// =============================================================================

/**
 * Predictive Maintenance Anomaly Detection Engine
 *
 * Monitors sensor data streams and detects statistical anomalies
 * for predictive maintenance applications.
 */
export class AnomalyDetectionEngine extends EventEmitter {
  private sensorConfigs: Map<string, SensorConfig> = new Map();
  private sensorWindows: Map<string, RollingWindow> = new Map();
  private anomalyHistory: Map<string, Anomaly[]> = new Map();
  private activeAlerts: Map<string, AnomalyAlert> = new Map();
  private alertHistory: AnomalyAlert[] = [];
  private lastAlertTimes: Map<string, Map<AnomalyType, number>> = new Map();

  private siteId: string = "SITE-001";
  private originId: string = "ANOMALY-DETECTION-ENGINE";
  private maxHistoryPerSensor: number = 1000;
  private maxAlertHistory: number = 10000;

  constructor() {
    super();
  }

  // ===========================================================================
  // CONFIGURATION
  // ===========================================================================

  /**
   * Set the site ID for event generation
   */
  setSiteId(siteId: string): void {
    this.siteId = siteId;
  }

  /**
   * Register a sensor for monitoring
   */
  registerSensor(config: SensorConfig): void {
    this.sensorConfigs.set(config.tagName, config);
    this.sensorWindows.set(config.tagName, new RollingWindow(config.windowSize));
    this.anomalyHistory.set(config.tagName, []);
    this.lastAlertTimes.set(config.tagName, new Map());

    console.log(
      `[AnomalyDetection] Registered sensor: ${config.tagName} (window: ${config.windowSize})`
    );
  }

  /**
   * Unregister a sensor
   */
  unregisterSensor(tagName: string): void {
    this.sensorConfigs.delete(tagName);
    this.sensorWindows.delete(tagName);
    this.anomalyHistory.delete(tagName);
    this.lastAlertTimes.delete(tagName);
  }

  /**
   * Update sensor configuration
   */
  updateSensorConfig(tagName: string, updates: Partial<SensorConfig>): boolean {
    const config = this.sensorConfigs.get(tagName);
    if (!config) return false;

    const updatedConfig = { ...config, ...updates };
    this.sensorConfigs.set(tagName, updatedConfig);

    // Resize window if needed
    if (updates.windowSize && updates.windowSize !== config.windowSize) {
      const oldWindow = this.sensorWindows.get(tagName);
      const newWindow = new RollingWindow(updates.windowSize);
      if (oldWindow) {
        const values = oldWindow.getValues();
        const timestamps = oldWindow.getTimestamps();
        const startIdx = Math.max(0, values.length - updates.windowSize);
        for (let i = startIdx; i < values.length; i++) {
          newWindow.push(values[i], timestamps[i]);
        }
      }
      this.sensorWindows.set(tagName, newWindow);
    }

    return true;
  }

  /**
   * Create a default sensor configuration
   */
  static createDefaultConfig(
    tagName: string,
    assetId: string,
    siteId: string
  ): SensorConfig {
    return {
      tagName,
      assetId,
      siteId,
      enabled: true,
      windowSize: 100,
      minSamples: 20,
      cooldownPeriod: 60000, // 1 minute
      methods: {
        zscore: {
          enabled: true,
          threshold: 3.0,
          severity: "HIGH",
        },
        iqr: {
          enabled: true,
          multiplier: 1.5,
          severity: "MEDIUM",
        },
        modifiedZscore: {
          enabled: true,
          threshold: 3.5,
          severity: "HIGH",
        },
        trend: {
          enabled: true,
          windowSize: 20,
          slopeThreshold: 0.1,
          severity: "MEDIUM",
        },
        rateOfChange: {
          enabled: true,
          maxChangePercent: 20,
          minAbsoluteChange: 1,
          severity: "HIGH",
        },
      },
    };
  }

  // ===========================================================================
  // DATA PROCESSING
  // ===========================================================================

  /**
   * Process a new sensor reading
   */
  processReading(
    tagName: string,
    value: number,
    timestamp: Date = new Date()
  ): Anomaly[] {
    const config = this.sensorConfigs.get(tagName);
    if (!config || !config.enabled) {
      return [];
    }

    const window = this.sensorWindows.get(tagName);
    if (!window) {
      return [];
    }

    // Get previous value for rate of change detection
    const previousValue = window.getLastValue();

    // Add new reading to window
    window.push(value, timestamp);

    // Check if we have enough samples
    if (window.size() < config.minSamples) {
      return [];
    }

    // Run anomaly detection
    const anomalies: Anomaly[] = [];
    const stats = this.calculateStatistics(tagName);

    if (!stats) return [];

    // Z-Score detection
    if (config.methods.zscore?.enabled) {
      const zscore = calculateZScore(value, stats.mean, stats.standardDeviation);
      if (Math.abs(zscore) > config.methods.zscore.threshold) {
        const anomaly = this.createAnomaly(
          config,
          "ZSCORE",
          config.methods.zscore.severity,
          value,
          stats.mean,
          zscore,
          timestamp,
          {
            zscore,
            threshold: config.methods.zscore.threshold,
            mean: stats.mean,
            stdDev: stats.standardDeviation,
          }
        );
        anomalies.push(anomaly);
      }
    }

    // IQR detection
    if (config.methods.iqr?.enabled) {
      const iqrResult = isIQROutlier(
        value,
        stats.q1,
        stats.q3,
        config.methods.iqr.multiplier
      );
      if (iqrResult.isOutlier) {
        const iqr = stats.q3 - stats.q1;
        const deviation =
          iqrResult.bound === "upper"
            ? value - (stats.q3 + config.methods.iqr.multiplier * iqr)
            : (stats.q1 - config.methods.iqr.multiplier * iqr) - value;
        const anomaly = this.createAnomaly(
          config,
          "IQR",
          config.methods.iqr.severity,
          value,
          stats.median,
          deviation,
          timestamp,
          {
            bound: iqrResult.bound,
            q1: stats.q1,
            q3: stats.q3,
            iqr,
            multiplier: config.methods.iqr.multiplier,
          }
        );
        anomalies.push(anomaly);
      }
    }

    // Modified Z-Score detection (robust to outliers)
    if (config.methods.modifiedZscore?.enabled) {
      const modZscore = calculateModifiedZScore(value, stats.median, stats.mad);
      if (Math.abs(modZscore) > config.methods.modifiedZscore.threshold) {
        const anomaly = this.createAnomaly(
          config,
          "MODIFIED_ZSCORE",
          config.methods.modifiedZscore.severity,
          value,
          stats.median,
          modZscore,
          timestamp,
          {
            modifiedZscore: modZscore,
            threshold: config.methods.modifiedZscore.threshold,
            median: stats.median,
            mad: stats.mad,
          }
        );
        anomalies.push(anomaly);
      }
    }

    // Trend detection
    if (config.methods.trend?.enabled) {
      const trendValues = window
        .getValues()
        .slice(-config.methods.trend.windowSize);
      if (trendValues.length >= config.methods.trend.windowSize) {
        const slope = calculateSlope(trendValues);
        if (Math.abs(slope) > config.methods.trend.slopeThreshold) {
          const trendDirection = slope > 0 ? "increasing" : "decreasing";
          const anomaly = this.createAnomaly(
            config,
            "TREND",
            config.methods.trend.severity,
            value,
            stats.ema,
            slope,
            timestamp,
            {
              slope,
              threshold: config.methods.trend.slopeThreshold,
              direction: trendDirection,
              windowSize: config.methods.trend.windowSize,
            }
          );
          anomalies.push(anomaly);
        }
      }
    }

    // Rate of change detection
    if (config.methods.rateOfChange?.enabled && previousValue !== undefined) {
      const absoluteChange = Math.abs(value - previousValue);
      const percentChange =
        previousValue !== 0
          ? (absoluteChange / Math.abs(previousValue)) * 100
          : absoluteChange > 0
          ? 100
          : 0;

      if (
        percentChange > config.methods.rateOfChange.maxChangePercent &&
        absoluteChange > config.methods.rateOfChange.minAbsoluteChange
      ) {
        const anomaly = this.createAnomaly(
          config,
          "RATE_OF_CHANGE",
          config.methods.rateOfChange.severity,
          value,
          previousValue,
          percentChange,
          timestamp,
          {
            previousValue,
            absoluteChange,
            percentChange,
            maxChangePercent: config.methods.rateOfChange.maxChangePercent,
          }
        );
        anomalies.push(anomaly);
      }
    }

    // Threshold detection (if configured)
    if (config.methods.threshold?.enabled) {
      const thresholdAnomalies = this.checkThresholds(
        config,
        value,
        timestamp,
        config.methods.threshold
      );
      anomalies.push(...thresholdAnomalies);
    }

    // Store anomalies and generate alerts
    for (const anomaly of anomalies) {
      this.storeAnomaly(tagName, anomaly);
      this.maybeGenerateAlert(anomaly);
    }

    return anomalies;
  }

  /**
   * Process multiple readings in batch
   */
  processBatch(
    readings: Array<{ tagName: string; value: number; timestamp?: Date }>
  ): Map<string, Anomaly[]> {
    const results = new Map<string, Anomaly[]>();

    for (const reading of readings) {
      const anomalies = this.processReading(
        reading.tagName,
        reading.value,
        reading.timestamp
      );
      if (anomalies.length > 0) {
        const existing = results.get(reading.tagName) || [];
        results.set(reading.tagName, [...existing, ...anomalies]);
      }
    }

    return results;
  }

  // ===========================================================================
  // STATISTICS
  // ===========================================================================

  /**
   * Calculate statistics for a sensor's current data window
   */
  calculateStatistics(tagName: string): SensorStatistics | null {
    const window = this.sensorWindows.get(tagName);
    if (!window || window.size() === 0) return null;

    const values = window.getValues();
    const mean = calculateMean(values);
    const variance = calculateVariance(values, mean);
    const stdDev = Math.sqrt(variance);
    const { q1, q2: median, q3 } = calculateQuartiles(values);
    const iqr = q3 - q1;
    const mad = calculateMAD(values);
    const ema = calculateEMA(values);
    const sma = calculateSMA(values, Math.min(20, values.length));
    const slope = calculateSlope(values);

    return {
      tagName,
      sampleCount: values.length,
      mean,
      standardDeviation: stdDev,
      variance,
      median,
      q1,
      q3,
      iqr,
      min: Math.min(...values),
      max: Math.max(...values),
      mad,
      ema,
      sma,
      slope,
      lastValue: values[values.length - 1],
      lastTimestamp: window.getLastTimestamp() || new Date(),
    };
  }

  /**
   * Get statistics for all monitored sensors
   */
  getAllStatistics(): Map<string, SensorStatistics> {
    const results = new Map<string, SensorStatistics>();
    for (const tagName of this.sensorConfigs.keys()) {
      const stats = this.calculateStatistics(tagName);
      if (stats) {
        results.set(tagName, stats);
      }
    }
    return results;
  }

  // ===========================================================================
  // HEALTH SCORING
  // ===========================================================================

  /**
   * Calculate health score for a sensor/asset
   */
  calculateHealthScore(tagName: string): HealthScore | null {
    const config = this.sensorConfigs.get(tagName);
    const stats = this.calculateStatistics(tagName);
    const history = this.anomalyHistory.get(tagName);

    if (!config || !stats || !history) return null;

    // Count anomalies in last 24 hours
    const now = Date.now();
    const oneDayAgo = now - 24 * 60 * 60 * 1000;
    const recentAnomalies = history.filter(
      (a) => a.timestamp.getTime() > oneDayAgo
    );

    // Calculate stability factor (0-100)
    // Lower coefficient of variation = more stable
    const cv =
      stats.mean !== 0 ? Math.abs(stats.standardDeviation / stats.mean) : 0;
    const stability = Math.max(0, Math.min(100, 100 - cv * 100));

    // Calculate trend health (0-100)
    // Steeper slopes = less healthy
    const normalizedSlope = Math.abs(stats.slope);
    const trendHealth = Math.max(0, Math.min(100, 100 - normalizedSlope * 500));

    // Calculate outlier frequency factor (0-100)
    // More anomalies = less healthy
    const anomalyRate = recentAnomalies.length / 24; // Anomalies per hour
    const outlierFrequency = Math.max(0, Math.min(100, 100 - anomalyRate * 10));

    // Combined score (weighted average)
    const score = Math.round(
      stability * 0.3 + trendHealth * 0.3 + outlierFrequency * 0.4
    );

    // Determine trend
    let trend: "IMPROVING" | "STABLE" | "DEGRADING";
    if (stats.slope > 0.05) {
      trend = "DEGRADING";
    } else if (stats.slope < -0.05) {
      trend = "IMPROVING";
    } else {
      trend = "STABLE";
    }

    return {
      tagName,
      assetId: config.assetId,
      score,
      trend,
      anomalyCount24h: recentAnomalies.length,
      lastAnomaly:
        recentAnomalies.length > 0
          ? recentAnomalies[recentAnomalies.length - 1].timestamp
          : undefined,
      factors: {
        stability: Math.round(stability),
        trendHealth: Math.round(trendHealth),
        outlierFrequency: Math.round(outlierFrequency),
      },
    };
  }

  // ===========================================================================
  // ALERTS
  // ===========================================================================

  /**
   * Get all active alerts
   */
  getActiveAlerts(): AnomalyAlert[] {
    return Array.from(this.activeAlerts.values());
  }

  /**
   * Get active alerts for a specific sensor
   */
  getActiveAlertsForSensor(tagName: string): AnomalyAlert[] {
    return this.getActiveAlerts().filter((a) => a.tagName === tagName);
  }

  /**
   * Acknowledge an alert
   */
  acknowledgeAlert(alertId: string, userId: string): boolean {
    const alert = this.activeAlerts.get(alertId);
    if (!alert || alert.status !== "ACTIVE") return false;

    alert.status = "ACKNOWLEDGED";
    alert.acknowledgedAt = new Date();
    alert.acknowledgedBy = userId;

    this.emit("alert:acknowledged", alert);
    return true;
  }

  /**
   * Resolve an alert
   */
  resolveAlert(alertId: string): boolean {
    const alert = this.activeAlerts.get(alertId);
    if (!alert) return false;

    alert.status = "RESOLVED";
    alert.resolvedAt = new Date();

    this.activeAlerts.delete(alertId);
    this.alertHistory.push(alert);

    // Trim history if needed
    if (this.alertHistory.length > this.maxAlertHistory) {
      this.alertHistory = this.alertHistory.slice(-this.maxAlertHistory);
    }

    this.emit("alert:resolved", alert);
    return true;
  }

  /**
   * Get alert history
   */
  getAlertHistory(limit: number = 100): AnomalyAlert[] {
    return this.alertHistory.slice(-limit);
  }

  // ===========================================================================
  // ANOMALY HISTORY
  // ===========================================================================

  /**
   * Get anomaly history for a sensor
   */
  getAnomalyHistory(
    tagName: string,
    options?: {
      limit?: number;
      since?: Date;
      type?: AnomalyType;
      severity?: AnomalySeverity;
    }
  ): Anomaly[] {
    let history = this.anomalyHistory.get(tagName) || [];

    if (options?.since) {
      history = history.filter((a) => a.timestamp >= options.since!);
    }

    if (options?.type) {
      history = history.filter((a) => a.type === options.type);
    }

    if (options?.severity) {
      history = history.filter((a) => a.severity === options.severity);
    }

    if (options?.limit) {
      history = history.slice(-options.limit);
    }

    return history;
  }

  /**
   * Get anomaly summary for a sensor
   */
  getAnomalySummary(tagName: string): {
    total: number;
    byType: Record<AnomalyType, number>;
    bySeverity: Record<AnomalySeverity, number>;
    last24Hours: number;
    lastWeek: number;
  } {
    const history = this.anomalyHistory.get(tagName) || [];
    const now = Date.now();
    const oneDayAgo = now - 24 * 60 * 60 * 1000;
    const oneWeekAgo = now - 7 * 24 * 60 * 60 * 1000;

    const byType: Record<AnomalyType, number> = {
      ZSCORE: 0,
      IQR: 0,
      MODIFIED_ZSCORE: 0,
      TREND: 0,
      RATE_OF_CHANGE: 0,
      THRESHOLD: 0,
      PATTERN: 0,
    };

    const bySeverity: Record<AnomalySeverity, number> = {
      CRITICAL: 0,
      HIGH: 0,
      MEDIUM: 0,
      LOW: 0,
      INFO: 0,
    };

    let last24Hours = 0;
    let lastWeek = 0;

    for (const anomaly of history) {
      byType[anomaly.type]++;
      bySeverity[anomaly.severity]++;

      const ts = anomaly.timestamp.getTime();
      if (ts > oneDayAgo) last24Hours++;
      if (ts > oneWeekAgo) lastWeek++;
    }

    return {
      total: history.length,
      byType,
      bySeverity,
      last24Hours,
      lastWeek,
    };
  }

  // ===========================================================================
  // STATUS & QUERIES
  // ===========================================================================

  /**
   * Get engine status
   */
  getStatus(): {
    sensorCount: number;
    activeAlertCount: number;
    totalAnomaliesDetected: number;
    sensors: Array<{
      tagName: string;
      enabled: boolean;
      sampleCount: number;
      anomalyCount: number;
    }>;
  } {
    let totalAnomalies = 0;
    const sensors: Array<{
      tagName: string;
      enabled: boolean;
      sampleCount: number;
      anomalyCount: number;
    }> = [];

    for (const [tagName, config] of this.sensorConfigs) {
      const window = this.sensorWindows.get(tagName);
      const history = this.anomalyHistory.get(tagName) || [];
      totalAnomalies += history.length;

      sensors.push({
        tagName,
        enabled: config.enabled,
        sampleCount: window?.size() || 0,
        anomalyCount: history.length,
      });
    }

    return {
      sensorCount: this.sensorConfigs.size,
      activeAlertCount: this.activeAlerts.size,
      totalAnomaliesDetected: totalAnomalies,
      sensors,
    };
  }

  /**
   * Get registered sensor configurations
   */
  getSensorConfigs(): SensorConfig[] {
    return Array.from(this.sensorConfigs.values());
  }

  /**
   * Clear all data for a sensor
   */
  clearSensorData(tagName: string): void {
    this.sensorWindows.get(tagName)?.clear();
    this.anomalyHistory.set(tagName, []);
    this.lastAlertTimes.get(tagName)?.clear();
  }

  /**
   * Clear all engine data
   */
  clearAll(): void {
    for (const tagName of this.sensorConfigs.keys()) {
      this.clearSensorData(tagName);
    }
    this.activeAlerts.clear();
    this.alertHistory = [];
  }

  // ===========================================================================
  // PRIVATE METHODS
  // ===========================================================================

  private createAnomaly(
    config: SensorConfig,
    type: AnomalyType,
    severity: AnomalySeverity,
    value: number,
    expectedValue: number,
    deviation: number,
    timestamp: Date,
    metadata: Record<string, unknown>
  ): Anomaly {
    const id = `ANM-${Date.now()}-${Math.random().toString(36).substr(2, 8)}`;

    let message: string;
    switch (type) {
      case "ZSCORE":
        message = `${config.tagName}: Z-score anomaly detected (z=${deviation.toFixed(2)}, value=${value.toFixed(2)})`;
        break;
      case "IQR":
        message = `${config.tagName}: IQR outlier detected (value=${value.toFixed(2)}, bound=${metadata.bound})`;
        break;
      case "MODIFIED_ZSCORE":
        message = `${config.tagName}: Modified Z-score anomaly (mz=${deviation.toFixed(2)}, value=${value.toFixed(2)})`;
        break;
      case "TREND":
        message = `${config.tagName}: Abnormal trend detected (slope=${deviation.toFixed(4)}, direction=${metadata.direction})`;
        break;
      case "RATE_OF_CHANGE":
        message = `${config.tagName}: Rapid change detected (${deviation.toFixed(1)}% change)`;
        break;
      case "THRESHOLD":
        message = `${config.tagName}: Threshold violation (value=${value.toFixed(2)}, limit=${expectedValue.toFixed(2)})`;
        break;
      default:
        message = `${config.tagName}: Anomaly detected (type=${type}, value=${value.toFixed(2)})`;
    }

    return {
      id,
      tagName: config.tagName,
      assetId: config.assetId,
      siteId: config.siteId,
      type,
      severity,
      value,
      expectedValue,
      deviation,
      timestamp,
      message,
      metadata,
    };
  }

  private checkThresholds(
    config: SensorConfig,
    value: number,
    timestamp: Date,
    thresholdConfig: ThresholdConfig
  ): Anomaly[] {
    const anomalies: Anomaly[] = [];
    const deadband = thresholdConfig.deadband || 0;

    if (
      thresholdConfig.highHigh !== undefined &&
      value >= thresholdConfig.highHigh - deadband
    ) {
      anomalies.push(
        this.createAnomaly(
          config,
          "THRESHOLD",
          "CRITICAL",
          value,
          thresholdConfig.highHigh,
          value - thresholdConfig.highHigh,
          timestamp,
          { thresholdType: "HIHI", limit: thresholdConfig.highHigh }
        )
      );
    } else if (
      thresholdConfig.high !== undefined &&
      value >= thresholdConfig.high - deadband
    ) {
      anomalies.push(
        this.createAnomaly(
          config,
          "THRESHOLD",
          "HIGH",
          value,
          thresholdConfig.high,
          value - thresholdConfig.high,
          timestamp,
          { thresholdType: "HIGH", limit: thresholdConfig.high }
        )
      );
    }

    if (
      thresholdConfig.lowLow !== undefined &&
      value <= thresholdConfig.lowLow + deadband
    ) {
      anomalies.push(
        this.createAnomaly(
          config,
          "THRESHOLD",
          "CRITICAL",
          value,
          thresholdConfig.lowLow,
          thresholdConfig.lowLow - value,
          timestamp,
          { thresholdType: "LOLO", limit: thresholdConfig.lowLow }
        )
      );
    } else if (
      thresholdConfig.low !== undefined &&
      value <= thresholdConfig.low + deadband
    ) {
      anomalies.push(
        this.createAnomaly(
          config,
          "THRESHOLD",
          "MEDIUM",
          value,
          thresholdConfig.low,
          thresholdConfig.low - value,
          timestamp,
          { thresholdType: "LOW", limit: thresholdConfig.low }
        )
      );
    }

    return anomalies;
  }

  private storeAnomaly(tagName: string, anomaly: Anomaly): void {
    const history = this.anomalyHistory.get(tagName);
    if (history) {
      history.push(anomaly);
      // Trim if needed
      if (history.length > this.maxHistoryPerSensor) {
        history.splice(0, history.length - this.maxHistoryPerSensor);
      }
    }

    this.emit("anomaly", anomaly);
  }

  private maybeGenerateAlert(anomaly: Anomaly): void {
    const config = this.sensorConfigs.get(anomaly.tagName);
    if (!config) return;

    // Check cooldown
    const lastAlertTimes = this.lastAlertTimes.get(anomaly.tagName);
    if (lastAlertTimes) {
      const lastTime = lastAlertTimes.get(anomaly.type);
      if (lastTime && Date.now() - lastTime < config.cooldownPeriod) {
        return; // Still in cooldown
      }
    }

    // Create alert
    const alert: AnomalyAlert = {
      id: `ALT-${Date.now()}-${Math.random().toString(36).substr(2, 8)}`,
      anomalyId: anomaly.id,
      tagName: anomaly.tagName,
      assetId: anomaly.assetId,
      siteId: anomaly.siteId,
      type: anomaly.type,
      severity: anomaly.severity,
      status: "ACTIVE",
      message: anomaly.message,
      createdAt: new Date(),
    };

    // Create signed event for blockchain anchoring
    try {
      const eventService = getEventService();
      const signedEvent = eventService.createEvent({
        eventType: EventType.ALARM,
        siteId: anomaly.siteId,
        assetId: anomaly.assetId,
        sourceTimestamp: new Date(),
        originType: OriginType.SYSTEM,
        originId: this.originId,
        payload: {
          alertId: alert.id,
          anomalyId: anomaly.id,
          anomalyType: anomaly.type,
          severity: anomaly.severity,
          tagName: anomaly.tagName,
          value: anomaly.value,
          expectedValue: anomaly.expectedValue,
          deviation: anomaly.deviation,
          metadata: anomaly.metadata,
        },
        details: `[PREDICTIVE MAINTENANCE] ${anomaly.message}`,
      });
      alert.eventHash = signedEvent.hash;
    } catch (error) {
      console.error("[AnomalyDetection] Failed to create event:", error);
    }

    // Store alert
    this.activeAlerts.set(alert.id, alert);
    lastAlertTimes?.set(anomaly.type, Date.now());

    console.log(
      `[AnomalyDetection] ALERT [${alert.severity}]: ${alert.message}`
    );

    this.emit("alert", alert);
    this.emit("alert:created", alert);
  }
}

// =============================================================================
// SINGLETON INSTANCE
// =============================================================================

let anomalyDetectionInstance: AnomalyDetectionEngine | null = null;

export function getAnomalyDetectionEngine(): AnomalyDetectionEngine {
  if (!anomalyDetectionInstance) {
    anomalyDetectionInstance = new AnomalyDetectionEngine();
  }
  return anomalyDetectionInstance;
}

export function initAnomalyDetection(siteId: string): AnomalyDetectionEngine {
  const engine = getAnomalyDetectionEngine();
  engine.setSiteId(siteId);
  console.log(`[AnomalyDetection] Initialized for site ${siteId}`);
  return engine;
}
