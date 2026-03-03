/**
 * Machine Learning Service Types
 * 
 * Types for ML services including models, training, and predictions.
 * 
 * Dependencies: ./common.ts, ../core/common.ts
 */

import { EntityId, Timestamp, DataValue } from '../core/common';
import { ServiceConfig, AsyncOperation } from './common';

export type MLModelType = 'anomaly-detection' | 'predictive-maintenance' | 'optimization' | 'classification';
export type ModelStatus = 'training' | 'ready' | 'failed' | 'updating';

export interface MLModel {
  id: EntityId;
  name: string;
  type: MLModelType;
  version: string;
  status: ModelStatus;
  accuracy?: number;
  lastTrained?: Timestamp;
  inputFeatures: string[];
  outputLabels: string[];
  config?: MLModelConfig;
}

export interface MLModelConfig extends ServiceConfig {
  algorithm: string;
  hyperparameters: Record<string, number | string | boolean>;
  trainingDataSize: number;
  validationSplit: number;
  epochs?: number;
  batchSize?: number;
}

export interface TrainingData {
  id: EntityId;
  features: Record<string, number>;
  label?: string | number;
  timestamp: Timestamp;
  source: string;
}

export interface Prediction {
  id: EntityId;
  modelId: EntityId;
  input: Record<string, number>;
  output: Record<string, number>;
  confidence: number;
  timestamp: Timestamp;
  anomalyScore?: number;
}

export interface AnomalyAlert {
  id: EntityId;
  modelId: EntityId;
  deviceId: EntityId;
  tagName: string;
  value: number;
  expectedValue: number;
  anomalyScore: number;
  severity: 'low' | 'medium' | 'high' | 'critical';
  timestamp: Timestamp;
  acknowledged: boolean;
}

export interface MLTrainingOperation extends AsyncOperation {
  modelId: EntityId;
  datasetSize: number;
  epoch?: number;
  totalEpochs?: number;
  validationAccuracy?: number;
  trainingLoss?: number;
}