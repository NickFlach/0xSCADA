/**
 * Machine Learning Service
 * 
 * Provides ML capabilities for industrial data analysis including:
 * - Anomaly detection for sensor readings
 * - Predictive maintenance algorithms
 * - Process optimization recommendations
 * - Pattern recognition in time series data
 */

import { EventEmitter } from 'events';
import { log, logError } from '../../logger';

export interface MLModel {
  id: string;
  name: string;
  type: 'anomaly-detection' | 'predictive-maintenance' | 'optimization' | 'classification';
  version: string;
  status: 'training' | 'ready' | 'failed' | 'updating';
  accuracy?: number;
  lastTrained?: Date;
  inputFeatures: string[];
  outputLabels: string[];
}

export interface TrainingData {
  id: string;
  features: Record<string, number>;
  label?: string | number;
  timestamp: Date;
  source: string;
}

export interface Prediction {
  id: string;
  modelId: string;
  input: Record<string, number>;
  output: Record<string, number>;
  confidence: number;
  timestamp: Date;
  anomalyScore?: number;
}

export interface AnomalyAlert {
  id: string;
  modelId: string;
  deviceId: string;
  tagName: string;
  value: number;
  expectedValue: number;
  anomalyScore: number;
  severity: 'low' | 'medium' | 'high' | 'critical';
  timestamp: Date;
  acknowledged: boolean;
}

export class MLService extends EventEmitter {
  private models: Map<string, MLModel> = new Map();
  private trainingData: Map<string, TrainingData[]> = new Map();
  private recentPredictions: Prediction[] = [];
  private isInitialized = false;
  private trainingTimer?: NodeJS.Timeout;

  constructor() {
    super();
  }

  /**
   * Initialize the ML service
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    log('Initializing ML service');
    
    // Load pre-trained models
    await this.loadDefaultModels();
    
    // Start periodic model updates
    this.startPeriodicTraining();
    
    this.isInitialized = true;
    this.emit('initialized');
    log('ML service initialized');
  }

  /**
   * Add a new ML model
   */
  async addModel(model: MLModel): Promise<void> {
    this.models.set(model.id, model);
    this.trainingData.set(model.id, []);
    
    log(`ML model added: ${model.name} (${model.type})`);
    this.emit('model-added', model);
  }

  /**
   * Add training data for a model
   */
  async addTrainingData(modelId: string, data: TrainingData[]): Promise<void> {
    const existingData = this.trainingData.get(modelId) || [];
    existingData.push(...data);
    
    // Keep only recent data (last 10,000 samples)
    if (existingData.length > 10000) {
      existingData.splice(0, existingData.length - 10000);
    }
    
    this.trainingData.set(modelId, existingData);
    log(`Added ${data.length} training samples for model ${modelId}`);
  }

  /**
   * Make a prediction using a model
   */
  async predict(modelId: string, input: Record<string, number>): Promise<Prediction | null> {
    const model = this.models.get(modelId);
    if (!model || model.status !== 'ready') {
      return null;
    }

    try {
      const prediction = await this.runPrediction(model, input);
      this.recentPredictions.push(prediction);
      
      // Keep only last 1000 predictions
      if (this.recentPredictions.length > 1000) {
        this.recentPredictions.shift();
      }

      // Check for anomalies if it's an anomaly detection model
      if (model.type === 'anomaly-detection' && prediction.anomalyScore && prediction.anomalyScore > 0.8) {
        await this.handleAnomalyDetection(model, prediction);
      }

      return prediction;
    } catch (error) {
      logError(`Prediction failed for model ${modelId}`, error);
      return null;
    }
  }

  /**
   * Train or retrain a model
   */
  async trainModel(modelId: string): Promise<boolean> {
    const model = this.models.get(modelId);
    const data = this.trainingData.get(modelId);
    
    if (!model || !data || data.length < 10) {
      log(`Insufficient training data for model ${modelId}`);
      return false;
    }

    try {
      model.status = 'training';
      this.emit('model-training-started', model);
      
      // Simulate training process
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // Simulate training results
      model.accuracy = 0.85 + Math.random() * 0.1; // 85-95% accuracy
      model.lastTrained = new Date();
      model.status = 'ready';
      model.version = `v${Date.now()}`;
      
      log(`Model ${modelId} training completed with ${(model.accuracy * 100).toFixed(1)}% accuracy`);
      this.emit('model-trained', model);
      
      return true;
    } catch (error) {
      model.status = 'failed';
      logError(`Model training failed for ${modelId}`, error);
      this.emit('model-training-failed', model, error);
      return false;
    }
  }

  /**
   * Get anomaly detection alerts
   */
  getAnomalyAlerts(since?: Date): AnomalyAlert[] {
    // In a real implementation, this would query a database
    // For now, return simulated alerts based on recent predictions
    const sinceTime = since || new Date(Date.now() - 24 * 60 * 60 * 1000);
    
    return this.recentPredictions
      .filter(p => p.timestamp >= sinceTime && p.anomalyScore && p.anomalyScore > 0.7)
      .map(p => ({
        id: `alert-${p.id}`,
        modelId: p.modelId,
        deviceId: 'device-001', // Would come from prediction context
        tagName: 'temperature',
        value: p.input['temperature'] || 0,
        expectedValue: p.output['expected_temperature'] || 0,
        anomalyScore: p.anomalyScore || 0,
        severity: p.anomalyScore! > 0.9 ? 'critical' : p.anomalyScore! > 0.8 ? 'high' : 'medium',
        timestamp: p.timestamp,
        acknowledged: false
      }));
  }

