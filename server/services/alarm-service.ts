/**
 * Alarm Service
 *
 * VS-1.5 - Vertical Slice: High-Level Alarm Event Service
 *
 * Monitors tag values, detects alarm conditions, and generates
 * alarm events for blockchain anchoring.
 */

import { EventEmitter } from "events";
import { getEventService, EventType, OriginType, type SignedEvent } from "../events";
import { tagService } from "../routes/tags";
import type { TagValue } from "../gateway";

// =============================================================================
// TYPES
// =============================================================================

export type AlarmPriority = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO";
export type AlarmState = "ACTIVE" | "CLEARED" | "ACKNOWLEDGED" | "SHELVED";
export type AlarmType = "HIHI" | "HIGH" | "LOW" | "LOLO" | "RATE" | "DEVIATION" | "DISCRETE";

export interface AlarmDefinition {
  id: string;
  tagName: string;
  type: AlarmType;
  priority: AlarmPriority;
  setpoint: number;
  deadband?: number;
  message: string;
  enabled: boolean;
}

export interface ActiveAlarm {
  id: string;
  alarmDefId: string;
  tagName: string;
  type: AlarmType;
  priority: AlarmPriority;
  state: AlarmState;
  value: number;
  setpoint: number;
  message: string;
  activatedAt: Date;
  clearedAt?: Date;
  acknowledgedAt?: Date;
  acknowledgedBy?: string;
  eventHash?: string;
}

export interface AlarmEvent {
  alarm: ActiveAlarm;
  signedEvent: SignedEvent;
}

// =============================================================================
// ALARM SERVICE
// =============================================================================

class AlarmService extends EventEmitter {
  private alarmDefinitions: Map<string, AlarmDefinition> = new Map();
  private activeAlarms: Map<string, ActiveAlarm> = new Map();
  private lastTagValues: Map<string, number> = new Map();
  private siteId: string = "SITE-001";
  private originId: string = "ALARM-SERVICE";

  constructor() {
    super();
  }

  // ===========================================================================
  // CONFIGURATION
  // ===========================================================================

  /**
   * Set site ID for event generation
   */
  setSiteId(siteId: string): void {
    this.siteId = siteId;
  }

  /**
   * Register alarm definitions
   */
  registerAlarms(definitions: AlarmDefinition[]): void {
    for (const def of definitions) {
      this.alarmDefinitions.set(def.id, def);
    }
    console.log(`[AlarmService] Registered ${definitions.length} alarm definitions`);
  }

  /**
   * Register alarms from tag alarm configs
   */
  registerAlarmsFromTags(): void {
    const tags = tagService.getTagDefinitions();
    const definitions: AlarmDefinition[] = [];

    for (const tag of tags) {
      if (tag.alarmConfig) {
        const config = tag.alarmConfig;

        if (config.highHigh !== undefined) {
          definitions.push({
            id: `${tag.name}_HIHI`,
            tagName: tag.name,
            type: "HIHI",
            priority: "CRITICAL",
            setpoint: config.highHigh,
            deadband: config.deadband,
            message: `${tag.name} HIGH-HIGH alarm`,
            enabled: true,
          });
        }

        if (config.high !== undefined) {
          definitions.push({
            id: `${tag.name}_HIGH`,
            tagName: tag.name,
            type: "HIGH",
            priority: "HIGH",
            setpoint: config.high,
            deadband: config.deadband,
            message: `${tag.name} HIGH alarm`,
            enabled: true,
          });
        }

        if (config.low !== undefined) {
          definitions.push({
            id: `${tag.name}_LOW`,
            tagName: tag.name,
            type: "LOW",
            priority: "MEDIUM",
            setpoint: config.low,
            deadband: config.deadband,
            message: `${tag.name} LOW alarm`,
            enabled: true,
          });
        }

        if (config.lowLow !== undefined) {
          definitions.push({
            id: `${tag.name}_LOLO`,
            tagName: tag.name,
            type: "LOLO",
            priority: "CRITICAL",
            setpoint: config.lowLow,
            deadband: config.deadband,
            message: `${tag.name} LOW-LOW alarm`,
            enabled: true,
          });
        }
      }
    }

    this.registerAlarms(definitions);
  }

