/**
 * Geometry Service
 * 
 * Handles spatial calculations, coordinate transformations, and geometric
 * operations for industrial facility layouts and device positioning.
 * 
 * Used for: Site maps, device coordinates, zone boundaries, proximity alerts
 */

import { EventEmitter } from 'events';
import { log, logError } from '../../logger';

export interface Point2D {
  x: number;
  y: number;
}

export interface Point3D extends Point2D {
  z: number;
}

export interface BoundingBox {
  min: Point2D;
  max: Point2D;
}

export interface GeometricZone {
  id: string;
  name: string;
  description?: string;
  type: 'rectangular' | 'circular' | 'polygon';
  coordinates: Point2D[];
  boundingBox: BoundingBox;
  metadata?: Record<string, unknown>;
}

export interface Device {
  id: string;
  name: string;
  position: Point3D;
  zoneId?: string;
  type: string;
}

export interface ProximityAlert {
  id: string;
  deviceId: string;
  zoneId: string;
  distance: number;
  threshold: number;
  severity: 'info' | 'warning' | 'critical';
  timestamp: Date;
  acknowledged: boolean;
}

export class GeometryService extends EventEmitter {
  private zones: Map<string, GeometricZone> = new Map();
  private devices: Map<string, Device> = new Map();
  private proximityThresholds: Map<string, number> = new Map();
  private isInitialized = false;

  constructor() {
    super();
  }

  /**
   * Initialize the geometry service
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    log('Initializing geometry service');
    
    // Load default zones and coordinate systems
    await this.loadDefaultZones();
    
    this.isInitialized = true;
    this.emit('initialized');
    log('Geometry service initialized');
  }

  /**
   * Add a geometric zone
   */
  addZone(zone: GeometricZone): void {
    this.zones.set(zone.id, zone);
    log(`Geometric zone added: ${zone.name} (${zone.type})`);
    this.emit('zone-added', zone);
  }

  /**
   * Add a device with position
   */
  addDevice(device: Device): void {
    // Auto-assign zone based on position
    if (!device.zoneId) {
      device.zoneId = this.findZoneForPoint(device.position);
    }

    this.devices.set(device.id, device);
    log(`Device positioned: ${device.name} at (${device.position.x}, ${device.position.y}, ${device.position.z})`);
    this.emit('device-positioned', device);
  }