  /**
   * Get model performance metrics
   */
  getModelMetrics(modelId: string): {
    predictions: number;
    averageConfidence: number;
    anomaliesDetected: number;
    lastPrediction?: Date;
  } | null {
    const predictions = this.recentPredictions.filter(p => p.modelId === modelId);
    
    if (predictions.length === 0) return null;

    const averageConfidence = predictions.reduce((sum, p) => sum + p.confidence, 0) / predictions.length;
    const anomaliesDetected = predictions.filter(p => p.anomalyScore && p.anomalyScore > 0.7).length;
    const lastPrediction = Math.max(...predictions.map(p => p.timestamp.getTime()));

    return {
      predictions: predictions.length,
      averageConfidence,
      anomaliesDetected,
      lastPrediction: new Date(lastPrediction)
    };
  }

  /**
   * Get service status
   */
  getStatus(): {
    initialized: boolean;
    modelsCount: number;
    readyModels: number;
    totalPredictions: number;
    recentAnomalies: number;
  } {
    const readyModels = Array.from(this.models.values()).filter(m => m.status === 'ready').length;
    const recentAnomalies = this.recentPredictions
      .filter(p => p.anomalyScore && p.anomalyScore > 0.7)
      .length;

    return {
      initialized: this.isInitialized,
      modelsCount: this.models.size,
      readyModels,
      totalPredictions: this.recentPredictions.length,
      recentAnomalies
    };
  }

  /**
   * Health check for ML service
   */
  async healthCheck(): Promise<{ healthy: boolean; message: string }> {
    if (!this.isInitialized) {
      return {
        healthy: false,
        message: 'ML service not initialized'
      };
    }

    const status = this.getStatus();
    const failedModels = Array.from(this.models.values()).filter(m => m.status === 'failed').length;
    
    if (failedModels > 0) {
      return {
        healthy: false,
        message: `ML service degraded: ${failedModels} failed models`
      };
    }

    if (status.readyModels === 0) {
      return {
        healthy: false,
        message: 'No ML models ready for inference'
      };
    }

    return {
      healthy: true,
      message: `ML service healthy: ${status.readyModels}/${status.modelsCount} models ready`
    };
  }

  // ── Private Methods ────────────────────────────────────────────────────────

  /**
   * Load default pre-trained models
   */
  private async loadDefaultModels(): Promise<void> {
    // Temperature anomaly detection model
    await this.addModel({
      id: 'temp-anomaly-detector',
      name: 'Temperature Anomaly Detection',
      type: 'anomaly-detection',
      version: 'v1.0.0',
      status: 'ready',
      accuracy: 0.92,
      lastTrained: new Date(),
      inputFeatures: ['temperature', 'pressure', 'flow_rate'],
      outputLabels: ['anomaly_score']
    });

    // Predictive maintenance model
    await this.addModel({
      id: 'predictive-maintenance',
      name: 'Equipment Health Predictor',
      type: 'predictive-maintenance',
      version: 'v1.0.0',
      status: 'ready',
      accuracy: 0.88,
      lastTrained: new Date(),
      inputFeatures: ['vibration', 'temperature', 'current', 'runtime_hours'],
      outputLabels: ['maintenance_score', 'days_until_maintenance']
    });

    log('Default ML models loaded');
  }

  /**
   * Run prediction with a model (simulated)
   */
  private async runPrediction(model: MLModel, input: Record<string, number>): Promise<Prediction> {
    // Simulate ML inference delay
    await new Promise(resolve => setTimeout(resolve, 50));

    const prediction: Prediction = {
      id: `pred-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      modelId: model.id,
      input,
      output: {},
      confidence: 0.7 + Math.random() * 0.3, // 70-100% confidence
      timestamp: new Date()
    };

    // Generate outputs based on model type
    switch (model.type) {
      case 'anomaly-detection':
        prediction.anomalyScore = Math.random(); // 0-1 anomaly score
        prediction.output = { anomaly_score: prediction.anomalyScore };
        break;
      case 'predictive-maintenance':
        prediction.output = {
          maintenance_score: Math.random(),
          days_until_maintenance: Math.floor(Math.random() * 30) + 1
        };
        break;
      case 'optimization':
        prediction.output = { optimized_setpoint: input['setpoint'] * (0.95 + Math.random() * 0.1) };
        break;
      default:
        prediction.output = { classification: Math.random() > 0.5 ? 'normal' : 'abnormal' };
    }

    return prediction;
  }

  /**
   * Handle anomaly detection
   */
  private async handleAnomalyDetection(model: MLModel, prediction: Prediction): Promise<void> {
    const alert: AnomalyAlert = {
      id: `anomaly-${Date.now()}`,
      modelId: model.id,
      deviceId: 'device-001', // Would be passed in context
      tagName: 'temperature', // Would be derived from input features
      value: prediction.input['temperature'] || 0,
      expectedValue: 25, // Would be calculated by model
      anomalyScore: prediction.anomalyScore!,
      severity: prediction.anomalyScore! > 0.95 ? 'critical' : 
                prediction.anomalyScore! > 0.85 ? 'high' : 'medium',
      timestamp: prediction.timestamp,
      acknowledged: false
    };

    log(`Anomaly detected: ${alert.severity} (score: ${alert.anomalyScore.toFixed(3)})`);
    this.emit('anomaly-detected', alert);
  }

  /**
   * Start periodic model training/updates
   */
  private startPeriodicTraining(): void {
    // Retrain models every 6 hours
    this.trainingTimer = setInterval(async () => {
      for (const modelId of this.models.keys()) {
        const data = this.trainingData.get(modelId);
        if (data && data.length > 100) { // Only retrain if we have sufficient new data
          await this.trainModel(modelId);
        }
      }
    }, 6 * 60 * 60 * 1000);
  }
}

// Singleton instance
export const mlService = new MLService();