  // ===========================================================================
  // ALARM PROCESSING
  // ===========================================================================

  /**
   * Process tag values and check for alarm conditions
   */
  processTagValues(values: TagValue[]): void {
    for (const value of values) {
      if (typeof value.value !== "number") continue;

      const numValue = value.value;
      this.lastTagValues.set(value.tag, numValue);

      // Check all alarm definitions for this tag
      for (const [defId, def] of this.alarmDefinitions) {
        if (def.tagName !== value.tag || !def.enabled) continue;

        const isInAlarm = this.checkAlarmCondition(def, numValue);
        const existingAlarm = this.activeAlarms.get(defId);

        if (isInAlarm && !existingAlarm) {
          // New alarm - activate
          this.activateAlarm(def, numValue);
        } else if (!isInAlarm && existingAlarm && existingAlarm.state === "ACTIVE") {
          // Alarm cleared
          this.clearAlarm(defId, numValue);
        }
      }
    }
  }

  /**
   * Check if value triggers alarm condition
   */
  private checkAlarmCondition(def: AlarmDefinition, value: number): boolean {
    const deadband = def.deadband || 0;

    switch (def.type) {
      case "HIHI":
      case "HIGH":
        return value >= def.setpoint - deadband;
      case "LOW":
      case "LOLO":
        return value <= def.setpoint + deadband;
      default:
        return false;
    }
  }