  /**
   * Calculate distance between two points
   */
  calculateDistance(p1: Point2D | Point3D, p2: Point2D | Point3D): number {
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const dz = ('z' in p1 && 'z' in p2) ? p2.z - p1.z : 0;
    
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  /**
   * Check if a point is within a zone
   */
  isPointInZone(point: Point2D, zoneId: string): boolean {
    const zone = this.zones.get(zoneId);
    if (!zone) return false;

    switch (zone.type) {
      case 'rectangular':
        return this.isPointInRectangle(point, zone.coordinates);
      case 'circular':
        return this.isPointInCircle(point, zone.coordinates);
      case 'polygon':
        return this.isPointInPolygon(point, zone.coordinates);
      default:
        return false;
    }
  }

  /**
   * Find all devices within a radius of a point
   */
  findDevicesNear(center: Point2D, radius: number): Device[] {
    return Array.from(this.devices.values()).filter(device => {
      const distance = this.calculateDistance(center, device.position);
      return distance <= radius;
    });
  }

  /**
   * Get devices in a specific zone
   */
  getDevicesInZone(zoneId: string): Device[] {
    return Array.from(this.devices.values()).filter(
      device => device.zoneId === zoneId
    );
  }

  /**
   * Calculate area of a zone
   */
  calculateZoneArea(zoneId: string): number {
    const zone = this.zones.get(zoneId);
    if (!zone) return 0;

    switch (zone.type) {
      case 'rectangular':
        return this.calculateRectangleArea(zone.coordinates);
      case 'circular':
        return this.calculateCircleArea(zone.coordinates);
      case 'polygon':
        return this.calculatePolygonArea(zone.coordinates);
      default:
        return 0;
    }
  }

  /**
   * Check proximity alerts for all devices
   */
  async checkProximityAlerts(): Promise<ProximityAlert[]> {
    const alerts: ProximityAlert[] = [];

    for (const [deviceId, device] of this.devices) {
      if (!device.zoneId) continue;

      const threshold = this.proximityThresholds.get(device.zoneId) || 10; // Default 10m
      const zone = this.zones.get(device.zoneId);
      if (!zone) continue;

      const distanceToZoneBoundary = this.calculateDistanceToZoneBoundary(
        device.position, 
        zone
      );

      if (distanceToZoneBoundary < threshold) {
        const severity = distanceToZoneBoundary < threshold * 0.5 ? 'critical' : 'warning';
        
        alerts.push({
          id: `alert-${Date.now()}-${deviceId}`,
          deviceId,
          zoneId: device.zoneId,
          distance: distanceToZoneBoundary,
          threshold,
          severity,
          timestamp: new Date(),
          acknowledged: false
        });
      }
    }

    if (alerts.length > 0) {
      this.emit('proximity-alerts', alerts);
    }

    return alerts;
  }

  /**
   * Transform coordinates between coordinate systems
   */
  transformCoordinates(
    point: Point2D, 
    fromSystem: string, 
    toSystem: string
  ): Point2D {
    // Simple coordinate transformation (would be more complex in real implementation)
    if (fromSystem === 'local' && toSystem === 'global') {
      return { x: point.x + 1000, y: point.y + 1000 }; // Add offset
    }
    if (fromSystem === 'global' && toSystem === 'local') {
      return { x: point.x - 1000, y: point.y - 1000 }; // Remove offset
    }
    return point; // No transformation needed
  }

  /**
   * Get service status
   */
  getStatus(): {
    initialized: boolean;
    zonesCount: number;
    devicesCount: number;
    totalArea: number;
  } {
    const totalArea = Array.from(this.zones.keys())
      .reduce((sum, zoneId) => sum + this.calculateZoneArea(zoneId), 0);

    return {
      initialized: this.isInitialized,
      zonesCount: this.zones.size,
      devicesCount: this.devices.size,
      totalArea
    };
  }

  /**
   * Health check for geometry service
   */
  async healthCheck(): Promise<{ healthy: boolean; message: string }> {
    if (!this.isInitialized) {
      return {
        healthy: false,
        message: 'Geometry service not initialized'
      };
    }

    const status = this.getStatus();
    
    return {
      healthy: true,
      message: `Geometry service healthy: ${status.zonesCount} zones, ${status.devicesCount} devices`
    };
  }

  // ── Private Methods ────────────────────────────────────────────────────────

  /**
   * Load default zones for demo
   */
  private async loadDefaultZones(): Promise<void> {
    // Production area
    this.addZone({
      id: 'production-floor',
      name: 'Production Floor',
      description: 'Main production area',
      type: 'rectangular',
      coordinates: [
        { x: 0, y: 0 },
        { x: 100, y: 100 }
      ],
      boundingBox: {
        min: { x: 0, y: 0 },
        max: { x: 100, y: 100 }
      }
    });

    // Control room (circular safety zone)
    this.addZone({
      id: 'control-room',
      name: 'Control Room',
      description: 'Critical control systems',
      type: 'circular',
      coordinates: [
        { x: 50, y: 50 }, // center
        { x: 60, y: 50 }  // radius point (10m radius)
      ],
      boundingBox: {
        min: { x: 40, y: 40 },
        max: { x: 60, y: 60 }
      }
    });

    // Set proximity thresholds
    this.proximityThresholds.set('control-room', 5); // 5m warning zone

    log('Default geometric zones loaded');
  }

  /**
   * Find which zone contains a point
   */
  private findZoneForPoint(point: Point2D): string | undefined {
    for (const [zoneId, zone] of this.zones) {
      if (this.isPointInZone(point, zoneId)) {
        return zoneId;
      }
    }
    return undefined;
  }

  /**
   * Check if point is in rectangle
   */
  private isPointInRectangle(point: Point2D, coords: Point2D[]): boolean {
    if (coords.length < 2) return false;
    const [min, max] = coords;
    return point.x >= min.x && point.x <= max.x && 
           point.y >= min.y && point.y <= max.y;
  }

  /**
   * Check if point is in circle
   */
  private isPointInCircle(point: Point2D, coords: Point2D[]): boolean {
    if (coords.length < 2) return false;
    const [center, radiusPoint] = coords;
    const radius = this.calculateDistance(center, radiusPoint);
    const distance = this.calculateDistance(center, point);
    return distance <= radius;
  }

  /**
   * Check if point is in polygon (ray casting algorithm)
   */
  private isPointInPolygon(point: Point2D, coords: Point2D[]): boolean {
    let inside = false;
    for (let i = 0, j = coords.length - 1; i < coords.length; j = i++) {
      if (((coords[i].y > point.y) !== (coords[j].y > point.y)) &&
          (point.x < (coords[j].x - coords[i].x) * (point.y - coords[i].y) / (coords[j].y - coords[i].y) + coords[i].x)) {
        inside = !inside;
      }
    }
    return inside;
  }

  /**
   * Calculate rectangle area
   */
  private calculateRectangleArea(coords: Point2D[]): number {
    if (coords.length < 2) return 0;
    const [min, max] = coords;
    return (max.x - min.x) * (max.y - min.y);
  }

  /**
   * Calculate circle area
   */
  private calculateCircleArea(coords: Point2D[]): number {
    if (coords.length < 2) return 0;
    const [center, radiusPoint] = coords;
    const radius = this.calculateDistance(center, radiusPoint);
    return Math.PI * radius * radius;
  }

  /**
   * Calculate polygon area (shoelace formula)
   */
  private calculatePolygonArea(coords: Point2D[]): number {
    if (coords.length < 3) return 0;
    let area = 0;
    for (let i = 0; i < coords.length; i++) {
      const j = (i + 1) % coords.length;
      area += coords[i].x * coords[j].y;
      area -= coords[j].x * coords[i].y;
    }
    return Math.abs(area) / 2;
  }

  /**
   * Calculate distance from point to zone boundary
   */
  private calculateDistanceToZoneBoundary(point: Point2D, zone: GeometricZone): number {
    // Simplified calculation - would be more complex for real implementation
    switch (zone.type) {
      case 'circular':
        if (zone.coordinates.length >= 2) {
          const [center, radiusPoint] = zone.coordinates;
          const radius = this.calculateDistance(center, radiusPoint);
          const distance = this.calculateDistance(center, point);
          return Math.abs(distance - radius);
        }
        break;
      case 'rectangular':
        if (zone.coordinates.length >= 2) {
          const [min, max] = zone.coordinates;
          const dx = Math.max(min.x - point.x, 0, point.x - max.x);
          const dy = Math.max(min.y - point.y, 0, point.y - max.y);
          return Math.sqrt(dx * dx + dy * dy);
        }
        break;
    }
    return 0;
  }
}

// Singleton instance
export const geometryService = new GeometryService();