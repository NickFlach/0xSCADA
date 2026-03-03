/**
 * Geometry Service Types
 */

import { EntityId, Point2D, Point3D, BoundingBox } from '../core/common';

export interface GeometricZone {
  id: EntityId;
  name: string;
  description?: string;
  type: 'rectangular' | 'circular' | 'polygon';
  coordinates: Point2D[];
  boundingBox: BoundingBox;
  metadata?: Record<string, unknown>;
}

export interface ProximityAlert {
  id: EntityId;
  deviceId: EntityId;
  zoneId: EntityId;
  distance: number;
  threshold: number;
  severity: 'info' | 'warning' | 'critical';
  timestamp: Date;
  acknowledged: boolean;
}