  /**
   * Activate a new alarm
   */
  private activateAlarm(def: AlarmDefinition, value: number): void {
    const eventService = getEventService();

    const alarm: ActiveAlarm = {
      id: `ALM-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
      alarmDefId: def.id,
      tagName: def.tagName,
      type: def.type,
      priority: def.priority,
      state: "ACTIVE",
      value,
      setpoint: def.setpoint,
      message: `${def.message}: ${value.toFixed(2)} (limit: ${def.setpoint})`,
      activatedAt: new Date(),
    };

    // Create signed event
    const signedEvent = eventService.createEvent({
      eventType: EventType.ALARM,
      siteId: this.siteId,
      assetId: def.tagName.split(".")[0], // Extract asset from tag name (e.g., TK-101)
      sourceTimestamp: alarm.activatedAt,
      originType: OriginType.SYSTEM,
      originId: this.originId,
      payload: {
        alarmId: alarm.id,
        alarmDefId: def.id,
        alarmType: def.type,
        severity: def.priority,
        state: "ACTIVE",
        tagName: def.tagName,
        value,
        setpoint: def.setpoint,
        message: alarm.message,
      },
      details: `[${def.priority}] ${alarm.message}`,
    });

    alarm.eventHash = signedEvent.hash;
    this.activeAlarms.set(def.id, alarm);

    console.log(`[AlarmService] ALARM ACTIVE: ${alarm.message}`);

    this.emit("alarm", { alarm, signedEvent });
    this.emit("alarm:active", alarm);
  }

  /**
   * Clear an alarm
   */
  private clearAlarm(defId: string, value: number): void {
    const alarm = this.activeAlarms.get(defId);
    if (!alarm) return;

    const eventService = getEventService();

    alarm.state = "CLEARED";
    alarm.clearedAt = new Date();

    // Create clear event
    const signedEvent = eventService.createEvent({
      eventType: EventType.ALARM,
      siteId: this.siteId,
      assetId: alarm.tagName.split(".")[0],
      sourceTimestamp: alarm.clearedAt,
      originType: OriginType.SYSTEM,
      originId: this.originId,
      payload: {
        alarmId: alarm.id,
        alarmDefId: alarm.alarmDefId,
        alarmType: alarm.type,
        severity: alarm.priority,
        state: "CLEARED",
        tagName: alarm.tagName,
        value,
        setpoint: alarm.setpoint,
        message: `${alarm.tagName} alarm cleared`,
        activatedAt: alarm.activatedAt.toISOString(),
        duration: alarm.clearedAt.getTime() - alarm.activatedAt.getTime(),
      },
      details: `[CLEARED] ${alarm.tagName} returned to normal`,
    });

    console.log(`[AlarmService] ALARM CLEARED: ${alarm.tagName}`);

    this.emit("alarm", { alarm, signedEvent });
    this.emit("alarm:cleared", alarm);

    // Remove from active alarms after cleared
    this.activeAlarms.delete(defId);
  }

  /**
   * Acknowledge an alarm
   */
  acknowledgeAlarm(alarmId: string, userId: string, comment?: string): boolean {
    // Find alarm by ID
    for (const [defId, alarm] of this.activeAlarms) {
      if (alarm.id === alarmId && alarm.state === "ACTIVE") {
        alarm.state = "ACKNOWLEDGED";
        alarm.acknowledgedAt = new Date();
        alarm.acknowledgedBy = userId;

        const eventService = getEventService();
        const signedEvent = eventService.createEvent({
          eventType: EventType.ACKNOWLEDGEMENT,
          siteId: this.siteId,
          assetId: alarm.tagName.split(".")[0],
          sourceTimestamp: alarm.acknowledgedAt,
          originType: OriginType.USER,
          originId: userId,
          payload: {
            alarmId: alarm.id,
            alarmDefId: alarm.alarmDefId,
            acknowledgedBy: userId,
            comment,
            activatedAt: alarm.activatedAt.toISOString(),
          },
          details: `Alarm ${alarm.id} acknowledged by ${userId}`,
        });

        console.log(`[AlarmService] ALARM ACK: ${alarm.id} by ${userId}`);

        this.emit("alarm", { alarm, signedEvent });
        this.emit("alarm:acknowledged", alarm);

        return true;
      }
    }
    return false;
  }

  // ===========================================================================
  // QUERIES
  // ===========================================================================

  /**
   * Get all active alarms
   */
  getActiveAlarms(): ActiveAlarm[] {
    return Array.from(this.activeAlarms.values());
  }

  /**
   * Get alarms by priority
   */
  getAlarmsByPriority(priority: AlarmPriority): ActiveAlarm[] {
    return this.getActiveAlarms().filter((a) => a.priority === priority);
  }

  /**
   * Get alarm count summary
   */
  getAlarmSummary(): Record<AlarmPriority, number> {
    const alarms = this.getActiveAlarms();
    return {
      CRITICAL: alarms.filter((a) => a.priority === "CRITICAL").length,
      HIGH: alarms.filter((a) => a.priority === "HIGH").length,
      MEDIUM: alarms.filter((a) => a.priority === "MEDIUM").length,
      LOW: alarms.filter((a) => a.priority === "LOW").length,
      INFO: alarms.filter((a) => a.priority === "INFO").length,
    };
  }

  /**
   * Get service status
   */
  getStatus(): Record<string, unknown> {
    return {
      definitionsCount: this.alarmDefinitions.size,
      activeAlarmsCount: this.activeAlarms.size,
      alarmSummary: this.getAlarmSummary(),
      siteId: this.siteId,
    };
  }
}

// =============================================================================
// SINGLETON
// =============================================================================

export const alarmService = new AlarmService();

// =============================================================================
// INTEGRATION WITH TAG SERVICE
// =============================================================================

/**
 * Initialize alarm service and connect to tag updates
 */
export function initAlarmService(siteId: string = "SITE-001"): void {
  alarmService.setSiteId(siteId);
  alarmService.registerAlarmsFromTags();

  // This would typically subscribe to tag service WebSocket or events
  // For now, it can be called manually or integrated in the tag service
  console.log(`[AlarmService] Initialized for site ${siteId}`);
}
