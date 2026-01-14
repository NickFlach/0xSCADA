/**
 * Tank Farm Overview Component
 *
 * CAP-1.1 - Capstone 1: Tank Farm Monitor
 *
 * Cross-track capstone project (Tracks A + B + E)
 * HMI overview screen displaying multiple tanks with real-time data.
 */

import * as React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { TankWidget, type TankData, type AlarmState } from "./TankWidget";
import { cn } from "@/lib/utils";

// =============================================================================
// TYPES
// =============================================================================

export interface TankFarmAlarm {
  id: string;
  tankId: string;
  type: AlarmState;
  message: string;
  timestamp: Date;
  acknowledged: boolean;
}

export interface TankFarmProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Array of tank data */
  tanks: TankData[];
  /** Active alarms */
  alarms?: TankFarmAlarm[];
  /** Callback when tank is selected */
  onTankSelect?: (tankId: string) => void;
  /** Callback when alarm is acknowledged */
  onAlarmAck?: (alarmId: string) => void;
  /** Callback to acknowledge all alarms */
  onAlarmAckAll?: () => void;
  /** Show alarm panel */
  showAlarmPanel?: boolean;
  /** Title */
  title?: string;
}

// =============================================================================
// ALARM PANEL
// =============================================================================

interface AlarmPanelProps {
  alarms: TankFarmAlarm[];
  onAck?: (alarmId: string) => void;
  onAckAll?: () => void;
}

function AlarmPanel({ alarms, onAck, onAckAll }: AlarmPanelProps) {
  const unackedAlarms = alarms.filter((a) => !a.acknowledged);
  const hasAlarms = unackedAlarms.length > 0;

  const priorityColors: Record<AlarmState, string> = {
    "high-high": "bg-red-500/20 border-red-500",
    "low-low": "bg-red-500/20 border-red-500",
    high: "bg-yellow-500/20 border-yellow-500",
    low: "bg-yellow-500/20 border-yellow-500",
    normal: "bg-muted",
  };

  return (
    <Card className={cn(hasAlarms && "border-red-500/50")}>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center justify-between text-sm">
          <span className="flex items-center gap-2">
            {hasAlarms && (
              <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
            )}
            Active Alarms ({unackedAlarms.length})
          </span>
          {hasAlarms && onAckAll && (
            <Button variant="outline" size="sm" onClick={onAckAll}>
              ACK ALL
            </Button>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {unackedAlarms.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-4">
            No active alarms
          </p>
        ) : (
          <div className="space-y-2 max-h-48 overflow-y-auto">
            {unackedAlarms.map((alarm) => (
              <div
                key={alarm.id}
                className={cn(
                  "flex items-center justify-between p-2 rounded border",
                  priorityColors[alarm.type]
                )}
              >
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm font-bold">
                      {alarm.tankId}
                    </span>
                    <span className="text-xs uppercase font-bold">
                      {alarm.type}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground">{alarm.message}</p>
                </div>
                {onAck && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onAck(alarm.id)}
                  >
                    ACK
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// =============================================================================
// TANK FARM OVERVIEW
// =============================================================================

const TankFarm = React.forwardRef<HTMLDivElement, TankFarmProps>(
  (
    {
      tanks,
      alarms = [],
      onTankSelect,
      onAlarmAck,
      onAlarmAckAll,
      showAlarmPanel = true,
      title = "Tank Farm Overview",
      className,
      ...props
    },
    ref
  ) => {
    // Calculate summary stats
    const totalTanks = tanks.length;
    const alarmedTanks = tanks.filter((t) => t.alarmState !== "normal").length;
    const avgLevel =
      tanks.reduce((sum, t) => sum + t.level, 0) / totalTanks || 0;

    return (
      <div ref={ref} className={cn("space-y-4", className)} {...props}>
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-2xl font-bold">{title}</h2>
            <p className="text-sm text-muted-foreground">
              {totalTanks} tanks | {alarmedTanks} in alarm | Avg level:{" "}
              {avgLevel.toFixed(1)}%
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span
              className={cn(
                "w-3 h-3 rounded-full",
                alarmedTanks > 0 ? "bg-red-500 animate-pulse" : "bg-green-500"
              )}
            />
            <span className="text-sm font-medium">
              {alarmedTanks > 0 ? "ALARM" : "NORMAL"}
            </span>
          </div>
        </div>

        {/* Main content */}
        <div className="grid gap-4 lg:grid-cols-4">
          {/* Tank grid */}
          <div className="lg:col-span-3">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {tanks.map((tank) => (
                <TankWidget
                  key={tank.id}
                  tank={tank}
                  onClick={() => onTankSelect?.(tank.id)}
                  showSetpoints={true}
                />
              ))}
            </div>
          </div>

          {/* Alarm panel */}
          {showAlarmPanel && (
            <div className="lg:col-span-1">
              <AlarmPanel
                alarms={alarms}
                onAck={onAlarmAck}
                onAckAll={onAlarmAckAll}
              />
            </div>
          )}
        </div>
      </div>
    );
  }
);

TankFarm.displayName = "TankFarm";

// =============================================================================
// DEMO DATA (for development/testing)
// =============================================================================

export const DEMO_TANKS: TankData[] = [
  {
    id: "TK-101",
    name: "Feed Tank A",
    level: 75.2,
    temperature: 45.2,
    temperatureUnit: "°C",
    alarmState: "normal",
    setpoints: { lowLow: 10, low: 20, high: 80, highHigh: 90 },
  },
  {
    id: "TK-102",
    name: "Feed Tank B",
    level: 23.1,
    temperature: 38.7,
    temperatureUnit: "°C",
    alarmState: "low",
    setpoints: { lowLow: 10, low: 25, high: 80, highHigh: 90 },
  },
  {
    id: "TK-103",
    name: "Product Tank",
    level: 98.4,
    temperature: 52.1,
    temperatureUnit: "°C",
    alarmState: "high-high",
    setpoints: { lowLow: 10, low: 20, high: 85, highHigh: 95 },
  },
];

export const DEMO_ALARMS: TankFarmAlarm[] = [
  {
    id: "ALM-001",
    tankId: "TK-103",
    type: "high-high",
    message: "Level exceeded 95% threshold",
    timestamp: new Date(),
    acknowledged: false,
  },
  {
    id: "ALM-002",
    tankId: "TK-102",
    type: "low",
    message: "Level below 25% threshold",
    timestamp: new Date(),
    acknowledged: false,
  },
];

export { TankFarm };
export default TankFarm;
