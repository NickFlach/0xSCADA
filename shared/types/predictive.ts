/**
 * Predictive Maintenance Types
 * ADR-0013 [13.1]
 */

export type SeverityLevel = 'info' | 'warning' | 'critical' | 'emergency';

export interface AnomalyScore {
  tagId: string;
  timestamp: number;
  zScore: number | null;
  ewmaScore: number | null;
  iqrScore: number | null;
  ensembleScore: number;
  severity: SeverityLevel;
  description: string;
}

export interface TagThresholds {
  tagId: string;
  zScoreThreshold: number;
  ewmaAlpha: number;
  ewmaThreshold: number;
  iqrMultiplier: number;
  ensembleWeights: { zScore: number; ewma: number; iqr: number };
  severityThresholds: { warning: number; critical: number; emergency: number };
}

export interface PredictiveAlert {
  id: string;
  tagId: string;
  severity: SeverityLevel;
  score: number;
  message: string;
  timestamp: number;
  detectors: string[];
  acknowledged: boolean;
  recommendation?: string;
}

export interface TimeSeriesPoint {
  timestamp: number;
  value: number;
}

export interface DetectorResult {
  detector: string;
  score: number;
  anomalous: boolean;
  details: Record<string, unknown>;
}

export interface MaintenancePrediction {
  tagId: string;
  equipmentId: string;
  failureProbability: number;
  estimatedTimeToFailure: number | null; // hours
  recommendedAction: string;
  confidence: number;
}
